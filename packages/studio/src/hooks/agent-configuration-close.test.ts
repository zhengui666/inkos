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
interface Call { action: Action; body: unknown; signal: AbortSignal; keepalive: boolean | undefined; aborted: boolean; reply(value: unknown): void; reject(error: unknown): void }
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
      reject: reason => { signal.removeEventListener("abort", abort); reject(reason); } };
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

describe("reservation precedes provider login and belongs to the original intent", () => {
  it("deduplicates connect synchronously through reserve and start and only starts the returned handle", async () => {
    const value = setup(); value.held.add("reserve"); value.held.add("start"); await value.controller.refresh();
    value.connect(); value.connect(); await flush(); expect(value.action("reserve")).toHaveLength(1); expect(value.action("start")).toHaveLength(0);
    value.action("reserve")[0]!.reply({ reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } }); await flush();
    value.connect(); await flush(); expect(value.action("start")).toHaveLength(1); expect(value.action("start")[0]!.body).toEqual({ attemptHandle: handle });
    value.action("start")[0]!.reply({ login }); await flush(); expect(value.action("reserve")).toHaveLength(1);
  });
  it("a lost reserve response stays uncertain and never starts or automatically retries reservation", async () => {
    const value = setup(); value.held.add("reserve"); await value.controller.refresh(); value.connect(); await flush();
    value.action("reserve")[0]!.reject(new TypeError("reserve response lost")); await flush();
    expect(value.controller.getSnapshot().authDetail?.en).toMatch(/uncertain/i); expect(value.action("start")).toHaveLength(0);
    await value.controller.refreshState(); await flush();
    expect(value.action("reserve")).toHaveLength(1); expect(value.action("close")).toHaveLength(0);
    // A new explicit user intent may reserve a new attempt; no readback replays the lost request.
    value.connect(); await flush(); expect(value.action("reserve")).toHaveLength(2); expect(value.action("start")).toHaveLength(0);
  });
  it.each(["stay", "navigate", "dispose"] as const)("Close during reserve sends only close when the late handle returns (%s)", async boundary => {
    const value = setup(); value.held.add("reserve"); value.ignoreAbort.add("reserve"); await value.controller.refresh(); value.connect(); await flush();
    value.controller.closeConnection(); value.controller.closeConnection();
    if (boundary === "navigate") value.controller.selectTarget(piTarget); else if (boundary === "dispose") value.controller.dispose();
    value.action("reserve")[0]!.reply({ reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } }); await flush();
    expect(value.action("start")).toHaveLength(0); expect(value.action("close")).toHaveLength(1);
    expect(value.action("close")[0]!.body).toEqual({ attemptHandle: handle }); expect(value.action("close")[0]!.signal.aborted).toBe(false);
    if (boundary === "navigate") expect(value.controller.getSnapshot().target).toEqual(piTarget);
  });
  it.each(["cancel", "navigate", "dispose"] as const)("pure %s aborts the reserve fetch and never starts provider login", async boundary => {
    const value = setup(); value.held.add("reserve"); await value.controller.refresh(); value.connect(); await flush();
    if (boundary === "cancel") value.controller.cancel(); else if (boundary === "navigate") value.controller.selectTarget(piTarget); else value.controller.dispose();
    await flush(); expect(value.action("reserve")[0]!.aborted).toBe(true); expect(value.action("start")).toHaveLength(0); expect(value.action("close")).toHaveLength(0);
  });
  it("pure navigation ignores a reserve transport that returns late without inventing a close intent", async () => {
    const value = setup(); value.held.add("reserve"); value.ignoreAbort.add("reserve"); await value.controller.refresh(); value.connect(); await flush();
    value.controller.selectTarget(piTarget); value.edit("pi-draft"); const before = value.controller.getSnapshot();
    value.action("reserve")[0]!.reply({ reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } }); await flush();
    expect(value.action("start")).toHaveLength(0); expect(value.action("close")).toHaveLength(0);
    expect(value.controller.getSnapshot().target).toEqual(before.target); expect(value.controller.getSnapshot().draft).toEqual(before.draft);
  });
  it("a late reservation settles its recorded Close without taking over a newer login lifecycle", async () => {
    const value = setup(); value.held.add("reserve"); value.ignoreAbort.add("reserve"); value.held.add("close");
    await value.controller.refresh(); value.connect(); await flush(); value.controller.closeConnection();
    value.controller.selectTarget(piTarget); value.edit("pi-draft");
    value.state(observed("signed-out", 2)); value.controller.selectTarget(target); await value.controller.refreshState(); value.edit("new-codex-draft");
    value.reservation("new-reserved-attempt"); value.connect(); await flush();
    expect(value.action("reserve")).toHaveLength(2); expect(value.controller.getSnapshot().authBusy).toBe("login");
    const before = value.controller.getSnapshot();
    value.action("reserve")[0]!.reply({ reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } }); await flush();
    expect(value.action("start")).toHaveLength(0); expect(value.action("close")).toHaveLength(1);
    expect(value.action("close")[0]!.body).toEqual({ attemptHandle: handle });
    expect(value.controller.getSnapshot().target).toEqual(before.target); expect(value.controller.getSnapshot().state).toEqual(before.state);
    expect(value.controller.getSnapshot().draft).toEqual(before.draft); expect(value.controller.getSnapshot().authBusy).toBe("login");
    value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().target).toEqual(before.target); expect(value.controller.getSnapshot().state).toEqual(before.state);
    expect(value.controller.getSnapshot().draft.model).toBe("new-codex-draft"); expect(value.controller.getSnapshot().authBusy).toBe("login");
    expect(value.controller.getSnapshot().authCloseResult).toBeUndefined(); expect(value.action("reserve")).toHaveLength(2);
  });
});

describe("explicit Close uses a separate signal and a server reservation handle", () => {
  it.each(["cancel", "navigate", "dispose"] as const)("Close survives %s and a real AbortError from the in-flight start fetch", async boundary => {
    const value = setup(); value.held.add("start"); value.held.add("close"); await value.controller.refresh(); value.connect(); await flush(); value.edit("codex-draft");
    value.controller.closeConnection(); value.controller.closeConnection(); await flush();
    if (boundary === "cancel") value.controller.cancel(); else if (boundary === "navigate") value.controller.selectTarget(piTarget); else value.controller.dispose();
    await flush(); const start = value.action("start")[0]!, closing = value.action("close")[0]!;
    expect(start.aborted).toBe(true); expect(value.action("close")).toHaveLength(1);
    expect(closing.signal).not.toBe(start.signal); expect(closing.signal.aborted).toBe(false); expect(closing.keepalive).toBe(true);
    expect(closing.body).toEqual({ attemptHandle: handle }); closing.reply({ result: closed }); await flush();
    if (boundary === "navigate") { expect(value.controller.getSnapshot().target).toEqual(piTarget); expect(value.controller.getSnapshot().state).toBeNull(); }
    if (boundary === "cancel") expect(value.controller.getSnapshot().draft.model).toBe("codex-draft");
  });
  it("a timed-out start has already reserved the handle, so Close does not need a provider login ID", async () => {
    vi.useFakeTimers(); const value = setup(25); value.held.add("start"); await value.controller.refresh(); value.connect(); await flush();
    await vi.advanceTimersByTimeAsync(26); await flush(); expect(value.action("start")[0]!.aborted).toBe(true);
    expect(value.controller.getSnapshot().authDetail?.en).toMatch(/uncertain/i); value.controller.closeConnection(); await flush();
    expect(value.action("close")).toHaveLength(1); expect(value.action("close")[0]!.body).toEqual({ attemptHandle: handle });
    expect(value.controller.getSnapshot().authCloseResult).toEqual(closed);
  });
  it("a lost start response can be closed with its known handle without repeating login", async () => {
    const value = setup(); value.held.add("start"); await value.controller.refresh(); value.connect(); await flush();
    value.action("start")[0]!.reject(new TypeError("start response lost")); await flush(); value.controller.closeConnection(); await flush();
    expect(value.action("reserve")).toHaveLength(1); expect(value.action("start")).toHaveLength(1); expect(value.action("close")).toHaveLength(1);
    expect(value.controller.getSnapshot().authCloseResult).toEqual(closed);
  });
  it("late start data cannot resurrect the old target after explicit Close and navigation", async () => {
    const value = setup(); value.held.add("start"); value.ignoreAbort.add("start"); await value.controller.refresh(); value.connect(); await flush();
    value.controller.closeConnection(); await flush(); value.controller.selectTarget(piTarget); value.edit("pi-draft"); await value.controller.refreshState();
    const before = value.controller.getSnapshot(); value.action("start")[0]!.reply({ login }); await flush();
    expect(value.controller.getSnapshot().target).toEqual(piTarget); expect(value.controller.getSnapshot().state).toEqual(before.state);
    expect(value.controller.getSnapshot().draft.model).toBe("pi-draft"); expect(value.action("close")).toHaveLength(1);
  });
  it("pure navigation aborts the started fetch while preserving the service attempt for readback and explicit Close", async () => {
    const value = setup(); value.held.add("start"); await value.controller.refresh(); value.connect(); await flush();
    value.controller.selectTarget(piTarget); value.edit("pi-draft"); await flush();
    expect(value.action("start")[0]!.aborted).toBe(true); expect(value.action("close")).toHaveLength(0);
    value.state(observed("signing-in", 1)); value.controller.selectTarget(target); await value.controller.refresh(); value.connect(); await flush();
    expect(value.controller.getSnapshot().state?.connection?.login?.loginId).toBe(login.loginId);
    expect(value.action("reserve")).toHaveLength(1); expect(value.action("start")).toHaveLength(1); expect(value.action("close")).toHaveLength(0);
    value.controller.closeConnection(); await flush(); expect(value.action("close")).toHaveLength(1);
    expect(value.action("close")[0]!.body).toEqual({ attemptHandle: handle });
    value.controller.selectTarget(piTarget); expect(value.controller.getSnapshot().draft.model).toBe("pi-draft");
  });
  it("a lost Close response preserves uncertainty and permits only explicit same-handle reconciliation", async () => {
    const value = setup(); value.held.add("start"); value.held.add("close"); await value.controller.refresh(); value.connect(); await flush(); value.edit("retained-draft");
    value.controller.closeConnection(); value.controller.closeConnection(); await flush(); expect(value.action("close")).toHaveLength(1);
    value.action("close")[0]!.reject(new TypeError("close response lost")); await flush();
    expect(value.controller.getSnapshot().authDetail?.en).toMatch(/uncertain/i); expect(value.controller.getSnapshot().draft.model).toBe("retained-draft");
    expect(value.controller.getSnapshot().revision).toBe(0); expect(value.action("close")).toHaveLength(1);
    value.controller.closeConnection(); value.controller.closeConnection(); await flush(); expect(value.action("close")).toHaveLength(2);
    expect(value.action("close")[1]!.body).toEqual({ attemptHandle: handle }); value.action("close")[1]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().authCloseResult).toEqual(closed); expect(value.action("start")).toHaveLength(1);
  });
  it("Close's own deadline may abort its signal without navigation aborting it, and retains the retry handle", async () => {
    vi.useFakeTimers(); const value = setup(25); value.held.add("start"); value.held.add("close"); await value.controller.refresh(); value.connect(); await flush();
    value.controller.closeConnection(); await flush(); const closing = value.action("close")[0]!; expect(closing.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(26); await flush(); expect(closing.aborted).toBe(true);
    expect(value.controller.getSnapshot().authDetail?.en).toMatch(/uncertain/i); value.controller.closeConnection(); await flush();
    expect(value.action("close")).toHaveLength(2); expect(value.action("close")[1]!.body).toEqual({ attemptHandle: handle });
    value.action("close")[1]!.reply({ result: closed }); await flush();
  });
  it("new generation and a new login cannot be overwritten by a previous handle's late Close reply", async () => {
    const value = setup(); value.held.add("start"); value.held.add("close"); await value.controller.refresh(); value.connect(); await flush(); value.controller.closeConnection(); await flush();
    value.state(observed("signed-out", 2)); await value.controller.refreshState(); value.reservation("new-reserved-attempt"); value.login("new-provider-login");
    value.connect(); await flush(); expect(value.action("reserve")).toHaveLength(2); expect(value.action("start")[1]!.body).toEqual({ attemptHandle: "new-reserved-attempt" });
    const before = value.controller.getSnapshot(); value.action("close")[0]!.reply({ result: closed }); await flush();
    expect(value.controller.getSnapshot().ownerGeneration).toBe(before.ownerGeneration); expect(value.controller.getSnapshot().target).toEqual(before.target);
    expect(value.controller.getSnapshot().authCloseResult).not.toEqual(closed); expect(value.controller.getSnapshot().authBusy).toBe(before.authBusy);
  });
});

describe("readback and Close results preserve what the server actually confirmed", () => {
  it("a returned controller reuses the same transport's known reservation without replaying login", async () => {
    const value = setup(); await value.controller.refresh(); value.connect(); await flush(); value.controller.dispose(); value.state(observed("signing-in", 1));
    const returned = createAgentConfigurationController(value.transport, target); controllers.push(returned); await returned.refresh();
    returned.closeConnection(); await flush(); expect(value.action("reserve")).toHaveLength(1); expect(value.action("start")).toHaveLength(1);
    expect(value.action("close")).toHaveLength(1); expect(value.action("close")[0]!.body).toEqual({ attemptHandle: handle });
  });
  it("an observed pending login without a local handle cannot be closed using its login ID", async () => {
    const value = setup(); value.state(observed("signing-in", 1)); await value.controller.refresh(); value.controller.closeConnection(); await flush();
    expect(value.action("reserve")).toHaveLength(0); expect(value.action("start")).toHaveLength(0); expect(value.action("close")).toHaveLength(0);
    expect(value.controller.getSnapshot().authDetail?.en).toMatch(/review|check|unknown|refresh/i);
  });
  it.each([
    { state: "closed" as const, cleanup: "not-started" as const },
    { state: "closed" as const, cleanup: "cancel-acknowledged" as const },
    { state: "closed" as const, cleanup: "unconfirmed" as const },
    { state: "already-terminal" as const, cleanup: "not-applicable" as const },
    { state: "unknown-or-expired" as const, cleanup: "not-applicable" as const },
    { state: "superseded" as const, cleanup: "not-applicable" as const },
  ])("keeps server state=$state and cleanup=$cleanup distinct in the close result", async result => {
    const value = setup(); value.held.add("start"); value.held.add("close"); await value.controller.refresh(); value.connect(); await flush(); value.controller.closeConnection(); await flush();
    const expected = { attemptHandle: handle, ...result }; value.action("close")[0]!.reply({ result: expected }); await flush();
    expect(value.controller.getSnapshot().authCloseResult).toEqual(expected); expect(value.controller.getSnapshot().authDetail?.en).toBeTruthy();
    expect(value.controller.getSnapshot().authDetail?.zh).toBeTruthy(); expect(value.controller.getSnapshot().state?.execution).toBeFalsy();
    if (result.cleanup === "unconfirmed") expect(value.controller.getSnapshot().authDetail?.en).toMatch(/unconfirmed|uncertain|not confirmed/i);
  });
});
