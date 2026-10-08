import { describe, expect, it, vi } from "vitest";
import { PublisherStartupCleanupError, type SchedulerConfig } from "@actalk/inkos-core";
import { StudioDaemonController } from "./daemon-controller.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function publisher() {
  return { ready: vi.fn(async () => {}), publish: vi.fn<NonNullable<SchedulerConfig["publisher"]>["publish"]>(), close: vi.fn(async () => {}) };
}
function setup() {
  const config: SchedulerConfig = {
    projectRoot: "/fixture", client: {} as SchedulerConfig["client"], model: "synthetic",
    radarCron: "0 */6 * * *", writeCron: "*/15 * * * *", maxConcurrentBooks: 1,
    chaptersPerCycle: 1, retryDelayMs: 0, cooldownAfterChapterMs: 0, maxChaptersPerDay: 2,
    workIds: ["selected"], publicationPollMs: 123456,
    market: { platform: "meganovel", language: "en", maxSourceAgeMs: 86400000, liveMegaNovel: false },
  };
  const daemon = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), isRunning: true };
  const load = vi.fn(async () => config), broadcast = vi.fn(), create = vi.fn(() => daemon);
  return { config, daemon, load, broadcast, create, controller: new StudioDaemonController(load, broadcast, create) };
}

describe("Studio daemon lifecycle", () => {
  it("preserves the complete configured scope and reports started only after ownership succeeds", async () => {
    const f = setup(), gate = deferred();
    f.daemon.start.mockImplementation(() => gate.promise);
    const start = f.controller.start();
    await vi.waitFor(() => expect(f.daemon.start).toHaveBeenCalledOnce());
    expect(f.controller.status().phase).toBe("starting");
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledWith(f.config);
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    gate.resolve(); await start;
    expect(f.broadcast).toHaveBeenCalledWith("daemon:started", {});
  });
  it("returns owner-claim failure without a false started receipt", async () => {
    const f = setup();
    f.daemon.start.mockRejectedValue(Object.assign(new Error("External owner"), { code: "DAEMON_BUSY" }));
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    expect(f.daemon.stop).toHaveBeenCalledOnce();
    expect(f.controller.status().phase).toBe("stopped");
    expect(f.broadcast).not.toHaveBeenCalled();
  });
  it("retains stopping state and blocks restart until the in-flight drain completes", async () => {
    const f = setup(), gate = deferred(); await f.controller.start();
    f.daemon.stop.mockImplementation(() => gate.promise);
    const stop = f.controller.stop();
    expect(f.controller.stop()).toBe(stop);
    expect(f.controller.status().phase).toBe("stopping");
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    expect(f.broadcast).not.toHaveBeenCalledWith("daemon:stopped", {});
    gate.resolve(); await stop;
    expect(f.controller.status().phase).toBe("stopped");
    expect(f.broadcast).toHaveBeenCalledWith("daemon:stopped", {});
    await f.controller.start(); expect(f.create).toHaveBeenCalledTimes(2);
  });
  it("cancels a start waiting on configuration without creating a late scheduler", async () => {
    const f = setup(), gate = deferred(); f.load.mockImplementation(async () => { await gate.promise; return f.config; });
    const start = f.controller.start(), rejected = expect(start).rejects.toMatchObject({ code: "DAEMON_START_CANCELLED" });
    const stop = f.controller.stop(); gate.resolve(); await rejected; await stop;
    expect(f.create).not.toHaveBeenCalled(); expect(f.controller.status().phase).toBe("stopped");
  });
  it("drains a start waiting on ownership without publishing a late started event", async () => {
    const f = setup(), gate = deferred(); f.daemon.start.mockImplementation(() => gate.promise);
    const start = f.controller.start(), rejected = expect(start).rejects.toMatchObject({ code: "DAEMON_START_CANCELLED" });
    await vi.waitFor(() => expect(f.daemon.start).toHaveBeenCalledOnce());
    const stop = f.controller.stop(); gate.resolve(); await rejected; await stop;
    expect(f.daemon.stop).toHaveBeenCalledOnce(); expect(f.broadcast).not.toHaveBeenCalledWith("daemon:started", {});
  });
  it("awaits a late-loaded publisher close before completing cancellation or allowing restart", async () => {
    const f = setup(), loading = deferred(), closing = deferred(), transport = publisher();
    f.load.mockImplementation(async () => { await loading.promise; return { ...f.config, publisher: transport }; });
    transport.close.mockImplementation(() => closing.promise);
    const start = f.controller.start();
    const rejected = expect(start).rejects.toMatchObject({ code: "DAEMON_START_CANCELLED" });
    const stop = f.controller.stop();
    let stopped = false; void stop.then(() => { stopped = true; });
    loading.resolve();
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
    expect(stopped).toBe(false);
    expect(f.controller.status().phase).toBe("stopping");
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
    closing.resolve(); await rejected; await stop;
    expect(f.controller.status().phase).toBe("stopped");
    f.load.mockResolvedValue(f.config);
    await f.controller.start();
    expect(f.create).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it("retains failed publisher cleanup across cancellation, repeated stop and restart requests", async () => {
    const f = setup(), loading = deferred(), transport = publisher(), failure = new Error("publisher close failed");
    transport.close.mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    f.load.mockImplementation(async () => { await loading.promise; return { ...f.config, publisher: transport }; });
    const rejectedStart = expect(f.controller.start()).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: "DAEMON_START_CANCELLED" }), failure],
    });
    const rejectedStop = expect(f.controller.stop()).rejects.toBe(failure);
    loading.resolve(); await rejectedStart; await rejectedStop;
    expect(f.controller.status().phase).toBe("failed");
    await expect(f.controller.stop()).rejects.toBe(failure);
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    expect(transport.close).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalledWith("daemon:stopped", {});
  });
  it("closes a loaded publisher if scheduler construction throws", async () => {
    const f = setup(), closing = deferred(), transport = publisher();
    f.load.mockResolvedValue({ ...f.config, publisher: transport });
    f.create.mockImplementation(() => { throw new Error("scheduler construction failed"); });
    transport.close.mockImplementation(() => closing.promise);
    const rejected = expect(f.controller.start()).rejects.toThrow("scheduler construction failed");
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
    expect(f.controller.status().phase).toBe("starting");
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    closing.resolve(); await rejected;
    expect(f.controller.status().phase).toBe("stopped");
    expect(f.daemon.stop).not.toHaveBeenCalled();
  });
  it("retains the failed constructor cleanup handle without falsely reporting stopped", async () => {
    const f = setup(), transport = publisher(), failure = new Error("publisher close failed");
    f.load.mockResolvedValue({ ...f.config, publisher: transport });
    f.create.mockImplementation(() => { throw new Error("scheduler construction failed"); });
    transport.close.mockRejectedValue(failure);
    await expect(f.controller.start()).rejects.toBeInstanceOf(AggregateError);
    await expect(f.controller.stop()).rejects.toBe(failure);
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    expect(f.controller.status().phase).toBe("failed");
    expect(transport.close).toHaveBeenCalledOnce();
    expect(f.broadcast).not.toHaveBeenCalled();
  });
  it("transfers publisher cleanup to the constructed scheduler exactly once", async () => {
    const f = setup(), transport = publisher();
    f.load.mockResolvedValue({ ...f.config, publisher: transport });
    f.daemon.stop.mockImplementation(() => transport.close());
    await f.controller.start(); await f.controller.stop(); await f.controller.stop();
    expect(f.daemon.stop).toHaveBeenCalledOnce();
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it("shares failed scheduler startup cleanup with an overlapping stop", async () => {
    const f = setup(), closing = deferred(), failure = new Error("scheduler close failed");
    f.daemon.start.mockRejectedValue(new Error("scheduler start failed"));
    f.daemon.stop.mockImplementation(async () => { await closing.promise; throw failure; });
    const rejectedStart = expect(f.controller.start()).rejects.toBeInstanceOf(AggregateError);
    await vi.waitFor(() => expect(f.daemon.stop).toHaveBeenCalledOnce());
    const rejectedStop = expect(f.controller.stop()).rejects.toBe(failure);
    closing.resolve(); await rejectedStart; await rejectedStop;
    expect(f.daemon.stop).toHaveBeenCalledOnce();
    expect(f.controller.status().phase).toBe("failed");
    expect(f.broadcast).not.toHaveBeenCalledWith("daemon:stopped", {});
  });
  it("does not claim a failed drain stopped or admit a replacement", async () => {
    const f = setup(); await f.controller.start(); f.daemon.stop.mockRejectedValue(new Error("drain failed"));
    await expect(f.controller.stop()).rejects.toThrow("drain failed");
    expect(f.controller.status().phase).toBe("failed");
    expect(f.broadcast).not.toHaveBeenCalledWith("daemon:stopped", {});
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
  });
  it("waits for an externally requested core drain before allowing another start", async () => {
    const f = setup(), gate = deferred(); await f.controller.start();
    f.daemon.isRunning = false; f.daemon.stop.mockImplementation(() => gate.promise);
    expect(f.controller.status().phase).toBe("stopping");
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    gate.resolve(); await vi.waitFor(() => expect(f.controller.status().phase).toBe("stopped"));
    f.daemon.isRunning = true; await f.controller.start(); expect(f.create).toHaveBeenCalledTimes(2);
  });
  it("refuses later starts after host shutdown, including when already idle", async () => {
    const f = setup(); await f.controller.shutdown();
    await expect(f.controller.start()).rejects.toMatchObject({ code: "STUDIO_SHUTTING_DOWN" });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("cancels a stale-runner replacement when a later stop arrives during its drain", async () => {
    const f = setup(), draining = deferred(); await f.controller.start();
    f.daemon.isRunning = false;
    f.daemon.stop.mockImplementation(() => draining.promise);
    const rejected = expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_START_CANCELLED" });
    const stop = f.controller.stop(); draining.resolve(); await rejected; await stop;
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.controller.status().phase).toBe("stopped");
  });
  it("waits for late publisher cleanup during shutdown and prevents future starts", async () => {
    const f = setup(), loading = deferred(), transport = publisher();
    f.load.mockImplementation(async () => { await loading.promise; return { ...f.config, publisher: transport }; });
    const rejected = expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_START_CANCELLED" });
    const shutdown = f.controller.shutdown(); loading.resolve(); await rejected; await shutdown;
    expect(transport.close).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
    await expect(f.controller.start()).rejects.toMatchObject({ code: "STUDIO_SHUTTING_DOWN" });
  });
  it("retains loader-internal cleanup failure and waits for explicit cleanup before admitting another instance", async () => {
    const f = setup(), closing = deferred();
    const close = vi.fn(() => closing.promise);
    const failure = new PublisherStartupCleanupError(new Error("factory failed"), new Error("initial close failed"), { close });
    f.load.mockRejectedValueOnce(failure);
    await expect(f.controller.start()).rejects.toBe(failure);
    expect(f.controller.status().phase).toBe("failed");
    expect(close).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    const stop = f.controller.stop();
    expect(f.controller.stop()).toBe(stop);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    expect(f.broadcast).not.toHaveBeenCalledWith("daemon:stopped", {});
    closing.resolve(); await stop;
    expect(f.controller.status().phase).toBe("stopped");
    await f.controller.start();
    expect(f.create).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it("reports a loader failure to an overlapping stop without silently retrying its failed cleanup", async () => {
    const f = setup(), loading = deferred(), close = vi.fn(async () => {});
    const failure = new PublisherStartupCleanupError(new Error("factory failed"), new Error("initial close failed"), { close });
    f.load.mockImplementation(async () => { await loading.promise; throw failure; });
    const rejectedStart = expect(f.controller.start()).rejects.toBe(failure);
    const rejectedStop = expect(f.controller.stop()).rejects.toBe(failure);
    loading.resolve(); await rejectedStart; await rejectedStop;
    expect(close).not.toHaveBeenCalled();
    expect(f.controller.status().phase).toBe("failed");
    await f.controller.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.controller.status().phase).toBe("stopped");
  });
  it("keeps a failed explicit loader cleanup retry visible and permits another cleanup-only attempt", async () => {
    const f = setup(), retryFailure = new Error("cleanup still failed");
    const close = vi.fn().mockRejectedValueOnce(retryFailure).mockResolvedValue(undefined);
    const failure = new PublisherStartupCleanupError(new Error("factory failed"), new Error("initial close failed"), { close });
    f.load.mockRejectedValue(failure);
    await expect(f.controller.start()).rejects.toBe(failure);
    await expect(f.controller.stop()).rejects.toBe(retryFailure);
    expect(f.controller.status().phase).toBe("failed");
    await expect(f.controller.start()).rejects.toMatchObject({ code: "DAEMON_BUSY" });
    expect(f.broadcast).not.toHaveBeenCalledWith("daemon:stopped", {});
    await f.controller.stop();
    expect(close).toHaveBeenCalledTimes(2);
    expect(f.load).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
    expect(f.controller.status().phase).toBe("stopped");
  });
});
