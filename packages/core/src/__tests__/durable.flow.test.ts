import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Harness, createRegistry, defineExtension, type TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { WorksService } from '../works/service.js';
import { Works, Reviews, defaultPlan, reviewKey } from '../works/documents.js';
import { saveArtifact, savedRevision, readArtifact } from '../works/artifacts.js';
import { createContentTask } from '../extensions/fiction/task.js';
import { contentProfiles } from '../extensions/fiction/profiles.js';
import { measureLength } from '../runtime/plugins.js';
import { exportArtifact, editArtifact } from '../extensions/export.js';

const context = BACKGROUND_CONTEXT;
const roots: string[] = []; const opened: Harness[] = [];
async function open(rootDir?: string) {
  const root = rootDir ?? await mkdtemp(join(tmpdir(), 'inkos-durable-'));
  if (!roots.includes(root)) roots.push(root);
  const registry = createRegistry();
  registry.install(Object.assign(defineExtension({ name: 'content', tasks: [createContentTask(root)] }), { profiles: contentProfiles }));
  // A real Models collection with no configured provider: no model simulation and no network calls.
  const harness = await Harness.open(await openNodeSqliteStorage(join(root, 'durable.sqlite')), { registry, models: createModels(), settings: { retry: { maxRetries: 0 } } }, context);
  opened.push(harness); const conversation = await harness.root(context);
  return { root, harness, conversation, works: new WorksService(harness, root) };
}
afterEach(async () => { for (const harness of opened.splice(0)) await harness.close(context); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function pause(ms = 30) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function submitContent(env: Awaited<ReturnType<typeof open>>, workId: string, input: { artifactId?: string; revisionId?: string; content?: string } = {}) {
  const task = createContentTask(env.root);
  return env.conversation.commit(tx => tx.createTask(task, { workId, artifactId: input.artifactId ?? 'unit', revisionId: input.revisionId ?? 'v1', title: 'Unit one', ...input }, { ownership: { kind: 'conversation' }, background: true }), context);
}
describe('real durable domain behavior', () => {
  it('deduplicates a native submission across reopen and viewer refresh', async () => {
    const env = await open(); const draft = { type: 'write', requestId: 'same-request', entry: { kind: 'inkos.note', data: { text: 'author note' } } } as const;
    const first = await env.conversation.submit(draft, context); const second = await env.conversation.submit(draft, context);
    expect(first.id).toBe(second.id); expect((await first.wait(context)).status).toBe('done');
    const watch = await env.conversation.watch(context); await watch.stop();
    await env.harness.close(context); opened.splice(opened.indexOf(env.harness), 1);
    const reopened = await open(env.root); const again = await reopened.conversation.submit(draft, context);
    expect(again.id).toBe(first.id);
    const entries = await reopened.conversation.entries({}, 100, undefined, context);
    expect(entries.items.filter(entry => entry.kind === 'inkos.note')).toHaveLength(1);
  });
  it('creates a platform-free manuscript in Japanese and preserves exact edits/exports', async () => {
    const env = await open(); const plan = defaultPlan('静かな物語'); plan.review.enabled = false;
    const work = await env.works.create({ id: 'japanese', title: '夜の手紙', locale: 'ja-JP', plan });
    expect(work.targetIds).toEqual([]);
    const id = await submitContent(env, work.id, { content: '窓の外は雨だった。\n手紙を読んだ。' });
    const result = await env.harness.waitForTask(id, context);
    expect(result.state.outcome.status).toBe('completed');
    const original = await env.works.read('unit');
    expect(original.content).toContain('手紙'); expect((await env.works.get(work.id)).status).toBe('completed');
    expect(measureLength('こんにちは世界', 'ja', 'grapheme')).toBe(7);
    await editArtifact(env.works, { id: 'unit', targetText: '手紙', replacement: '本' });
    const edited = await env.works.read('unit'); expect(edited.content).toBe('窓の外は雨だった。\n本を読んだ。');
    expect((await env.works.read('unit', 'v1')).content).toBe(original.content);
    const output = await exportArtifact(env.works, { artifactId: 'unit', format: 'epub' });
    expect((await readFile(join(env.root, output.path))).subarray(0, 2).toString()).toBe('PK');
  });
  it('persists pause as a boundary intention and resumes without terminal abort', async () => {
    const env = await open(); const plan = defaultPlan(); plan.review.enabled = false;
    const work = await env.works.create({ id: 'paused', title: 'Paused', plan }); await env.works.pause(work.id, true);
    const id = await submitContent(env, work.id, { content: 'Saved once.' }); env.harness.resume(); await pause();
    expect(await savedRevision(env.root, work.id, 'unit', 'v1')).toBeUndefined();
    await env.harness.close(context); opened.splice(opened.indexOf(env.harness), 1);
    const reopened = await open(env.root); reopened.harness.resume(); await pause();
    expect((await reopened.works.get(work.id)).pauseRequested).toBe(true);
    await reopened.works.pause(work.id, false);
    expect((await reopened.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
    expect((await reopened.works.artifact('unit')).revisions).toHaveLength(1);
  });
  it('uses native abort for cancellation and retains it after reopen', async () => {
    const env = await open(); const work = await env.works.create({ id: 'cancel', title: 'Cancel' }); await env.works.pause(work.id, true);
    const id = await submitContent(env, work.id, { content: 'Never generate on cancellation.' }); env.harness.resume(); await pause();
    await env.harness.abortTask(id, context);
    expect((await env.harness.waitForTask(id, context)).state.outcome.status).toBe('aborted');
    await env.harness.close(context); opened.splice(opened.indexOf(env.harness), 1);
    const reopened = await open(env.root);
    expect((await reopened.harness.getTask(id as TaskId, context))?.state.status).toBe('terminal');
    expect((await reopened.works.get(work.id)).status).toBe('cancelled');
  });
  it('adopts a fully saved file revision after interruption, without writing it again', async () => {
    const env = await open(); const plan = defaultPlan(); plan.review.enabled = false;
    const work = await env.works.create({ id: 'resume', title: 'Resume', plan });
    const revision = await saveArtifact(env.root, { id: 'v1', workId: work.id, artifactId: 'unit', title: 'Unit one', content: 'Previously finished draft.', format: 'text', metadata: { role: 'content' } });
    const before = (await stat(join(env.root, revision.path))).mtimeMs;
    const id = await submitContent(env, work.id, { content: 'This must not replace the saved draft.' });
    expect((await env.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
    expect((await env.works.read('unit')).content).toBe('Previously finished draft.');
    expect((await stat(join(env.root, revision.path))).mtimeMs).toBe(before);
    expect((await env.works.artifact('unit')).revisions).toHaveLength(1);
  });
  it('reuses review by revision and policy, allowing suggestions without a model call or rewrite', async () => {
    const env = await open(); const work = await env.works.create({ id: 'reviewed', title: 'Reviewed' });
    const review = { revisionId: 'v1', policyId: work.plan.review.id, issues: [{ kind: 'suggestion' as const, message: 'A quieter adjective is optional.' }], storyState: { fact: 'Ada read the letter.' }, completedAt: 1 };
    await env.harness.commit(async tx => { await tx.doc(Reviews, reviewKey('v1', work.plan.review.id), review); }, context);
    const id = await submitContent(env, work.id, { content: 'Ada read the letter.' });
    expect((await env.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
    expect((await env.works.artifact('unit')).revisions).toHaveLength(1);
    expect((await env.works.get(work.id)).domain.fact).toBe('Ada read the letter.');
    expect((await env.harness.usage(context)).models).toEqual({});
  });
  it('retains the draft when the unconfigured model review fails, with no revision attempts', async () => {
    const env = await open(); const work = await env.works.create({ id: 'service-failure', title: 'Service failure' });
    const id = await submitContent(env, work.id, { content: 'A finished draft.' });
    const failed = await env.harness.waitForTask(id, context);
    expect(failed.state.outcome.status).toBe('faulted');
    if (failed.state.outcome.status === 'faulted') expect(failed.state.outcome.error.message).toContain('Model step failed');
    const revision = await savedRevision(env.root, work.id, 'unit', 'v1'); expect(revision).toBeDefined();
    expect(await readArtifact(env.root, revision!)).toBe('A finished draft.');
    expect(await savedRevision(env.root, work.id, 'unit', 'v1-edit-1')).toBeUndefined();
  });
  it.each(['short-fiction', 'translation', 'article', 'script', 'storyboard', 'play'])('runs existing %s content on the same task substrate', async profile => {
    const env = await open(); const plan = defaultPlan(); plan.review.enabled = false;
    const work = await env.works.create({ id: profile, title: profile, profile, locale: 'fr-FR', plan });
    const structures: Record<string, object> = { script: { characters: [{ id: 'ada', name: 'Ada' }], episodes: [{ id: 'ep1', title: 'Arrival', scenes: [{ id: 'scene1', location: 'Station', time: 'Night', action: 'Ada arrives.', dialogue: [{ speaker: 'Ada', text: 'Bonjour.' }] }] }] },
      storyboard: { shots: [{ id: 'shot1', sceneId: 'scene1', framing: 'wide', movement: 'static', duration: 4, action: 'Ada arrives.', dialogue: 'Bonjour.', sound: 'Train' }] },
      play: { entities: [{ id: 'ada', type: 'actor', label: 'Ada', summary: 'Traveller' }], edges: [], stateSlots: [], events: [], presentation: { scene: 'Station', choices: ['Look around'] } } };
    const content = structures[profile] ? JSON.stringify(structures[profile]) : 'Bonjour, monde.';
    const id = await submitContent(env, work.id, { content });
    expect((await env.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
    expect((await env.works.get(work.id)).profile).toBe(profile);
    expect((await env.works.read('unit')).content).toBe(content);
    if (structures[profile]) expect((await env.works.get(work.id)).domain[profile]).toBeDefined();
  });
  it('keeps serial goals open and accepts plan changes after content exists', async () => {
    const env = await open(); const plan = defaultPlan(); plan.serial = true; plan.units = null; plan.review.enabled = false;
    const work = await env.works.create({ id: 'serial', title: 'Serial', plan });
    const id = await submitContent(env, work.id, { content: 'The serial continues.' }); await env.harness.waitForTask(id, context);
    expect((await env.works.get(work.id)).status).toBe('active');
    await env.works.update(work.id, { title: 'New title', plan: { brief: 'Change only the next unit.' } });
    expect((await env.works.get(work.id)).title).toBe('New title');
    expect((await env.works.read('unit')).content).toBe('The serial continues.');
  });
  it('adopts an already saved targeted revision and cached reviews with zero model budget', async () => {
    const env = await open();
    const work = await env.works.create({ id: 'saved-edit', title: 'Saved edit', plan: { review: { id: 'author-intent-v1', enabled: true, maxRevisions: 2, maxCost: 0 } } });
    const edit = await saveArtifact(env.root, { id: 'v1-edit-1', workId: work.id, artifactId: 'unit', title: 'Unit one', content: 'Already corrected.', format: 'text', metadata: { role: 'content' } });
    const before = (await stat(join(env.root, edit.path))).mtimeMs;
    await env.harness.commit(async tx => {
      await tx.doc(Reviews, reviewKey('v1', work.plan.review.id), { revisionId: 'v1', policyId: work.plan.review.id, issues: [{ kind: 'requirement', message: 'Correct the retained author requirement.' }], storyState: {}, completedAt: 1 });
      await tx.doc(Reviews, reviewKey(edit.id, work.plan.review.id), { revisionId: edit.id, policyId: work.plan.review.id, issues: [], storyState: {}, completedAt: 2 });
    }, context);
    const id = await submitContent(env, work.id, { content: 'Original author draft.' });
    expect((await env.harness.waitForTask(id, context)).state.outcome.status).toBe('completed');
    expect((await env.works.read('unit')).content).toBe('Already corrected.');
    expect((await stat(join(env.root, edit.path))).mtimeMs).toBe(before);
    expect((await env.harness.usage(context)).models).toEqual({});
  });
});
