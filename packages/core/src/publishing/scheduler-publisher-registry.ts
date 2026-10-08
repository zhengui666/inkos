import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { SchedulerPublisher } from '../pipeline/autonomous-chapters.js';
import { publishingError, PublishingPlatformSchema, PublishingTargetInputSchema, type PublishingTarget } from './contracts.js';
import { PublishingStore } from './store.js';
import { RemoteWorkDestinationSchema, type RemoteWorkDestination, type RemoteWorkRun } from './work-creation-contracts.js';
import { RemoteWorkStore } from './work-creation-store.js';
import { RemoteWorkCreationService, requireBoundRemoteWork, type RemoteWorkCreationPort } from './work-creation-service.js';
import { createMegaNovelSchedulerPublisherFromConfiguration, MegaNovelSchedulerBindingConfigurationSchema } from './scheduler-publisher.js';
import { createPublisherCleanup, PublisherStartupCleanupError } from './publisher-cleanup.js';

export const SchedulerPublisherBindingSchema = z.object({
  provider: z.string().trim().min(1), workId: z.string().trim().min(1), targetId: z.string().trim().min(1),
  configuration: z.unknown(),
}).strict();
export type SchedulerPublisherBinding = z.infer<typeof SchedulerPublisherBindingSchema>;
export const SchedulerNewWorkDefaultSchema = z.object({
  destination: RemoteWorkDestinationSchema, configuration: z.unknown(),
}).strict();
export type SchedulerNewWorkDefault = z.infer<typeof SchedulerNewWorkDefaultSchema>;
export const SchedulerPublishingConfigurationSchema = z.object({
  version: z.literal(1), bindings: z.array(SchedulerPublisherBindingSchema).default([]),
  newWorks: z.array(SchedulerNewWorkDefaultSchema).default([]),
}).strict().refine(value => value.bindings.length > 0 || value.newWorks.length > 0, 'Configure a binding or an explicit new-work destination.');

/** Factories are installed by application code, never imported from a provider name in JSON.
 * Parsing/validation must be read-only. Each driver owns durable attempt reconciliation:
 * a pending/unknown result must never authorize resubmission, including after restart.
 */
export interface SchedulerPublisherFactory<Configuration> {
  provider: string;
  parseConfiguration(input: unknown, binding: SchedulerPublisherBinding): Configuration;
  target(configuration: Configuration): Pick<PublishingTarget, 'platform' | 'accountLabel' | 'remoteBookId'>;
  /** Actual signed-in account identity from validated transport configuration. Required for new-book capability. */
  accountId?(configuration: Configuration): string;
  create(root: string, binding: SchedulerPublisherBinding, configuration: Configuration): SchedulerPublisher | Promise<SchedulerPublisher>;
  /** Optional verified capability. No dynamically imported adapter or guessed UI is accepted. */
  newWork?: {
    parseConfiguration(input: unknown, destination: RemoteWorkDestination): unknown;
    createPort(root: string, destination: RemoteWorkDestination, configuration: unknown): RemoteWorkCreationPort | Promise<RemoteWorkCreationPort>;
    /** Trusted driver derives first-chapter transport config; the remote response cannot supply it. */
    chapterBinding(run: RemoteWorkRun, configuration: unknown): SchedulerPublisherBinding;
  };
}

type PreparedFactory = { accountId?: string; target: ReturnType<SchedulerPublisherFactory<unknown>['target']>;
  create(): SchedulerPublisher | Promise<SchedulerPublisher> };
type PreparedNewWork = { destination: RemoteWorkDestination; createPort?: () => RemoteWorkCreationPort | Promise<RemoteWorkCreationPort>;
  chapterBinding?: (run: RemoteWorkRun) => SchedulerPublisherBinding };
type RegistryEntry = { mode: 'automatic'; prepare(root: string, binding: SchedulerPublisherBinding): PreparedFactory;
  prepareNew(root: string, defaults: SchedulerNewWorkDefault): PreparedNewWork }
  | { mode: 'manual_required'; reason: string };

/** One explicitly selected destination per work; no fallback, account discovery or retries. */
export class SchedulerPublisherRegistry {
  private readonly providers = new Map<string, RegistryEntry>();

  register<Configuration>(factory: SchedulerPublisherFactory<Configuration>): this {
    if (factory.newWork && !factory.accountId) throw publishingError('REMOTE_WORK_CAPABILITY_INCOMPLETE', 'New-book adapters must expose their validated chapter-transport actual account identity.');
    this.add(factory.provider, { mode: 'automatic', prepare: (root, binding) => {
      const configuration = factory.parseConfiguration(binding.configuration, binding);
      return { accountId: factory.accountId?.(configuration), target: PublishingTargetInputSchema.omit({workId: true}).parse(factory.target(configuration)),
        create: () => factory.create(root, binding, configuration) };
    }, prepareNew: (root, defaults) => {
      if (!factory.newWork) return {destination: defaults.destination};
      const configuration = factory.newWork.parseConfiguration(defaults.configuration, defaults.destination);
      return {destination: defaults.destination, createPort: () => factory.newWork!.createPort(root, defaults.destination, configuration),
        chapterBinding: run => factory.newWork!.chapterBinding(run, configuration)};
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
    const { bindings, newWorks } = normalizeConfiguration(input);
    const newDefaults = new Map<string, PreparedNewWork>();
    for (const defaults of newWorks) {
      const platform = defaults.destination.platform;
      if (newDefaults.has(platform)) throw publishingError('REMOTE_WORK_DEFAULT_CONFLICT', 'Select one explicit default account/session per platform.');
      const entry = this.providers.get(defaults.destination.provider);
      if (!entry) throw publishingError('PUBLISHING_PROVIDER_UNKNOWN', 'The selected new-work provider is not installed.');
      newDefaults.set(platform, entry.mode === 'automatic' ? entry.prepareNew(root, defaults) : {destination: defaults.destination});
    }
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
    const creations = new RemoteWorkStore(join(root, '.inkos', 'harness.sqlite'));
    const ports = new Map<string, RemoteWorkCreationPort>();
    const ensuring = new Map<string, Promise<void>>();
    const byWork = new Map(bindings.map((binding, index) => [binding.workId, {binding, target: prepared[index]!.target, accountId: prepared[index]!.accountId}]));
    const requireTarget = (workId: string) => {
      const selected = byWork.get(workId);
      if (!selected) throw publishingError('PUBLISHING_BINDING_MISSING', `No configured publication destination for ${workId}.`);
      const priorCreation = creations.forWork(workId);
      if (priorCreation && priorCreation.attempts > 0 && (priorCreation.phase !== 'bound' || priorCreation.targetId !== selected.binding.targetId)) {
        throw publishingError('PUBLISHING_RECONCILIATION_REQUIRED', 'An earlier new-book creation attempt is unresolved or bound elsewhere; retain its original operation for readback.');
      }
      const target = store.getTarget(selected.binding.targetId);
      const observedAccountId = priorCreation?.receipt?.destination.accountId ?? target.observedAccountId;
      if (observedAccountId !== undefined && selected.accountId !== observedAccountId) {
        throw publishingError('REMOTE_WORK_ACCOUNT_MISMATCH', 'Configured chapter transport differs from the durably observed actual account.');
      }
      if (target.workId !== workId || target.id !== selected.binding.targetId || target.platform !== selected.target.platform
          || target.accountLabel !== selected.target.accountLabel || target.remoteBookId !== selected.target.remoteBookId) {
        throw publishingError('PUBLISHING_TARGET_CONFLICT', 'Configured binding differs from the retained target.');
      }
    };
    const publishers = new Map<string, SchedulerPublisher>();
    const unfinishedLoaders = new Set<{ close(): Promise<void> }>();
    const cleanup = createPublisherCleanup(() => [
      [...publishers.values(), ...ports.values(), ...unfinishedLoaders], [creations, store],
    ], () => Promise.allSettled([...ensuring.values()]));
    try {
      for (const binding of bindings) requireTarget(binding.workId);
      for (const [index, factory] of prepared.entries()) publishers.set(bindings[index]!.workId, await factory.create());
    } catch (error) {
      try { await cleanup.close(); }
      catch (cleanupError) {
        if (error instanceof PublisherStartupCleanupError) unfinishedLoaders.add(error.cleanup);
        throw new PublisherStartupCleanupError(error, cleanupError, cleanup);
      }
      // A nested loader already attempted cleanup. Keep its failure visible;
      // only an explicit later cleanup request may retry its unfinished handles.
      throw error;
    }
    const requirePublisher = (workId: string) => {
      if (cleanup.requested) throw publishingError('PUBLISHING_CLOSED', 'The configured publisher has closed.');
      requireTarget(workId);
      const publisher = publishers.get(workId);
      if (!publisher) throw publishingError('PUBLISHING_BINDING_MISSING', `No configured publication destination for ${workId}.`);
      return publisher;
    };
    const ensureWork: NonNullable<SchedulerPublisher['ensureWork']> = async request => {
      if (cleanup.requested) throw publishingError('PUBLISHING_CLOSED', 'The configured publisher has closed.');
      request.signal.throwIfAborted();
      const existing = creations.forWork(request.workId);
      const defaults = newDefaults.get(request.platform);
      if (existing) {
        if (existing.input.destination.platform !== request.platform) throw publishingError('REMOTE_WORK_INPUT_CONFLICT', 'The Work already has a different frozen platform.');
        creations.reserve({workId: request.workId, metadata: request.metadata, destination: defaults?.destination ?? existing.input.destination});
      }
      if (byWork.has(request.workId)) { requireTarget(request.workId); return; }
      if (!defaults) throw publishingError('REMOTE_WORK_NEEDS_SETUP', 'Select an authorized default provider/account/session for this platform in publishing settings.');
      // Freeze every request before any asynchronous factory call or coalescing a duplicate.
      creations.reserve({workId: request.workId, metadata: request.metadata, destination: defaults.destination});
      const pending = ensuring.get(request.workId);
      if (pending) return pending;
      const operation = (async () => {
        let port = ports.get(request.workId);
        if (!port && defaults.createPort) {
          port = await defaults.createPort();
          ports.set(request.workId, port);
        }
        const run = await new RemoteWorkCreationService(creations, port).ensure({workId: request.workId,
          destination: defaults.destination, metadata: request.metadata}, request.signal, request.beforeMutation);
        requireBoundRemoteWork(run);
        if (!defaults.chapterBinding) throw publishingError('REMOTE_WORK_UNSUPPORTED', 'This adapter cannot bootstrap chapter publication for a newly created book.');
        const binding = SchedulerPublisherBindingSchema.parse(defaults.chapterBinding(run));
        if (binding.workId !== request.workId || binding.targetId !== run.targetId || binding.provider !== run.input.destination.provider) {
          throw publishingError('REMOTE_WORK_BINDING_CONFLICT', 'The installed driver returned a chapter binding outside this observed operation.');
        }
        const entry = this.providers.get(binding.provider);
        if (!entry || entry.mode !== 'automatic') throw publishingError('REMOTE_WORK_UNSUPPORTED', 'The observed book has no installed automatic chapter driver.');
        const factory = entry.prepare(root, binding);
        if (factory.accountId !== run.input.destination.accountId) throw publishingError('REMOTE_WORK_ACCOUNT_MISMATCH', 'Derived chapter transport uses a different actual account from the independent creation receipt.');
        if (factory.target.platform !== run.input.destination.platform || factory.target.accountLabel !== run.input.destination.accountLabel
          || factory.target.remoteBookId !== run.receipt.remoteBookId) throw publishingError('REMOTE_WORK_BINDING_CONFLICT', 'Derived chapter routing differs from the independent creation receipt.');
        request.signal.throwIfAborted();
        const publisher = await factory.create();
        byWork.set(request.workId, {binding, target: factory.target, accountId: factory.accountId});
        publishers.set(request.workId, publisher);
      })().catch(error => {
        if (error instanceof PublisherStartupCleanupError) unfinishedLoaders.add(error.cleanup);
        throw error;
      });
      ensuring.set(request.workId, operation);
      try { await operation; } finally { ensuring.delete(request.workId); }
    };
    return {
      ensureWork,
      async ready(workId, signal, continuingChapter) {
        signal.throwIfAborted();
        await requirePublisher(workId).ready(workId, signal, continuingChapter);
      },
      async reconcile(input) {
        input.signal.throwIfAborted();
        // A restart may have an existing remote-book attempt but no chapter
        // binding yet. Recover that original outcome before reading edited prose.
        const creation = !byWork.has(input.workId) ? creations.forWork(input.workId) : undefined;
        if (creation && creation.attempts > 0) {
          await ensureWork({ workId: input.workId, platform: creation.input.destination.platform,
            metadata: creation.input.metadata, signal: input.signal,
            beforeMutation: () => { throw publishingError('REMOTE_WORK_RECONCILIATION_REQUIRED', 'Read-only recovery cannot create another remote work.'); } });
        }
        const publisher = requirePublisher(input.workId);
        if (!publisher.reconcile) return { status: 'unsupported' }; 
        return publisher.reconcile(input);
      },
      async publish(input) {
        input.signal.throwIfAborted();
        return requirePublisher(input.workId).publish(input);
      },
      close: () => cleanup.close(),
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
    accountId(configuration) { return configuration.scope.accountId; },
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
