import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SchedulerPublisher } from '../pipeline/autonomous-chapters.js';
import type { PublishingPlatform, PublishingTarget } from '../publishing/contracts.js';
import type { MegaNovelBrowserPort } from '../publishing/meganovel-contracts.js';
import { PublishingStore } from '../publishing/store.js';
import { SchedulerPublisherRegistry, createDefaultSchedulerPublisherRegistry, loadSchedulerPublisher,
  type SchedulerPublisherBinding } from '../publishing/scheduler-publisher-registry.js';

const configSchema = z.object({accountLabel: z.string(), remoteBookId: z.string()}).strict();
let root: string, store: PublishingStore;
let open: Array<SchedulerPublisher & {close(): Promise<void>}>;
const signal = () => new AbortController().signal;
const configuration = (bindings: SchedulerPublisherBinding[]) => ({version: 1, bindings});
const input = (workId: string) => ({workId, chapterNumber: 7, revisionId: 'reviewed-revision', signal: signal()});
const binding = (provider: string, target: PublishingTarget): SchedulerPublisherBinding => ({
  provider, workId: target.workId, targetId: target.id,
  configuration: {accountLabel: target.accountLabel, remoteBookId: target.remoteBookId},
});
function target(workId: string, platform: PublishingPlatform, accountLabel = workId, remoteBookId = 'same-remote-id') {
  return store.mapBook({workId, platform, accountLabel, remoteBookId});
}
function synthetic(registry: SchedulerPublisherRegistry, provider: string, platform: PublishingPlatform) {
  const drivers: Array<{binding: SchedulerPublisherBinding; configuration: z.infer<typeof configSchema>;
    ready: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>}> = [];
  const create = vi.fn((_root: string, selected: SchedulerPublisherBinding, config: z.infer<typeof configSchema>) => {
    const driver = {binding: selected, configuration: config, ready: vi.fn(async () => {}),
      publish: vi.fn(async () => ({status: 'submitted' as const, remoteChapterId: `${provider}:${selected.targetId}`})),
      close: vi.fn(async () => {})};
    drivers.push(driver);
    return driver;
  });
  registry.register({provider, parseConfiguration: value => configSchema.parse(value),
    target: config => ({platform, ...config}), create});
  return {create, drivers};
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inkos-publisher-registry-'));
  store = new PublishingStore(join(root, '.inkos', 'harness.sqlite'));
  open = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(open.map(publisher => publisher.close()));
  store.close();
  await rm(root, {recursive: true, force: true});
});

// These are protocol/route tests with synthetic providers, not live platform acceptance.
describe('typed publisher registry with synthetic providers and real local targets', () => {
  it('routes multiple works across two providers without mixing accounts or same-valued remote IDs', async () => {
    const registry = new SchedulerPublisherRegistry();
    const alpha = synthetic(registry, 'synthetic-alpha', 'qidian');
    const beta = synthetic(registry, 'synthetic-beta', 'dreame');
    const a = target('work-a', 'qidian'), b = target('work-b', 'dreame'), c = target('work-c', 'qidian');
    const publisher = await registry.create(root, configuration([
      binding('synthetic-alpha', a), binding('synthetic-beta', b), binding('synthetic-alpha', c),
    ])); open.push(publisher);
    const abort = signal();
    await publisher.ready('work-b', abort, 7);
    expect(beta.drivers[0]!.ready).toHaveBeenCalledWith('work-b', abort, 7);
    expect(alpha.drivers.every(driver => driver.ready.mock.calls.length === 0)).toBe(true);
    const request = input('work-c');
    expect(await publisher.publish(request)).toEqual({status: 'submitted', remoteChapterId: `synthetic-alpha:${c.id}`});
    expect(alpha.drivers[1]!.publish).toHaveBeenCalledWith(request);
    expect(alpha.drivers[0]!.publish).not.toHaveBeenCalled();
    expect(beta.drivers[0]!.publish).not.toHaveBeenCalled();
    expect(alpha.drivers.map(driver => driver.configuration.accountLabel)).toEqual(['work-a', 'work-c']);
    expect(beta.drivers[0]!.binding.targetId).toBe(b.id);
    await expect(publisher.ready('unbound-work', signal())).rejects.toMatchObject({code: 'PUBLISHING_BINDING_MISSING'});
    await expect(publisher.publish(input('unbound-work'))).rejects.toMatchObject({code: 'PUBLISHING_BINDING_MISSING'});
  });

  it.each(['work', 'target', 'provider', 'configuration'] as const)('rejects a bad %s before any factory is created', async kind => {
    const registry = new SchedulerPublisherRegistry(), fixture = synthetic(registry, 'synthetic-alpha', 'qidian');
    const a = binding('synthetic-alpha', target('work-a', 'qidian'));
    const b = binding('synthetic-alpha', target('work-b', 'qidian'));
    if (kind === 'work') b.workId = a.workId;
    if (kind === 'target') b.targetId = a.targetId;
    if (kind === 'provider') b.provider = 'not-installed';
    if (kind === 'configuration') b.configuration = {accountLabel: 'incomplete'};
    await expect(registry.create(root, configuration([a, b]))).rejects.toThrow();
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it.each(['workId', 'platform', 'accountLabel', 'remoteBookId'] as const)('checks retained %s before creation and again before delegated calls', async field => {
    const registry = new SchedulerPublisherRegistry(), fixture = synthetic(registry, 'synthetic-alpha', 'qidian');
    const a = target('work-a', 'qidian'), config = configuration([binding('synthetic-alpha', a)]);
    const getTarget = vi.spyOn(PublishingStore.prototype, 'getTarget');
    const changed = {...a, [field]: field === 'platform' ? 'dreame' : 'changed'};
    getTarget.mockReturnValue(changed);
    await expect(registry.create(root, config)).rejects.toMatchObject({code: 'PUBLISHING_TARGET_CONFLICT'});
    expect(fixture.create).not.toHaveBeenCalled();
    getTarget.mockReturnValue(a);
    const publisher = await registry.create(root, config); open.push(publisher);
    getTarget.mockReturnValue(changed);
    await expect(publisher.ready('work-a', signal())).rejects.toMatchObject({code: 'PUBLISHING_TARGET_CONFLICT'});
    await expect(publisher.publish(input('work-a'))).rejects.toMatchObject({code: 'PUBLISHING_TARGET_CONFLICT'});
    expect(fixture.drivers[0]!.ready).not.toHaveBeenCalled();
    expect(fixture.drivers[0]!.publish).not.toHaveBeenCalled();
  });

  it('does not retry or promote an unknown result; a recreated driver only reconciles its retained attempt', async () => {
    const registry = new SchedulerPublisherRegistry(), a = target('work-a', 'qidian');
    // This object models a provider-owned durable reservation across publisher recreation.
    // Real driver restart safety is exercised separately by scheduler-publisher.flow.test.ts.
    const retained = {reserved: false, mutations: 0, readbacks: 0};
    const publish = vi.fn(async () => {
      if (!retained.reserved) { retained.reserved = true; retained.mutations++; }
      else retained.readbacks++;
      return {status: 'pending' as const, evidence: 'Synthetic submit_unknown; reconciliation only'};
    });
    registry.register({provider: 'synthetic-unknown', parseConfiguration: value => configSchema.parse(value),
      target: config => ({platform: 'qidian', ...config}), create: () => ({ready: async () => {}, publish})});
    const config = configuration([binding('synthetic-unknown', a)]);
    let publisher = await registry.create(root, config); open.push(publisher);
    expect((await publisher.publish(input('work-a'))).status).toBe('pending');
    expect(publish).toHaveBeenCalledTimes(1);
    await publisher.close();
    publisher = await registry.create(root, config); open.push(publisher);
    expect((await publisher.publish(input('work-a'))).status).toBe('pending');
    expect(publish).toHaveBeenCalledTimes(2);
    expect(retained).toEqual({reserved: true, mutations: 1, readbacks: 1});
  });

  it('propagates failures once without falling back to another provider or target', async () => {
    const registry = new SchedulerPublisherRegistry(), alpha = synthetic(registry, 'alpha', 'qidian'), beta = synthetic(registry, 'beta', 'dreame');
    const publisher = await registry.create(root, configuration([
      binding('alpha', target('work-a', 'qidian')), binding('beta', target('work-b', 'dreame')),
    ])); open.push(publisher);
    alpha.drivers[0]!.publish.mockRejectedValue(new Error('unknown outcome'));
    await expect(publisher.publish(input('work-a'))).rejects.toThrow('unknown outcome');
    expect(alpha.drivers[0]!.publish).toHaveBeenCalledOnce();
    expect(beta.drivers[0]!.publish).not.toHaveBeenCalled();
  });

  it('honors cancellation before invoking a provider', async () => {
    const registry = new SchedulerPublisherRegistry(), fixture = synthetic(registry, 'alpha', 'qidian');
    const publisher = await registry.create(root, configuration([binding('alpha', target('work-a', 'qidian'))])); open.push(publisher);
    const controller = new AbortController(); controller.abort(new Error('stop'));
    await expect(publisher.ready('work-a', controller.signal)).rejects.toThrow('stop');
    await expect(publisher.publish({...input('work-a'), signal: controller.signal})).rejects.toThrow('stop');
    expect(fixture.drivers[0]!.ready).not.toHaveBeenCalled();
    expect(fixture.drivers[0]!.publish).not.toHaveBeenCalled();
  });

  it('closes every created provider on startup failure even if one close fails', async () => {
    const registry = new SchedulerPublisherRegistry(), fixture = synthetic(registry, 'alpha', 'qidian');
    const closeA = vi.fn(async () => {throw new Error('close failed');}), closeB = vi.fn(async () => {});
    fixture.create.mockReturnValueOnce({binding: {} as SchedulerPublisherBinding, configuration: {accountLabel: '', remoteBookId: ''},
      ready: vi.fn(), publish: vi.fn(), close: closeA}).mockReturnValueOnce({binding: {} as SchedulerPublisherBinding,
      configuration: {accountLabel: '', remoteBookId: ''}, ready: vi.fn(), publish: vi.fn(), close: closeB})
      .mockImplementationOnce(() => {throw new Error('startup failed');});
    await expect(registry.create(root, configuration(['a', 'b', 'c'].map(id => binding('alpha', target(`work-${id}`, 'qidian'))))))
      .rejects.toThrow('Publisher startup and cleanup failed');
    expect(closeA).toHaveBeenCalledOnce(); expect(closeB).toHaveBeenCalledOnce();
  });

  it('deduplicates shared publisher cleanup and closes only once', async () => {
    const registry = new SchedulerPublisherRegistry(), fixture = synthetic(registry, 'alpha', 'qidian');
    const close = vi.fn(async () => {});
    fixture.create.mockReturnValue({binding: {} as SchedulerPublisherBinding, configuration: {accountLabel: '', remoteBookId: ''},
      ready: vi.fn(), publish: vi.fn(), close});
    const publisher = await registry.create(root, configuration(['a', 'b'].map(id => binding('alpha', target(`work-${id}`, 'qidian'))))); open.push(publisher);
    await Promise.all([publisher.close(), publisher.close()]);
    expect(close).toHaveBeenCalledOnce();
    await expect(publisher.ready('work-a', signal())).rejects.toMatchObject({code: 'PUBLISHING_CLOSED'});
  });

  it('rejects duplicate provider registration and malformed routing envelopes', async () => {
    const registry = new SchedulerPublisherRegistry(); synthetic(registry, 'alpha', 'qidian');
    expect(() => synthetic(registry, 'alpha', 'qidian')).toThrow();
    await expect(registry.create(root, {version: 2, bindings: []})).rejects.toThrow();
    await expect(registry.create(root, {version: 1, bindings: []})).rejects.toThrow();
  });
});

describe('default provider capability boundary and legacy deployment loading', () => {
  it.each(['manual', 'fanqie', 'qidian', 'qimao', 'goodnovel', 'dreame'])('blocks %s as manual_required before any transport or publication', async provider => {
    const registry = createDefaultSchedulerPublisherRegistry();
    expect(registry.list().filter(entry => entry.mode === 'automatic')).toEqual([{provider: 'meganovel', mode: 'automatic'}]);
    await expect(registry.create(root, configuration([{provider, workId: 'work-a', targetId: 'no-target', configuration: {}}])))
      .rejects.toMatchObject({code: 'PUBLISHING_MANUAL_REQUIRED'});
  });

  it('loads a versioned file with a supplied registered factory', async () => {
    const registry = new SchedulerPublisherRegistry(), fixture = synthetic(registry, 'alpha', 'qidian');
    const path = join(root, 'publish.json');
    await writeFile(path, JSON.stringify(configuration([binding('alpha', target('work-a', 'qidian'))])));
    const publisher = await loadSchedulerPublisher(root, path, registry); open.push(publisher);
    expect(fixture.create).toHaveBeenCalledOnce();
  });

  it.each(['versioned', 'legacy'] as const)('keeps the existing MegaNovel driver and transport for %s configuration', async format => {
    const a = target('work-a', 'meganovel');
    const scope = {sessionId: 'tab', accountId: 'account-id', accountLabel: a.accountLabel, remoteBookId: a.remoteBookId};
    const browser: MegaNovelBrowserPort & {close(): Promise<void>} = {
      probe: vi.fn(), snapshot: vi.fn(), createDraft: vi.fn(), submit: vi.fn(), close: vi.fn(async () => {}),
    };
    const connect = vi.fn(async (_config: unknown, _dom: unknown) => browser);
    vi.doMock('../publishing/meganovel-cdp.js', () => ({connectMegaNovelCdpPort: connect}));
    try {
      const options = {firstNewChapter: 3, historicalChapterIds: {'1': 'known-one'},
        requiredStateReplay: {chapterNumber: 2, planId: 'reviewed-plan'}, aiAssisted: true, scope,
        endpointURL: 'http://127.0.0.1:9222', lockDirectory: join(root, 'locks'),
        authorization: {automation: {provenance: 'user_reported', reference: 'Synthetic permission'},
          aiAssistedContent: {provenance: 'user_reported', reference: 'Synthetic AI permission'}}};
      const route = {provider: 'meganovel', workId: a.workId, targetId: a.id, configuration: options};
      const configured = format === 'legacy' ? [{workId: a.workId, targetId: a.id, ...options}] : configuration([route]);
      const publisher = await createDefaultSchedulerPublisherRegistry().create(root, configured); open.push(publisher);
      expect(connect).toHaveBeenCalledOnce();
      expect(connect.mock.calls[0]![0]).toEqual({scope, endpointURL: options.endpointURL,
        lockDirectory: options.lockDirectory, authorization: options.authorization});
      expect(connect.mock.calls[0]![1]).toMatchObject({protocol: 'inkos-meganovel-dom-v1', snapshot: expect.any(Function)});
      // The original driver's canonical-replay gate still runs before any browser probe.
      await expect(publisher.ready(a.workId, signal())).rejects.toMatchObject({code: 'PUBLISHING_CANONICAL_REPLAY_REQUIRED'});
      expect(browser.probe).not.toHaveBeenCalled(); expect(browser.createDraft).not.toHaveBeenCalled();
      await publisher.close(); expect(browser.close).toHaveBeenCalledOnce();
    } finally { vi.doUnmock('../publishing/meganovel-cdp.js'); }
  });

  it('does not open an earlier automatic provider when a later binding is manual-only', async () => {
    const registry = new SchedulerPublisherRegistry(), fixture = synthetic(registry, 'alpha', 'qidian');
    registry.registerManual('manual', 'Export only.');
    await expect(registry.create(root, configuration([
      binding('alpha', target('work-a', 'qidian')), {provider: 'manual', workId: 'work-b', targetId: 'manual-target', configuration: {}},
    ]))).rejects.toMatchObject({code: 'PUBLISHING_MANUAL_REQUIRED'});
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it('normalizes a legacy MegaNovel array without dropping migration or authorization options', async () => {
    const registry = new SchedulerPublisherRegistry(), a = target('work-a', 'meganovel');
    const selected: SchedulerPublisherBinding[] = [];
    const parse = vi.fn((value: unknown, route: SchedulerPublisherBinding) => {selected.push(route); return value as {scope: {accountLabel: string; remoteBookId: string}};});
    registry.register({provider: 'meganovel', parseConfiguration: parse,
      target: config => ({platform: 'meganovel', accountLabel: config.scope.accountLabel, remoteBookId: config.scope.remoteBookId}),
      create: () => ({ready: async () => {}, publish: async () => ({status: 'pending'})})});
    const path = join(root, 'legacy.json');
    const legacy = {workId: a.workId, targetId: a.id, firstNewChapter: 3, historicalChapterIds: {'1': 'known-one'},
      requiredStateReplay: {chapterNumber: 2, planId: 'reviewed-plan'}, aiAssisted: true,
      scope: {sessionId: 'tab', accountId: 'account-id', accountLabel: a.accountLabel, remoteBookId: a.remoteBookId},
      endpointURL: 'http://127.0.0.1:9222', lockDirectory: join(root, 'locks'),
      authorization: {automation: {provenance: 'user_reported', reference: 'Synthetic permission'},
        aiAssistedContent: {provenance: 'user_reported', reference: 'Synthetic AI permission'}}};
    await writeFile(path, JSON.stringify([legacy]));
    const publisher = await loadSchedulerPublisher(root, path, registry); open.push(publisher);
    const {workId, targetId, ...options} = legacy;
    expect(selected).toEqual([{provider: 'meganovel', workId, targetId, configuration: options}]);
    expect(parse).toHaveBeenCalledOnce();
  });
});
