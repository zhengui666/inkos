import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SchedulerPublisher } from '../pipeline/autonomous-chapters.js';
import { publishingError, PublishingPlatformSchema, PublishingTargetInputSchema, type PublishingTarget } from './contracts.js';
import { PublishingStore } from './store.js';
import { createMegaNovelSchedulerPublisherFromConfiguration, MegaNovelSchedulerBindingConfigurationSchema } from './scheduler-publisher.js';

export const SchedulerPublisherBindingSchema = z.object({
  provider: z.string().trim().min(1), workId: z.string().trim().min(1), targetId: z.string().trim().min(1),
  configuration: z.unknown(),
}).strict();
export type SchedulerPublisherBinding = z.infer<typeof SchedulerPublisherBindingSchema>;
export const SchedulerPublishingConfigurationSchema = z.object({
  version: z.literal(1), bindings: z.array(SchedulerPublisherBindingSchema).min(1),
}).strict();

/** Factories are installed by application code, never imported from a provider name in JSON.
 * Parsing/validation must be read-only. Each driver owns durable attempt reconciliation:
 * a pending/unknown result must never authorize resubmission, including after restart.
 */
export interface SchedulerPublisherFactory<Configuration> {
  provider: string;
  parseConfiguration(input: unknown, binding: SchedulerPublisherBinding): Configuration;
  target(configuration: Configuration): Pick<PublishingTarget, 'platform' | 'accountLabel' | 'remoteBookId'>;
  create(root: string, binding: SchedulerPublisherBinding, configuration: Configuration): SchedulerPublisher | Promise<SchedulerPublisher>;
}

type PreparedFactory = { target: ReturnType<SchedulerPublisherFactory<unknown>['target']>;
  create(): SchedulerPublisher | Promise<SchedulerPublisher> };
type RegistryEntry = { mode: 'automatic'; prepare(root: string, binding: SchedulerPublisherBinding): PreparedFactory }
  | { mode: 'manual_required'; reason: string };

/** One explicitly selected destination per work; no fallback, account discovery or retries. */
export class SchedulerPublisherRegistry {
  private readonly providers = new Map<string, RegistryEntry>();

  register<Configuration>(factory: SchedulerPublisherFactory<Configuration>): this {
    this.add(factory.provider, { mode: 'automatic', prepare: (root, binding) => {
      const configuration = factory.parseConfiguration(binding.configuration, binding);
      return { target: PublishingTargetInputSchema.omit({workId: true}).parse(factory.target(configuration)),
        create: () => factory.create(root, binding, configuration) };
    } });
    return this;
  }

  registerManual(provider: string, reason: string): this {
    this.add(provider, { mode: 'manual_required', reason });
    return this;
  }

  list(): ReadonlyArray<{ provider: string; mode: 'automatic' | 'manual_required' }> {
    return [...this.providers].map(([provider, entry]) => ({ provider, mode: entry.mode }));
  }

  private add(provider: string, entry: RegistryEntry): void {
    if (!provider.trim() || provider !== provider.trim() || this.providers.has(provider)) {
      throw publishingError('PUBLISHING_PROVIDER_CONFLICT', 'Register each nonempty publisher provider exactly once.');
    }
    this.providers.set(provider, entry);
  }

  async create(root: string, input: unknown): Promise<SchedulerPublisher & { close(): Promise<void> }> {
    const { bindings } = normalizeConfiguration(input);
    const works = new Set<string>(), targets = new Set<string>();
    // Validate the entire routing table before parsing providers or opening any transport.
    for (const binding of bindings) {
      if (works.has(binding.workId) || targets.has(binding.targetId)) {
        throw publishingError('PUBLISHING_BINDING_CONFLICT', 'Select one unique publication target per work; do not reuse targets.');
      }
      works.add(binding.workId); targets.add(binding.targetId);
      const entry = this.providers.get(binding.provider);
      if (!entry) throw publishingError('PUBLISHING_PROVIDER_UNKNOWN', `Publisher provider ${binding.provider} is not registered.`);
      if (entry.mode === 'manual_required') {
        throw publishingError('PUBLISHING_MANUAL_REQUIRED', `${binding.provider}: ${entry.reason}`);
      }
    }
    const prepared = bindings.map(binding => (this.providers.get(binding.provider) as Extract<RegistryEntry, {mode: 'automatic'}>).prepare(root, binding));
    const store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
    const byWork = new Map(bindings.map((binding, index) => [binding.workId, {binding, target: prepared[index]!.target}]));
    const requireTarget = (workId: string) => {
      const selected = byWork.get(workId);
      if (!selected) throw publishingError('PUBLISHING_BINDING_MISSING', `No configured publication destination for ${workId}.`);
      const target = store.getTarget(selected.binding.targetId);
      if (target.workId !== workId || target.id !== selected.binding.targetId || target.platform !== selected.target.platform
          || target.accountLabel !== selected.target.accountLabel || target.remoteBookId !== selected.target.remoteBookId) {
        throw publishingError('PUBLISHING_TARGET_CONFLICT', 'Configured binding differs from the retained target.');
      }
    };
    const publishers = new Map<string, SchedulerPublisher>();
    const closeAll = async () => {
      const results = await Promise.allSettled([...new Set(publishers.values())].map(async publisher => publisher.close?.()));
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      try { store.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Publisher cleanup failed.');
    };
    try {
      for (const binding of bindings) requireTarget(binding.workId);
      for (const [index, factory] of prepared.entries()) publishers.set(bindings[index]!.workId, await factory.create());
    } catch (error) {
      try { await closeAll(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Publisher startup and cleanup failed.'); }
      throw error;
    }
    let closePromise: Promise<void> | undefined;
    const requirePublisher = (workId: string) => {
      if (closePromise) throw publishingError('PUBLISHING_CLOSED', 'The configured publisher has closed.');
      requireTarget(workId);
      const publisher = publishers.get(workId);
      if (!publisher) throw publishingError('PUBLISHING_BINDING_MISSING', `No configured publication destination for ${workId}.`);
      return publisher;
    };
    return {
      async ready(workId, signal, continuingChapter) {
        signal.throwIfAborted();
        await requirePublisher(workId).ready(workId, signal, continuingChapter);
      },
      async publish(input) {
        input.signal.throwIfAborted();
        return requirePublisher(input.workId).publish(input);
      },
      close() { return closePromise ??= closeAll(); },
    };
  }
}

function normalizeConfiguration(input: unknown) {
  if (Array.isArray(input)) {
    // Preserve the existing MegaNovel array format, including all of its refinements.
    const legacy = z.array(MegaNovelSchedulerBindingConfigurationSchema).min(1).parse(input);
    return SchedulerPublishingConfigurationSchema.parse({ version: 1, bindings: legacy.map(({workId, targetId, ...configuration}) =>
      ({provider: 'meganovel', workId, targetId, configuration})) });
  }
  return SchedulerPublishingConfigurationSchema.parse(input);
}

/** Only the existing MegaNovel driver is automatic. A listed manual platform is not an integration. */
export function createDefaultSchedulerPublisherRegistry(): SchedulerPublisherRegistry {
  const registry = new SchedulerPublisherRegistry();
  registry.register({
    provider: 'meganovel',
    parseConfiguration(input, binding) {
      // Strictly reject routing identities inside provider options rather than silently overriding them.
      const configuration = MegaNovelSchedulerBindingConfigurationSchema.innerType().omit({workId: true, targetId: true}).parse(input);
      return MegaNovelSchedulerBindingConfigurationSchema.parse({...configuration, workId: binding.workId, targetId: binding.targetId});
    },
    target(configuration) {
      return {platform: 'meganovel', accountLabel: configuration.scope.accountLabel, remoteBookId: configuration.scope.remoteBookId};
    },
    create(root, _binding, configuration) {
      return createMegaNovelSchedulerPublisherFromConfiguration(root, [configuration]);
    },
  });
  const reason = 'Automatic scheduler publication is unavailable. Use inkos publishing prepare and the explicit manual receipt workflow; an export is not verified publication.';
  registry.registerManual('manual', reason);
  for (const platform of PublishingPlatformSchema.options) if (platform !== 'meganovel') registry.registerManual(platform, reason);
  return registry;
}

/** Explicit local configuration only; new providers require an installed, registered factory. */
export async function loadSchedulerPublisher(root: string, configurationPath: string,
  registry = createDefaultSchedulerPublisherRegistry()): Promise<SchedulerPublisher & { close(): Promise<void> }> {
  return registry.create(root, JSON.parse(await readFile(configurationPath, 'utf8')));
}
