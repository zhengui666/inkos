import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { AgentDoc, Harness, createRegistry, type ConversationId, type HarnessOptions, type JsonObject } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Artifacts, ProjectDoc, Works } from '../../works/documents.js';
import { Distributions, PublishingTargets } from '../../publishing/documents.js';
import { distributionKey } from '../../publishing/contracts.js';
import { distributionDecision } from '../../publishing/protocol.js';
import { importLegacyPublishing, migrateToDurable, type LegacyPublishingData } from '../index.js';
import { array, files, object } from '../source.js';

const roots: string[] = [], harnesses: Harness[] = [], databases: DatabaseSync[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close(context)));
  databases.splice(0).forEach(db => db.close());
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const path = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-publishing-import-')); roots.push(path); return path; }
async function put(root: string, path: string, value: unknown) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); }
async function open(root: string, extra: Partial<HarnessOptions> = {}) {
  await mkdir(join(root, '.inkos'), { recursive: true });
  const harness = await Harness.open(await openNodeSqliteStorage(join(root, '.inkos/durable.sqlite')), { models: createModels(), registry: createRegistry(), ...extra }, context);
  harnesses.push(harness); return harness;
}
async function counts(harness: Harness) { return harness.commit(async tx => ({ conversations: (await tx.scanConversations({}, 1000)).items.length, tasks: (await tx.scanTasks({}, 1000)).items.length }), context); }
async function bytes(root: string) { return new Map(await Promise.all((await files(root)).filter(path => !path.endsWith('-shm')).map(async path => [path, await readFile(path)] as const))); }
async function unchanged(before: Map<string, Buffer>) { for (const [path, content] of before) expect(await readFile(path), path).toEqual(content); }
const readDistribution = (harness: Harness, targetId: string, artifactId: string) => harness.snapshot(Distributions, distributionKey(targetId, artifactId), context);

async function legacySource(source: string) {
  const artifacts = [];
  for (let number = 1; number <= 8; number++) {
    const path = `source/chapters/${String(number).padStart(4, '0')}_Chapter.md`, id = `artifact-original-${number}`, revisionId = `revision-selected-${number}`;
    const selected = { id: revisionId, path, snapshotPath: `revisions/${id}/${revisionId}.md`, createdAt: '2024-01-01T00:00:00Z', status: number === 1 ? 'superseded' : 'current' };
    const revisions = number === 1 ? [selected, { id: 'revision-new-current', path, createdAt: '2024-02-01T00:00:00Z', status: 'current' }] : [selected];
    artifacts.push({ id, kind: 'chapter', metadata: { number }, currentRevisionId: number === 1 ? 'revision-new-current' : revisionId, revisions });
    await put(source, `works/work-original/${path}`, `Current chapter ${number}`);
    await put(source, `works/work-original/${selected.snapshotPath}`, `Selected immutable chapter ${number}`);
  }
  await put(source, 'works/work-original/work.json', { version: 2, id: 'work-original', title: 'Original Work', profileId: 'longform-novel', language: 'en', status: 'active', artifacts, lineage: [], metadata: {} });
  await put(source, 'books/v1-work/book.json', { id: 'v1-work', title: 'V1', language: 'en', status: 'paused' });
  await put(source, 'books/v1-work/chapters/0001_First.md', 'V1 chapter one'); await put(source, 'books/v1-work/chapters/0002_Second.md', 'V1 chapter two');
  await mkdir(join(source, '.inkos'), { recursive: true });
  const db = new DatabaseSync(join(source, '.inkos/harness.sqlite')); databases.push(db);
  // The baseline tables use real columns, including chapters without state_json and nested run scopes.
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE publishing_targets(id TEXT PRIMARY KEY,work_id TEXT,platform TEXT,account_label TEXT,remote_book_id TEXT,target_json TEXT);
    CREATE TABLE publishing_packages(id TEXT PRIMARY KEY,target_id TEXT,operation_key TEXT,manifest_json TEXT,version INTEGER);
    CREATE TABLE publishing_chapters(package_id TEXT,number INTEGER,status TEXT,remote_chapter_id TEXT,evidence TEXT,provenance TEXT,PRIMARY KEY(package_id,number));
    CREATE TABLE publishing_meganovel_runs(package_id TEXT,number INTEGER,account_id TEXT,remote_book_id TEXT,run_json TEXT,PRIMARY KEY(package_id,number));
    CREATE TABLE publishing_fanqie_runs(package_id TEXT,number INTEGER,account_id TEXT,remote_book_id TEXT,run_json TEXT,PRIMARY KEY(package_id,number));
    CREATE TABLE publishing_remote_work_runs(id TEXT,work_id TEXT,run_json TEXT);
    CREATE TABLE publishing_remote_work_bindings(work_id TEXT,target_id TEXT,account_id TEXT,remote_book_id TEXT,receipt_json TEXT);
    CREATE TABLE publishing_events(package_id TEXT,event_id TEXT,action_json TEXT,created_at TEXT);`);
  const target = (id: string, platform: string, workId = 'work-original', extra: JsonObject = {}) => {
    const value = { id, workId, platform, accountLabel: `${id}-label`, remoteBookId: 'same-scoped-remote-book', verification: 'user_supplied', createdAt: '2024-01-01T00:00:00Z', ...extra };
    db.prepare('INSERT INTO publishing_targets VALUES(?,?,?,?,?,?)').run(id, workId, platform, value.accountLabel, value.remoteBookId, JSON.stringify(value)); return value;
  };
  const mega = target('mega-original', 'meganovel', 'work-original', { config: { entryUrl: 'https://www.meganovel.com/author', browser: { userDataDir: 'browser-original' }, skill: 'Retained publishing directions', metadata: { custom: 'keep' } } });
  const fanqie = target('fanqie-original', 'fanqie'); const manual = target('manual-original', 'meganovel');
  const creator = target('creation-original-target', 'fanqie'); const conflicting = target('conflicting-original', 'meganovel');
  const v1 = target('v1-original-target', 'meganovel', 'v1-work', { observedAccountId: 'v1-actual-account', verification: 'independently_observed', creationOperationId: 'v1-creation-original' });
  target('missing-work-original', 'fanqie', 'work-missing');
  const selected = (number: number) => ({ number, artifactId: `artifact-original-${number}`, revisionId: `revision-selected-${number}`, title: `Chapter ${number}`, sourcePath: `source/chapters/${String(number).padStart(4, '0')}_Chapter.md` });
  const pack = (id: string, destination: JsonObject, chapters: JsonObject[]) => {
    const manifest = { id, version: 1, adapter: 'manual', target: destination, chapters, createdAt: '2024-01-02T00:00:00Z', operationKey: `operation-${id}`, remoteVerified: false };
    db.prepare('INSERT INTO publishing_packages VALUES(?,?,?,?,0)').run(id, String(destination.id), `operation-${id}`, JSON.stringify(manifest)); return id;
  };
  const megaPack = pack('package-mega-original', mega, Array.from({ length: 8 }, (_, index) => selected(index + 1)));
  const fanqiePack = pack('package-fanqie-original', fanqie, [1, 2, 3, 4].map(selected));
  const manualPack = pack('package-manual-original', manual, [selected(6), { number: 999, artifactId: 'missing-original', revisionId: 'missing-revision', title: 'No match' }]);
  const v1Pack = pack('package-v1-original', v1, [
    { number: 1, artifactId: 'v1-old-original-id', revisionId: 'v1-old-selected-revision', sourcePath: 'books/v1-work/chapters/0001_First.md', title: 'First' },
    { number: 2, artifactId: 'v1-second-old-id', revisionId: 'v1-second-old-revision', title: 'Second' },
  ]);
  for (const [id, numbers] of [[megaPack, [1, 2, 3, 4, 5, 6, 7, 8]], [fanqiePack, [1, 2, 3, 4]], [manualPack, [6, 999]], [v1Pack, [1, 2]]] as const) {
    for (const number of numbers) db.prepare('INSERT INTO publishing_chapters VALUES(?,?,?,?,?,?)').run(id, number,
      id === megaPack && number !== 6 || id === fanqiePack ? 'awaiting_receipt' : 'published_reported',
      id === manualPack || id === v1Pack || number === 6 ? `reported-remote-${number}` : null, 'Retained manual evidence', id === manualPack || id === v1Pack || number === 6 ? 'user_reported' : null);
  }
  const run = (table: string, id: string, number: number, phase: string, accountId: string, extra: JsonObject = {}) => {
    const value = { packageId: id, chapterNumber: number, scope: { sessionId: 'old-session-not-resumable', accountId, accountLabel: 'not-account-identity', remoteBookId: 'same-scoped-remote-book' },
      aiAssisted: true, revisionId: `revision-selected-${number}`, phase, remoteChapterId: `remote-${accountId}-${number}`, evidence: phase.endsWith('_unknown') ? null : `Independently reopened ${phase} UI`, ...extra };
    db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?)`).run(id, number, accountId, 'same-scoped-remote-book', JSON.stringify(value));
  };
  for (const [number, phase] of [[1, 'submitted'], [2, 'reviewing'], [3, 'published'], [4, 'draft_unknown'], [5, 'submit_unknown'], [7, 'rejected'], [8, 'draft']] as const) run('publishing_meganovel_runs', megaPack, number, phase, 'actual-account-A');
  run('publishing_fanqie_runs', fanqiePack, 1, 'draft_unknown', 'actual-account-B'); run('publishing_fanqie_runs', fanqiePack, 2, 'schedule_unknown', 'actual-account-B');
  // A retained manual ID is only a hint when the current unknown run has not confirmed its identity.
  const unknown = JSON.parse(String(db.prepare('SELECT run_json FROM publishing_meganovel_runs WHERE package_id=? AND number=5').get(megaPack)!.run_json));
  unknown.remoteChapterId = null;
  db.prepare('UPDATE publishing_meganovel_runs SET run_json=? WHERE package_id=? AND number=5').run(JSON.stringify(unknown), megaPack);
  db.prepare('UPDATE publishing_chapters SET remote_chapter_id=?,provenance=? WHERE package_id=? AND number=5').run('retained-remote-chapter-original', 'user_reported', megaPack);
  run('publishing_fanqie_runs', fanqiePack, 3, 'scheduled', 'actual-account-B', { scheduledFor: '2024-06-01T12:00:00Z' }); run('publishing_fanqie_runs', fanqiePack, 4, 'reviewing', 'actual-account-B');
  db.prepare('INSERT INTO publishing_remote_work_runs VALUES(?,?,?)').run('remote-create-original', 'work-original', JSON.stringify({ id: 'remote-create-original', targetId: creator.id, phase: 'create_unknown', input: { workId: 'work-original', destination: { accountId: 'actual-creator-account', accountLabel: 'creator-label', platform: 'fanqie' } }, attempts: 1, unverifiedRemoteBookId: 'unverified-remote-original', receipt: null, attemptedAt: 1700000000000 }));
  for (const accountId of ['conflicting-account-A', 'conflicting-account-B']) db.prepare('INSERT INTO publishing_remote_work_bindings VALUES(?,?,?,?,?)').run('work-original', conflicting.id, accountId, 'same-scoped-remote-book', JSON.stringify({ provenance: 'user_reported', evidence: 'Retained account conflict' }));
  db.prepare('INSERT INTO publishing_events VALUES(?,?,?,?)').run(megaPack, 'event-original', JSON.stringify({ id: 'event-original', action: 'observed', number: 2, custom: 'keep' }), '2024-01-03T00:00:00Z');
  return { db, expectedTargetIds: [mega.id, fanqie.id, manual.id, creator.id, conflicting.id, v1.id] };
}

it('converts real legacy tables into active native targets/distributions with exact historical identities, distinct observed states and retained uncertainty', async () => {
  const source = await root(), target = await root(), fixture = await legacySource(source), harness = await open(target), before = await bytes(source);
  await harness.commit(async tx => { (await tx.doc(ProjectDoc)).model = { provider: 'offline-unused-provider', modelId: 'offline-unused-model' }; }, context);
  const preview = await migrateToDurable(harness, target, { source, importPublishing: data => importLegacyPublishing(harness, data) });
  expect(preview.apply).toBe(false); expect((await harness.snapshot(ProjectDoc, context))?.targetIds).toEqual([]);
  const report = await migrateToDurable(harness, target, { source, apply: true, importPublishing: data => importLegacyPublishing(harness, data) });
  expect(report.publishingImport).toBe('imported'); expect(report.publishingError).toBeNull();
  const project = (await harness.snapshot(ProjectDoc, context))!; expect([...project.targetIds].sort()).toEqual(fixture.expectedTargetIds.sort());
  const mega = (await harness.snapshot(PublishingTargets, 'mega-original', context))!, fanqie = (await harness.snapshot(PublishingTargets, 'fanqie-original', context))!;
  expect(mega).toMatchObject({ workId: 'work-original', platform: 'meganovel', enabled: true, config: { accountId: 'actual-account-A', entryUrl: 'https://www.meganovel.com/author', remote: { workId: 'same-scoped-remote-book' }, browser: { userDataDir: 'browser-original' }, skill: 'Retained publishing directions', metadata: { custom: 'keep' } } });
  expect(fanqie.config.accountId).toBe('actual-account-B'); expect(fanqie.config.remote.workId).toBe(mega.config.remote.workId);
  expect((await harness.snapshot(AgentDoc, mega.conversationId as ConversationId, context))?.model).toEqual(project.model);
  const submitted = (await readDistribution(harness, mega.id, 'artifact-original-1'))!;
  expect(submitted).toMatchObject({ workId: 'work-original', status: 'submitted', desired: { revisionId: 'revision-selected-1' }, submittedRevisionId: 'revision-selected-1', publishedRevisionId: null, observedRevisionId: 'revision-selected-1', remote: { workId: 'same-scoped-remote-book', artifactId: 'remote-actual-account-A-1' }, taskId: null, intent: null });
  expect((await harness.snapshot(Artifacts, 'artifact-original-1', context))?.currentRevision).toBe('revision-new-current');
  for (const [number, status] of [[2, 'reviewing'], [3, 'published'], [7, 'rejected'], [8, 'draft']] as const) expect((await readDistribution(harness, mega.id, `artifact-original-${number}`))?.status).toBe(status);
  expect((await readDistribution(harness, mega.id, 'artifact-original-3'))?.publishedRevisionId).toBe('revision-selected-3');
  expect(submitted.lastObservation).toMatchObject({ complete: false, body: null, evidence: 'Independently reopened submitted UI' });
  for (const [id, numbers] of [[mega.id, [4, 5, 6]], [fanqie.id, [1, 2]]] as const) for (const number of numbers) {
    const value = (await readDistribution(harness, id, `artifact-original-${number}`))!;
    expect(value).toMatchObject({ status: 'needs-observation', taskId: null, observedRevisionId: null, submittedRevisionId: null, publishedRevisionId: null, lastObservation: null, intent: { conversationId: id === mega.id ? mega.conversationId : fanqie.conversationId } });
    expect(value.remote.artifactId).not.toBeNull();
  }
  const uncertain = (await readDistribution(harness, mega.id, 'artifact-original-5'))!;
  expect(uncertain.remote.artifactId).toBe('retained-remote-chapter-original');
  expect(mega.config.remote.artifactIds['artifact-original-5']).toBe('retained-remote-chapter-original');
  expect(distributionDecision({ distribution: uncertain, target: mega, request: uncertain.desired, title: 'Chapter 5', body: 'Retained body', capabilities: ['publish'], observeOnly: false,
    observation: { state: 'draft', accountId: mega.config.accountId, remote: { ...uncertain.remote, authorUrl: 'https://www.meganovel.com/author/chapter' }, complete: true, notApplied: false, title: 'Chapter 5', body: 'Retained body', evidence: 'Still a draft is not nonapplication evidence', observedAt: 1 } })).toBe('needs-observation');
  expect((await readDistribution(harness, fanqie.id, 'artifact-original-3'))?.desired.scheduledAt).toBe(Date.parse('2024-06-01T12:00:00Z'));
  const manual = (await harness.snapshot(PublishingTargets, 'manual-original', context))!;
  expect(manual.enabled).toBe(false); expect(manual.config.accountId).toBe(''); expect(array(object(manual.config.metadata.legacy).issues).join(' ')).toContain('Missing actual account ID');
  expect((await readDistribution(harness, manual.id, 'artifact-original-6'))?.status).toBe('needs-observation');
  const conflicting = (await harness.snapshot(PublishingTargets, 'conflicting-original', context))!;
  expect(conflicting.enabled).toBe(false); expect(conflicting.config.accountId).toBe(''); expect(object(conflicting.config.metadata.legacy).actualAccountIds).toEqual(['conflicting-account-A', 'conflicting-account-B']);
  const creator = (await harness.snapshot(PublishingTargets, 'creation-original-target', context))!;
  expect(creator.enabled).toBe(false); expect(creator.config.accountId).toBe('actual-creator-account'); expect(object(creator.config.metadata.legacy).unverifiedRemoteWorkIds).toEqual(['unverified-remote-original']);
  expect(await harness.snapshot(PublishingTargets, 'missing-work-original', context)).toBeUndefined();
  const v1Mappings = report.publishing.artifactMappings.filter(mapping => mapping.workId === 'v1-work');
  for (const [number, basis] of [[1, 'source-path'], [2, 'chapter-number']] as const) {
    const mapping = v1Mappings.find(mapping => mapping.sourcePath.includes(`/000${number}_`))!;
    const value = (await readDistribution(harness, 'v1-original-target', mapping.artifactId))!;
    expect(value.desired.revisionId).toBe(mapping.revisionId); expect(value.status).toBe('needs-observation');
    const v1 = (await harness.snapshot(PublishingTargets, 'v1-original-target', context))!;
    expect(array(object(object(object(v1.config.metadata.legacy).distributions)[value.id]).sources)[0]).toMatchObject({ mapping: basis });
  }
  expect(array(object(manual.config.metadata.legacy).unresolved)).toHaveLength(1);
  expect(array(object(project.migrations[`${report.migrationKey}:publishing-documents-v1`]).unresolved).length).toBeGreaterThan(0);
  expect((await harness.snapshot(Works, 'work-original', context))?.targetIds).toEqual(expect.arrayContaining(['mega-original', 'fanqie-original']));
  const beforeRepeat = await counts(harness); expect(beforeRepeat).toEqual({ conversations: report.history.length + fixture.expectedTargetIds.length, tasks: 0 });
  await importLegacyPublishing(harness, report.publishing);
  await Promise.all([importLegacyPublishing(harness, report.publishing), importLegacyPublishing(harness, report.publishing)]);
  await migrateToDurable(harness, target, { source, apply: true, importPublishing: data => importLegacyPublishing(harness, data) });
  expect(await counts(harness)).toEqual(beforeRepeat); expect((await harness.snapshot(ProjectDoc, context))?.distributionIds).toHaveLength(15);
  for (const id of project.targetIds) {
    const destination = (await harness.snapshot(PublishingTargets, id, context))!;
    const conversation = await harness.commit(async tx => ({ record: await tx.conversation(destination.conversationId as ConversationId), entries: (await tx.scanEntries({ conversationId: destination.conversationId as ConversationId }, 10)).items }), context);
    expect(conversation.record?.owner).toBeUndefined(); expect(conversation.entries).toEqual([]);
  }
  await unchanged(before);
});

it('rolls back active publishing documents and native conversations when the callback commit fails, then imports once on migration recovery', async () => {
  const source = await root(), target = await root(); await legacySource(source);
  let failImport = false;
  const harness = await open(target, { conversationCreated: () => { if (failImport) throw new Error('Interrupted native target creation'); } });
  const before = await bytes(source);
  const report = await migrateToDurable(harness, target, { source, apply: true, importPublishing: async data => { failImport = true; try { await importLegacyPublishing(harness, data); } finally { failImport = false; } } });
  expect(report.publishingImport).toBe('failed'); expect(report.publishingError).toContain('Interrupted native target creation');
  expect((await harness.snapshot(ProjectDoc, context))?.targetIds).toEqual([]); expect(await harness.snapshot(PublishingTargets, 'mega-original', context)).toBeUndefined();
  expect((await harness.snapshot(ProjectDoc, context))?.migrations[`${report.migrationKey}:publishing-documents-v1`]).toBeUndefined();
  const initial = await counts(harness); expect(initial).toEqual({ conversations: report.history.length, tasks: 0 });
  const retry = await migrateToDurable(harness, target, { source, apply: true, importPublishing: data => importLegacyPublishing(harness, data) });
  expect(retry.publishingImport).toBe('imported'); expect(retry.imported).toEqual([]); expect(retry.history).toEqual(report.history);
  expect(await counts(harness)).toEqual({ conversations: initial.conversations + 6, tasks: 0 }); await unchanged(before);
});

it('acknowledges a completed importer after callback interruption or SQLite reopen without duplicating conversations or resetting active records', async () => {
  const source = await root(), target = await root(); await legacySource(source); const harness = await open(target);
  const report = await migrateToDurable(harness, target, { source, apply: true, importPublishing: async data => { await importLegacyPublishing(harness, data); throw new Error('Callback acknowledgement interrupted'); } });
  expect(report.publishingImport).toBe('failed'); const before = await counts(harness);
  const targetDoc = (await harness.snapshot(PublishingTargets, 'mega-original', context))!;
  await harness.commit(async tx => { (await tx.doc(PublishingTargets, targetDoc.id, targetDoc)).label = 'New native author label'; }, context);
  await harness.close(context); harnesses.splice(harnesses.indexOf(harness), 1); const reopened = await open(target);
  const retry = await migrateToDurable(reopened, target, { source, apply: true, importPublishing: data => importLegacyPublishing(reopened, data) });
  expect(retry.publishingImport).toBe('imported'); expect(await counts(reopened)).toEqual(before);
  expect((await reopened.snapshot(PublishingTargets, 'mega-original', context))?.label).toBe('New native author label');
});

it('serializes concurrent first imports by the same atomic version marker and preserves the package revision when a run names another revision', async () => {
  const source = await root(), target = await root(), fixture = await legacySource(source), harness = await open(target);
  const row = fixture.db.prepare('SELECT run_json FROM publishing_meganovel_runs WHERE package_id=? AND number=1').get('package-mega-original')!;
  const run = JSON.parse(String(row.run_json)); run.revisionId = 'revision-new-current';
  fixture.db.prepare('UPDATE publishing_meganovel_runs SET run_json=? WHERE package_id=? AND number=1').run(JSON.stringify(run), 'package-mega-original');
  const before = await bytes(source);
  const report = await migrateToDurable(harness, target, { source, apply: true, importPublishing: async data => {
    await Promise.all([importLegacyPublishing(harness, data), importLegacyPublishing(harness, data)]);
  } });
  expect(report.publishingImport).toBe('imported');
  const value = (await readDistribution(harness, 'mega-original', 'artifact-original-1'))!;
  expect(value).toMatchObject({ desired: { revisionId: 'revision-selected-1' }, status: 'needs-observation', lastObservation: null, submittedRevisionId: null, publishedRevisionId: null, taskId: null, intent: { request: { revisionId: 'revision-selected-1' } } });
  const project = (await harness.snapshot(ProjectDoc, context))!;
  expect(new Set(project.targetIds).size).toBe(6); expect(project.targetIds).toHaveLength(6);
  expect(new Set(project.distributionIds).size).toBe(15); expect(project.distributionIds).toHaveLength(15);
  expect(await counts(harness)).toEqual({ conversations: report.history.length + 6, tasks: 0 }); await unchanged(before);
});
