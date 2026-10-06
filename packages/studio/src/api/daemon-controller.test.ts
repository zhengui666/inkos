import { describe, expect, it, vi } from "vitest";
import type { SchedulerConfig } from "@actalk/inkos-core";
import { StudioDaemonController } from "./daemon-controller.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
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
});
