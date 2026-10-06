import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({load: vi.fn(), start: vi.fn(), stop: vi.fn(), constructor: vi.fn(),
  error: vi.fn(), close: vi.fn(), write: vi.fn(), end: vi.fn()}));
vi.mock('node:fs/promises', () => ({readFile: vi.fn(), writeFile: fixture.write, unlink: vi.fn()}));
vi.mock('node:fs', () => ({createWriteStream: () => ({end: fixture.end})}));
vi.mock('@actalk/inkos-core', () => ({loadSchedulerPublisher: fixture.load,
  Scheduler: class {constructor(options: unknown) {fixture.constructor(options);} start = fixture.start; stop = fixture.stop;},
  SchedulerStore: class {},
}));
vi.mock('../utils.js', () => ({loadConfig: async () => ({daemon: {schedule: {radarCron: '0 */6 * * *', writeCron: '*/15 * * * *'}}}),
  findProjectRoot: () => '/fixture-project', buildPipelineConfig: () => ({projectRoot: '/fixture-project'}), log: vi.fn(), logError: fixture.error}));

let initialInt: Function[], initialTerm: Function[];
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); process.exitCode = 0;
  initialInt = process.listeners('SIGINT'); initialTerm = process.listeners('SIGTERM');
  fixture.start.mockResolvedValue(undefined); fixture.stop.mockResolvedValue(undefined); fixture.write.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const handler of process.listeners('SIGINT')) if (!initialInt.includes(handler)) process.removeListener('SIGINT', handler);
  for (const handler of process.listeners('SIGTERM')) if (!initialTerm.includes(handler)) process.removeListener('SIGTERM', handler);
  process.exitCode = 0;
});

describe('daemon generic publisher configuration wiring', () => {
  it('passes the explicit config file through the generic loader and injects its publisher', async () => {
    const publisher = {ready: vi.fn(), publish: vi.fn(), close: fixture.close}; fixture.load.mockResolvedValue(publisher);
    const {upCommand} = await import('../commands/daemon.js');
    await upCommand.parseAsync(['node', 'up', '--publish-config', '/fixture/config.json', '--work', 'work-a', 'work-b']);
    expect(fixture.load).toHaveBeenCalledWith('/fixture-project', '/fixture/config.json');
    expect(fixture.constructor).toHaveBeenCalledWith(expect.objectContaining({publisher, workIds: ['work-a', 'work-b']}));
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it('does not construct or start a scheduler after a manual-only or unknown provider is rejected', async () => {
    fixture.load.mockRejectedValue(Object.assign(new Error('manual_required'), {code: 'PUBLISHING_MANUAL_REQUIRED'}));
    const {upCommand} = await import('../commands/daemon.js');
    await upCommand.parseAsync(['node', 'up', '--publish-config', '/fixture/manual.json']);
    expect(fixture.constructor).not.toHaveBeenCalled(); expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
  });

  it('describes per-work binding support and manual/unknown startup rejection in help', async () => {
    const {upCommand} = await import('../commands/daemon.js');
    expect(upCommand.helpInformation()).toContain('per-work publisher bindings');
    expect(upCommand.helpInformation()).toContain('unknown/manual-only providers');
  });
});
