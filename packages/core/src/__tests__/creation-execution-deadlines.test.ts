import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../codex/agent.js";
import type { CodexClient, CodexRequestOptions } from "../codex/client.js";
import { resolveCodexModel } from "../codex/model.js";
import { withAgentRequestDeadline } from "../agent/execution-deadline.js";
import { withUnboundedWorkerExecution } from "../agent/worker-execution-policy.js";
import { CodexFixture } from "./codex-fixture.js";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("../codex/client.js", () => ({ createCodexClient: mocks.createClient }));
const settings = { model: "gpt-6.1-sol", reasoningEffort: "ultra" as const, serviceTier: "priority" as const };
function agent(signal?: AbortSignal, projectRoot = "/tmp/creation-deadline-test") {
  return new Agent({ projectRoot, signal, settings,
    initialState: { model: resolveCodexModel(settings), systemPrompt: "Create", tools: [], messages: [] } });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); mocks.createClient.mockReset(); });

describe("scoped creation execution deadlines", () => {
  it("removes only the scoped whole-agent deadline and keeps concurrent legacy requests bounded", async () => {
    vi.useFakeTimers();
    vi.stubEnv("INKOS_AGENT_TIMEOUT_MS", "50");
    const drain = deferred(), controller = new AbortController();
    const scoped = withUnboundedWorkerExecution(() => withAgentRequestDeadline(controller.signal, async signal => {
      expect(signal).toBe(controller.signal); await drain.promise; signal.throwIfAborted(); return "done";
    }));
    const legacy = withAgentRequestDeadline(undefined, signal => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })).then(() => null, error => error);
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60_000);
    expect(await legacy).toMatchObject({ code: "AGENT_REQUEST_TIMEOUT", timeoutMs: 50 });
    expect(controller.signal.aborted).toBe(false);
    drain.resolve();
    await expect(scoped).resolves.toBe("done");
  });

  it("retains already-aborted and mid-run cancellation through the scoped whole-agent wrapper", async () => {
    const controller = new AbortController();
    const running = withUnboundedWorkerExecution(() => withAgentRequestDeadline(controller.signal, signal => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    controller.abort(new Error("stop creation"));
    await expect(running).rejects.toThrow("stop creation");
    const task = vi.fn();
    await expect(withUnboundedWorkerExecution(() => withAgentRequestDeadline(controller.signal, task))).rejects.toThrow("stop creation");
    expect(task).not.toHaveBeenCalled();
  });

  it("does not reject scoped execution because a disabled deadline setting is malformed", async () => {
    vi.stubEnv("INKOS_AGENT_TIMEOUT_MS", "invalid");
    await expect(withUnboundedWorkerExecution(() => withAgentRequestDeadline(undefined, async signal => signal.aborted))).resolves.toBe(false);
    await expect(withAgentRequestDeadline(undefined, async () => true)).rejects.toThrow("INKOS_AGENT_TIMEOUT_MS");
  });

  it("lets a silent creation model complete after days while a concurrent legacy Agent still times out", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubEnv("INKOS_AGENT_IDLE_TIMEOUT_MS", "50");
    const creationEntered = deferred(), legacyEntered = deferred(), drain = deferred();
    const fixture = new CodexFixture(async turn => {
      if (turn.messages.at(-1)?.content === "creation") {
        creationEntered.resolve(); await drain.promise; return { text: "created after long reasoning" };
      }
      legacyEntered.resolve(); return { hold: true };
    });
    mocks.createClient.mockImplementation(fixture.createClient);
    const creationAgent = agent();
    const scoped = withUnboundedWorkerExecution(() => creationAgent.prompt("creation"));
    const legacy = agent().prompt("legacy").then(() => null, error => error);
    await Promise.all([creationEntered.promise, legacyEntered.promise]);
    await vi.advanceTimersByTimeAsync(3 * 24 * 60 * 60_000);
    expect(await legacy).toMatchObject({ code: "AGENT_MODEL_STALLED", idleTimeoutMs: 50 });
    drain.resolve();
    await scoped;
    expect(creationAgent.finalOutput).toBe("created after long reasoning");
    const threads = fixture.requests.filter(request => request.method === "thread/start");
    expect(threads).toHaveLength(2);
    for (const thread of threads) expect(thread.params).toMatchObject({ model: settings.model, serviceTier: "priority" });
    for (const turn of fixture.requests.filter(request => request.method === "turn/start")) {
      expect(turn.params).toMatchObject({ effort: "ultra", serviceTierForTurn: "priority" });
      expect(turn.params).not.toHaveProperty("serviceTier");
    }
    expect(fixture.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
  });

  it("still interrupts a silent scoped native Agent when the user stops it", async () => {
    vi.stubEnv("INKOS_AGENT_IDLE_TIMEOUT_MS", "invalid");
    const entered = deferred(), controller = new AbortController();
    const fixture = new CodexFixture(async () => { entered.resolve(); return { hold: true }; });
    mocks.createClient.mockImplementation(fixture.createClient);
    const running = withUnboundedWorkerExecution(() => agent(controller.signal).prompt("creation"));
    await entered.promise;
    controller.abort(new Error("user cancelled creation"));
    await expect(running).rejects.toThrow("user cancelled creation");
    expect(fixture.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
    await expect(agent().prompt("legacy")).rejects.toThrow("INKOS_AGENT_IDLE_TIMEOUT_MS");
  });

  it.each(["resolved", "rejected"] as const)("settles a delayed %s interrupt ACK before closing a stalled model peer", async ack => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubEnv("INKOS_AGENT_IDLE_TIMEOUT_MS", "50");
    vi.stubEnv("INKOS_CODEX_HOME", undefined);
    vi.stubEnv("INKOS_CODEX_STATE_ROOT", undefined);
    const root = await mkdtemp(join(tmpdir(), "inkos-interrupt-ack-"));
    const modelEntered = deferred(), interruptEntered = deferred(), releaseAck = deferred();
    const ackError = new Error("Synthetic interrupt ACK rejected");
    const events: Array<{ event: string; closed: boolean }> = [];
    const dispatchClosed: boolean[] = [], requestTimeouts: Array<number | undefined> = [];
    let modelPeer: CodexClient | undefined, settled = false;
    const fixture = new CodexFixture(() => { modelEntered.resolve(); return { hold: true }; });
    mocks.createClient.mockImplementation(async (projectRoot: string) => {
      const peer = await fixture.createClient(projectRoot);
      const request = peer.request.bind(peer), close = peer.close.bind(peer);
      peer.request = async <T>(method: string, params?: unknown, options?: CodexRequestOptions): Promise<T> => {
        if (method === "turn/start") modelPeer = peer;
        if (method !== "turn/interrupt") return request<T>(method, params, options);
        dispatchClosed.push(peer.closed); requestTimeouts.push(options?.timeoutMs);
        events.push({ event: "interrupt-request", closed: peer.closed });
        interruptEntered.resolve();
        // The real fixture must accept the request while open; hold only its ACK.
        const response = await request<T>(method, params, options);
        await releaseAck.promise;
        events.push({ event: `interrupt-ack-${ack}`, closed: peer.closed });
        if (ack === "rejected") throw ackError;
        return response;
      };
      peer.close = async () => {
        if (peer === modelPeer && !peer.closed) events.push({ event: "peer-close", closed: peer.closed });
        await close();
      };
      return peer;
    });
    const host = agent(undefined, root);
    const running = host.prompt("legacy");
    const observed = running.then(() => {
      settled = true; events.push({ event: "caller-resolved", closed: modelPeer?.closed ?? false });
      return undefined;
    }, error => {
      settled = true; events.push({ event: "caller-rejected", closed: modelPeer?.closed ?? false });
      return error;
    });
    try {
      expect(await Promise.race([modelEntered.promise.then(() => true), observed.then(() => false)])).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(await Promise.race([interruptEntered.promise.then(() => true), observed.then(() => false)])).toBe(true);
      expect(dispatchClosed).toEqual([false]);
      expect(requestTimeouts).toEqual([5000]);
      expect(fixture.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
      expect(modelPeer?.closed).toBe(false);
      expect(settled).toBe(false);
      expect(events).toEqual([{ event: "interrupt-request", closed: false }]);
      releaseAck.resolve();
      const error = await observed;
      expect(error).toMatchObject({ code: "AGENT_MODEL_STALLED", idleTimeoutMs: 50 });
      expect(error).not.toBe(ackError);
      expect(modelPeer?.closed).toBe(true);
      expect(events).toEqual([
        { event: "interrupt-request", closed: false },
        { event: `interrupt-ack-${ack}`, closed: false },
        { event: "peer-close", closed: false },
        { event: "caller-rejected", closed: true },
      ]);
      expect(fixture.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseAck.resolve(); host.abort();
      await observed;
      await fixture.close();
      await fixture.drain();
      console.info(`interrupt ACK ${ack} ordering: ${JSON.stringify(events)}`);
      await rm(root, { recursive: true, force: true });
    }
  });
});
