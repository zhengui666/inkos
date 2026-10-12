import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { Harness, createRegistry, ROOT_CONVERSATION_ID, type ConversationId, type HarnessOptions } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Artifacts, ProjectDoc, Works } from '../../works/documents.js';
import { WorksService } from '../../works/service.js';
import { LegacyArchive, LegacyMaterials, LegacyProgress, LegacyPublishing, legacyProgressKey, migrateToDurable, type LegacyPublishingData } from '../index.js';
import { files, object, array } from '../source.js';

import { RuntimeHost } from '../../runtime/host.js';
const roots: string[] = [], harnesses: Harness[] = [], databases: DatabaseSync[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.close(context)));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const path = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-durable-migration-')); roots.push(path); return path; }
async function put(root: string, path: string, value: unknown) {
  const target = join(root, path); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value));
}
async function open(root: string, extra: Partial<HarnessOptions> = {}) {
  await mkdir(join(root, '.inkos'), { recursive: true });
  const harness = await Harness.open(await openNodeSqliteStorage(join(root, '.inkos', 'durable.sqlite')), { models: createModels(), registry: createRegistry(), ...extra }, context);
  harnesses.push(harness); return harness;
}
async function legacyDb(root: string, schema: string, name = '.inkos/harness.sqlite') {
  await mkdir(dirname(join(root, name)), { recursive: true });
  const db = new DatabaseSync(join(root, name)); databases.push(db); db.exec(schema); return db;
}
async function sourceBytes(root: string) {
  return new Map(await Promise.all((await files(root)).filter(path => !path.endsWith('-shm')).map(async path => [path, await readFile(path)] as const)));
}
async function unchanged(before: Map<string, Buffer>) { for (const [path, bytes] of before) expect(await readFile(path), path).toEqual(bytes); }
async function taskCount(harness: Harness) { return harness.commit(async tx => (await tx.scanTasks({}, 1000)).items.length, context); }
async function book(root: string, id: string, status = 'active') { await put(root, `books/${id}/book.json`, { id, title: id, status, language: 'en', targetChapters: 12, unusual: { keep: true } }); }
const v2 = (id = 'novel') => ({ version: 2, id, title: 'Novel', profileId: 'longform-novel', language: 'fr-CA', status: 'active',
  lineage: [{ relation: 'derived-from', sourceWorkId: 'parent', sourceArtifactId: 'parent-artifact', sourceRevisionId: 'parent-revision' }],
  metadata: { genre: 'mystery', specialist: { keep: true } }, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-02-01T00:00:00Z',
  artifacts: [{ id: 'chapter-original', kind: 'chapter', currentRevisionId: 'rev-current', metadata: { number: 1, lineageNote: 'keep' }, revisions: [
    { id: 'rev-snapshot', path: 'source/chapters/0001_One.md', snapshotPath: 'revisions/chapter-original/rev-snapshot.md', contentBase64: Buffer.from('not snapshot').toString('base64'), status: 'superseded', parentRevisionId: null, createdAt: '2024-01-01T00:00:00Z', professionalField: 'keep' },
    { id: 'rev-base64', path: 'source/chapters/0001_One.md', contentBase64: Buffer.from('base64 historical bytes').toString('base64'), status: 'superseded', parentRevisionId: 'rev-snapshot' },
    { id: 'rev-current', path: 'source/chapters/0001_One.md', status: 'current', parentRevisionId: 'rev-base64' },
  ] }] });

it('previews without writes; preserves v2 IDs, exact historical/hidden versions, intent, reader contract, materials and binary attachments', async () => {
  const source = await root(), harness = await open(source);
  await put(source, 'inkos.json', { language: 'fr-CA', customConfig: { keep: true } });
  await put(source, 'works/novel/work.json', v2());
  await put(source, 'works/novel/revisions/chapter-original/rev-snapshot.md', 'snapshot historical bytes');
  await put(source, 'works/novel/source/chapters/0001_One.md', 'current chapter bytes');
  await put(source, 'works/novel/source/chapters/.versions/0001/1700000000000_manual_original.md', 'hidden original chapter');
  await put(source, 'works/novel/source/story/.backup-foundation-1/author_intent.md', 'hidden author intent');
  await put(source, 'works/novel/source/book.json', { id: 'novel', title: 'Auteur', language: 'fr-CA', status: 'paused' });
  const contract = { promises: ['No false ending'], forbidden: ['amnesia'] };
  await put(source, 'works/novel/source/story/book_rules.json', { version: '2', readerContract: contract, unknownRule: 'keep' });
  await put(source, 'works/novel/source/story/author_intent.md', 'Author decides the ending.');
  await put(source, 'works/novel/source/story/current_focus.md', 'Focus on the witness.');
  await put(source, 'works/novel/source/story/outline/story_frame.md', 'Outline.');
  for (const [name, value] of Object.entries({ manifest: { lastAppliedChapter: 1 }, current_state: { facts: [{ subject: 'Ada', sourceChapter: 1 }] }, hooks: { hooks: [{ hookId: 'promise', dependsOn: ['old-hook'] }] }, chapter_summaries: { rows: [{ chapter: 1, events: 'Arrived' }] } })) await put(source, `works/novel/source/story/state/${name}.json`, value);
  const binding = { materialId: 'reference-original', uses: ['worldbuilding'], note: 'Keep the citation', createdAt: 'old' };
  await put(source, 'works/novel/source/story/reference_bindings.json', { version: 1, bookId: 'novel', bindings: [binding] });
  await put(source, '.inkos/materials/reference-original.json', { id: 'reference-original', title: 'Reference', markdownPath: '.inkos/materials/reference-original.md', manifestPath: '.inkos/materials/reference-original.json', source: 'local', purpose: 'worldbuilding', kind: 'text', mimeType: 'text/markdown', charCount: 13 });
  await put(source, '.inkos/materials/reference-original.md', 'Reference text');
  const image = Buffer.from([137, 80, 78, 71, 0, 255, 0, 128]); await put(source, 'works/novel/source/assets/cover.png', image);
  const before = await sourceBytes(source), preview = await migrateToDurable(harness, source);
  expect(preview.status).toBe('preview'); expect(preview.imported.map(item => item.workId)).toEqual(['novel']); expect(preview.conflicts).toEqual([]);
  expect(await harness.snapshot(ProjectDoc, context)).toBeUndefined();
  await expect(stat(join(source, '.inkos/artifacts'))).rejects.toMatchObject({ code: 'ENOENT' });
  // Durable SQLite can change when we apply, but no legacy file may change.
  before.delete(join(source, '.inkos/durable.sqlite')); before.delete(join(source, '.inkos/durable.sqlite-wal'));
  const report = await migrateToDurable(harness, source, { apply: true }); expect(report.status).toBe('applied');
  const service = new WorksService(harness, source), work = await service.get('novel');
  expect(work).toMatchObject({ id: 'novel', title: 'Auteur', profile: 'fiction', locale: 'fr-CA', status: 'paused', pauseRequested: true, materialIds: ['reference-original'] });
  expect(work.domain.readerContract).toEqual(contract); expect(work.domain.referenceBindings).toMatchObject({ bindings: [binding] });
  expect(work.domain).toMatchObject({ manifest: { lastAppliedChapter: 1 }, hooks: { hooks: [{ hookId: 'promise', dependsOn: ['old-hook'] }] } });
  expect(work.legacy.lineage).toEqual(v2().lineage);
  expect((await service.read('chapter-original', 'rev-snapshot')).content).toBe('snapshot historical bytes');
  expect((await service.read('chapter-original', 'rev-base64')).content).toBe('base64 historical bytes');
  expect((await service.read('chapter-original')).content).toBe('current chapter bytes');
  const artifact = await service.artifact('chapter-original'); expect(artifact.currentRevision).toBe('rev-current'); expect(artifact.revisions.map(revision => revision.id)).toEqual(['rev-snapshot', 'rev-base64', 'rev-current']);
  expect(artifact.revisions[0].metadata).toMatchObject({ legacy: { professionalField: 'keep', parentRevisionId: null }, lineageNote: 'keep' });
  const refs = object(work.domain.files);
  const hidden = object(refs['works/novel/source/chapters/.versions/0001/1700000000000_manual_original.md']);
  expect((await service.read(String(hidden.artifactId))).content).toBe('hidden original chapter');
  expect(await readFile(join(source, String(object(refs['works/novel/source/assets/cover.png']).path)))).toEqual(image);
  expect((await service.read(String(object(work.domain.authorIntent).artifactId))).content).toBe('Author decides the ending.');
  expect((await harness.snapshot(LegacyMaterials, 'reference-original', context))?.markdownPath).toBe('.inkos/materials/reference-original.md');
  await harness.close(context); harnesses.splice(harnesses.indexOf(harness), 1);
  const reopened = await open(source);
  const again = await migrateToDurable(reopened, source, { apply: true }); expect(again.imported).toEqual([]); expect(again.skipped).toHaveLength(1);
  expect((await harnesses.at(-1)!.snapshot(ProjectDoc, context))?.workIds).toEqual(['novel']); expect(await taskCount(reopened)).toBe(0);
  expect((await new WorksService(reopened, source).read('chapter-original', 'rev-base64')).content).toBe('base64 historical bytes');
  await unchanged(before);
});

it('imports all seven v1 profiles, YAML readerContract, translation paragraphs/glossary and real play tables into domain, copying only destination material files', async () => {
  const source = await root(), target = await root(), harness = await open(target);
  await book(source, 'old');
  await put(source, 'books/old/story/book_rules.md', '---\nversion: 1\nreaderContract:\n  promise: Keep the protagonist\n---\nAuthor notes.');
  await put(source, 'books/old/story/reference_bindings.json', { bindings: [{ materialId: 'm1', uses: ['voice'], note: 'Do not lose' }] });
  await put(source, 'books/old/chapters/.versions/0001/old.md', 'Old hidden text');
  await put(source, 'shorts/short/outline/v001.md', 'Outline'); await put(source, 'shorts/short/final/full.md', 'Complete short');
  await put(source, 'dramas/script/script-spec.md', 'Script spec'); await put(source, 'dramas/script/script.json', { scenes: [{ id: 'scene-original', characters: ['speaker-original'] }] });
  await put(source, 'storyboards/board/storyboard-spec.md', 'Storyboard spec'); await put(source, 'storyboards/board/storyboard.json', { panels: [{ id: 'panel-original', shotId: 'shot-original' }] });
  const graph = { nodes: [{ id: 'node-original', choices: [{ id: 'choice-original', target: 'node-end', condition: 'has-key' }] }], characters: [{ id: 'character-original' }], variables: { key: false } };
  await put(source, 'interactive-films/film/story-graph.json', graph); await put(source, 'worlds/world/world.json', { id: 'world', title: 'World', mode: 'open' });
  const play = await legacyDb(source, 'CREATE TABLE entities(id TEXT PRIMARY KEY,data_json TEXT); CREATE TABLE edges(id TEXT,data_json TEXT); CREATE TABLE state_slots(id TEXT,value_json TEXT); CREATE TABLE events(seq INTEGER,payload_json TEXT);', 'worlds/world/runs/run-original/play.db');
  play.prepare('INSERT INTO entities VALUES(?,?)').run('entity-original', JSON.stringify({ name: 'Ada', professional: 'keep' }));
  play.prepare('INSERT INTO edges VALUES(?,?)').run('edge-original', JSON.stringify({ from: 'entity-original', to: 'other' }));
  play.prepare('INSERT INTO state_slots VALUES(?,?)').run('slot-original', JSON.stringify({ score: 1 })); play.prepare('INSERT INTO events VALUES(?,?)').run(1, JSON.stringify({ eventId: 'event-original' }));
  const translation = { id: 'translated', title: '译稿', sourceLanguage: 'ja', targetLanguage: 'de-DE', source: { kind: 'markdown', path: 'original.md' }, chapters: [{ number: 1, sourcePath: 'source/chapter-0001.json', translatedPath: 'translated/chapter-0001.json', reviewSummary: 'Keep review' }] };
  await put(source, 'translations/translated/manifest.json', translation);
  const paragraphs = { segments: [{ index: 0, source: '原文', target: 'Übersetzung', notes: 'specialist note' }] };
  await put(source, 'translations/translated/source/chapter-0001.json', { segments: [{ index: 0, source: '原文' }] }); await put(source, 'translations/translated/translated/chapter-0001.json', paragraphs);
  await put(source, 'translations/translated/glossary.json', { terms: [{ source: '鍵', target: 'Schlüssel', note: 'keep' }] });
  await put(source, '.inkos/materials/m1.json', { id: 'm1', title: 'Material', markdownPath: '.inkos/materials/m1.md', manifestPath: '.inkos/materials/m1.json', source: 'local' }); await put(source, '.inkos/materials/m1.md', 'Material bytes');
  const before = await sourceBytes(source), report = await migrateToDurable(harness, target, { source, apply: true });
  expect(report.conflicts).toEqual([]); expect(report.imported).toHaveLength(7);
  const service = new WorksService(harness, target), works = await service.list(); expect(works.map(work => work.profile).sort()).toEqual(['fiction', 'interactive-film', 'play', 'script', 'short-fiction', 'storyboard', 'translation'].sort());
  expect((await service.get('old')).domain.readerContract).toEqual({ promise: 'Keep the protagonist' }); expect((await service.get('film')).domain.graph).toEqual(graph);
  expect((await service.get('script')).domain.script).toMatchObject({ scenes: [{ id: 'scene-original' }] });
  const run = object(object(object((await service.get('world')).domain.play).runs)['run-original']);
  expect(array(run.entities)[0]).toMatchObject({ id: 'entity-original', decoded: { data_json: { professional: 'keep' } } }); expect(array(run.stateSlots)[0]).toMatchObject({ id: 'slot-original' });
  const translated = object((await service.get('translated')).domain.translation);
  expect(translated).toMatchObject({ sourceLanguage: 'ja', targetLanguage: 'de-DE', glossary: { terms: [{ source: '鍵', target: 'Schlüssel', note: 'keep' }] } });
  const translatedRef = object(array(translated.target)[0]); expect(JSON.parse((await service.read(String(translatedRef.artifactId))).content)).toEqual(paragraphs);
  expect(await readFile(join(target, '.inkos/materials/m1.md'), 'utf8')).toBe('Material bytes'); await unchanged(before);
});

it('retains control intent priority and business step receipts without claiming that old model sessions can resume', async () => {
  const source = await root(), target = await root(), harness = await open(target);
  for (const [id, status] of [['book-paused', 'paused'], ['book-completed', 'completed'], ['book-dropped', 'dropped'], ['creation-paused', 'active'], ['goal-paused', 'active'], ['goal-cancelled', 'active'], ['goal-completed', 'active'], ['scheduler-stopped', 'active']]) await book(source, id, status);
  const db = await legacyDb(source, 'PRAGMA journal_mode=WAL; CREATE TABLE creation_tasks(id TEXT PRIMARY KEY,work_id TEXT,data_json TEXT); CREATE TABLE goals(id TEXT PRIMARY KEY,work_id TEXT,data_json TEXT); CREATE TABLE goal_steps(goal_id TEXT,id TEXT,operation_key TEXT,data_json TEXT); CREATE TABLE scheduler_control(id INTEGER,stop_requested INTEGER); CREATE TABLE scheduler_chapters(work_id TEXT,chapter INTEGER,data_json TEXT); CREATE TABLE creative_episodes(episode_id TEXT,work_id TEXT,status TEXT); CREATE TABLE creative_episode_events(episode_id TEXT,seq INTEGER,payload_json TEXT); CREATE TABLE mysterious_history(id INTEGER,extra_json TEXT,blob BLOB);');
  db.prepare('INSERT INTO creation_tasks VALUES(?,?,?)').run('creation-original', 'creation-paused', JSON.stringify({ desiredState: 'paused', phase: 'writing', request: { id: 'request-original', kind: 'original', brief: 'Preserve ending' }, plan: { targetChapters: 3 }, foundationAttempts: 2 }));
  for (const [workId, desiredState, status] of [['goal-paused', 'paused', 'running'], ['goal-cancelled', 'cancelled', 'running'], ['goal-completed', 'run', 'completed'], ['book-completed', 'paused', 'running']]) db.prepare('INSERT INTO goals VALUES(?,?,?)').run(`goal-${workId}`, workId, JSON.stringify({ desiredState, status, attempts: 4 }));
  const receipt = { artifacts: [{ artifactId: 'original-output', revisionId: 'original-revision' }], evidence: { kept: true } };
  db.prepare('INSERT INTO goal_steps VALUES(?,?,?,?)').run('goal-goal-paused', 'saved-step', 'operation-saved', JSON.stringify({ id: 'saved-step', status: 'completed', kind: 'write', receipt, attempts: 2 }));
  db.prepare('INSERT INTO goal_steps VALUES(?,?,?,?)').run('goal-goal-paused', 'unfinished-step', 'operation-unfinished', JSON.stringify({ id: 'unfinished-step', status: 'pending', kind: 'review', revisionId: 'original-revision', baselineState: { chapter: 1 } }));
  db.prepare('INSERT INTO scheduler_control VALUES(1,1)').run(); db.prepare('INSERT INTO scheduler_chapters VALUES(?,?,?)').run('scheduler-stopped', 2, JSON.stringify({ goalId: 'schedule-original', phase: 'reviewing', writingCompleted: true, revisionId: 'original-revision', reviewAttempts: 3 }));
  db.prepare('INSERT INTO creative_episodes VALUES(?,?,?)').run('episode-original', 'goal-paused', 'running'); db.prepare('INSERT INTO creative_episode_events VALUES(?,?,?)').run('episode-original', 1, JSON.stringify({ modelCallId: 'old-model-call', message: { role: 'assistant', content: 'Old answer' }, custom: 'keep' }));
  db.prepare('INSERT INTO mysterious_history VALUES(?,?,?)').run(9007199254740993n, JSON.stringify({ unknown: 'keep' }), Buffer.from([0, 255]));
  await put(source, '.inkos/sessions/session-original.jsonl', JSON.stringify({ seq: 1, uuid: 'uuid-original', parentUuid: null, requestId: 'request-original', type: 'request_committed', message: { role: 'user', content: 'Old question' }, visibility: 'ui', piTurnIndex: 2 }) + '\n' + '{invalid legacy line}\n');
  await put(source, '.inkos/session.json', { activeBook: 'goal-paused', messages: [{ role: 'assistant', content: 'Old TUI answer' }], pendingProposedAction: { id: 'pending-original' } });
  const before = await sourceBytes(source), report = await migrateToDurable(harness, target, { source, apply: true }), service = new WorksService(harness, target);
  for (const [id, expected] of Object.entries({ 'book-paused': 'paused', 'book-completed': 'completed', 'book-dropped': 'cancelled', 'creation-paused': 'paused', 'goal-paused': 'paused', 'goal-cancelled': 'cancelled', 'goal-completed': 'completed', 'scheduler-stopped': 'paused' })) expect((await service.get(id)).status, id).toBe(expected);
  const progress = await harness.snapshot(LegacyProgress, legacyProgressKey(report.migrationKey, 'goal-paused'), context);
  expect(progress?.resume).toMatchObject({ status: 'paused', taskId: null }); expect(progress?.unfinished.some(step => step.id === 'saved-step')).toBe(false);
  expect(progress?.records.find(row => row.row.id === 'saved-step')?.decoded.data_json).toMatchObject({ receipt, attempts: 2 });
  expect(progress?.unfinished.find(step => step.id === 'unfinished-step')).toMatchObject({ operationKey: 'operation-unfinished', nextTask: 'inkos.content' });
  expect(progress?.unfinished.filter(step => step.id === 'unfinished-step')).toHaveLength(1);
  expect((await service.get('creation-paused')).legacy).toMatchObject({ effectiveDeliveryMode: 'publish', request: { id: 'request-original' } });
  expect((await service.get('goal-paused')).history.length).toBeGreaterThan(0); expect(await taskCount(harness)).toBe(0);
  for (const item of report.history) {
    const stored = await harness.commit(async tx => ({ entries: (await tx.scanEntries({ conversationId: item.conversationId as ConversationId, order: 'ascending' }, 1000)).items, conversation: await tx.conversation(item.conversationId as ConversationId) }), context);
    expect(stored.conversation?.owner).toBeUndefined(); expect(stored.entries.every(entry => entry.kind === 'inkos.legacy-history' && entry.model === undefined)).toBe(true);
    if (item.sourceFile.endsWith('session-original.jsonl')) expect(stored.entries[0].data).toMatchObject({ event: { uuid: 'uuid-original', piTurnIndex: 2 } });
    if (item.sourceFile.endsWith('harness.sqlite')) expect(stored.entries.find(entry => object(entry.data).table === 'mysterious_history')?.data).toMatchObject({ row: { id: { type: 'integer', value: '9007199254740993' }, blob: { type: 'blob', encoding: 'base64', value: 'AP8=' } } });
  }
  expect(await harness.commit(tx => tx.conversation(ROOT_CONVERSATION_ID), context)).toBeUndefined();
  const archive = await harness.snapshot(LegacyArchive, report.migrationKey, context); expect(archive?.history.length).toBe(report.history.length);
  const again = await migrateToDurable(harness, target, { source, apply: true }); expect(again.history).toEqual(report.history); expect(again.skipped).toHaveLength(8); await unchanged(before);
});

async function publishingSource(source: string) {
  await book(source, 'published-work');
  const db = await legacyDb(source, 'CREATE TABLE publishing_targets(id TEXT,target_json TEXT); CREATE TABLE publishing_packages(id TEXT,manifest_json TEXT); CREATE TABLE publishing_chapters(package_id TEXT,number INTEGER,state_json TEXT); CREATE TABLE publishing_fanqie_runs(package_id TEXT,number INTEGER,account_id TEXT,remote_book_id TEXT,run_json TEXT); CREATE TABLE publishing_meganovel_runs(package_id TEXT,number INTEGER,account_id TEXT,remote_book_id TEXT,run_json TEXT); CREATE TABLE publishing_remote_work_runs(operation_id TEXT,work_id TEXT,run_json TEXT); CREATE TABLE publishing_remote_work_bindings(work_id TEXT,target_id TEXT,account_id TEXT,remote_book_id TEXT,receipt_json TEXT);');
  db.prepare('INSERT INTO publishing_targets VALUES(?,?)').run('target-original', JSON.stringify({ id: 'target-original', platform: 'fanqie', accountLabel: 'label-not-account-id' }));
  db.prepare('INSERT INTO publishing_packages VALUES(?,?)').run('package-original', JSON.stringify({ id: 'package-original', workId: 'published-work', targetId: 'target-original', chapters: [{ artifactId: 'chapter-original', revisionId: 'revision-original' }], remoteVerified: false }));
  db.prepare('INSERT INTO publishing_chapters VALUES(?,?,?)').run('package-original', 1, JSON.stringify({ status: 'submitted_reported', receipt: { provenance: 'user_reported', remoteChapterId: 'reported-chapter' }, artifactId: 'chapter-original', revisionId: 'revision-original' }));
  for (const state of ['draft_unknown', 'schedule_unknown']) db.prepare('INSERT INTO publishing_fanqie_runs VALUES(?,?,?,?,?)').run('package-original', state === 'draft_unknown' ? 1 : 2, 'actual-account-A', 'scoped-remote-book', JSON.stringify({ phase: state, accountLabel: 'Not identity', artifactId: 'chapter-original', revisionId: 'revision-original', remoteChapterId: 'chapter-remote-A' }));
  db.prepare('INSERT INTO publishing_meganovel_runs VALUES(?,?,?,?,?)').run('package-original', 1, 'actual-account-B', 'scoped-remote-book', JSON.stringify({ phase: 'submit_unknown', revisionId: 'revision-original' }));
  db.prepare('INSERT INTO publishing_remote_work_runs VALUES(?,?,?)').run('creation-operation-original', 'published-work', JSON.stringify({ phase: 'create_unknown', attempts: 1, unverifiedRemoteBookId: 'unverified-only', version: 4 }));
  db.prepare('INSERT INTO publishing_remote_work_bindings VALUES(?,?,?,?,?)').run('published-work', 'target-original', 'actual-account-A', 'scoped-remote-book', JSON.stringify({ provenance: 'user_reported', evidence: 'Manual receipt' }));
  await put(source, '.inkos/publishing/package-original/manifest.json', { id: 'package-original', workId: 'published-work' }); await put(source, '.inkos/publishing/package-original/chapters/000001.md', 'Selected package bytes');
  return db;
}
it('retains actual account-scoped remote IDs, selected revisions and all unknown outcomes; calls only the local importer, once', async () => {
  const source = await root(), target = await root(), harness = await open(target); await publishingSource(source);
  const before = await sourceBytes(source), calls: LegacyPublishingData[] = [];
  const importer = async (data: LegacyPublishingData) => { calls.push(data); expect((await harness.snapshot(ProjectDoc, context))?.migrations[data.migrationKey]).toBeDefined(); };
  const preview = await migrateToDurable(harness, target, { source, importPublishing: importer }); expect(calls).toEqual([]); expect(preview.publishingImport).toBe('pending');
  const report = await migrateToDurable(harness, target, { source, apply: true, importPublishing: importer });
  expect(report.publishingImport).toBe('imported'); expect(calls).toHaveLength(1);
  expect(report.publishing.fanqieRuns[0]).toMatchObject({ workId: 'published-work', accountId: 'actual-account-A', remoteBookId: 'scoped-remote-book', remoteChapterId: 'chapter-remote-A', disposition: 'needs-observation' });
  expect(report.publishing.meganovelRuns[0]).toMatchObject({ accountId: 'actual-account-B', remoteBookId: 'scoped-remote-book', unknownStates: ['submit_unknown'] });
  expect(report.publishing.remoteWorkRuns[0]).toMatchObject({ id: 'creation-operation-original', unknownStates: ['create_unknown'], remoteBookId: null });
  expect(report.publishing.chapters[0]).toMatchObject({ artifactId: 'chapter-original', revisionId: 'revision-original', disposition: 'user-reported' });
  expect(report.publishing.bindings[0]).toMatchObject({ accountId: 'actual-account-A', disposition: 'user-reported' });
  expect((await harness.snapshot(Works, 'published-work', context))?.legacy.publishing).toMatchObject({ key: report.migrationKey, needsObservation: expect.any(Array) });
  expect((await harness.snapshot(Works, 'published-work', context))?.status).toBe('paused'); expect(await harness.snapshot(LegacyPublishing, report.migrationKey, context)).toEqual(report.publishing);
  await migrateToDurable(harness, target, { source, apply: true, importPublishing: importer }); expect(calls).toHaveLength(1); await unchanged(before);
});

it('keeps publishing data durably pending when the importer fails and can retry it without reimporting content/history', async () => {
  const source = await root(), target = await root(), harness = await open(target); await publishingSource(source);
  const report = await migrateToDurable(harness, target, { source, apply: true, importPublishing: async () => { throw new Error('publishing extension not installed'); } });
  expect(report.publishingImport).toBe('failed'); expect(report.publishingError).toContain('not installed'); expect(await harness.snapshot(LegacyPublishing, report.migrationKey, context)).toBeDefined();
  const retry = await migrateToDurable(harness, target, { source, apply: true, importPublishing: async data => { expect(data.remoteWorkRuns[0].unknownStates).toEqual(['create_unknown']); } });
  expect(retry.imported).toEqual([]); expect(retry.publishingImport).toBe('imported'); expect(retry.history).toEqual(report.history); expect((await harness.snapshot(ProjectDoc, context))?.workIds).toEqual(['published-work']);
});

it('reports unavailable historical bytes and existing durable work conflicts, without substituting current content or mutating originals', async () => {
  const source = await root(), target = await root(), harness = await open(target);
  const manifest = v2('broken'); delete (manifest.artifacts[0].revisions[0] as { contentBase64?: string }).contentBase64;
  await put(source, 'works/broken/work.json', manifest); await put(source, 'works/broken/source/chapters/0001_One.md', 'not historical bytes'); await book(source, 'collision');
  await new WorksService(harness, target).create({ id: 'collision', title: 'New durable work' });
  const before = await sourceBytes(source), report = await migrateToDurable(harness, target, { source, apply: true });
  expect(report.status).toBe('partial'); expect(report.imported).toEqual([]); expect(report.conflicts.find(item => item.workId === 'broken')?.reason).toContain('Historical revision bytes unavailable');
  expect(report.conflicts.find(item => item.workId === 'collision')?.reason).toContain('Durable work ID already exists'); expect(await harness.snapshot(Works, 'broken', context)).toBeUndefined();
  expect((await harness.snapshot(Works, 'collision', context))?.title).toBe('New durable work'); await unchanged(before);
});

it('commits migration marker and documents atomically in real SQLite, and reuses stable file IDs after an interrupted commit', async () => {
  const source = await root(), target = await root(); await book(source, 'atomic'); await put(source, 'books/atomic/chapters/0001.md', 'Saved manuscript'); await put(source, '.inkos/session.json', { messages: [{ role: 'user', content: 'history only' }] });
  let fail = false;
  const harness = await open(target, { conversationCreated: async (_tx, conversation) => { if (fail && conversation.id !== ROOT_CONVERSATION_ID) throw new Error('Interrupted migration commit'); } });
  const before = await sourceBytes(source); fail = true;
  await expect(migrateToDurable(harness, target, { source, apply: true })).rejects.toThrow('Interrupted migration commit');
  expect(await harness.snapshot(ProjectDoc, context)).toBeUndefined(); expect(await harness.snapshot(Works, 'atomic', context)).toBeUndefined();
  fail = false; const report = await migrateToDurable(harness, target, { source, apply: true }); expect(report.imported).toHaveLength(1); expect(report.history).toHaveLength(1);
  expect((await harness.snapshot(ProjectDoc, context))?.migrations[report.migrationKey]).toBeDefined(); expect(await taskCount(harness)).toBe(0);
  const work = await new WorksService(harness, target).get('atomic'); expect(new Set(work.artifactIds).size).toBe(work.artifactIds.length);
  const repeat = await migrateToDurable(harness, target, { source, apply: true }); expect(repeat.skipped).toHaveLength(1); await unchanged(before);
});

it('recovers omitted v1 archives/readerContract beside a previously converted v2 work without replacing current domain state', async () => {
  const source = await root(), target = await root(), harness = await open(target);
  await book(source, 'converted');
  await put(source, 'books/converted/story/book_rules.json', { version: '1', readerContract: { promise: 'Original promise' }, oldSpecialistField: 'keep' });
  await put(source, 'books/converted/story/state/current_state.json', { chapter: 1 });
  await put(source, 'books/converted/chapters/.versions/0001/original.md', 'Lost by the earlier directory converter');
  await put(source, 'works/converted/work.json', { version: 2, id: 'converted', profileId: 'longform-novel', title: 'Converted', language: 'en', status: 'active', artifacts: [], lineage: [], metadata: { legacySource: 'books/converted' } });
  await put(source, 'works/converted/source/book.json', { id: 'converted', title: 'Current title', status: 'completed', language: 'en' });
  await put(source, 'works/converted/source/story/book_rules.json', { version: '2', currentSpecialistField: 'current' });
  await put(source, 'works/converted/source/story/state/current_state.json', { chapter: 5, facts: [{ sourceChapter: 5 }] });
  const before = await sourceBytes(source), report = await migrateToDurable(harness, target, { source, apply: true });
  expect(report.conflicts).toEqual([]); expect(report.imported).toHaveLength(1);
  const service = new WorksService(harness, target), work = await service.get('converted');
  expect(work).toMatchObject({ title: 'Current title', status: 'completed', domain: { readerContract: { promise: 'Original promise' }, current_state: { chapter: 5 }, bookRules: { version: '2', oldSpecialistField: 'keep', currentSpecialistField: 'current' } } });
  const archived = object(object(work.domain.files)['books/converted/chapters/.versions/0001/original.md']);
  expect((await service.read(String(archived.artifactId))).content).toBe('Lost by the earlier directory converter');
  await unchanged(before);
});

it('reads a separate old goals.sqlite and retains ledger-only intake, original task IDs and incomplete steps as paused durable progress', async () => {
  const source = await root(), target = await root(), harness = await open(target);
  const db = await legacyDb(source, 'CREATE TABLE creation_tasks(id TEXT,work_id TEXT,data_json TEXT); CREATE TABLE goals(id TEXT,work_id TEXT,data_json TEXT); CREATE TABLE goal_steps(goal_id TEXT,id TEXT,operation_key TEXT,data_json TEXT);', '.inkos/goals.sqlite');
  db.prepare('INSERT INTO creation_tasks VALUES(?,?,?)').run('intake-original', 'creation-original', JSON.stringify({ id: 'intake-original', desiredState: 'run', phase: 'queued', request: { id: 'intake-original', brief: 'A preserved brief', deliveryMode: 'manuscript' }, plan: { title: 'Intake title', language: 'es-MX', targetChapters: 4 } }));
  db.prepare('INSERT INTO goals VALUES(?,?,?)').run('goal-original', 'creation-original', JSON.stringify({ desiredState: 'run', status: 'running' }));
  db.prepare('INSERT INTO goal_steps VALUES(?,?,?,?)').run('goal-original', 'step-original', 'operation-original', JSON.stringify({ id: 'step-original', kind: 'write', status: 'pending', attempts: 1 }));
  const before = await sourceBytes(source), report = await migrateToDurable(harness, target, { source, apply: true });
  expect(report.imported.map(item => item.workId)).toEqual(['creation-original']); expect(report.sourceFiles).toContain(join(source, '.inkos/goals.sqlite'));
  expect(await harness.snapshot(Works, 'creation-original', context)).toMatchObject({ title: 'Intake title', locale: 'es-MX', status: 'paused', legacy: { effectiveDeliveryMode: 'manuscript' } });
  expect(await harness.snapshot(LegacyProgress, legacyProgressKey(report.migrationKey, 'creation-original'), context)).toMatchObject({ taskIds: expect.arrayContaining(['intake-original', 'goal-original']), unfinished: expect.arrayContaining([expect.objectContaining({ id: 'step-original', operationKey: 'operation-original' })]), resume: { status: 'paused', taskId: null } });
  await migrateToDurable(harness, target, { source, apply: true }); expect((await harness.snapshot(ProjectDoc, context))?.workIds).toEqual(['creation-original']); expect(await taskCount(harness)).toBe(0); await unchanged(before);
});
it('previews and applies migration through the actual host while excluding its live owner and endpoint files', async () => {
  const source = await root(); await book(source, 'self-migration');
  const host = await RuntimeHost.open(source, { resume: false });
  try {
    await put(source, '.inkos/runtime.json', { pid: process.pid });
    await put(source, '.inkos/runtime.log', 'Current runtime startup.');
    const preview = await host.rpc('work.migrate');
    expect(preview.conflicts).toEqual([]); expect(preview.imported.map((item: any) => item.workId)).toEqual(['self-migration']);
    expect(preview.sourceFiles.some((path: string) => /runtime-owner|runtime\.json|runtime\.log/.test(path))).toBe(false);
    const report = await host.rpc('work.migrate', { apply: true }); expect(report.status).toBe('applied');
    expect((await host.rpc('work.migrate', { apply: true })).status).toBe('already-applied');
    expect(await host.works.list()).toHaveLength(1); expect(await host.tasks()).toHaveLength(0);
    expect(JSON.parse(await readFile(join(source, 'books/self-migration/book.json'), 'utf8')).id).toBe('self-migration');
  } finally { await host.close(); }
});
