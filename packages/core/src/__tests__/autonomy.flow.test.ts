import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { defineTask, defineExtension, type TaskId, type ConversationId, type EntryId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { RuntimeHost } from '../runtime/host.js';
import { readConversationEntry } from '../extensions/model-answer.js';
import { verifyTopic, recoveryTime } from '../extensions/fiction/autonomy.js';
import { defaultAutonomyConfig } from '../works/autonomy.js';
import { Works } from '../works/documents.js';
import { publishingBufferFull } from '../works/progress.js';

const ctx = BACKGROUND_CONTEXT, roots: string[] = [], hosts: RuntimeHost[] = [], servers: Server[] = [];
async function open(root?: string, extensions: ReturnType<typeof defineExtension>[] = []) {
  root ??= await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-autonomy-')); if (!roots.includes(root)) roots.push(root);
  const host = await RuntimeHost.open(root, { extensions }); hosts.push(host); return host;
}
async function source() {
  let reads = 0;
  const server = createServer((_request, response) => { reads++; response.setHeader('Content-Type', 'text/html'); response.end('<h1>Local author research</h1><p>This is authored local source text for storage and recovery checks, not a real market ranking or simulated model result.</p><p>Observe source text exactly; preserve original author intent.</p>'); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, reads: () => reads };
}
async function until(check: () => Promise<boolean>, timeout = 5000) { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error('Condition did not settle'); await new Promise(resolve => setTimeout(resolve, 20)); } }
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('reads an owned child entry in its own native context, never the parent-scoped entry lookup', async () => {
  type Checkpoint = { phase: 'write'; child: null; entry: null } | { phase: 'read'; child: ConversationId; entry: EntryId };
  const scope = defineTask<{}, Checkpoint, { parentVisible: boolean; childVisible: boolean }, {}>({
    name: 'test.entry-scope', version: 1, initial: () => ({ phase: 'write', child: null, entry: null }),
    phases: {
      write: async (task, runtime, context) => { await runtime.commit(async tx => {
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } });
        // Passive author note tests genuine SDK storage visibility, not a scripted assistant or successful inference.
        const entry = await tx.appendEntry(child.id, { kind: 'inkos.note', data: { text: 'A real stored author note in the child.' } });
        return { status: 'running', checkpoint: { phase: 'read', child: child.id, entry: entry.id } };
      }, context); },
      read: async (task, runtime, context) => {
        const { child, entry } = task.state.checkpoint;
        const parentVisible = Boolean(await runtime.entry(entry, context));
        const owned = await readConversationEntry(runtime, child, entry, context);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { parentVisible, childVisible: JSON.stringify(owned?.data) === JSON.stringify({ text: 'A real stored author note in the child.' }) } } }), context);
      },
    }, abort: async (_task, runtime, context) => { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context); },
  });
  const host = await open(undefined, [defineExtension({ name: 'scope', tasks: [scope] })]);
  const id = await (await host.harness.root(ctx)).commit(tx => tx.createTask(scope, {}, { ownership: { kind: 'conversation' } }), ctx);
  expect((await host.harness.waitForTask(id, ctx)).state.outcome).toEqual({ status: 'completed', result: { parentVisible: false, childVisible: true } });
  expect((await host.harness.usage(ctx)).models).toEqual({});
});
it('persists a bounded run, paced real model failure and its original deadline across reopen without re-reading the source', async () => {
  const page = await source(); let host = await open(); const root = host.rootDir;
  const work = await host.works.create({ title: 'Preserve author title', brief: 'Preserve author brief', locale: 'ja', plan: { serial: true, units: null } });
  await host.rpc('autonomy.configure', { workId: work.id, config: { ...defaultAutonomyConfig(), sources: [{ id: 'local', source: 'public-page', url: page.url }] } });
  const admitted = await host.rpc('autonomy.start', { workId: work.id, durationMs: 1800, requestId: 'same-run' });
  expect(await host.rpc('autonomy.start', { workId: work.id, durationMs: 99999, requestId: 'same-run' })).toEqual(admitted);
  expect((await host.rpc('autonomy.start', { workId: work.id, requestId: 'another-click' })).taskId).toBe(admitted.taskId);
  await until(async () => (await host.harness.getTask(admitted.taskId, ctx))?.state.status === 'running' && Boolean((await host.works.get(work.id)).autonomy?.lastError));
  const before = await host.works.get(work.id), native = await host.harness.getTask(admitted.taskId, ctx);
  expect(before.autonomy?.research[0]?.text).toContain('authored local source'); expect(before.autonomy?.lastError).toContain('model step failed');
  expect(native?.state.status === 'running' && native.state.checkpoint).toMatchObject({ phase: 'retry', resume: 'select' });
  expect(before.title).toBe(work.title); expect(before.plan.brief).toBe(work.plan.brief); expect(before.artifactIds).toEqual([]);
  expect(page.reads()).toBe(1);
  await host.close(); hosts.splice(hosts.indexOf(host), 1); host = await open(root);
  expect((await host.works.get(work.id)).autonomy?.endAt).toBe(before.autonomy?.endAt);
  await host.harness.waitForTask(admitted.taskId, ctx);
  await until(async () => (await host.works.get(work.id)).status === 'paused');
  expect((await host.works.get(work.id)).autonomy?.stopReason).toBe('deadline'); expect(page.reads()).toBe(1);
  expect((await host.harness.usage(ctx)).models).toEqual({}); expect(await host.publishing.listDistributions()).toEqual([]);
});
it('deadline interrupts a paused work and stop only affects the selected run', async () => {
  const page = await source(), host = await open();
  const work = await host.works.create({ title: 'Paused bounded serial', plan: { serial: true, units: null } });
  await host.rpc('autonomy.configure', { workId: work.id, config: { ...defaultAutonomyConfig(), sources: [{ id: 'local', source: 'public-page', url: page.url }] } });
  const admitted = await host.rpc('autonomy.start', { workId: work.id, durationMs: 600 });
  await host.works.pause(work.id, true);
  expect(await host.stopAutonomy(work.id, admitted.taskId + 100, true)).toEqual({ stopped: false });
  await host.harness.waitForTask(admitted.taskId, ctx);
  expect((await host.works.get(work.id)).autonomy?.stopReason).toBe('deadline');
  expect((await host.works.get(work.id)).status).toBe('paused');
});
it('does not stop platform-free or disabled-target serials at a lifetime chapter backlog', async () => {
  const host = await open();
  const work = await host.works.create({ title: 'Offline serial', plan: { serial: true, units: null, production: { backlog: 1, nextAt: null, cron: null } } });
  for (let i = 0; i < 4; i++) await host.works.save({ workId: work.id, title: `Author chapter ${i}`, content: `Author-supplied chapter ${i}.` });
  expect(await publishingBufferFull(host.harness, await host.works.get(work.id), ctx)).toBe(false);
  await host.publishing.createTarget({ workId: work.id, platform: 'not-installed', enabled: false, config: { accountId: 'disabled', entryUrl: 'https://example.invalid' } });
  expect(await publishingBufferFull(host.harness, await host.works.get(work.id), ctx)).toBe(false);
  const production = await host.rpc('creation.produce', { workId: work.id });
  const terminal = await host.harness.waitForTask(production.taskId, ctx);
  expect(terminal.state.outcome.status).toBe('failed'); // Real unconfigured model, not a fake successful chapter.
  expect((await host.tasks()).filter(task => task.kind === 'inkos.content')).toHaveLength(1);
  expect((await host.works.get(work.id)).artifactIds).toHaveLength(4);
});
it('rejects unconfigured sources and invalid durations before admitting unattended work', async () => {
  const host = await open(), work = await host.works.create({ title: 'Unconfigured' });
  await expect(host.rpc('autonomy.start', { workId: work.id })).rejects.toThrow('ranking source');
  await expect(host.rpc('autonomy.configure', { workId: work.id, config: { ...defaultAutonomyConfig(), sources: [{ id: 'absent', source: 'not-installed', url: 'https://example.invalid' }] } })).rejects.toThrow('not installed');
  expect((await host.tasks()).filter(task => task.kind === 'inkos.autonomy')).toEqual([]);
  expect(recoveryTime(0, 100)).toBe(300100); expect(recoveryTime(100, 100)).toBe(3600100);
});
it('requires exact acquired evidence for a proposed topic rather than invented ranking claims', () => {
  const source = { id: 'author', source: 'public-page', url: 'https://example.invalid', label: 'Author source', fetchedAt: 1, text: 'An author-observed research signal.' };
  const proposed = { topic: 'Original theme', title: 'Original title', brief: 'Original brief', blueprint: 'Original serial outline', evidence: [{ sourceId: 'author', quote: 'research signal' }] };
  expect(verifyTopic(JSON.stringify(proposed), [source]).title).toBe('Original title');
  expect(() => verifyTopic(JSON.stringify({ ...proposed, evidence: [{ sourceId: 'author', quote: 'invented bestseller' }] }), [source])).toThrow('evidence');
});
it('keeps an author-established topic, saved chapter and next chapter time when starting a later bounded run', async () => {
  const page = await source(), host = await open();
  const work = await host.works.create({ title: 'Author serial', locale: 'fr', plan: { serial: true, units: null } });
  await host.rpc('autonomy.configure', { workId: work.id, config: { ...defaultAutonomyConfig(), sources: [{ id: 'local', source: 'public-page', url: page.url }] } });
  await host.works.save({ workId: work.id, title: 'Author chapter', content: 'An author-supplied first chapter.' });
  const nextAt = Date.now() + 3600000;
  const selection = { topic: 'Author topic', title: 'Author serial', brief: 'Author brief', blueprint: 'Author continuity', evidence: [] };
  const prior = await host.works.get(work.id);
  // Retained author business data, not a simulated model selection or chapter.
  await host.harness.commit(async tx => { const doc = await tx.doc(Works, work.id, prior); doc.autonomy!.selection = selection; doc.autonomy!.nextChapterAt = nextAt; }, ctx);
  const admitted = await host.rpc('autonomy.start', { workId: work.id, durationMs: 1200 });
  const record = await host.harness.getTask(admitted.taskId as TaskId, ctx);
  expect(record?.input).toMatchObject({ reuseSelection: true, firstAt: nextAt });
  await host.harness.waitForTask(admitted.taskId, ctx);
  expect((await host.works.get(work.id)).autonomy?.selection).toEqual(selection);
  expect((await host.works.get(work.id)).artifactIds).toHaveLength(1);
  expect((await host.harness.usage(ctx)).models).toEqual({});
});
it('retains structured author briefs and blueprints while still rejecting empty plans or fabricated source evidence', () => {
  const source = { id: 'author', source: 'public-page', url: 'https://example.invalid', label: 'Author source', fetchedAt: 1, text: 'Author research observation.' };
  const proposal = { topic: 'Author topic', title: 'Author title', brief: { readerPromise: 'Author direction', format: 'Serial' }, blueprint: { world: { place: 'Library' }, continuity: ['Keep the letter intact'] }, evidence: [{ sourceId: 'author', quote: 'research observation' }] };
  const result = verifyTopic(JSON.stringify(proposal), [source]);
  expect(JSON.parse(result.brief)).toEqual(proposal.brief); expect(JSON.parse(result.blueprint)).toEqual(proposal.blueprint);
  expect(() => verifyTopic(JSON.stringify({ ...proposal, blueprint: {} }), [source])).toThrow();
  expect(() => verifyTopic(JSON.stringify({ ...proposal, evidence: [{ sourceId: 'author', quote: 'imaginary trend' }] }), [source])).toThrow('evidence');
});
