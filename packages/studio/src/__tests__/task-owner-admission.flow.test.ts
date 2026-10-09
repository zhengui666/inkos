import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionConfig } from "@actalk/inkos-core";
import type { StudioTaskSnapshot } from "../api/task-store.js";

const fixture = vi.hoisted(() => ({
  beforeAppend: undefined as (() => Promise<void>) | undefined,
  beforeLoadSession: undefined as (() => Promise<void>) | undefined,
  appendCalls: 0,
  beforeTransition: undefined as (() => Promise<void>) | undefined,
  tool: vi.fn(),
  model: vi.fn(),
  writes: [] as StudioTaskSnapshot[],
  beforeTaskCommit: undefined as ((snapshot: StudioTaskSnapshot) => Promise<void>) | undefined,
}));

// Only production/model work and explicit fault injection are fixtures. The
// public ownership helper, task store, server and ordinary atomic commits run.
vi.mock("@actalk/inkos-core", async importOriginal => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return {
    ...actual,
    appendManualSessionMessages: async (...args: Parameters<typeof actual.appendManualSessionMessages>) => {
      fixture.appendCalls++;
      await fixture.beforeAppend?.();
      return actual.appendManualSessionMessages(...args);
    },
    transitionSessionToWork: async (...args: Parameters<typeof actual.transitionSessionToWork>) => {
      await fixture.beforeTransition?.();
      return actual.transitionSessionToWork(...args);
    },
    createShortFictionRunTool: (...args: Parameters<typeof actual.createShortFictionRunTool>) => {
      const tool = actual.createShortFictionRunTool(...args);
      return { ...tool, parameters: { ...tool.parameters, required: [] }, execute: fixture.tool };
    },
    runAgentSession: fixture.model,
    loadBookSession: async (...args: Parameters<typeof actual.loadBookSession>) => {
      await fixture.beforeLoadSession?.();
      return actual.loadBookSession(...args);
    },
    commitAtomicFileSet: async (input: Parameters<typeof actual.commitAtomicFileSet>[0]) => {
      for (const write of input.writes) {
        if (!write.relativePath.replaceAll("\\", "/").startsWith(".inkos/tasks/")) continue;
        const snapshot = JSON.parse(String(write.content)) as StudioTaskSnapshot;
        fixture.writes.push(snapshot);
        await fixture.beforeTaskCommit?.(snapshot);
      }
      await actual.commitAtomicFileSet(input);
    },
  };
});

import { createOwnershipLockSpace, createAndPersistBookSession, createWorkManifest, saveWorkManifest, createShortFictionRunTool, SQLITE_OWNER_TOKEN_PREFIX } from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "../api/server.js";
import {
  loadStudioTaskSnapshot,
  reserveStudioTaskExecution,
  saveStudioTaskSnapshot,
  studioTaskSnapshotPath,
} from "../api/task-store.js";

const roots: string[] = [];
const apps: ReturnType<typeof createStudioServer>[] = [];
const children: ChildProcess[] = [];
const requests: Promise<Response>[] = [];
const gates: Array<() => void> = [];
const toolResult = { content: [{ type: "text", text: "Deterministic fixture tool completed." }], details: {} };
const post = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  gates.push(resolve);
  return { promise, resolve };
}

beforeEach(() => {
  fixture.beforeAppend = undefined;
  fixture.beforeLoadSession = undefined;
  fixture.appendCalls = 0;
  fixture.beforeTransition = undefined;
  fixture.writes = [];
  fixture.beforeTaskCommit = undefined;
  fixture.tool.mockReset().mockResolvedValue(toolResult);
  fixture.model.mockReset().mockResolvedValue({ responseText: "Deterministic fixture response." });
});

afterEach(async () => {
  for (const resolve of gates.splice(0)) resolve();
  await Promise.allSettled(requests.splice(0));
  await Promise.all(apps.splice(0).map(shutdownStudioServer));
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, "exit");
    child.kill("SIGKILL");
    await ended;
  }));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), "inkos-task-owner-flow-"));
  roots.push(root);
  await mkdir(join(root, ".inkos"));
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "Owner fixture", version: "0.1.0", language: "en" }));
  // Create and initialize the actual ledger before simultaneous child startup.
  createOwnershipLockSpace(join(root, ".inkos", "harness.sqlite"));
  return root;
}

function server(root: string) {
  const app = createStudioServer({} as never, root);
  apps.push(app);
  return app;
}

async function session(root: string, sessionId = "fixture-session") {
  await createAndPersistBookSession(root, null, sessionId, "short");
  return sessionId;
}

function confirm(app: ReturnType<typeof createStudioServer>, sessionId: string) {
  const request = Promise.resolve(app.request("/api/v1/agent", post({
    sessionId, sessionKind: "short", instruction: "Produce the deterministic fixture.",
    actionSource: "button", requestedIntent: "short_run",
    actionPayload: { shortRun: { direction: "A clockmaker repairs one clock.", language: "en", cover: false } },
  })));
  requests.push(request);
  return request;
}

function snapshot(sessionId: string, executionId: string): StudioTaskSnapshot {
  return {
    version: 1, sessionId, requestedIntent: "short_run", updatedAt: 20,
    execution: {
      id: executionId, tool: "short-fiction__short_fiction_run", label: "Fixture task",
      status: "running", startedAt: 10, args: { direction: "Fixture" },
      logs: ["Saved fixture progress"], details: { receipt: "preserve-me" },
    },
  };
}

async function assertOwnerReleased(root: string, sessionId: string) {
  const lease = await reserveStudioTaskExecution(root, sessionId, "replacement-fixture");
  expect(lease).not.toBeNull();
  await lease?.release();
}

describe("Studio task ownership through two real servers", () => {
  it("keeps the other server's live task unchanged, rejects confirmation, and allows contextual chat", async () => {
    const root = await project(), sessionId = await session(root);
    const first = server(root), second = server(root), hold = gate();
    fixture.tool.mockImplementation(async () => { await hold.promise; return toolResult; });
    const pending = confirm(first, sessionId);
    await vi.waitFor(() => expect(fixture.tool).toHaveBeenCalledTimes(1));
    const path = studioTaskSnapshotPath(root, sessionId), before = await readFile(path, "utf8");
    const saved = JSON.parse(before) as StudioTaskSnapshot;
    expect(saved.owner?.token.startsWith(SQLITE_OWNER_TOKEN_PREFIX)).toBe(true);

    const detail = await (await second.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(detail.task).toMatchObject({ owner: saved.owner, execution: { id: saved.execution.id, status: "running" } });
    expect(detail.task.execution.error).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(before);
    const rejected = await confirm(second, sessionId);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "PRODUCTION_TASK_ALREADY_RUNNING" } });
    expect(fixture.tool.mock.calls.length + fixture.model.mock.calls.length).toBe(1);
    expect(await readFile(path, "utf8")).toBe(before);

    const chat = await second.request("/api/v1/agent", post({ sessionId, instruction: "What is the running task doing?", clientRequestId: "context-chat" }));
    expect(chat.status, await chat.clone().text()).toBe(200);
    expect(fixture.model.mock.calls[0]?.[0]).toMatchObject({ suppressProductionTools: true, backgroundTaskContext: expect.stringContaining(saved.execution.tool) });
    expect(await readFile(path, "utf8")).toBe(before);
    hold.resolve();
    expect((await pending).status).toBe(200);
    await assertOwnerReleased(root, sessionId);
  });

  it("holds admission before the first snapshot commit and invokes no losing tool", async () => {
    const root = await project(), sessionId = await session(root);
    const first = server(root), second = server(root), hold = gate();
    fixture.beforeTaskCommit = async () => { await hold.promise; };
    const pending = confirm(first, sessionId);
    await vi.waitFor(() => expect(fixture.writes).toHaveLength(1));
    expect(fixture.tool).not.toHaveBeenCalled();
    expect((await confirm(second, sessionId)).status).toBe(409);
    expect(fixture.tool).not.toHaveBeenCalled();
    hold.resolve();
    expect((await pending).status).toBe(200);
    expect(fixture.tool).toHaveBeenCalledTimes(1);
  });

  it("preserves the legitimate completed-to-running continuation with the same lease", async () => {
    const root = await project(), sessionId = await session(root);
    const first = server(root), second = server(root), hold = gate();
    fixture.model.mockImplementation(async () => { await hold.promise; return { responseText: "Continuation completed." }; });
    const pending = confirm(first, sessionId);
    await vi.waitFor(() => expect(fixture.model).toHaveBeenCalledTimes(1));
    expect(fixture.writes.map(value => value.execution.status)).toEqual(["running", "completed", "running"]);
    expect(new Set(fixture.writes.map(value => value.owner?.token)).size).toBe(1);
    const detail = await (await second.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(detail.task.execution.status).toBe("running");
    expect((await confirm(second, sessionId)).status).toBe(409);
    hold.resolve();
    expect((await pending).status).toBe(200);
    expect((await loadStudioTaskSnapshot(root, sessionId))?.execution.status).toBe("completed");
    await assertOwnerReleased(root, sessionId);
  });

  it.each(["first snapshot", "tool", "continuation"])("releases ownership after %s failure", async stage => {
    const root = await project(), sessionId = await session(root), app = server(root);
    const failure = new Error(`Deterministic ${stage} failure`);
    if (stage === "first snapshot") {
      fixture.beforeTaskCommit = async () => { fixture.beforeTaskCommit = undefined; throw failure; };
    } else if (stage === "tool") fixture.tool.mockRejectedValueOnce(failure);
    else fixture.model.mockRejectedValueOnce(failure);
    const response = await confirm(app, sessionId);
    expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(500);
    if (stage === "first snapshot") {
      expect(fixture.tool).not.toHaveBeenCalled();
      expect(fixture.model).not.toHaveBeenCalled();
      expect(await loadStudioTaskSnapshot(root, sessionId)).toBeNull();
    }
    else {
      expect(fixture.tool).toHaveBeenCalledTimes(1);
      expect(fixture.model).toHaveBeenCalledTimes(stage === "continuation" ? 1 : 0);
      const saved = await loadStudioTaskSnapshot(root, sessionId);
      expect(saved?.execution.status).toBe("error");
      if (stage === "tool") expect(saved?.execution.error).toContain(failure.message);
    }
    await assertOwnerReleased(root, sessionId);
  });

  it("surfaces a release settlement failure and still frees the kernel lock", async () => {
    const root = await project(), sessionId = await session(root), app = server(root);
    fixture.model.mockRejectedValueOnce(new Error("Deterministic continuation failure"));
    let injected = false;
    fixture.beforeTaskCommit = async value => {
      if (value.execution.status !== "error") return;
      injected = true;
      fixture.beforeTaskCommit = undefined;
      throw new Error("Deterministic release settlement failure");
    };
    const response = await confirm(app, sessionId);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await response.text()).toContain("Deterministic release settlement failure");
    expect(injected).toBe(true);
    expect(fixture.tool).toHaveBeenCalledTimes(1);
    expect(fixture.model).toHaveBeenCalledTimes(1);
    await assertOwnerReleased(root, sessionId);
  });

  it("keeps ownership while deletion drains and fences late task callbacks", async () => {
    const root = await project(), sessionId = await session(root), app = server(root), hold = gate();
    let progress: ((value: typeof toolResult) => void) | undefined;
    fixture.tool.mockImplementation(async (_id, _params, _signal, onUpdate) => {
      progress = onUpdate;
      await hold.promise;
      return toolResult;
    });
    const pending = confirm(app, sessionId);
    await vi.waitFor(() => expect(fixture.tool).toHaveBeenCalledTimes(1));
    expect((await app.request(`/api/v1/sessions/${sessionId}`, { method: "DELETE" })).status).toBe(200);
    progress?.(toolResult);
    expect(await reserveStudioTaskExecution(root, sessionId, "too-early")).toBeNull();
    expect(await loadStudioTaskSnapshot(root, sessionId)).toBeNull();
    hold.resolve();
    await pending;
    progress?.(toolResult);
    await new Promise<void>(done => setImmediate(done));
    expect(await loadStudioTaskSnapshot(root, sessionId)).toBeNull();
    await assertOwnerReleased(root, sessionId);
  });

  it("conservatively preserves an ownerless legacy running task and rejects admission", async () => {
    const root = await project(), sessionId = await session(root);
    await saveStudioTaskSnapshot(root, snapshot(sessionId, "legacy-running"));
    const app = server(root), path = studioTaskSnapshotPath(root, sessionId), before = await readFile(path, "utf8");
    const detail = await (await app.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(detail.task.execution).toMatchObject({ id: "legacy-running", status: "running" });
    expect(detail.task.owner).toBeUndefined();
    expect((await confirm(app, sessionId)).status).toBe(409);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(fixture.tool).not.toHaveBeenCalled();
    expect(fixture.model).not.toHaveBeenCalled();
  });
});

interface ChildResult { acquired: boolean; owner?: { pid: number; token: string } }

async function ownerChild(root: string, sessionId: string, executionId: string, persist = false) {
  const directory = await mkdtemp(join(tmpdir(), "inkos-task-owner-child-"));
  roots.push(directory);
  const script = join(directory, "owner.mts"), config = join(directory, "tsconfig.json");
  const core = fileURLToPath(new URL("../../../core/src/index.ts", import.meta.url));
  const store = new URL("../api/task-store.ts", import.meta.url).href;
  await writeFile(config, JSON.stringify({ compilerOptions: { baseUrl: "/", paths: { "@actalk/inkos-core": [core] } } }));
  await writeFile(script, `
import { reserveStudioTaskExecution, saveStudioTaskSnapshot } from ${JSON.stringify(store)};
const command = () => new Promise(resolve => process.once('message', resolve));
try {
  const start = command();
  process.send({ type: 'ready' });
  await start;
  const [root, sessionId, executionId, persist] = process.argv.slice(2);
  const lease = await reserveStudioTaskExecution(root, sessionId, executionId);
  if (lease && persist === 'yes') await saveStudioTaskSnapshot(root, ${JSON.stringify(snapshot(sessionId, executionId))});
  const release = command();
  process.send({ type: 'result', acquired: !!lease, owner: lease?.owner });
  if (lease) { await release; await lease.release(); }
  process.disconnect();
} catch (error) {
  process.send({ type: 'error', message: error?.stack ?? String(error) });
  process.exitCode = 1;
  process.disconnect();
}
`);
  const child = fork(script, [root, sessionId, executionId, persist ? "yes" : "no"], {
    execArgv: ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href], silent: true,
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { ...process.env, TSX_TSCONFIG_PATH: config },
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", data => { stderr += String(data); });
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let resultResolve!: (value: ChildResult) => void, resultReject!: (error: Error) => void;
  const result = new Promise<ChildResult>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  void ready.catch(() => undefined);
  void result.catch(() => undefined);
  child.on("message", (message: { type?: string; message?: string } & ChildResult) => {
    if (message.type === "ready") readyResolve();
    else if (message.type === "result") resultResolve(message);
    else if (message.type === "error") {
      const error = new Error(message.message);
      readyReject(error); resultReject(error);
    }
  });
  child.on("error", error => { readyReject(error); resultReject(error); });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => {
    const error = new Error(`Owner child exited (${code ?? signal}): ${stderr}`);
    readyReject(error); resultReject(error);
    resolve({ code, signal });
  }));
  await ready;
  return {
    child, result, ended,
    start() { child.send("start"); },
    async release() {
      if (child.connected) child.send("release");
      expect((await ended).code, stderr).toBe(0);
    },
  };
}

describe("Studio task ownership in real child processes", () => {
  it.each(["same session", "different sessions", "symlink alias"])("enforces kernel admission for %s", async scenario => {
    const root = await project();
    let secondRoot = root;
    if (scenario === "symlink alias") {
      secondRoot = join(root, "alias");
      await symlink(root, secondRoot, process.platform === "win32" ? "junction" : "dir");
    }
    const first = await ownerChild(root, "shared-session", "first");
    const second = await ownerChild(secondRoot, scenario === "different sessions" ? "other-session" : "shared-session", "second");
    first.start(); second.start();
    const results = await Promise.all([first.result, second.result]);
    expect(results.filter(value => value.acquired)).toHaveLength(scenario === "different sessions" ? 2 : 1);
    for (const value of results.filter(value => value.acquired)) expect(value.owner?.token.startsWith(SQLITE_OWNER_TOKEN_PREFIX)).toBe(true);
    await Promise.all([first.release(), second.release()]);
  });

  it("recovers a killed owner exactly once despite a reused live PID and never restarts production", async () => {
    const root = await project(), sessionId = await session(root), app = server(root);
    const owner = await ownerChild(root, sessionId, "killed-task", true);
    owner.start();
    expect((await owner.result).acquired).toBe(true);
    const path = studioTaskSnapshotPath(root, sessionId), before = await readFile(path, "utf8");
    const live = await (await app.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(live.task.execution.status).toBe("running");
    expect(await readFile(path, "utf8")).toBe(before);
    owner.child.kill("SIGKILL");
    await owner.ended;
    // The protocol token is authoritative even when the persisted PID now
    // belongs to a live, unrelated process (the test runner itself).
    const reused = { ...JSON.parse(before), owner: { ...(JSON.parse(before).owner), pid: process.pid } };
    await writeFile(path, `${JSON.stringify(reused, null, 2)}\n`);
    const recovered = await (await app.request(`/api/v1/sessions/${sessionId}`)).json();
    expect(recovered.task).toMatchObject({
      owner: reused.owner,
      execution: { id: "killed-task", status: "error", completedAt: expect.any(Number), logs: ["Saved fixture progress"], details: { receipt: "preserve-me" } },
    });
    const terminal = await readFile(path, "utf8");
    expect((await (await app.request(`/api/v1/sessions/${sessionId}`)).json()).task).toEqual(recovered.task);
    expect(await readFile(path, "utf8")).toBe(terminal);
    expect(fixture.writes.filter(value => value.execution.id === "killed-task")).toHaveLength(1);
    expect(fixture.tool).not.toHaveBeenCalled();
    expect(fixture.model).not.toHaveBeenCalled();
    await assertOwnerReleased(root, sessionId);
  });
});


describe("Studio ownership before the first task snapshot", () => {
  it("suppresses production after tool completion until its retained-owner continuation starts", async () => {
    const root = await project(), sessionId = await session(root), first = server(root), second = server(root), hold = gate(), entered = gate();
    const workId = "fixture-created-work";
    await saveWorkManifest(root, createWorkManifest({ id: workId, title: "Fixture", profileId: "short-fiction", language: "en" }));
    await mkdir(join(root, "works", workId, "source"));
    fixture.tool.mockResolvedValue({ ...toolResult, details: { workId } });
    fixture.beforeTransition = async () => { entered.resolve(); await hold.promise; };
    const pending = confirm(first, sessionId);
    await Promise.race([entered.promise, pending.then(async response => { throw new Error(await response.text()); })]);
    expect((await loadStudioTaskSnapshot(root, sessionId))?.execution.status).toBe("completed");
    const response = await chat(second, sessionId, "completed-before-continuation");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(fixture.model.mock.calls[0]?.[0]).toMatchObject({ suppressProductionTools: true });
    expect(fixture.model.mock.calls[0]?.[0].backgroundTaskContext).toBeUndefined();
    expect(fixture.tool).toHaveBeenCalledTimes(1);
    hold.resolve();
    expect((await pending).status).toBe(200);
    expect(fixture.writes.map(value => value.execution.status)).toEqual(["running", "completed", "running", "completed"]);
    expect(fixture.model.mock.calls[1]?.[0]).toMatchObject({ resumeAction: expect.any(Object) });
    expect(fixture.model.mock.calls[1]?.[0].suppressProductionTools).not.toBe(true);
    await assertOwnerReleased(root, sessionId);
  });

  it("suppresses another server's chat production while initial transcript persistence is paused", async () => {
    const root = await project(), sessionId = await session(root), first = server(root), second = server(root), hold = gate();
    fixture.beforeAppend = async () => { await hold.promise; };
    const pending = confirm(first, sessionId);
    await vi.waitFor(() => expect(fixture.appendCalls).toBe(1));
    expect(await loadStudioTaskSnapshot(root, sessionId)).toBeNull();
    expect(await reserveStudioTaskExecution(root, sessionId, "concurrent-confirmation")).toBeNull();
    const escapedProduction = vi.fn();
    fixture.model.mockImplementationOnce(async config => {
      if (!config.suppressProductionTools) escapedProduction();
      expect(config.backgroundTaskContext).toBeUndefined();
      return { responseText: "The task has been admitted." };
    });
    const chat = await second.request("/api/v1/agent", post({ sessionId, instruction: "What is the running task doing?", clientRequestId: "pre-snapshot-chat" }));
    expect(chat.status, await chat.clone().text()).toBe(200);
    expect(fixture.model.mock.calls[0]?.[0]).toMatchObject({ suppressProductionTools: true });
    expect(escapedProduction).not.toHaveBeenCalled();
    expect(fixture.tool).not.toHaveBeenCalled();
    expect(await loadStudioTaskSnapshot(root, sessionId)).toBeNull();
    hold.resolve();
    await pending;
    expect(fixture.tool).toHaveBeenCalledTimes(1);
    expect(fixture.model.mock.calls[1]?.[0]).toMatchObject({ resumeAction: expect.any(Object) });
    expect(fixture.model.mock.calls[1]?.[0].suppressProductionTools).not.toBe(true);
    await assertOwnerReleased(root, sessionId);
  });
});


// Exercise the real awaited Agent tool-start / argument / execute path without
// opening a model connection. Only the business tool body is a fixture.
async function executeChatTool(config: AgentSessionConfig, options: {
  name?: string;
  beforeToolCall?: () => Promise<void>;
  prepareArguments?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  execute: () => Promise<typeof toolResult>;
}) {
  const { Agent } = await import(fileURLToPath(new URL("../../../core/src/codex/agent.ts", import.meta.url)));
  const tool = createShortFictionRunTool(config.pipeline, config.projectRoot);
  const name = options.name ?? "short-fiction__short_fiction_run";
  const agent = new Agent({
    projectRoot: config.projectRoot,
    beforeToolCall: options.beforeToolCall,
    initialState: {
      model: { id: "deterministic-fixture" }, systemPrompt: "Fixture", messages: [],
      tools: [{ ...tool, name, prepareArguments: options.prepareArguments, execute: options.execute }],
    },
  });
  agent.subscribe(config.onEvent);
  await agent.executeTool({ type: "toolCall", id: "ordinary-chat-tool", name, arguments: {} }, config.signal ?? new AbortController().signal);
  return { responseText: "Deterministic fixture response." };
}

function chat(app: ReturnType<typeof createStudioServer>, sessionId: string, requestId: string) {
  const pending = Promise.resolve(app.request("/api/v1/agent", post({ sessionId, instruction: "Run the fixture chat tool.", clientRequestId: requestId })));
  requests.push(pending);
  return pending;
}

describe("Studio owner guard at real Agent tool admission", () => {
  it("blocks a chat tool when confirmation acquires ownership after the initial chat check", async () => {
    const root = await project(), sessionId = await session(root), first = server(root), second = server(root);
    const modelReady = gate(), startTool = gate(), transcript = gate();
    const chatTool = vi.fn().mockResolvedValue(toolResult);
    fixture.model.mockImplementationOnce(async config => {
      expect(config.suppressProductionTools).not.toBe(true);
      modelReady.resolve();
      await startTool.promise;
      return executeChatTool(config, { execute: chatTool });
    });
    const chatting = chat(second, sessionId, "chat-before-confirmation");
    await modelReady.promise;
    fixture.beforeAppend = async () => { await transcript.promise; };
    const confirmed = confirm(first, sessionId);
    await vi.waitFor(() => expect(fixture.appendCalls).toBe(1));
    expect(await loadStudioTaskSnapshot(root, sessionId)).toBeNull();
    startTool.resolve();
    const response = await chatting;
    expect(response.status, await response.clone().text()).toBe(409);
    expect((await response.json()).error.code).toBe("PRODUCTION_TASK_ALREADY_RUNNING");
    expect(chatTool).not.toHaveBeenCalled();
    transcript.resolve();
    await confirmed;
    expect(fixture.tool).toHaveBeenCalledTimes(1);
    await assertOwnerReleased(root, sessionId);
  });

  it.each(["arguments", "prepare", "tool", "failure", "cancel", "settlement", "model failure"])("holds the chat owner through %s and releases only after drain", async stage => {
    const root = await project(), sessionId = await session(root), first = server(root), second = server(root), hold = gate(), entered = gate();
    const chatTool = vi.fn(async () => {
      if (!["arguments", "prepare", "settlement", "model failure"].includes(stage)) { entered.resolve(); await hold.promise; }
      if (stage === "failure") throw new Error("Deterministic chat tool failure");
      return toolResult;
    });
    fixture.model.mockImplementationOnce(async config => {
      const result = await executeChatTool(config, {
        ...(stage === "arguments" ? { prepareArguments: async (args: Record<string, unknown>) => { entered.resolve(); await hold.promise; return args; } } : {}),
        ...(stage === "prepare" ? { beforeToolCall: async () => { entered.resolve(); await hold.promise; } } : {}),
        execute: chatTool,
      });
      if (stage === "settlement" || stage === "model failure") {
        entered.resolve();
        await hold.promise;
        if (stage === "model failure") throw new Error("Deterministic model settlement failure");
      }
      return result;
    });
    const chatting = chat(first, sessionId, `chat-${stage}`);
    await entered.promise;
    expect(await loadStudioTaskSnapshot(root, sessionId)).toBeNull();
    expect((await confirm(second, sessionId)).status).toBe(409);
    expect(fixture.tool).not.toHaveBeenCalled();
    if (stage === "prepare") {
      const remote = await ownerChild(root, sessionId, "cross-process-chat-contender");
      remote.start();
      expect((await remote.result).acquired).toBe(false);
      await remote.release();
    }
    if (stage === "cancel") {
      const stopping = await first.request(`/api/v1/sessions/${sessionId}/abort?scope=chat`, { method: "POST" });
      expect(await stopping.json()).toMatchObject({ aborted: true });
    }
    const tooSoon = await reserveStudioTaskExecution(root, sessionId, "before-drain");
    try { expect(tooSoon).toBeNull(); } finally { await tooSoon?.release(); }
    hold.resolve();
    await chatting;
    expect(chatTool).toHaveBeenCalledTimes(1);
    await assertOwnerReleased(root, sessionId);
  });

  it("allows an initially suppressed chat to execute read tools without taking the owner's lock", async () => {
    const root = await project(), sessionId = await session(root), first = server(root), second = server(root), hold = gate();
    fixture.beforeAppend = async () => { await hold.promise; };
    const confirmed = confirm(first, sessionId);
    await vi.waitFor(() => expect(fixture.appendCalls).toBe(1));
    const read = vi.fn().mockResolvedValue(toolResult);
    fixture.model.mockImplementationOnce(config => {
      expect(config.suppressProductionTools).toBe(true);
      return executeChatTool(config, { name: "workspace__read", execute: read });
    });
    const response = await chat(second, sessionId, "read-while-confirmed");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await reserveStudioTaskExecution(root, sessionId, "still-owned")).toBeNull();
    hold.resolve();
    await confirmed;
    await assertOwnerReleased(root, sessionId);
  });
});

describe('Independent ABC cancellation boundary', () => {
  it('does not report completed if stopped while final continuation completion commit is still pending', async () => {
    const root = await project(), sessionId = await session(root), app = server(root), entered = gate(), hold = gate();
    let completedWrites = 0;
    fixture.beforeTaskCommit = async value => {
      if (value.execution.status === 'completed' && ++completedWrites === 2) { entered.resolve(); await hold.promise; }
    };
    const pending = confirm(app, sessionId);
    await Promise.race([entered.promise, pending.then(async response => { throw new Error(await response.clone().text()); })]);
    const before = JSON.parse(await readFile(studioTaskSnapshotPath(root, sessionId), 'utf8'));
    expect(before.execution.status).toBe('running');
    const abort = await app.request(`/api/v1/sessions/${sessionId}/abort`, { method: 'POST' });
    expect(await abort.json()).toMatchObject({ aborted: true });
    hold.resolve();
    const result = await pending;
    const saved = await loadStudioTaskSnapshot(root, sessionId);
    console.log('INDEPENDENT_FINAL_COMMIT_CANCEL', JSON.stringify({ responseStatus: result.status, savedStatus: saved?.execution.status, modelSignalAborted: fixture.model.mock.calls[0]?.[0].signal.aborted }));
    expect(saved?.execution.status).not.toBe('completed');
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: 'PRODUCTION_TASK_CANCELLED', message: 'The production task was stopped.' } });
    expect(saved?.execution.status).toBe('error');
    expect(saved?.execution.error).toBe('The production task was stopped.');
    expect(saved?.execution.result).toBe('Deterministic fixture tool completed.');
    expect(saved?.execution.details).toMatchObject({ requestedIntent: 'short_run' });
    expect(fixture.tool).toHaveBeenCalledTimes(1);
    await assertOwnerReleased(root, sessionId);
  });

  it('does not leave completed when stopped after initial tool receipt but before continuation starts', async () => {
    const root = await project(), sessionId = await session(root), app = server(root), entered = gate(), hold = gate();
    const workId = 'independent-created-work';
    await saveWorkManifest(root, createWorkManifest({ id: workId, title: 'Fixture', profileId: 'short-fiction', language: 'en' }));
    await mkdir(join(root, 'works', workId, 'source'));
    fixture.tool.mockResolvedValue({ ...toolResult, details: { workId } });
    fixture.beforeTransition = async () => { entered.resolve(); await hold.promise; };
    const pending = confirm(app, sessionId);
    await Promise.race([entered.promise, pending.then(async response => { throw new Error(await response.clone().text()); })]);
    expect((await loadStudioTaskSnapshot(root, sessionId))?.execution.status).toBe('completed');
    const abort = await app.request(`/api/v1/sessions/${sessionId}/abort`, { method: 'POST' });
    expect(await abort.json()).toMatchObject({ aborted: true });
    hold.resolve();
    const result = await pending;
    const saved = await loadStudioTaskSnapshot(root, sessionId);
    console.log('INDEPENDENT_PRE_CONTINUATION_CANCEL', JSON.stringify({ responseStatus: result.status, savedStatus: saved?.execution.status, continuationCalls: fixture.model.mock.calls.length }));
    expect(fixture.model).not.toHaveBeenCalled();
    expect(saved?.execution.status).not.toBe('completed');
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: 'PRODUCTION_TASK_CANCELLED', message: 'The production task was stopped.' } });
    expect(saved?.execution.status).toBe('error');
    expect(saved?.execution.error).toBe('The production task was stopped.');
    expect(saved?.execution.result).toBe('Deterministic fixture tool completed.');
    expect(saved?.execution.details).toMatchObject({ requestedIntent: 'short_run' });
    expect(fixture.tool).toHaveBeenCalledTimes(1);
    await assertOwnerReleased(root, sessionId);
  });
});


describe('Independent ABC success boundary', () => {
  it('rejects Stop for an old controller selected before the task settles', async () => {
    const root = await project(), sessionId = await session(root), app = server(root);
    const modelEntered = gate(), modelHold = gate(), finderSelected = gate(), finderHold = gate();
    const responseEntered = gate(), responseHold = gate();
    fixture.model.mockImplementation(async () => {
      modelEntered.resolve();
      await modelHold.promise;
      return { responseText: 'Deterministic fixture response.' };
    });
    const pending = confirm(app, sessionId);
    await Promise.race([modelEntered.promise, pending.then(async response => { throw new Error(await response.clone().text()); })]);
    const running = await loadStudioTaskSnapshot(root, sessionId);
    expect(running?.execution.status).toBe('running');

    // Hold only the async finder's return after it selects the real controller.
    // Then allow real final persistence and controller settlement to complete
    // before the abort handler resumes with that stale selection.
    let selected: AbortController | undefined;
    const get = Map.prototype.get;
    const lookup = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      const value = get.call(this, key);
      if (key === running!.execution.id && value instanceof AbortController && !selected) {
        selected = value;
        Object.defineProperty(value, 'then', {
          configurable: true,
          value: (resolve: (controller: AbortController) => void) => {
            finderSelected.resolve();
            void finderHold.promise.then(() => {
              Reflect.deleteProperty(value, 'then');
              resolve(value);
            });
          },
        });
      }
      return value;
    });
    try {
      const stopping = Promise.resolve(app.request(`/api/v1/sessions/${sessionId}/abort`, { method: 'POST' }));
      requests.push(stopping);
      await Promise.race([finderSelected.promise, stopping.then(async response => { throw new Error(await response.clone().text()); })]);
      lookup.mockRestore();
      fixture.beforeLoadSession = async () => { responseEntered.resolve(); await responseHold.promise; };
      modelHold.resolve();
      await Promise.race([responseEntered.promise, pending.then(async response => { throw new Error(await response.clone().text()); })]);
      expect((await loadStudioTaskSnapshot(root, sessionId))?.execution.status).toBe('completed');
      expect(await reserveStudioTaskExecution(root, sessionId, 'stale-controller-still-owned')).toBeNull();
      finderHold.resolve();
      expect(await (await stopping).json()).toMatchObject({ aborted: false });
      expect(selected?.signal.aborted).toBe(false);
      responseHold.resolve();
      expect((await pending).status).toBe(200);
      await assertOwnerReleased(root, sessionId);
    } finally {
      lookup.mockRestore();
      finderHold.resolve();
    }
  });

  it('reports Stop too late after successful completion selection while retaining owner until response drain', async () => {
    const root = await project(), sessionId = await session(root), app = server(root), entered = gate(), hold = gate();
    let completedWrites = 0;
    fixture.beforeTaskCommit = async value => {
      if (value.execution.status === 'completed' && ++completedWrites === 2) {
        fixture.beforeLoadSession = async () => { entered.resolve(); await hold.promise; };
      }
    };
    const pending = confirm(app, sessionId);
    await Promise.race([entered.promise, pending.then(async response => { throw new Error(await response.clone().text()); })]);
    expect((await loadStudioTaskSnapshot(root, sessionId))?.execution.status).toBe('completed');
    const abort = await app.request(`/api/v1/sessions/${sessionId}/abort`, { method: 'POST' });
    expect(await abort.json()).toMatchObject({ aborted: false });
    expect(await reserveStudioTaskExecution(root, sessionId, 'premature-after-success')).toBeNull();
    hold.resolve();
    expect((await pending).status).toBe(200);
    expect((await loadStudioTaskSnapshot(root, sessionId))?.execution.status).toBe('completed');
    await assertOwnerReleased(root, sessionId);
  });
});
