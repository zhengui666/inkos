import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai';
import { Harness, createRegistry, type TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { ProjectDoc, Works, Artifacts, defaultPlan, type Work } from '../../../works/documents.js';
import { createPublishingExtension, createBrowserPublisherExtension } from '../index.js';
import { createDistributionTask } from '../../../publishing/task.js';
import { PublishingService, queueDistribution } from '../../../publishing/service.js';
import { Distributions } from '../../../publishing/documents.js';
import { applyObservation, distributionDecision } from '../../../publishing/protocol.js';
import { emptyRemote, type BrowserObservation, type Distribution, type PublishingTarget } from '../../../publishing/contracts.js';
import { browserProfileDir, playwrightMcpConfig } from '../../browser/session.js';
import { normalizeMegaNovelBodyText } from '../../../publishing/meganovel-contracts.js';
import { interpretMegaNovelReadback, megaNovelEditorIdentity, megaNovelReaderIdentity, type MegaNovelReadback } from '../meganovel.js';

const roots: string[] = [], harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function open(root?: string) {
  root ??= await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-publishing-'));
  if (!roots.includes(root)) roots.push(root);
  const registry = createRegistry();
  registry.install(createPublishingExtension(root));
  const harness = await Harness.open(await openNodeSqliteStorage(join(root, 'durable.sqlite')),
    { registry, models: createModels(), settings: { retry: { enabled: false } } }, BACKGROUND_CONTEXT);
  harnesses.push(harness);
  return { root, registry, harness, service: new PublishingService(harness, root) };
}
async function seedWork(harness: Harness, root: string) {
  const work: Work = { id: 'work', title: 'A work', profile: 'fiction', locale: 'en', status: 'active', plan: defaultPlan(),
    artifactIds: ['artifact'], targetIds: [], materialIds: [], domain: {}, history: [], legacy: {},
    pauseRequested: false, createdAt: 1, updatedAt: 1 };
  await writeFile(join(root, 'revision-1.txt'), 'First paragraph.\n\nSecond paragraph.\n');
  await writeFile(join(root, 'revision-2.txt'), 'Edited body.\n');
  await harness.commit(async tx => {
    const project = await tx.doc(ProjectDoc); project.workIds.push(work.id);
    await tx.doc(Works, work.id, work);
    await tx.doc(Artifacts, 'artifact', { id: 'artifact', workId: work.id, title: 'Chapter', currentRevision: 'r1', revisions: [
      { id: 'r1', artifactId: 'artifact', workId: work.id, title: 'Chapter', path: 'revision-1.txt', format: 'text', metadata: {}, createdAt: 1 },
      { id: 'r2', artifactId: 'artifact', workId: work.id, title: 'Chapter', path: 'revision-2.txt', format: 'text', metadata: {}, createdAt: 2 },
    ] });
  }, BACKGROUND_CONTEXT);
}
async function target(service: PublishingService, id: string, accountId: string, platform = 'browser', enabled = true) {
  return service.createTarget({ id, workId: 'work', platform, enabled, config: { entryUrl: 'about:blank', accountId } });
}
function observed(accountId: string, changes: Partial<BrowserObservation> = {}): BrowserObservation {
  return { state: 'submitted', accountId, remote: { workId: 'remote-work', artifactId: 'remote-artifact', authorUrl: 'about:blank', readerUrl: null },
    title: 'Chapter', body: 'First paragraph.\n\nSecond paragraph.\n', complete: true, notApplied: false,
    evidence: 'Domain protocol observation input (not platform acceptance).', observedAt: 2, ...changes };
}
function decide(record: Distribution, destination: PublishingTarget, seen: BrowserObservation, changes: Partial<Parameters<typeof distributionDecision>[0]> = {}) {
  return distributionDecision({ distribution: record, target: destination, request: record.desired, observation: seen,
    title: 'Chapter', body: 'First paragraph.\n\nSecond paragraph.\n', capabilities: ['publish', 'update'], observeOnly: false, ...changes });
}

describe('official durable publishing documents and tasks (no provider, no platform)', () => {
  it('registers the same factory task and only implemented default publishers', async () => {
    const { root, registry } = await open();
    expect(registry.snapshot().task('inkos.distribution')).toBe(createDistributionTask(root));
    expect(createPublishingExtension(root).publishers?.map(item => item.id)).toEqual(['browser', 'meganovel']);
    expect(createPublishingExtension(root).tools?.find(item => item.name === 'inkos_browser_call')?.replay).toBe('unsafe');
  });
  it('uses stable target/artifact records and versioned task inputs, with request replay', async () => {
    const { root, harness, service } = await open(); await seedWork(harness, root);
    const destination = await target(service, 'target-a', '101');
    const first = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact', revisionId: 'r1', requestId: 'request-1' });
    const replay = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact', revisionId: 'r1', requestId: 'request-1' });
    expect(replay.id).toBe(first.id); expect(replay.taskId).toBe(first.taskId);
    const next = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact', revisionId: 'r2' });
    expect(next.id).toBe(first.id); expect(next.taskId).toBe(first.taskId); expect(next.desired.revisionId).toBe('r2');
    expect((await service.listDistributions()).length).toBe(1);
    expect((await harness.getTask(first.taskId as TaskId, BACKGROUND_CONTEXT))?.input).toMatchObject({ request: { revisionId: 'r1' } });
    await expect(queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact', revisionId: 'r2', requestId: 'request-1' })).rejects.toThrow('requestId');
  });
  it('isolates target/account sessions, configurations and distribution identities', async () => {
    const { root, harness, service } = await open(); await seedWork(harness, root);
    const a = await target(service, 'target-a', '101'), b = await target(service, 'target-b', '202');
    expect(browserProfileDir(root, a)).not.toBe(browserProfileDir(root, b));
    expect(browserProfileDir(root, a)).not.toBe(browserProfileDir(root, { ...a, config: { ...a.config, accountId: '202' } }));
    expect(playwrightMcpConfig(root, a).args).toContain(browserProfileDir(root, a));
    expect(playwrightMcpConfig(root, a).args?.[0]).toMatch(/@playwright\/mcp\/cli\.js$/u);
    const da = await queueDistribution(harness, root, { targetId: a.id, artifactId: 'artifact' });
    const db = await queueDistribution(harness, root, { targetId: b.id, artifactId: 'artifact' });
    expect(da.id).not.toBe(db.id);
    expect((await harness.snapshot(Works, 'work', BACKGROUND_CONTEXT))?.targetIds).toEqual([a.id, b.id]);
    const updated = await service.updateTarget(a.id, { config: { skill: 'Observed site skill', metadata: { coverPath: 'cover.png' } } });
    expect(updated.config.skill).toBe('Observed site skill'); expect((await service.listTargets())[1]?.config.skill).toBe('');
    await expect(service.updateTarget(a.id, { config: { accountId: '202' } })).rejects.toThrow('separate target');
  });
  it('keeps unsupported/disabled targets local to their own task and never pauses creation', async () => {
    const { root, harness, service } = await open(); await seedWork(harness, root);
    const unsupported = await target(service, 'unsupported', '101', 'fanqie');
    const disabled = await target(service, 'disabled', '202', 'browser', false);
    const a = await service.queue({ targetId: unsupported.id, artifactId: 'artifact' });
    const b = await service.queue({ targetId: disabled.id, artifactId: 'artifact' });
    await harness.waitForTask(a.taskId as TaskId, BACKGROUND_CONTEXT);
    await harness.waitForTask(b.taskId as TaskId, BACKGROUND_CONTEXT);
    const rows = await service.listDistributions();
    expect(rows.find(row => row.id === a.id)?.status).toBe('unsupported');
    expect(rows.find(row => row.id === b.id)?.status).toBe('failed');
    expect((await harness.snapshot(Works, 'work', BACKGROUND_CONTEXT))?.status).toBe('active');
    expect((await harness.snapshot(Works, 'work', BACKGROUND_CONTEXT))?.pauseRequested).toBe(false);
  });
  it('keeps publish and update capabilities separate without a model or external mutation', async () => {
    const { root, harness, service, registry } = await open(); await seedWork(harness, root);
    registry.install(createBrowserPublisherExtension({ id: 'publish-only', capabilities: ['publish'] }));
    const destination = await target(service, 'publish-only-target', '101', 'publish-only');
    const queued = await service.queue({ targetId: destination.id, artifactId: 'artifact', operation: 'update' });
    await harness.waitForTask(queued.taskId as TaskId, BACKGROUND_CONTEXT);
    const record = (await service.listDistributions())[0]!;
    expect(record.status).toBe('unsupported'); expect(record.intent).toBeNull();
    expect(record.error).toContain('update capability');
  });
  it('persists uncertain intent on real SQLite reopen; negative observation cannot reset it', async () => {
    const env = await open(); await seedWork(env.harness, env.root);
    const destination = await target(env.service, 'target-a', '101');
    const queued = await queueDistribution(env.harness, env.root, { targetId: destination.id, artifactId: 'artifact' });
    await env.harness.commit(async tx => {
      const doc = await tx.doc(Distributions, queued.id, queued);
      const conversation = await tx.createConversation({ ownership: { kind: 'task', taskId: queued.taskId as TaskId } });
      doc.intent = { target: destination, request: doc.desired, conversationId: conversation.id, startedAt: 1 };
      doc.status = 'unknown';
    }, BACKGROUND_CONTEXT);
    await env.harness.close(BACKGROUND_CONTEXT); harnesses.splice(harnesses.indexOf(env.harness), 1);
    const reopened = await open(env.root), retained = (await reopened.service.listDistributions())[0]!;
    expect(retained.id).toBe(queued.id); expect(retained.intent?.request.revisionId).toBe('r1');
    const absent = observed('101', { state: 'absent', remote: emptyRemote(), title: null, body: null });
    expect(decide(retained, destination, absent)).toBe('needs-observation');
    await reopened.harness.commit(async tx => applyObservation(await tx.doc(Distributions, retained.id, retained), absent, destination,
      { id: 'r1', title: 'Chapter' }, 'First paragraph.\n\nSecond paragraph.\n'), BACKGROUND_CONTEXT);
    expect((await reopened.service.listDistributions())[0]?.intent).not.toBeNull();
    const resumed = await reopened.service.resume(retained.id);
    await reopened.harness.waitForTask(resumed.taskId as TaskId, BACKGROUND_CONTEXT);
    const result = (await reopened.service.listDistributions())[0]!;
    expect(result.status).toBe('needs-observation'); expect(result.intent).not.toBeNull();
    expect((await reopened.harness.snapshot(ProjectDoc, BACKGROUND_CONTEXT))?.distributionIds).toEqual([retained.id]);
    const inspection = await reopened.service.observe(retained.id);
    const inspectionTask = await reopened.harness.getTask(inspection.taskId as TaskId, BACKGROUND_CONTEXT);
    expect(inspectionTask?.input).toMatchObject({ mode: 'observe' });
    await reopened.harness.waitForTask(inspection.taskId as TaskId, BACKGROUND_CONTEXT);
    expect((await reopened.service.listDistributions())[0]?.intent).not.toBeNull();
    // Protocol evidence input, not a model success script or a platform acceptance claim.
    await reopened.harness.commit(async tx => applyObservation(await tx.doc(Distributions, retained.id, retained), observed('101'), destination,
      { id: 'r1', title: 'Chapter' }, 'First paragraph.\n\nSecond paragraph.\n'), BACKGROUND_CONTEXT);
    const settled = (await reopened.service.listDistributions())[0]!;
    expect(settled.intent).toBeNull(); expect(settled.status).toBe('submitted'); expect(settled.publishedRevisionId).toBeNull();
  });
  it('settles submitted without publication, and requires explicit update for a new revision', async () => {
    const { root, harness, service } = await open(); await seedWork(harness, root);
    const destination = await target(service, 'target-a', '101');
    const queued = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact' });
    await harness.abortTask(queued.taskId as TaskId, BACKGROUND_CONTEXT);
    await harness.waitForTask(queued.taskId as TaskId, BACKGROUND_CONTEXT);
    await harness.commit(async tx => applyObservation(await tx.doc(Distributions, queued.id, queued), observed('101'), destination,
      { id: 'r1', title: 'Chapter' }, 'First paragraph.\n\nSecond paragraph.\n'), BACKGROUND_CONTEXT);
    const submitted = (await service.listDistributions())[0]!;
    expect(submitted.status).toBe('submitted'); expect(submitted.publishedRevisionId).toBeNull();
    expect(decide(submitted, destination, observed('101'))).toBe('settled');
    await expect(queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact', revisionId: 'r2' })).rejects.toThrow('operation:update');
    const update = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact', revisionId: 'r2', operation: 'update' });
    expect(update.id).toBe(queued.id); expect(update.desired.operation).toBe('update');
    expect(decide(update, destination, observed('101'), { body: 'Edited body.\n', capabilities: ['publish'] })).toBe('unsupported');
    expect(decide(update, destination, observed('101'), { body: 'Edited body.\n' })).toBe('mutate');
    expect(decide(update, destination, observed('202'), { body: 'Edited body.\n' })).toBe('needs-observation');
  });
  it('allows retry only with positive notApplied evidence and keeps account mismatches unresolved', async () => {
    const { root, harness, service } = await open(); await seedWork(harness, root);
    const destination = await target(service, 'target-a', '101');
    const record = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact' });
    record.intent = { target: destination, request: record.desired, conversationId: destination.conversationId, startedAt: 1 };
    expect(decide(record, destination, observed('101', { state: 'draft' }))).toBe('needs-observation');
    const notApplied = observed('101', { state: 'draft', notApplied: true, evidence: 'Positive domain input: final action was not issued.' });
    expect(decide(record, destination, notApplied)).toBe('mutate');
    applyObservation(record, observed('202'), destination, { id: 'r1', title: 'Chapter' }, 'First paragraph.\n\nSecond paragraph.\n');
    expect(record.intent).not.toBeNull(); expect(record.remote).toEqual(emptyRemote());
    applyObservation(record, notApplied, destination, { id: 'r1', title: 'Chapter' }, 'First paragraph.\n\nSecond paragraph.\n');
    expect(record.intent).toBeNull(); expect(record.status).toBe('draft');
  });
});

describe('MegaNovel pure URL/content interpretation, not simulated site acceptance', () => {
  const read: MegaNovelReadback = { accountId: '101', authorUrl: 'https://www.meganovel.com/create_chapter/123?chapterId=456',
    title: 'Chapter', body: 'First\n\nSecond', rowPresent: true, unpublished: false, hasPublish: false,
    readerUrl: null, readerChapterId: null, readerBody: null };
  it('retains only minimal body normalization', () => {
    expect(normalizeMegaNovelBodyText('First\r\n\r\nSecond\r\n')).toBe('First\n\nSecond');
    expect(normalizeMegaNovelBodyText(' First  \nSecond')).toBe(' First  \nSecond');
    expect(normalizeMegaNovelBodyText('First\n\nSecond')).not.toBe(normalizeMegaNovelBodyText('First\nSecond'));
  });
  it('does not require a saved ID for an empty-book editor', () => {
    expect(megaNovelEditorIdentity('https://www.meganovel.com/create_chapter/123')).toEqual({ workId: '123', artifactId: null });
    expect(megaNovelEditorIdentity('https://other.invalid/create_chapter/123?chapterId=456')).toBeNull();
  });
  it('treats author-only state as submitted and requires public reader identity/body for published', () => {
    expect(interpretMegaNovelReadback(read, 'Domain input').state).toBe('submitted');
    const reader = { ...read, readerUrl: 'https://www.meganovel.com/story/book_123/chapter_456', readerChapterId: '456', readerBody: 'First\r\n\r\nSecond\n' };
    expect(interpretMegaNovelReadback(reader, 'Domain input').state).toBe('published');
    expect(interpretMegaNovelReadback({ ...reader, readerChapterId: '457' }, 'Domain input').state).toBe('submitted');
    expect(interpretMegaNovelReadback({ ...reader, readerBody: 'First\nSecond' }, 'Domain input').state).toBe('submitted');
    expect(megaNovelReaderIdentity('https://www.meganovel.com/story/book_123/chapter_456?preview=1')).toBeNull();
    expect(interpretMegaNovelReadback({ ...read, rowPresent: false }, 'Domain input').state).toBe('unknown');
  });
});

it('declares create-work separately, handling an absent work and an empty existing work without predecessor IDs', async () => {
  const { root, harness, service } = await open(); await seedWork(harness, root);
  const destination = await target(service, 'new-work', '101');
  const record = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact' });
  const absent = observed('101', { state: 'absent', remote: emptyRemote(), title: null, body: null, notApplied: true });
  expect(decide(record, destination, absent, { capabilities: ['publish', 'update'] })).toBe('unsupported');
  expect(decide(record, destination, absent, { capabilities: ['create-work', 'publish'] })).toBe('mutate');
  const emptyBook = { ...absent, remote: { ...emptyRemote(), workId: 'existing-empty-work' } };
  expect(decide(record, destination, emptyBook, { capabilities: ['publish'] })).toBe('mutate');
  expect(createPublishingExtension(root).publishers?.find(item => item.id === 'meganovel')?.capabilities).toEqual(['create-work', 'publish', 'update']);
});
it('retains login/captcha/payment user action without claiming a submitted or published revision', async () => {
  const { root, harness, service } = await open(); await seedWork(harness, root);
  const destination = await target(service, 'blocked', '101');
  const record = await queueDistribution(harness, root, { targetId: destination.id, artifactId: 'artifact' });
  const blocked = observed(null as any, { state: 'user-action', complete: false, remote: emptyRemote(), title: null, body: null, evidence: 'Login/captcha must be completed by the user.' });
  expect(decide(record, destination, blocked)).toBe('settled');
  applyObservation(record, blocked, destination, { id: 'r1', title: 'Chapter' }, 'First paragraph.\n\nSecond paragraph.\n');
  expect(record.status).toBe('user-action'); expect(record.error).toContain('Login/captcha');
  expect(record.submittedRevisionId).toBeNull(); expect(record.publishedRevisionId).toBeNull();
});
