import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentConfigurationController, createAgentConfigurationTransport } from "./agent-configuration-controller";
import { unavailableHarnessState, type AgentSettings, type HarnessState } from "../shared/agent-configuration";

const target = { harness: "codex" as const, contextKey: "server-context" };
const piTarget = { harness: "pi" as const, contextKey: "unobserved" };
const native = { model: null, effort: null, speed: null };
const initial: AgentSettings = { schemaVersion: 1, revision: 0, selectedHarnessId: "codex", modelConnectionRef: null, harnessPreferences: { codex: native, pi: native } };
const handle = "server-reserved-attempt";
const login = { loginId: "provider-login-one", status: "pending" as const, verificationUrl: "https://auth.openai.com/codex/device", userCode: "PUBLIC-CODE" };
const closed = { attemptHandle: handle, state: "closed" as const, cleanup: "cancel-acknowledged" as const };
type Action = "reserve" | "start" | "close";
interface Call { action: Action; body: unknown; signal: AbortSignal; keepalive: boolean | undefined; aborted: boolean; rejection?: unknown; reply(value: unknown): void; reject(error: unknown): void }
function observed(phase: NonNullable<HarnessState["connection"]>["phase"] = "signed-out", generation: number | null = null): HarnessState {
  return { ...unavailableHarnessState("codex"), availability: "available", installation: "installed",
    scope: { harnessId: "codex", authContextRef: target.contextKey, ownerGeneration: generation, adapterVersion: "1", catalogVersion: "1" },
    account: phase === "signed-in" ? { type: "chatgpt", label: "Observed account" } : null,
    connection: { phase, login: phase === "signing-in" ? login : null, connectionRef: null } };
}

async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
const controllers: ReturnType<typeof createAgentConfigurationController>[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) controller.dispose(); for (const cleanup of cleanups.splice(0)) cleanup(); await flush(); vi.useRealTimers(); });

/** Real fetch abort semantics: mutation promises reject AbortError when their own signal aborts. */
function setup(timeout = 15_000) {
  const calls: Call[] = [];
  const held = new Set<Action>();
  const ignoreAbort = new Set<Action>();
  let state = observed();
  let reserveResponse = { reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } };
  let startResponse = { login };
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/settings")) return Response.json({ settings: initial });
    if (url.endsWith("/state")) return Response.json({ state: url.includes("/pi/") ? unavailableHarnessState("pi") : state });
    const action = url.endsWith("/login/reserve") ? "reserve" : url.endsWith("/login/close") ? "close" : url.endsWith("/login") ? "start" : undefined;
    if (!action) throw new Error(`Unexpected fixture HTTP request: ${url}`);
    const signal = init?.signal as AbortSignal;
    let resolve!: (response: Response) => void; let reject!: (reason: unknown) => void;
    const pending = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    const call: Call = { action, body: JSON.parse(String(init?.body)), signal, keepalive: init?.keepalive, aborted: signal.aborted,
      reply: value => { signal.removeEventListener("abort", abort); resolve(Response.json(value)); },
      reject: reason => { call.rejection = reason; signal.removeEventListener("abort", abort); reject(reason); } };
    const abort = () => { call.aborted = true; if (!ignoreAbort.has(action)) call.reject(new DOMException("The request was aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true }); calls.push(call);
    const automatic = action === "reserve" ? reserveResponse : action === "start" ? startResponse : { result: closed };
    cleanups.push(() => call.reply(automatic));
    if (signal.aborted) abort(); else if (!held.has(action)) call.reply(automatic);
    return pending;
  });
  const transport = createAgentConfigurationTransport(fetchImpl);
  const controller = createAgentConfigurationController(transport, target, timeout); controllers.push(controller);
  const connect = () => controller.connectionIntent({ action: "connect", target: controller.getSnapshot().target });
  const edit = (choiceKey: string) => controller.edit({ action: "choose-option", field: "model", choiceKey, target: controller.getSnapshot().target });
  return { controller, transport, fetchImpl, calls, held, ignoreAbort, connect, edit,
    action: (name: Action) => calls.filter(call => call.action === name),
    state: (value: HarnessState) => { state = value; },
    reservation: (attemptHandle: string) => { reserveResponse = { reservation: { attemptHandle, expiresAt: Date.now() + 120_000 } }; },
    login: (loginId: string) => { startResponse = { login: { ...login, loginId } }; } };
}

async function beginHeldClose(value: ReturnType<typeof setup>) {
  value.held.add("close"); await value.controller.refresh(); value.connect(); await flush();
  value.state(observed("signing-in")); await value.controller.refreshState(); value.edit("codex-draft");
  value.controller.closeConnection(); await flush(); expect(value.action("close")).toHaveLength(1);
}
async function returnThroughContextAdoption(value: ReturnType<typeof setup>) {
  value.controller.selectTarget({ harness: "codex", contextKey: "unobserved" }); await value.controller.refresh();
  expect(value.controller.getSnapshot().target).toEqual(target);
}
function mutationCounts(value: ReturnType<typeof setup>) { return [value.action("reserve").length, value.action("start").length, value.action("close").length]; }

describe("shared Close receipt recovery has a current-page observer", () => {
  it("a successful generation-three Close cannot carry its receipt into a generation-four readback with no login", async () => {
    const value = setup(); value.held.add("close"); value.state(observed("signed-out", 3)); await value.controller.refresh(); value.connect(); await flush();
    value.state(observed("signing-in", 3)); await value.controller.refreshState(); value.edit("generation-three-draft");
    expect(value.controller.getSnapshot().ownerGeneration).toBe(3); value.controller.closeConnection(); await flush(); expect(value.action("close")).toHaveLength(1);
    const currentState = observed("signed-out", 4); value.state(currentState); value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(4); expect(value.controller.getSnapshot().state).toEqual(currentState);
    expect(value.controller.getSnapshot().state?.connection?.login).toBeNull(); expect(value.controller.getSnapshot().authCloseResult).toBeUndefined();
    expect(value.controller.getSnapshot().draft.model).toBe("generation-three-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    expect(mutationCounts(value)).toEqual([1, 1, 1]); await value.controller.refreshState(); await flush();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(4); expect(value.controller.getSnapshot().state).toEqual(currentState);
    expect(value.controller.getSnapshot().authCloseResult).toBeUndefined(); expect(value.controller.getSnapshot().draft.model).toBe("generation-three-draft");
    expect(mutationCounts(value)).toEqual([1, 1, 1]);
  });
  it.each([3, 4])("an attempt observed at generation 3 recovers only at the same non-null generation (%s)", async returnedGeneration => {
    const value = setup(); value.held.add("close"); value.state(observed("signed-out", 3)); await value.controller.refresh(); value.connect(); await flush();
    value.state(observed("signing-in", 3)); await value.controller.refreshState(); value.edit("generation-three-draft");
    expect(value.controller.getSnapshot().ownerGeneration).toBe(3); value.controller.closeConnection(); await flush(); expect(value.action("close")).toHaveLength(1);
    value.controller.selectTarget(piTarget); value.state(observed("signing-in", returnedGeneration)); await returnThroughContextAdoption(value); await flush();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(returnedGeneration);
    expect(value.controller.getSnapshot().authBusy).toBe(returnedGeneration === 3 ? "cancel" : null);
    const before = value.controller.getSnapshot();
    if (returnedGeneration === 3) value.state(observed("signed-out", 3));
    value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().draft.model).toBe("generation-three-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    if (returnedGeneration === 3) expect(value.controller.getSnapshot().authCloseResult).toEqual(closed);
    else { expect(value.controller.getSnapshot().authCloseResult).toBeUndefined(); expect(value.controller.getSnapshot().state).toEqual(before.state); }
    expect(mutationCounts(value)).toEqual([1, 1, 1]);
  });
  it("returning through context adoption observes the existing Close promise without another POST or changing a dirty draft", async () => {
    const value = setup(); await beginHeldClose(value); value.controller.selectTarget(piTarget); value.edit("pi-draft");
    await returnThroughContextAdoption(value); value.controller.closeConnection(); value.controller.closeConnection(); await flush();
    expect(value.controller.getSnapshot().authBusy).toBe("cancel"); expect(value.controller.getSnapshot().draft.model).toBe("codex-draft");
    expect(value.controller.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    value.state(observed("signed-out")); const readsBefore = value.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/state")).length;
    value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().authCloseResult).toEqual(closed); expect(value.controller.getSnapshot().authBusy).toBeNull();
    expect(value.controller.getSnapshot().state?.connection?.phase).toBe("signed-out");
    expect(value.fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/state")).length).toBeGreaterThan(readsBefore);
    expect(value.controller.getSnapshot().draft.model).toBe("codex-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    expect(mutationCounts(value)).toEqual([1, 1, 1]); value.controller.selectTarget(piTarget); expect(value.controller.getSnapshot().draft.model).toBe("pi-draft");
  });
  it("a remount with the same transport observes an in-flight Close and preserves its own new draft", async () => {
    const value = setup(); await beginHeldClose(value); value.controller.dispose();
    const returned = createAgentConfigurationController(value.transport, { harness: "codex", contextKey: "unobserved" }); controllers.push(returned);
    await returned.refresh(); returned.edit({ action: "choose-option", target: returned.getSnapshot().target, field: "model", choiceKey: "remounted-draft" });
    returned.closeConnection(); returned.closeConnection(); await flush(); expect(returned.getSnapshot().authBusy).toBe("cancel");
    expect(mutationCounts(value)).toEqual([1, 1, 1]); value.state(observed("signed-out")); value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(returned.getSnapshot().authCloseResult).toEqual(closed); expect(returned.getSnapshot().authBusy).toBeNull();
    expect(returned.getSnapshot().state?.connection?.phase).toBe("signed-out"); expect(returned.getSnapshot().draft.model).toBe("remounted-draft");
    expect(returned.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 1, 1]);
  });
  it("a receipt settled while away is restored by readback with zero new mutations", async () => {
    const value = setup(); await beginHeldClose(value); value.controller.selectTarget(piTarget);
    value.state(observed("signed-out")); value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().authCloseResult).toBeUndefined(); const counts = mutationCounts(value);
    await returnThroughContextAdoption(value); await flush();
    expect(value.controller.getSnapshot().authCloseResult).toEqual(closed); expect(value.controller.getSnapshot().authDetail?.en).toBeTruthy();
    expect(value.controller.getSnapshot().draft.model).toBe("codex-draft"); expect(mutationCounts(value)).toEqual(counts);
  });
  it.each(["rejection", "timeout"] as const)("a Close %s while away is restored as uncertain without replay; only an explicit check retries the original handle", async failure => {
    if (failure === "timeout") vi.useFakeTimers(); const value = setup(failure === "timeout" ? 25 : 15_000); await beginHeldClose(value);
    value.controller.selectTarget(piTarget);
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(26); else value.action("close")[0]!.reject(new TypeError("close response lost"));
    await flush(); await returnThroughContextAdoption(value); await flush();
    expect(value.controller.getSnapshot().authDetail?.en).toMatch(/uncertain/i); expect(value.controller.getSnapshot().authCloseResult).toBeUndefined();
    expect(value.controller.getSnapshot().authBusy).toBeNull(); expect(value.controller.getSnapshot().draft.model).toBe("codex-draft");
    expect(value.controller.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    await value.controller.refreshState(); await flush(); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    value.controller.closeConnection(); value.controller.closeConnection(); await flush(); expect(mutationCounts(value)).toEqual([1, 1, 2]);
    expect(value.action("close")[1]!.body).toEqual({ attemptHandle: handle }); value.state(observed("signed-out")); value.action("close")[1]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().authCloseResult).toEqual(closed); expect(value.controller.getSnapshot().draft.model).toBe("codex-draft");
  });
  it.each(["pi", "observed-id", "generation", "new-login"] as const)("the old Close receipt cannot overwrite the $boundary lifecycle (%s)", async boundary => {
    const value = setup(); await beginHeldClose(value);
    if (boundary === "pi") { value.controller.selectTarget(piTarget); value.edit("pi-current"); await value.controller.refreshState(); }
    else if (boundary === "observed-id") {
      const other = observed("signing-in"); value.state({ ...other, connection: { ...other.connection!, login: { ...login, loginId: "another-provider-login" } } });
      await value.controller.refreshState();
    } else if (boundary === "generation") { value.state(observed("signing-in", 2)); await value.controller.refreshState(); }
    else {
      value.state(observed("signed-out", 2)); await value.controller.refreshState(); value.reservation("new-reserved-attempt"); value.login("new-provider-login");
      value.connect(); await flush(); expect(value.action("reserve")).toHaveLength(2); expect(value.action("start")).toHaveLength(2);
    }
    const before = value.controller.getSnapshot(); value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().target).toEqual(before.target); expect(value.controller.getSnapshot().ownerGeneration).toBe(before.ownerGeneration);
    expect(value.controller.getSnapshot().state).toEqual(before.state); expect(value.controller.getSnapshot().draft).toEqual(before.draft);
    expect(value.controller.getSnapshot().authCloseResult).toBeUndefined(); expect(value.controller.getSnapshot().authBusy).toBe(before.authBusy);
    expect(value.action("close")).toHaveLength(1);
  });
  it.each([
    { state: "closed" as const, cleanup: "not-started" as const },
    { state: "closed" as const, cleanup: "cancel-acknowledged" as const },
    { state: "closed" as const, cleanup: "unconfirmed" as const },
    { state: "already-terminal" as const, cleanup: "not-applicable" as const },
    { state: "unknown-or-expired" as const, cleanup: "not-applicable" as const },
    { state: "superseded" as const, cleanup: "not-applicable" as const },
  ])("readback restores cached state=$state cleanup=$cleanup without mutation", async result => {
    const value = setup(); await beginHeldClose(value); value.controller.dispose(); const expected = { attemptHandle: handle, ...result };
    value.action("close")[0]!.reply({ result: expected }); await flush();
    const returned = createAgentConfigurationController(value.transport, { harness: "codex", contextKey: "unobserved" }); controllers.push(returned); await returned.refresh(); await flush();
    expect(returned.getSnapshot().authCloseResult).toEqual(expected); expect(returned.getSnapshot().authDetail?.zh).toBeTruthy(); expect(returned.getSnapshot().authDetail?.en).toBeTruthy();
    expect(returned.getSnapshot().state?.execution).toBeNull(); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    if (result.cleanup === "unconfirmed") {
      await returned.refreshState(); await flush(); expect(returned.getSnapshot().authDetail?.en).toMatch(/unconfirmed|uncertain/i);
    } else {
      returned.closeConnection(); await flush(); expect(returned.getSnapshot().authDetail?.en).not.toMatch(/no known handle/i);
    }
    expect(returned.getSnapshot().authCloseResult).toEqual(expected); expect(mutationCounts(value)).toEqual([1, 1, 1]);
  });
});

async function beginUnknownStartClose(value: ReturnType<typeof setup>) {
  value.held.add("start"); value.held.add("close"); value.state(observed("signed-out", 3)); await value.controller.refresh(); value.edit("unknown-start-draft");
  value.connect(); await flush(); expect(value.action("start")).toHaveLength(1); value.controller.closeConnection(); await flush();
  expect(mutationCounts(value)).toEqual([1, 1, 1]);
}
function expectAttemptScope(current: ReturnType<typeof createAgentConfigurationController>) {
  expect(current.getSnapshot().authCloseScope).toBe("attempt");
  expect(current.getSnapshot().authDetail?.en).toMatch(/original.*attempt/i);
  expect(current.getSnapshot().authDetail?.en).toMatch(/current connection/i);
  expect(current.getSnapshot().authDetail?.zh).toMatch(/原.*尝试/);
  expect(current.getSnapshot().authDetail?.zh).toMatch(/当前.*连接/);
}
function expectRealStartAbort(value: ReturnType<typeof setup>) {
  const start = value.action("start")[0]!; expect(start.aborted).toBe(true);
  expect(start.rejection).toBeInstanceOf(DOMException); expect((start.rejection as DOMException).name).toBe("AbortError");
}

describe("unknown-start Close receipts describe an attempt independently of the current connection", () => {
  it("a requested Close stays attempt-only when a delayed first observation later reports the returned login ID cancelled at generation five", async () => {
    const value = setup(); value.held.add("close"); value.state(observed("signed-out", 3)); await value.controller.refresh(); value.edit("close-before-observation-draft");
    const originalFetch = value.fetchImpl.getMockImplementation()!; let holdFirstState = true; let releaseState!: (value: HarnessState) => void;
    value.fetchImpl.mockImplementation((input, init) => {
      if (holdFirstState && String(input).endsWith("/state")) {
        holdFirstState = false;
        // This already-issued read can arrive late; its old epoch must not bind the closed attempt.
        return new Promise<Response>(resolve => { releaseState = state => resolve(Response.json({ state })); cleanups.push(() => releaseState(observed("signed-out", 3))); });
      }
      return originalFetch(input, init);
    });
    value.connect(); await flush(); expect(value.action("start")).toHaveLength(1); expect(value.controller.getSnapshot().authBlocking).toBe("login");
    value.controller.closeConnection(); await flush(); expect(value.action("close")).toHaveLength(1);
    const observedFive = observed("signed-out", 5);
    const currentState: HarnessState = { ...observedFive, connection: { ...observedFive.connection!, login: { ...login, status: "cancelled" } } };
    value.state(currentState); releaseState(currentState); await flush(); await value.controller.refreshState(); await flush();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(5); expect(value.controller.getSnapshot().state).toEqual(currentState);
    expectAttemptScope(value.controller); expect(value.controller.getSnapshot().authBlocking).toBeNull();
    expect(value.controller.getSnapshot().draft.model).toBe("close-before-observation-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    value.controller.closeConnection(); value.controller.closeConnection(); await flush(); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    value.action("close")[0]!.reply({ result: closed }); await flush();
    expectAttemptScope(value.controller); expect(value.controller.getSnapshot().authCloseResult).toEqual(closed); expect(value.controller.getSnapshot().authBlocking).toBeNull();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(5); expect(value.controller.getSnapshot().state).toEqual(currentState);
    await value.controller.refreshState(); await flush(); value.controller.closeConnection(); await flush();
    expectAttemptScope(value.controller); expect(value.controller.getSnapshot().authCloseResult).toEqual(closed); expect(value.controller.getSnapshot().authBlocking).toBeNull();
    expect(value.controller.getSnapshot().state).toEqual(currentState); expect(value.controller.getSnapshot().draft.model).toBe("close-before-observation-draft");
    expect(value.controller.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 1, 1]);
  });
  it("normal matching-login observation before Close still establishes a blocking connection-scoped Close", async () => {
    const value = setup(); value.held.add("close"); value.state(observed("signed-out", 3)); await value.controller.refresh(); value.edit("normally-correlated-draft");
    value.state(observed("signing-in", 5)); value.connect(); await flush();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(5); expect(value.controller.getSnapshot().state?.connection?.login?.loginId).toBe(login.loginId);
    expect(value.controller.getSnapshot().authBlocking).toBeNull(); value.controller.closeConnection(); await flush();
    expect(value.controller.getSnapshot().authCloseScope).toBe("connection"); expect(value.controller.getSnapshot().authBlocking).toBe("cancel");
    expect(value.controller.getSnapshot().draft.model).toBe("normally-correlated-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    expect(mutationCounts(value)).toEqual([1, 1, 1]);
  });
  it.each(["context", "harness"] as const)("an actual %s mismatch invalidates unknown-start recovery and prevents another Close POST", async mismatch => {
    const value = setup(); await beginUnknownStartClose(value); const actual = observed("signed-in", 4);
    value.state(mismatch === "context" ? { ...actual, scope: { ...actual.scope!, authContextRef: "different-server-context" } }
      : { ...actual, harnessId: "pi", scope: { ...actual.scope!, harnessId: "pi" } });
    await value.controller.refreshState(); await flush(); expectRealStartAbort(value);
    expect(value.controller.getSnapshot().state).toBeNull(); expect(value.controller.getSnapshot().authCloseResult).toBeUndefined();
    expect(value.controller.getSnapshot().authCloseScope).toBeUndefined(); value.controller.closeConnection(); await flush();
    expect(mutationCounts(value)).toEqual([1, 1, 1]);
    value.action("close")[0]!.reply({ result: { ...closed, cleanup: "unconfirmed" } }); await flush();
    expect(value.controller.getSnapshot().target).toEqual(target); expect(value.controller.getSnapshot().state).toBeNull();
    expect(value.controller.getSnapshot().authCloseResult).toBeUndefined(); expect(value.controller.getSnapshot().authCloseScope).toBeUndefined();
    expect(value.controller.getSnapshot().draft.model).toBe("unknown-start-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    value.controller.closeConnection(); value.controller.closeConnection(); await flush(); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    expect(value.controller.getSnapshot().state).toBeNull(); expect(value.controller.getSnapshot().authCloseResult).toBeUndefined();
    expect(value.controller.getSnapshot().authCloseScope).toBeUndefined();
  });
  it("a newer local login intent replaces the unknown-start correlation before its held reservation returns", async () => {
    const value = setup(); await beginUnknownStartClose(value);
    value.state(observed("signed-out", 4)); await value.controller.refreshState(); await flush(); expectRealStartAbort(value);
    value.held.add("reserve"); value.reservation("new-reserved-attempt"); value.controller.connectionIntent({ action: "connect", target: value.controller.getSnapshot().target }); await flush();
    value.edit("new-login-draft"); expect(mutationCounts(value)).toEqual([2, 1, 1]); expect(value.controller.getSnapshot().authBusy).toBe("login");
    const before = value.controller.getSnapshot(); value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().authCloseResult).toBeUndefined(); expect(value.controller.getSnapshot().authBusy).toBe("login");
    expect(value.controller.getSnapshot().authDetail).toEqual(before.authDetail); expect(value.controller.getSnapshot().target).toEqual(before.target);
    expect(value.controller.getSnapshot().ownerGeneration).toBe(before.ownerGeneration); expect(value.controller.getSnapshot().state).toEqual(before.state);
    expect(value.controller.getSnapshot().draft.model).toBe("new-login-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    expect(mutationCounts(value)).toEqual([2, 1, 1]);
  });
  it("a generation-three reservation closed before start keeps its not-started receipt when GET still observes three", async () => {
    const value = setup(); value.held.add("reserve"); value.held.add("close"); value.state(observed("signed-out", 3)); await value.controller.refresh(); value.edit("reserved-draft");
    value.connect(); await flush(); value.controller.closeConnection();
    value.action("reserve")[0]!.reply({ reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } }); await flush();
    const result = { attemptHandle: handle, state: "closed", cleanup: "not-started" };
    value.action("close")[0]!.reply({ result }); await flush(); await value.controller.refreshState(); await flush();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(3); expect(value.controller.getSnapshot().authCloseResult).toEqual(result);
    expect(value.controller.getSnapshot().state).toEqual(observed("signed-out", 3)); expect(value.controller.getSnapshot().draft.model).toBe("reserved-draft");
    expect(value.controller.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 0, 1]);
  });
  it.each([
    ["return", "success"], ["return", "rejection"], ["return", "timeout"],
    ["remount", "success"], ["remount", "rejection"], ["remount", "timeout"],
    ["refresh", "success"], ["refresh", "rejection"], ["refresh", "timeout"],
  ] as const)("%s observes independent owner four while the original unknown-start Close settles with %s", async (boundary, outcome) => {
    if (outcome === "timeout") vi.useFakeTimers(); const value = setup(outcome === "timeout" ? 25 : 15_000); await beginUnknownStartClose(value);
    const currentState = observed("signed-in", 4); value.state(currentState); let current = value.controller;
    if (boundary === "return") { value.controller.selectTarget(piTarget); await returnThroughContextAdoption(value); }
    else if (boundary === "remount") {
      value.controller.dispose(); current = createAgentConfigurationController(value.transport, { harness: "codex", contextKey: "unobserved" }); controllers.push(current);
      await current.refresh(); current.edit({ action: "choose-option", target: current.getSnapshot().target, field: "model", choiceKey: "remounted-unknown-draft" });
    } else await current.refreshState();
    await flush(); expectRealStartAbort(value); expect(current.getSnapshot().ownerGeneration).toBe(4); expect(current.getSnapshot().state).toEqual(currentState);
    const retainedDraft = current.getSnapshot().draft; await current.refreshState(); await flush(); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    if (outcome === "success") value.action("close")[0]!.reply({ result: closed });
    else if (outcome === "rejection") value.action("close")[0]!.reject(new TypeError("Close response lost"));
    else await vi.advanceTimersByTimeAsync(26);
    await flush(); expectAttemptScope(current); expect(current.getSnapshot().ownerGeneration).toBe(4); expect(current.getSnapshot().state).toEqual(currentState);
    expect(current.getSnapshot().state?.account).toEqual(currentState.account); expect(current.getSnapshot().draft).toEqual(retainedDraft); expect(current.getSnapshot().revision).toBe(0);
    if (outcome === "success") expect(current.getSnapshot().authCloseResult).toEqual(closed);
    else { expect(current.getSnapshot().authCloseResult).toBeUndefined(); expect(current.getSnapshot().authDetail?.en).toMatch(/uncertain/i); }
    expect(mutationCounts(value)).toEqual([1, 1, 1]); current.closeConnection(); current.closeConnection(); await flush();
    expect(value.action("reserve")).toHaveLength(1); expect(value.action("start")).toHaveLength(1); expect(value.action("close").length).toBeLessThanOrEqual(2);
    expect(current.getSnapshot().state).toEqual(currentState); expect(current.getSnapshot().draft).toEqual(retainedDraft);
    if (outcome === "success") {
      expect(value.action("close")).toHaveLength(1); expect(current.getSnapshot().authCloseResult).toEqual(closed);
      expect(current.getSnapshot().authDetail?.en).not.toMatch(/no known handle/i);
    } else {
      expect(value.action("close")).toHaveLength(2); expect(value.action("close")[1]!.body).toEqual({ attemptHandle: handle });
      value.action("close")[1]!.reply({ result: closed }); await flush(); expect(current.getSnapshot().authCloseResult).toEqual(closed); expectAttemptScope(current);
      expect(current.getSnapshot().ownerGeneration).toBe(4); expect(current.getSnapshot().state).toEqual(currentState); expect(current.getSnapshot().draft).toEqual(retainedDraft);
    }
  });
  it.each([
    { state: "closed" as const, cleanup: "not-started" as const },
    { state: "closed" as const, cleanup: "cancel-acknowledged" as const },
    { state: "closed" as const, cleanup: "unconfirmed" as const },
    { state: "already-terminal" as const, cleanup: "not-applicable" as const },
    { state: "unknown-or-expired" as const, cleanup: "not-applicable" as const },
    { state: "superseded" as const, cleanup: "not-applicable" as const },
  ])("remount recovers unknown-start cached $state/$cleanup only as the original attempt's receipt", async result => {
    const value = setup(); await beginUnknownStartClose(value); value.controller.dispose(); await flush(); expectRealStartAbort(value);
    const expected = { attemptHandle: handle, ...result }; value.action("close")[0]!.reply({ result: expected }); await flush();
    const currentState = observed("signed-in", 4); value.state(currentState);
    const returned = createAgentConfigurationController(value.transport, { harness: "codex", contextKey: "unobserved" }); controllers.push(returned); await returned.refresh();
    returned.edit({ action: "choose-option", target: returned.getSnapshot().target, field: "model", choiceKey: "independent-remount-draft" }); await returned.refreshState(); await flush();
    expectAttemptScope(returned); expect(returned.getSnapshot().authCloseResult).toEqual(expected); expect(returned.getSnapshot().ownerGeneration).toBe(4);
    expect(returned.getSnapshot().state).toEqual(currentState); expect(returned.getSnapshot().draft.model).toBe("independent-remount-draft");
    expect(returned.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    if (result.cleanup !== "unconfirmed") {
      returned.closeConnection(); await flush(); expect(returned.getSnapshot().authCloseResult).toEqual(expected);
      expect(returned.getSnapshot().authDetail?.en).not.toMatch(/no known handle/i); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    }
  });
  it("only explicit same-handle checks retry unknown-start unconfirmed cleanup, leaving owner four's connection intact", async () => {
    const value = setup(); await beginUnknownStartClose(value); value.controller.selectTarget(piTarget); await flush(); expectRealStartAbort(value);
    const result = { attemptHandle: handle, state: "closed", cleanup: "unconfirmed" }; value.action("close")[0]!.reply({ result }); await flush();
    const currentState = observed("signed-in", 4); value.state(currentState); await returnThroughContextAdoption(value); await flush();
    expectAttemptScope(value.controller); expect(value.controller.getSnapshot().authCloseResult).toEqual(result);
    await value.controller.refreshState(); await flush(); expect(mutationCounts(value)).toEqual([1, 1, 1]);
    value.controller.closeConnection(); value.controller.closeConnection(); await flush(); expect(mutationCounts(value)).toEqual([1, 1, 2]);
    expect(value.action("close")[1]!.body).toEqual({ attemptHandle: handle }); expect(value.controller.getSnapshot().state).toEqual(currentState);
    value.action("close")[1]!.reply({ result: closed }); await flush(); expectAttemptScope(value.controller);
    expect(value.controller.getSnapshot().authCloseResult).toEqual(closed); expect(value.controller.getSnapshot().ownerGeneration).toBe(4);
    expect(value.controller.getSnapshot().state).toEqual(currentState); expect(value.controller.getSnapshot().draft.model).toBe("unknown-start-draft");
    expect(value.controller.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 1, 2]);
  });
  it("a lost start response does not turn the original handle's receipt into evidence about owner four", async () => {
    const value = setup(); value.held.add("start"); value.held.add("close"); value.state(observed("signed-out", 3)); await value.controller.refresh(); value.edit("lost-start-draft");
    value.connect(); await flush(); value.action("start")[0]!.reject(new TypeError("provider start response lost")); await flush(); value.controller.closeConnection(); await flush();
    const currentState = observed("signed-in", 4); value.state(currentState); await value.controller.refreshState();
    const result = { attemptHandle: handle, state: "already-terminal", cleanup: "not-applicable" }; value.action("close")[0]!.reply({ result }); await flush();
    expectAttemptScope(value.controller); expect(value.controller.getSnapshot().authCloseResult).toEqual(result); expect(value.controller.getSnapshot().ownerGeneration).toBe(4);
    expect(value.controller.getSnapshot().state).toEqual(currentState); expect(value.controller.getSnapshot().draft.model).toBe("lost-start-draft");
    expect(value.controller.getSnapshot().revision).toBe(0); expect(mutationCounts(value)).toEqual([1, 1, 1]);
  });
  it.each(["rejection", "timeout"] as const)("returning after the unknown-start Close's %s restores uncertainty without mutating owner four", async failure => {
    if (failure === "timeout") vi.useFakeTimers(); const value = setup(failure === "timeout" ? 25 : 15_000); await beginUnknownStartClose(value);
    value.controller.selectTarget(piTarget); await flush(); expectRealStartAbort(value);
    if (failure === "rejection") value.action("close")[0]!.reject(new TypeError("Close receipt lost while away")); else await vi.advanceTimersByTimeAsync(26);
    await flush(); const currentState = observed("signed-in", 4); value.state(currentState); await returnThroughContextAdoption(value); await flush();
    expectAttemptScope(value.controller); expect(value.controller.getSnapshot().authDetail?.en).toMatch(/uncertain/i); expect(value.controller.getSnapshot().authCloseResult).toBeUndefined();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(4); expect(value.controller.getSnapshot().state).toEqual(currentState);
    expect(value.controller.getSnapshot().draft.model).toBe("unknown-start-draft"); expect(value.controller.getSnapshot().revision).toBe(0);
    expect(mutationCounts(value)).toEqual([1, 1, 1]); value.controller.closeConnection(); value.controller.closeConnection(); await flush();
    expect(mutationCounts(value)).toEqual([1, 1, 2]); expect(value.action("close")[1]!.body).toEqual({ attemptHandle: handle });
    expect(value.controller.getSnapshot().state).toEqual(currentState); value.action("close")[1]!.reply({ result: closed }); await flush();
    expectAttemptScope(value.controller); expect(value.controller.getSnapshot().authCloseResult).toEqual(closed);
    expect(value.controller.getSnapshot().ownerGeneration).toBe(4); expect(value.controller.getSnapshot().state).toEqual(currentState);
  });
});
