import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { RuntimeHost } from '../../../runtime/host.js';
import { Distributions, PublishingTargets } from '../../../publishing/documents.js';
import { distributionKey } from '../../../publishing/contracts.js';
import { bufferedUnits } from '../../../works/progress.js';
import { editArtifact } from '../../export.js';
import { queueDistribution } from '../../../publishing/service.js';

const hosts: RuntimeHost[] = [], roots: string[] = [], ctx = BACKGROUND_CONTEXT;
async function open() {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-creation-distribution-')); roots.push(root);
  const host = await RuntimeHost.open(root); hosts.push(host); return host;
}
afterEach(async () => { for (const host of hosts.splice(0)) await host.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('derives native tasks for two targets, while retained reviewing/failed state never blocks later author content', async () => {
  const host = await open();
  const work = await host.works.create({ id: 'serial', title: 'Serial', plan: { serial: true, units: null, review: { id: 'off', enabled: false, maxRevisions: 0, maxCost: null } } });
  for (const id of ['a', 'b']) await host.publishing.createTarget({ id, workId: work.id, platform: 'not-installed', config: { accountId: id, entryUrl: 'https://example.invalid/' } });
  const first = await host.startContent({ workId: work.id, artifactId: 'first', revisionId: 'v1', content: 'First author manuscript.' });
  expect((await host.harness.waitForTask(first.taskId as any, ctx)).state.outcome.status).toBe('completed');
  const initial = await host.publishing.listDistributions(); expect(initial).toHaveLength(2);
  for (const record of initial) {
    await host.harness.waitForTask(record.taskId as any, ctx);
    expect((await host.publishing.listDistributions()).find(item => item.id === record.id)?.status).toBe('unsupported');
  }
  // Domain-state regression only: this is retained local business data, NOT a browser observation or real site acceptance.
  await host.harness.commit(async tx => {
    const a = await tx.doc(Distributions, distributionKey('a', 'first'), null); a.status = 'reviewing'; a.submittedRevisionId = 'v1';
    const b = await tx.doc(Distributions, distributionKey('b', 'first'), null); b.status = 'failed'; b.error = 'Retained local failure';
  }, ctx);
  const next = await host.startContent({ workId: work.id, artifactId: 'second', revisionId: 'v2', content: 'Second author manuscript.' });
  expect((await host.harness.waitForTask(next.taskId as any, ctx)).state.outcome.status).toBe('completed');
  const later = await host.publishing.listDistributions(); expect(later).toHaveLength(4);
  expect(later.find(item => item.id === distributionKey('a', 'first'))?.status).toBe('reviewing');
  expect(later.find(item => item.id === distributionKey('b', 'first'))?.status).toBe('failed');
  await host.harness.commit(async tx => { const b = await tx.doc(Distributions, distributionKey('b', 'first'), null); b.status = 'user-action'; b.error = 'Retained login action required'; }, ctx);
  const third = await host.startContent({ workId: work.id, artifactId: 'third', revisionId: 'v3', content: 'Creation continues while a target needs login.' });
  expect((await host.harness.waitForTask(third.taskId as any, ctx)).state.outcome.status).toBe('completed');
  expect((await host.publishing.listDistributions()).find(item => item.id === distributionKey('b', 'first'))).toMatchObject({ status: 'user-action', error: 'Retained login action required' });
  expect((await host.publishing.listDistributions()).filter(item => item.artifactId === 'third')).toHaveLength(2);
  await editArtifact(host.works, { id: 'first', targetText: 'First', replacement: 'Edited' });
  expect((await host.publishing.listDistributions()).filter(item => item.artifactId === 'first')).toHaveLength(2);
  expect((await host.publishing.listDistributions()).find(item => item.id === distributionKey('a', 'first'))?.desired.revisionId).toBe('v1');
  expect((await host.works.read('first')).content).toBe('Edited author manuscript.');
});
it('counts actual unaccepted buffer and wakes native production on distribution progress rather than lifetime chapter count', async () => {
  const host = await open();
  const work = await host.works.create({ id: 'buffer', title: 'Buffer', plan: { serial: true, units: null, production: { backlog: 1, cron: null, nextAt: null }, review: { id: 'off', enabled: false, maxRevisions: 0, maxCost: null } } });
  await host.publishing.createTarget({ id: 'buffer-target', workId: work.id, platform: 'not-installed', config: { accountId: 'local', entryUrl: 'https://example.invalid/' } });
  await host.works.save({ workId: work.id, artifactId: 'saved', revisionId: 'stored', title: 'Stored', content: 'Retained buffer.' });
  const record = (await host.publishing.listDistributions())[0]!; await host.harness.waitForTask(record.taskId as any, ctx);
  expect(await bufferedUnits(host.harness, await host.works.get(work.id), ctx)).toBe(1);
  const production = await host.rpc('creation.produce', { workId: work.id });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect((await host.tasks()).filter(task => task.kind === 'inkos.content')).toHaveLength(0);
  await host.harness.commit(async tx => { const doc = await tx.doc(Distributions, record.id, null); doc.status = 'reviewing'; doc.submittedRevisionId = 'stored'; }, ctx);
  expect(await bufferedUnits(host.harness, await host.works.get(work.id), ctx)).toBe(0);
  const result = await host.harness.waitForTask(production.taskId, ctx);
  // The unconfigured REAL model fails; no fake success or fees. Child admission proves that the native wait was woken.
  expect(result.state.outcome.status).toBe('failed');
  const children = (await host.tasks()).filter(task => task.kind === 'inkos.content'); expect(children).toHaveLength(1);
  expect(children[0]!.state.status).toBe('terminal');
  expect((await host.works.read('saved')).content).toBe('Retained buffer.');
});
it('rejects invalid calendar input and isolates a retained bad target cadence from content and other targets', async () => {
  const host = await open(), work = await host.works.create({ id: 'cadence', title: 'Cadence' });
  await expect(host.publishing.createTarget({ id: 'invalid', workId: work.id, platform: 'not-installed', config: { accountId: 'local', entryUrl: 'https://example.invalid/', cadence: { cron: 'not-a-cron' } } })).rejects.toThrow();
  expect(await host.publishing.listTargets()).toHaveLength(0);
  for (const id of ['bad', 'good']) await host.publishing.createTarget({ id, workId: work.id, platform: 'not-installed', config: { accountId: id, entryUrl: 'https://example.invalid/' } });
  await expect(host.publishing.updateTarget('good', { config: { cadence: { cron: 'not-a-cron' } } })).rejects.toThrow();
  // Retained legacy configuration, not a new accepted configuration or remote-site result.
  await host.harness.commit(async tx => { (await tx.doc(PublishingTargets, 'bad', null)).config.cadence = { cron: 'not-a-cron' }; }, ctx);
  await host.works.save({ workId: work.id, artifactId: 'kept', revisionId: 'v1', title: 'Kept', content: 'Content survives target configuration failure.' });
  expect((await host.works.read('kept')).content).toContain('survives');
  const records = await host.publishing.listDistributions(); expect(records).toHaveLength(2);
  expect(records.find(record => record.targetId === 'bad')).toMatchObject({ status: 'failed', taskId: null, error: expect.stringContaining('Invalid publishing cadence') });
  const good = records.find(record => record.targetId === 'good')!;
  expect(good.taskId).not.toBeNull(); await host.harness.waitForTask(good.taskId as any, ctx);
});
it('does not lose an explicit update accepted while the prior revision observation task is queued', async () => {
  let host = await open(); const root = host.rootDir;
  const work = await host.works.create({ id: 'pending-update', title: 'Pending update' });
  await host.works.save({ workId: work.id, artifactId: 'article', revisionId: 'r1', title: 'Article', content: 'First revision.' });
  await host.publishing.createTarget({ id: 'destination', workId: work.id, platform: 'not-installed', config: { accountId: 'local', entryUrl: 'https://example.invalid/' } });
  const initial = await host.publishing.queue({ targetId: 'destination', artifactId: 'article' });
  await host.harness.waitForTask(initial.taskId as any, ctx);
  await host.works.save({ workId: work.id, artifactId: 'article', revisionId: 'r2', title: 'Article', content: 'Explicit edited revision.' });
  // Local retained business state only; no claim that this revision was published on a real site.
  await host.harness.commit(async tx => { const doc = await tx.doc(Distributions, initial.id, null); doc.status = 'published'; doc.submittedRevisionId = 'r1'; doc.publishedRevisionId = 'r1'; }, ctx);
  await host.close(); hosts.splice(hosts.indexOf(host), 1);
  host = await RuntimeHost.open(root, { resume: false }); hosts.push(host);
  const observation = await queueDistribution(host.harness, root, { targetId: 'destination', artifactId: 'article', revisionId: 'r1' });
  expect((await host.harness.getTask(observation.taskId as any, ctx))?.input).toMatchObject({ mode: 'observe' });
  await queueDistribution(host.harness, root, { targetId: 'destination', artifactId: 'article', revisionId: 'r2', operation: 'update', requestId: 'update-r2' });
  host.harness.resume(); await host.harness.waitForTask(observation.taskId as any, ctx);
  const latest = (await host.publishing.listDistributions())[0]!;
  expect(latest.taskId).not.toBe(observation.taskId);
  expect((await host.harness.getTask(latest.taskId as any, ctx))?.input).toMatchObject({ mode: 'deliver', request: { revisionId: 'r2', operation: 'update' } });
  await host.harness.waitForTask(latest.taskId as any, ctx);
  expect((await host.publishing.queue({ targetId: 'destination', artifactId: 'article', revisionId: 'r2', operation: 'update', requestId: 'update-r2' })).taskId).toBe(latest.taskId);
});
it('admits prototype-shaped request IDs and separates content from production request namespaces', async () => {
  const host = await open();
  const work = await host.works.create({ id: 'ids', title: 'IDs' }); await host.works.pause(work.id, true);
  const other = await host.works.create({ id: 'producer', title: 'Producer' }); await host.works.pause(other.id, true);
  const admitted = [];
  for (const requestId of ['toString', 'constructor', 'production:X']) {
    const task = await host.startContent({ workId: work.id, requestId, content: 'Author content.' });
    expect(task.taskId).toBeGreaterThan(0); admitted.push(task);
    expect(await host.startContent({ workId: work.id, requestId })).toEqual(task);
  }
  const producer = await host.rpc('creation.produce', { workId: other.id, requestId: 'X' });
  expect(admitted.map(item => item.taskId)).not.toContain(producer.taskId);
  expect((await host.harness.getTask(producer.taskId, ctx))?.kind).toBe('inkos.production');
});
