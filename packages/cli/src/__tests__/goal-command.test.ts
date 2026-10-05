import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ServiceOptions = { projectRoot: string; createPipeline?: () => Promise<unknown> };
type RunOptions = { signal: AbortSignal; workId?: string };
const mock = vi.hoisted(() => ({
  root: "/fixture/goal-project", services: [] as ServiceOptions[],
  create: vi.fn(), get: vi.fn(), list: vi.fn(), events: vi.fn(), stop: vi.fn(), recover: vi.fn(), run: vi.fn(), close: vi.fn(),
  findRoot: vi.fn(), loadConfig: vi.fn(), buildConfig: vi.fn(), pipeline: vi.fn(), output: vi.fn(), error: vi.fn(),
}));

vi.mock("@actalk/inkos-core", async importOriginal => ({
  chapterGoalView: (await importOriginal<typeof import("@actalk/inkos-core")>()).chapterGoalView,
  ChapterGoalService: class {
    constructor(options: ServiceOptions) { mock.services.push(options); }
    create = mock.create;
    get = mock.get;
    list = mock.list;
    events = mock.events;
    stop = mock.stop;
    recover = mock.recover;
    run = mock.run;
    close = mock.close;
  },
  PipelineRunner: class { constructor(config: unknown) { mock.pipeline(config); } },
}));

vi.mock("../utils.js", () => ({
  findProjectRoot: mock.findRoot, loadConfig: mock.loadConfig, buildPipelineConfig: mock.buildConfig,
  log: mock.output, logError: mock.error,
}));

import { createGoalCommand } from "../commands/goal.js";

const goal = {
  id: "chapter-batch", workId: "novel", version: 7, schemaVersion: 1, intent: "Finish the opening arc",
  status: "paused", desiredState: "paused", attempts: 0, error: null,
  owner: { pid: 42, leaseUntil: 2_232_806_400_000, token: "private-owner-token" },
  budget: { maxAttempts: 6, expiresAt: 2_232_806_400_000 },
  steps: [], createdAt: 1, updatedAt: 1, lastProgressAt: 1,
};
const createArguments = ["create", "chapter-batch", "--work", "novel", "--from", "4", "--to", "5",
  "--intent", "Finish the opening arc", "--deadline", "2040-10-03T18:00:00+08:00"];

let exitCode: typeof process.exitCode;
beforeEach(() => {
  vi.resetAllMocks();
  mock.services = [];
  mock.findRoot.mockReturnValue(mock.root);
  mock.create.mockResolvedValue(goal);
  mock.get.mockReturnValue(goal);
  mock.list.mockReturnValue([goal]);
  mock.events.mockReturnValue({ events: [], nextAfterSeq: -1 });
  mock.stop.mockReturnValue(goal);
  mock.recover.mockReturnValue(goal);
  mock.loadConfig.mockResolvedValue({ llm: { model: "fixture-model" } });
  mock.buildConfig.mockReturnValue({ model: "fixture-model", projectRoot: mock.root });
  mock.run.mockImplementation(async () => {
    await mock.services.at(-1)!.createPipeline!();
    return { ...goal, owner: null, status: "completed", desiredState: "run", version: 10 };
  });
  exitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

async function run(args: string[], json = true) {
  const command = createGoalCommand();
  for (const entry of [command, ...command.commands]) entry.exitOverride().configureOutput({ writeErr: () => {} });
  await command.parseAsync([...args, ...(json ? ["--json"] : [])], { from: "user" });
}
function result() { return JSON.parse(mock.output.mock.calls.at(-1)![0]); }

describe("persistent chapter goal CLI", () => {
  it("creates the exact bounded goal without loading models or starting a writer", async () => {
    await run([...createArguments, "--words", "2400", "--attempts", "2"]);
    expect(mock.create).toHaveBeenCalledWith({
      id: goal.id, workId: "novel", intent: goal.intent, startChapter: 4, endChapter: 5,
      wordCount: 2400, maxAttemptsPerChapter: 2, expiresAt: Date.parse("2040-10-03T10:00:00Z"),
    });
    expect(result()).toMatchObject({ version: 7, status: "paused", owner: { pid: 42, leaseUntil: goal.owner.leaseUntil } });
    expect(JSON.stringify(result())).not.toContain("private-owner-token");
    expect(mock.findRoot).toHaveBeenCalledTimes(1);
    expect(mock.services[0]!.projectRoot).toBe(mock.root);
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.loadConfig).not.toHaveBeenCalled();
    expect(mock.pipeline).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("create --run composes creation and foreground execution using the returned version", async () => {
    await run([...createArguments, "--run"]);
    expect(mock.create.mock.calls[0]![0]).toMatchObject({ maxAttemptsPerChapter: 3 });
    expect(mock.create.mock.calls[0]![0]).not.toHaveProperty("wordCount");
    expect(mock.run).toHaveBeenCalledWith(goal.id, 7, { workId: "novel", signal: expect.any(AbortSignal) });
    expect(mock.loadConfig).toHaveBeenCalledWith({ requireApiKey: false, projectRoot: mock.root });
    expect(mock.buildConfig).toHaveBeenCalledWith({ llm: { model: "fixture-model" } }, mock.root, { quiet: true });
    expect(mock.pipeline).toHaveBeenCalledTimes(1);
    expect(mock.output).toHaveBeenCalledTimes(1);
    expect(result()).toMatchObject({ status: "completed", version: 10 });
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("forwards explicit version and Work scope to run", async () => {
    await run(["run", goal.id, "--version", "0", "--work", "novel"]);
    expect(mock.run).toHaveBeenCalledWith(goal.id, 0, { workId: "novel", signal: expect.any(AbortSignal) });
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it.each(["show", "list"])("%s reads scoped goals and excludes ownership tokens without loading models", async command => {
    await run([command, ...(command === "show" ? [goal.id] : []), "--work", "novel"]);
    if (command === "show") expect(mock.get).toHaveBeenCalledWith(goal.id, "novel");
    else expect(mock.list).toHaveBeenCalledWith("novel");
    expect(JSON.stringify(result())).not.toContain("private-owner-token");
    expect(command === "show" ? result().owner.pid : result()[0].owner.pid).toBe(42);
    expect(mock.loadConfig).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("passes event pagination through and removes internal claim tokens", async () => {
    mock.events.mockReturnValue({ events: [
      { goalId: goal.id, seq: 4, at: 123, type: "goal-claimed", payload: { token: "private-owner-token", pid: 42 } },
      { goalId: goal.id, seq: 5, at: 124, type: "step-started", payload: { stepId: "chapter-4" } },
    ], nextAfterSeq: 5 });
    await run(["events", goal.id, "--work", "novel", "--after", "3", "--limit", "2"]);
    expect(mock.events).toHaveBeenCalledWith(goal.id, { workId: "novel", afterSeq: 3, limit: 2 });
    expect(result()).toMatchObject({ nextAfterSeq: 5, events: [
      { seq: 4, payload: { pid: 42 } }, { seq: 5, payload: { stepId: "chapter-4" } },
    ] });
    expect(JSON.stringify(result())).not.toContain("private-owner-token");
    expect(mock.loadConfig).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("reads an initial event page with the documented defaults", async () => {
    await run(["events", goal.id]);
    expect(mock.events).toHaveBeenCalledWith(goal.id, { workId: undefined, afterSeq: -1, limit: 100 });
    expect(result()).toEqual({ events: [], nextAfterSeq: -1 });
  });

  it.each([["pause", "paused"], ["cancel", "cancelled"], ["recover", undefined]])(
    "%s forwards CAS and Work scope without loading a model or running", async (command, desired) => {
      await run([command!, goal.id, "--version", "7", "--work", "novel"]);
      if (desired) expect(mock.stop).toHaveBeenCalledWith(goal.id, desired, 7, "novel");
      else expect(mock.recover).toHaveBeenCalledWith(goal.id, 7, "novel");
      expect(mock.run).not.toHaveBeenCalled();
      expect(mock.loadConfig).not.toHaveBeenCalled();
      expect(mock.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["run", "pause", "cancel", "recover"])("%s requires an explicit version", async command => {
    await expect(run([command, goal.id])).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    expect(mock.services).toHaveLength(0);
  });

  it.each([
    ["--from", "4junk"], ["--to", "5.5"], ["--from", "0"], ["--words", "-1"],
    ["--attempts", "1e2"], ["--words", "9007199254740992"],
    ["--deadline", "2040-10-03"], ["--deadline", "2040-10-03T18:00:00"],
    ["--deadline", "2040-02-30T18:00:00Z"], ["--deadline", "2040-10-03T24:00:00Z"],
    ["--deadline", "2040-10-03T18:00:00+25:00"],
  ])("rejects malformed %s=%s before creation", async (flag, value) => {
    await run([...createArguments, flag, value]);
    expect(result()).toMatchObject({ code: "GOAL_INVALID_ARGUMENT" });
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.loadConfig).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["run", "--version", "7junk"], ["pause", "--version", "-1"], ["cancel", "--version", "0.5"],
    ["recover", "--version", "NaN"], ["events", "--after", "-2"], ["events", "--limit", "0"],
  ])("rejects malformed control input for %s", async (command, flag, value) => {
    await run([command, goal.id, flag, value]);
    expect(result()).toMatchObject({ code: "GOAL_INVALID_ARGUMENT" });
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.recover).not.toHaveBeenCalled();
    expect(mock.events).not.toHaveBeenCalled();
    expect(mock.loadConfig).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it.each(["GOAL_VERSION_CONFLICT", "GOAL_WORK_MISMATCH", "GOAL_TERMINAL"])("preserves core rejection %s", async code => {
    mock.stop.mockImplementation(() => { throw Object.assign(new Error("Core rejected this transition."), { code }); });
    await run(["pause", goal.id, "--version", "7"]);
    expect(result()).toEqual({ error: "Core rejected this transition.", code });
    expect(process.exitCode).toBe(1);
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("does not start a run when creation fails", async () => {
    mock.create.mockRejectedValue(Object.assign(new Error("ID belongs to another input."), { code: "GOAL_ID_CONFLICT" }));
    await run([...createArguments, "--run"]);
    expect(result()).toMatchObject({ code: "GOAL_ID_CONFLICT" });
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.loadConfig).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up signal handlers and the service if model configuration fails", async () => {
    const interrupts = process.listeners("SIGINT"), terminations = process.listeners("SIGTERM");
    mock.loadConfig.mockRejectedValue(new Error("Model configuration unavailable."));
    await run(["run", goal.id, "--version", "7"]);
    expect(result()).toEqual({ error: "Model configuration unavailable.", code: "GOAL_COMMAND_FAILED" });
    expect(mock.close).toHaveBeenCalledTimes(1);
    expect(process.listeners("SIGINT")).toEqual(interrupts);
    expect(process.listeners("SIGTERM")).toEqual(terminations);
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)(
    "%s aborts the run and waits for cleanup before output, close, and handler removal", async (signal, expectedCode) => {
      const interrupts = process.listeners("SIGINT"), terminations = process.listeners("SIGTERM");
      let release!: () => void;
      const cleanup = new Promise<void>(resolve => { release = resolve; });
      let runSignal: AbortSignal | undefined;
      mock.run.mockImplementation(async (_id: string, _version: number, options: RunOptions) => {
        runSignal = options.signal;
        await cleanup;
        return { ...goal, owner: null, status: "interrupted" };
      });
      const pending = run(["run", goal.id, "--version", "7"]);
      expect(runSignal).toBeInstanceOf(AbortSignal);
      const existing = signal === "SIGINT" ? interrupts : terminations;
      const handler = process.listeners(signal).find(listener => !existing.includes(listener))!;
      expect(handler).toBeTypeOf("function");
      try {
        handler(signal);
        expect(runSignal!.aborted).toBe(true);
        expect(runSignal!.reason).toMatchObject({ code: "GOAL_INTERRUPTED" });
        expect(mock.output).not.toHaveBeenCalled();
        expect(mock.close).not.toHaveBeenCalled();
        expect(process.listeners(signal)).toContain(handler);
        handler(signal); // Repeated interruption still waits for the same cleanup.
      } finally {
        release();
        await pending;
      }
      expect(result()).toMatchObject({ status: "interrupted", owner: null });
      expect(process.exitCode).toBe(expectedCode);
      expect(mock.close).toHaveBeenCalledTimes(1);
      expect(process.listeners("SIGINT")).toEqual(interrupts);
      expect(process.listeners("SIGTERM")).toEqual(terminations);
    },
  );

  it.each(["ready", "failed", "interrupted", "waiting_user", "reconciliation_required"])("reports %s as an unsuccessful run", async status => {
    mock.run.mockResolvedValue({ ...goal, status });
    await run(["run", goal.id, "--version", "7"]);
    expect(result().status).toBe(status);
    expect(process.exitCode).toBe(1);
  });

  it("uses readable error output when JSON was not requested", async () => {
    mock.get.mockImplementation(() => { throw new Error("Unknown goal."); });
    await run(["show", "missing"], false);
    expect(mock.error).toHaveBeenCalledWith("Unknown goal.");
    expect(mock.output).not.toHaveBeenCalled();
    expect(mock.close).toHaveBeenCalledTimes(1);
  });

  it("persists and controls a fixture goal across compiled CLI processes without model configuration", async () => {
    const { StateManager, createWorkManifest, saveWorkManifest } = await vi.importActual<typeof import("@actalk/inkos-core")>("@actalk/inkos-core");
    const root = await mkdtemp(join(tmpdir(), "inkos-goal-cli-"));
    try {
      await saveWorkManifest(root, createWorkManifest({ id: "novel", title: "Fixture", profileId: "longform-novel", language: "en" }));
      const now = new Date().toISOString();
      await new StateManager(root).saveBookConfig("novel", {
        id: "novel", title: "Fixture", genre: "general", platform: "other", status: "active",
        targetChapters: 5, chapterWordCount: 100, language: "en", createdAt: now, updatedAt: now,
      });
      const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
      const invoke = (args: string[], expectedStatus = 0) => {
        const response = spawnSync(process.execPath, [cli, "goal", ...args, "--json"], {
          cwd: root, encoding: "utf8", timeout: 15_000, env: { ...process.env, HOME: root },
        });
        expect(response.error).toBeUndefined();
        expect(response.status, response.stderr + response.stdout).toBe(expectedStatus);
        return JSON.parse(response.stdout);
      };
      const created = invoke(createArguments);
      expect(created).toMatchObject({
        id: goal.id, workId: "novel", status: "paused", desiredState: "paused", version: 0,
        completedSteps: 0, totalSteps: 2, nextStepId: "chapter-4", execution: "foreground",
        acceptance: "Committed chapters with settled state; not editorial approval or publication.",
      });
      expect(invoke(createArguments)).toEqual(created);
      expect(invoke(["show", goal.id, "--work", "novel"])).toEqual(created);
      expect(invoke(["list", "--work", "novel"])).toEqual([created]);
      expect(invoke(["list", "--work", "other"])).toEqual([]);
      expect(invoke(["events", goal.id])).toMatchObject({ nextAfterSeq: 0, events: [{ seq: 0, type: "goal-created" }] });
      const paused = invoke(["pause", goal.id, "--version", String(created.version)]);
      const recovered = invoke(["recover", goal.id, "--version", String(paused.version)]);
      expect(recovered.status).toBe("paused");
      const cancelled = invoke(["cancel", goal.id, "--version", String(recovered.version)]);
      expect(cancelled.status).toBe("cancelled");
      expect(invoke(["show", goal.id])).toEqual(cancelled);
      expect(invoke(["show", goal.id, "--work", "other"], 1).code).toBe("GOAL_WORK_SCOPE_MISMATCH");
      expect(invoke(["pause", goal.id, "--version", "0"], 1).code).toBe("GOAL_VERSION_CONFLICT");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
