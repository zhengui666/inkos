import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {WorkResourceIdSchema} from '../harness/contracts.js';
import {listWorkManifests} from '../harness/work-store.js';
import {publishingError} from './contracts.js';
import {MegaNovelScopeSchema, MegaNovelProbeSchema, MegaNovelSnapshotSchema, MegaNovelSnapshotRequestSchema,
  type MegaNovelObservationPort, type MegaNovelScope, type MegaNovelBrowserOptions} from './meganovel-contracts.js';
import {MegaNovelCdpConfigurationSchema} from './meganovel-cdp.js';
import {createMegaNovelDomBinding, MegaNovelDomConfigurationSchema} from './meganovel-dom-binding.js';
import {compareMegaNovelChapter} from './meganovel-observation.js';
import {assertPreflightProjectSettled, readPreflightChapter, assertSamePreflightChapter} from './preflight-source.js';

export const PublishingPreflightConfigurationSchema = z.object({version: z.literal(1), bindings: z.array(z.object({
  provider: z.string().trim().min(1), workId: WorkResourceIdSchema, configuration: z.unknown(),
}).strict()).min(1)}).strict();
const ObservationSchema = z.object({
  accountMatches: z.boolean(), bookMatches: z.boolean(), sessionMatches: z.boolean(), lookupComplete: z.boolean(),
  chapterFound: z.boolean(), chapterIdentityMatches: z.boolean(), titleMatches: z.boolean(), contentMatches: z.boolean(),
  remoteStatus: z.enum(['draft', 'submitted', 'reviewing', 'published', 'rejected']).nullable(),
  errors: z.array(z.object({code: z.string(), message: z.string()}).strict()),
}).strict();
export type PublishingPreflightObservation = z.infer<typeof ObservationSchema>;
export type PublishingPreflightChapter = Pick<Awaited<ReturnType<typeof readPreflightChapter>>,
  'workId' | 'artifactId' | 'revisionId' | 'number' | 'title' | 'content'>;
export interface PublishingPreflightProvider<Configuration> {
  provider: string;
  parseConfiguration(input: unknown): Configuration;
  observe(configuration: Configuration, chapter: PublishingPreflightChapter,
    options: MegaNovelBrowserOptions): Promise<PublishingPreflightObservation>;
}

/** Only application-installed observers; configuration cannot import executable provider modules. */
export class PublishingPreflightRegistry {
  private readonly providers = new Map<string, PublishingPreflightProvider<unknown>>();
  register<Configuration>(provider: PublishingPreflightProvider<Configuration>): this {
    if (!provider.provider.trim() || provider.provider !== provider.provider.trim() || this.providers.has(provider.provider)) {
      throw publishingError('PUBLISHING_PROVIDER_CONFLICT', 'Register each nonempty observer exactly once.');
    }
    this.providers.set(provider.provider, provider as PublishingPreflightProvider<unknown>);
    return this;
  }
  list() { return [...this.providers.keys()]; }
  prepare(provider: string, input: unknown) {
    const selected = this.providers.get(provider);
    if (!selected) throw publishingError('PUBLISHING_PREFLIGHT_UNSUPPORTED', 'No read-only provider is installed for this platform.');
    const configuration = selected.parseConfiguration(input);
    return (chapter: PublishingPreflightChapter, options: MegaNovelBrowserOptions) => selected.observe(configuration, chapter, options);
  }
}

const safeErrors: Record<string, string> = {
  PUBLISHING_PREFLIGHT_FAILED: 'Preflight could not complete. No publication action was requested.',
  PUBLISHING_PREFLIGHT_UNSUPPORTED: 'This platform has no installed read-only preflight provider.',
  PUBLISHING_WORK_REQUIRED: 'Specify work-id when there is not exactly one Work.',
  PUBLISHING_BINDING_MISSING: 'No observation binding exists for the selected Work.',
  PUBLISHING_BINDING_CONFLICT: 'Select one observation binding per Work.',
  PUBLISHING_WORK_IDENTITY_CONFLICT: 'The manifest identifies a different Work.',
  PUBLISHING_LOCAL_RECOVERY_REQUIRED: 'A local file transaction requires separate recovery before preflight.',
  CHAPTER_REVISION_CHANGED: 'The current revision or source changed; it cannot be matched to this observation.',
  ARTIFACT_SNAPSHOT_UNAVAILABLE: 'The current revision has no independently retained bytes.',
  ARTIFACT_PATH_OUTSIDE_WORK: 'The selected source resolves outside its Work.',
  PUBLISHING_CHAPTER_MISSING: 'Select one indexed chapter with one current retained revision.',
  PUBLISHING_REMOTE_CHAPTER_ABSENT: 'No matching remote chapter was observed; this does not authorize a submission.',
  MEGANOVEL_SCOPE_CHANGED: 'The observed browser target, account or book differs from the configured scope.',
  MEGANOVEL_CONTENT_CONFLICT: 'Remote chapter identity, title or body differs from the current retained revision.',
  MEGANOVEL_DUPLICATE_CHAPTER: 'Multiple remote rows match this chapter.',
  MEGANOVEL_INCOMPLETE_LOOKUP: 'The remote inventory could not be checked completely.',
  MEGANOVEL_BROWSER_BLOCKED: 'An account, agreement, risk, quota or unrecognized-UI blocker requires attention.',
};
for (const code of ['MEGANOVEL_BROWSER_BUSY', 'MEGANOVEL_BROWSER_CLOSED', 'MEGANOVEL_BROWSER_TIMEOUT',
  'MEGANOVEL_BROWSER_TARGET_MISSING', 'MEGANOVEL_OBSERVATION_UNSUPPORTED', 'MEGANOVEL_SESSION_IDENTITY_UNVERIFIED',
  'MEGANOVEL_PENDING_EDITOR', 'MEGANOVEL_EDITOR_REQUIRED', 'MEGANOVEL_UNRECOGNIZED_UI', 'MEGANOVEL_PUBLICATION_UNVERIFIED',
  'MEGANOVEL_CDP_CONFIG', 'MEGANOVEL_DOM_CONFIG', 'MEGANOVEL_LANGUAGE_UNSUPPORTED', 'MEGANOVEL_ENCODING_UNSUPPORTED',
  'PUBLISHING_SOURCE_UNSUPPORTED', 'PUBLISHING_EMPTY_CHAPTER']) safeErrors[code] = 'Preflight stopped at a provider or source validation boundary. No publication action was requested.';
export function publishingPreflightFailure(error: unknown) {
  const supplied = error && typeof error === 'object' ? (error as {code?: unknown}).code : undefined;
  const code = typeof supplied === 'string' && Object.hasOwn(safeErrors, supplied) ? supplied : 'PUBLISHING_PREFLIGHT_FAILED';
  return {code, message: safeErrors[code]!};
}

export async function observeMegaNovelPreflight(browser: MegaNovelObservationPort, inputScope: MegaNovelScope,
  chapter: PublishingPreflightChapter, options: MegaNovelBrowserOptions = {}): Promise<PublishingPreflightObservation> {
  const scope = MegaNovelScopeSchema.parse(inputScope);
  const identity = (actual: MegaNovelScope) => ({accountMatches: actual.accountId === scope.accountId && actual.accountLabel === scope.accountLabel,
    bookMatches: actual.remoteBookId === scope.remoteBookId, sessionMatches: actual.sessionId === scope.sessionId});
  options.signal?.throwIfAborted();
  const probe = MegaNovelProbeSchema.parse(await browser.probe(scope, options));
  if (!Object.values(identity(probe.scope)).every(Boolean)) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'Scope differs.');
  if (probe.blocker !== 'none') throw publishingError('MEGANOVEL_BROWSER_BLOCKED', 'Stop at this blocker.');
  options.signal?.throwIfAborted();
  const snapshot = MegaNovelSnapshotSchema.parse(await browser.snapshot(MegaNovelSnapshotRequestSchema.parse({
    scope, chapterNumber: chapter.number, expectedTitle: chapter.title,
  }), options));
  options.signal?.throwIfAborted();
  const observedIdentity = identity(snapshot.scope), comparison = compareMegaNovelChapter(snapshot, chapter);
  if (!Object.values(observedIdentity).every(Boolean) || snapshot.chapterNumber !== chapter.number) {
    comparison.errors.unshift(publishingPreflightFailure({code: 'MEGANOVEL_SCOPE_CHANGED'}));
  }
  if (snapshot.blocker !== 'none') comparison.errors.unshift(publishingPreflightFailure({code: 'MEGANOVEL_BROWSER_BLOCKED'}));
  if (!comparison.chapterFound) comparison.errors.push(publishingPreflightFailure({code: 'PUBLISHING_REMOTE_CHAPTER_ABSENT'}));
  return {...observedIdentity, ...comparison};
}

/** Only the current native MegaNovel binding is supported by the default observation registry. */
export function createDefaultPublishingPreflightRegistry() {
  const schema = MegaNovelCdpConfigurationSchema.extend({dom: MegaNovelDomConfigurationSchema.optional()});
  return new PublishingPreflightRegistry().register({provider: 'meganovel', parseConfiguration: input => schema.parse(input),
    async observe({dom, ...configuration}, chapter, options) {
      options.signal?.throwIfAborted();
      const {connectMegaNovelCdpPort} = await import('./meganovel-cdp.js');
      const browser = await connectMegaNovelCdpPort(configuration, createMegaNovelDomBinding(dom));
      try {
        return await observeMegaNovelPreflight({probe: (scope, readOptions) => browser.probe(scope, readOptions),
          snapshot: (request, readOptions) => browser.observeSnapshot(request, readOptions)}, configuration.scope, chapter, options);
      } finally { await browser.close(); }
    }});
}

/** Observation only: intentionally no Store, package, Goal, scheduler or mutation adapter. */
export async function runPublishingPreflight(input: {projectRoot: string; configuration: unknown; workId?: string;
  chapterNumber: number; signal?: AbortSignal}, registry = createDefaultPublishingPreflightRegistry()) {
  const chapterNumber = z.number().int().positive().parse(input.chapterNumber);
  const configuration = PublishingPreflightConfigurationSchema.parse(input.configuration);
  if (new Set(configuration.bindings.map(binding => binding.workId)).size !== configuration.bindings.length) {
    throw publishingError('PUBLISHING_BINDING_CONFLICT', 'Select one binding per Work.');
  }
  let workId = input.workId;
  if (!workId) {
    const works = await listWorkManifests(input.projectRoot);
    if (works.length !== 1) throw publishingError('PUBLISHING_WORK_REQUIRED', 'Select an explicit Work.');
    workId = works[0]!.id;
  }
  const binding = configuration.bindings.find(item => item.workId === WorkResourceIdSchema.parse(workId));
  if (!binding) throw publishingError('PUBLISHING_BINDING_MISSING', 'No configured observation binding.');
  const observe = registry.prepare(binding.provider, binding.configuration);
  input.signal?.throwIfAborted();
  await assertPreflightProjectSettled(input.projectRoot);
  const before = await readPreflightChapter(input.projectRoot, workId, chapterNumber);
  const {bytes: _bytes, manifest: _manifest, chapter: _chapter, ...selected} = before;
  const observation = ObservationSchema.parse(await observe(selected, {signal: input.signal}));
  input.signal?.throwIfAborted();
  await assertPreflightProjectSettled(input.projectRoot);
  assertSamePreflightChapter(before, await readPreflightChapter(input.projectRoot, workId, chapterNumber));
  const errors = observation.errors.map(publishingPreflightFailure);
  return {observationOnly: true as const, publicationAuthorized: false as const, targetMappingChecked: false as const,
    retainedAttemptsChecked: false as const, provider: binding.provider, workId, chapterNumber,
    artifactId: before.artifactId, revisionId: before.revisionId, ...observation, errors,
    matchesCurrentRevision: errors.length === 0 && observation.accountMatches && observation.bookMatches && observation.sessionMatches
      && observation.lookupComplete && observation.chapterFound && observation.chapterIdentityMatches && observation.titleMatches && observation.contentMatches};
}
export async function loadPublishingPreflight(projectRoot: string, configurationPath: string,
  options: {workId?: string; chapterNumber: number; signal?: AbortSignal}) {
  return runPublishingPreflight({projectRoot, configuration: JSON.parse(await readFile(configurationPath, 'utf8')), ...options});
}
