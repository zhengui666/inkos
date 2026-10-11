import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentConfigurationController, createAgentConfigurationTransport, type AgentConfigurationTransport } from "./agent-configuration-controller";
import { ApiResponseError } from "./use-api";
import { unavailableHarnessState, type AgentSettings, type HarnessState, type StudioPiLoginAttempt, type StudioPiCloseResult } from "../shared/agent-configuration";
import type { StudioCodexLogin } from "../shared/codex";
import { toSelection } from "../pages/agent-configuration-adapter";

const native = { model: null, effort: null, speed: null };
const initial: AgentSettings = { schemaVersion: 1, revision: 0, selectedHarnessId: "codex", modelConnectionRef: null, harnessPreferences: { codex: native, pi: native } };
const target = { harness: "codex" as const, contextKey: "server-context" };
const piTarget = { harness: "pi" as const, contextKey: "unobserved" };
const attemptHandle = "reserved-attempt-one";
type LoginCloseResult = Awaited<ReturnType<NonNullable<AgentConfigurationTransport["closeLogin"]>>>;
const closeResult: LoginCloseResult = { attemptHandle, state: "closed", cleanup: "cancel-acknowledged" };
const pendingLogin: StudioCodexLogin = { loginId: "attempt-one", status: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "PUBLIC-CODE" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function settings(revision = 1, model: string | null = null): AgentSettings {
  return { ...initial, revision, modelConnectionRef: "backend-owned-binding", harnessPreferences: { ...initial.harnessPreferences, codex: { ...native, model } } };
}
function observed(phase: NonNullable<HarnessState["connection"]>["phase"] = "signed-in", generation: number | null = null, context = target.contextKey, login: StudioCodexLogin | null = null): HarnessState {
  return { ...unavailableHarnessState("codex"), availability: "available", installation: "installed",
    scope: { harnessId: "codex", authContextRef: context, ownerGeneration: generation, adapterVersion: "1", catalogVersion: "1" },
    account: phase === "signed-in" ? { type: "chatgpt", label: "Observed account" } : null,
    connection: { phase, login, connectionRef: phase === "signed-in" ? "backend-owned-binding" : null } };
}
function setup(state = observed(), timeout = 15_000) {
  const transport = {
    readSettings: vi.fn<AgentConfigurationTransport["readSettings"]>().mockResolvedValue(initial),
    saveSettings: vi.fn<AgentConfigurationTransport["saveSettings"]>(),
    readHarnessState: vi.fn<AgentConfigurationTransport["readHarnessState"]>().mockImplementation(async harness => harness === "codex" ? state : unavailableHarnessState(harness)),
    reserveLogin: vi.fn<NonNullable<AgentConfigurationTransport["reserveLogin"]>>().mockImplementation(async () => ({ attemptHandle, expiresAt: Date.now() + 120_000 })),
    startLogin: vi.fn<NonNullable<AgentConfigurationTransport["startLogin"]>>().mockResolvedValue(pendingLogin),
    closeLogin: vi.fn<NonNullable<AgentConfigurationTransport["closeLogin"]>>().mockResolvedValue(closeResult),
    logout: vi.fn<NonNullable<AgentConfigurationTransport["logout"]>>().mockResolvedValue(undefined),
    bindConnection: vi.fn<NonNullable<AgentConfigurationTransport["bindConnection"]>>().mockResolvedValue(settings()),
  };
  const controller = createAgentConfigurationController(transport, target, timeout);
  const edit = (choiceKey: string | null) => controller.edit({ action: "choose-option", target: controller.getSnapshot().target, field: "model", choiceKey });
  const save = () => controller.save({ action: "save-defaults", target: controller.getSnapshot().target, selection: toSelection(controller.getSnapshot().draft) });
  const intent = (action: "connect" | "cancel-sign-in" | "sign-out", attemptKey = pendingLogin.loginId) => controller.connectionIntent(action === "cancel-sign-in"
    ? { action, target: controller.getSnapshot().target, attemptKey }
    : { action, target: controller.getSnapshot().target });
  return { controller, transport, edit, save, intent };
}
afterEach(() => { vi.useRealTimers(); });
async function primeKnownAttempt(value: ReturnType<typeof setup>, pendingState: HarnessState) {
  value.transport.readHarnessState.mockResolvedValue(observed("signed-out")); await value.controller.refreshState();
  value.transport.readHarnessState.mockResolvedValue(pendingState); value.intent("connect"); await flush();
  value.transport.startLogin.mockClear(); value.transport.reserveLogin.mockClear();
}

describe("account requests belong to one observed attempt", () => {
  it("dispatches synchronous repeated connect only once and keeps a null owner generation valid", async () => {
    const { controller, transport, intent } = setup(observed("signed-out")); await controller.refresh();
    const login = deferred<StudioCodexLogin>(); transport.startLogin.mockReturnValue(login.promise);
    intent("connect"); intent("connect"); intent("sign-out"); await flush();
    expect(transport.startLogin).toHaveBeenCalledTimes(1); expect(transport.logout).not.toHaveBeenCalled();
    expect(controller.getSnapshot().authBusy).toBe("login");
    transport.readHarnessState.mockResolvedValue(observed("signing-in", null, target.contextKey, pendingLogin));
    login.resolve(pendingLogin); await flush();
    expect(controller.getSnapshot().ownerGeneration).toBeNull();
    expect(controller.getSnapshot().state?.connection?.login?.loginId).toBe("attempt-one");
    expect(controller.getSnapshot().authBusy).toBeNull(); controller.dispose();
  });
  it("closes only the locally reserved observed pending attempt and ignores wrong IDs and repeated clicks", async () => {
    const value = setup(observed("signing-in", 1, target.contextKey, pendingLogin)); const { controller, transport, intent } = value;
    await controller.refresh(); await primeKnownAttempt(value, observed("signing-in", 1, target.contextKey, pendingLogin));
    intent("cancel-sign-in", "another-attempt"); expect(transport.closeLogin).not.toHaveBeenCalled();
    const cancellation = deferred<LoginCloseResult>(); transport.closeLogin.mockReturnValue(cancellation.promise);
    intent("cancel-sign-in", pendingLogin.loginId); intent("cancel-sign-in", pendingLogin.loginId); await flush();
    expect(transport.closeLogin).toHaveBeenCalledTimes(1); expect(transport.closeLogin.mock.calls[0]![0]).toBe(attemptHandle);
    controller.selectTarget(piTarget); cancellation.resolve(closeResult); await flush();
    expect(controller.getSnapshot().target).toEqual(piTarget); expect(controller.getSnapshot().state).toBeNull();
    expect(transport.startLogin).not.toHaveBeenCalled(); controller.dispose();
  });
  it("dispatches synchronous repeated logout only once", async () => {
    const { controller, transport, intent } = setup(); await controller.refresh();
    const logout = deferred<void>(); transport.logout.mockReturnValue(logout.promise);
    intent("sign-out"); intent("sign-out"); await flush(); expect(transport.logout).toHaveBeenCalledTimes(1);
    transport.readHarnessState.mockResolvedValue(observed("signed-out")); logout.resolve(); await flush();
    expect(controller.getSnapshot().state?.account).toBeNull(); expect(controller.getSnapshot().authBusy).toBeNull(); controller.dispose();
  });
  it("explicit Close before login/start returns closes its reserved handle once, even after navigation", async () => {
    const { controller, transport, intent, edit } = setup(observed("signed-out")); await controller.refresh();
    const login = deferred<StudioCodexLogin>(); transport.startLogin.mockReturnValue(login.promise);
    intent("connect"); await flush(); controller.closeConnection(); controller.closeConnection();
    controller.selectTarget(piTarget); edit("pi-draft"); login.resolve(pendingLogin); await flush();
    expect(transport.closeLogin).toHaveBeenCalledTimes(1); expect(transport.closeLogin.mock.calls[0]![0]).toBe(attemptHandle);
    expect(controller.getSnapshot().target).toEqual(piTarget); expect(controller.getSnapshot().draft.model).toBe("pi-draft");
    expect(controller.getSnapshot().state).toBeNull(); expect(controller.getSnapshot().authDetail).toBeUndefined(); controller.dispose();
  });
  it("explicit Close survives timeout when transport ignores abort and closes only the reserved attempt despite a late response", async () => {
    vi.useFakeTimers(); const { controller, transport, intent } = setup(observed("signed-out"), 25); await controller.refresh();
    const login = deferred<StudioCodexLogin>(); transport.startLogin.mockReturnValue(login.promise);
    intent("connect"); await flush(); controller.closeConnection(); await vi.advanceTimersByTimeAsync(26); await flush();
    expect(transport.startLogin.mock.calls[0]![1].aborted).toBe(true);
    const before = controller.getSnapshot(); login.resolve(pendingLogin); await flush();
    expect(transport.closeLogin).toHaveBeenCalledTimes(1); expect(transport.closeLogin.mock.calls[0]![0]).toBe(attemptHandle);
    expect(controller.getSnapshot().target).toEqual(before.target); expect(controller.getSnapshot().state).toEqual(before.state);
    expect(transport.startLogin).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it("Close with an observed pending attempt suppresses duplicate cancellation", async () => {
    const value = setup(observed("signing-in", null, target.contextKey, pendingLogin)); const { controller, transport } = value;
    await controller.refresh(); await primeKnownAttempt(value, observed("signing-in", null, target.contextKey, pendingLogin));
    const cancellation = deferred<LoginCloseResult>(); transport.closeLogin.mockReturnValue(cancellation.promise);
    controller.closeConnection(); controller.closeConnection(); await flush();
    expect(transport.closeLogin).toHaveBeenCalledTimes(1); expect(transport.closeLogin.mock.calls[0]![0]).toBe(attemptHandle);
    cancellation.resolve(closeResult); await flush(); controller.dispose();
  });
  it("explicit Close after login/start returned still cancels that attempt while its observation is delayed", async () => {
    const { controller, transport, intent } = setup(observed("signed-out")); await controller.refresh();
    const observation = deferred<HarnessState>(); transport.readHarnessState.mockReturnValue(observation.promise);
    intent("connect"); await flush();
    expect(transport.startLogin).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().authBusy).toBe("login");
    controller.closeConnection(); controller.closeConnection(); await flush();
    const cancellationCountBeforeObservation = transport.closeLogin.mock.calls.length;
    observation.resolve(observed("signing-in", null, target.contextKey, pendingLogin)); await flush(); controller.dispose();
    expect(cancellationCountBeforeObservation).toBe(1); expect(transport.closeLogin).toHaveBeenCalledTimes(1);
    expect(transport.closeLogin.mock.calls[0]![0]).toBe(attemptHandle);
  });
  it("a rejected Close cancellation fences the old pending observation and retains the draft with an uncertain outcome", async () => {
    const { controller, transport, intent, edit } = setup(observed("signed-out")); await controller.refresh(); edit("before-close");
    const observation = deferred<HarnessState>(); transport.readHarnessState.mockReturnValueOnce(observation.promise);
    const cancellation = deferred<LoginCloseResult>(); transport.closeLogin.mockReturnValue(cancellation.promise);
    intent("connect"); await flush(); controller.closeConnection(); await flush(); edit("during-close");
    cancellation.reject(new Error("cancel response lost")); await flush();
    expect(controller.getSnapshot().authDetail?.en).toContain("uncertain");
    expect(controller.getSnapshot().state).toBeNull();
    observation.resolve(observed("signing-in", null, target.contextKey, pendingLogin)); await flush();
    expect(controller.getSnapshot().state).toBeNull(); expect(controller.getSnapshot().authBusy).toBeNull();
    expect(controller.getSnapshot().authDetail?.en).toContain("uncertain");
    expect(controller.getSnapshot().draft.model).toBe("during-close"); expect(controller.getSnapshot().revision).toBe(0);
    expect(transport.closeLogin).toHaveBeenCalledTimes(1); expect(transport.startLogin).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it("navigation to Pi after Close cannot be changed by late cancellation rejection or the older login observation", async () => {
    const { controller, transport, intent, edit } = setup(observed("signed-out")); await controller.refresh(); edit("codex-draft");
    const observation = deferred<HarnessState>(); transport.readHarnessState.mockReturnValueOnce(observation.promise);
    const cancellation = deferred<LoginCloseResult>(); transport.closeLogin.mockReturnValue(cancellation.promise);
    intent("connect"); await flush(); controller.closeConnection(); await flush();
    controller.selectTarget(piTarget); edit("pi-draft"); await controller.refreshState();
    const before = controller.getSnapshot(); cancellation.reject(new Error("late cancel response lost")); await flush();
    observation.resolve(observed("signing-in", null, target.contextKey, pendingLogin)); await flush();
    expect(controller.getSnapshot().target).toEqual(piTarget); expect(controller.getSnapshot().state).toEqual(before.state);
    expect(controller.getSnapshot().draft.model).toBe("pi-draft"); expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().authDetail).toBeUndefined(); expect(controller.getSnapshot().authBusy).toBeNull();
    expect(transport.closeLogin).toHaveBeenCalledTimes(1); expect(transport.closeLogin.mock.calls[0]![0]).toBe(attemptHandle);
    expect(transport.startLogin).toHaveBeenCalledTimes(1); controller.selectTarget(target);
    expect(controller.getSnapshot().draft.model).toBe("codex-draft"); controller.dispose();
  });
  it.each(["cancel", "harness", "context"] as const)("%s invalidates a late login reply without changing the current target, account or draft", async boundary => {
    const { controller, transport, intent, edit } = setup(observed("signed-out")); await controller.refresh(); edit("original-draft");
    const login = deferred<StudioCodexLogin>(); transport.startLogin.mockReturnValue(login.promise);
    intent("connect"); await flush();
    if (boundary === "cancel") controller.cancel();
    else controller.selectTarget(boundary === "harness" ? piTarget : { ...target, contextKey: "new-context" });
    edit("current-draft"); const before = controller.getSnapshot(); login.resolve(pendingLogin); await flush();
    expect(controller.getSnapshot().target).toEqual(before.target); expect(controller.getSnapshot().draft).toEqual(before.draft);
    expect(controller.getSnapshot().state).toEqual(before.state); expect(controller.getSnapshot().revision).toBe(before.revision);
    expect(transport.closeLogin).not.toHaveBeenCalled(); expect(transport.readHarnessState).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it("navigation return observes an existing pending attempt without starting another login", async () => {
    const { controller, transport, intent } = setup(observed("signed-out")); await controller.refresh();
    const login = deferred<StudioCodexLogin>(); transport.startLogin.mockReturnValue(login.promise); intent("connect"); await flush(); controller.cancel();
    transport.readHarnessState.mockResolvedValue(observed("signing-in", 2, target.contextKey, pendingLogin)); await controller.refresh();
    intent("connect"); login.resolve(pendingLogin); await flush();
    expect(transport.startLogin).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().state?.connection?.login?.loginId).toBe("attempt-one");
    expect(controller.getSnapshot().ownerGeneration).toBe(2); controller.dispose();
  });
  it("a generation change invalidates an in-flight save without promoting its late result", async () => {
    const { controller, transport, edit, save } = setup(observed("signed-in", 1)); await controller.refresh(); edit("draft-at-one");
    const saved = deferred<AgentSettings>(); transport.saveSettings.mockReturnValue(saved.promise); const pending = save(); await flush();
    transport.readHarnessState.mockResolvedValue(observed("signed-in", 2)); await controller.refreshState();
    expect(transport.saveSettings.mock.calls[0]![1].aborted).toBe(true); saved.resolve(settings(1, "draft-at-one")); await pending;
    expect(controller.getSnapshot().ownerGeneration).toBe(2); expect(controller.getSnapshot().draft.model).toBe("draft-at-one");
    expect(controller.getSnapshot().revision).toBe(0); expect(controller.getSnapshot().baseline?.revision).toBe(0);
    expect(controller.getSnapshot().savePhase).toBe("uncertain"); controller.dispose();
  });
  it("never dispatches Codex authentication or binding for Pi or a stale target intent", async () => {
    const { controller, transport } = setup(); await controller.refresh(); controller.selectTarget(piTarget); await controller.refresh();
    for (const action of ["connect", "sign-out", "cancel-sign-in"] as const) controller.connectionIntent({ action, target: piTarget, attemptKey: "attempt-one" });
    controller.connectionIntent({ action: "connect", target }); controller.closeConnection(); await controller.bindConnection(); await flush();
    expect(controller.getSnapshot().target).toEqual(piTarget); expect(controller.getSnapshot().state?.availability).toBe("unavailable");
    expect(transport.startLogin).not.toHaveBeenCalled(); expect(transport.closeLogin).not.toHaveBeenCalled();
    expect(transport.logout).not.toHaveBeenCalled(); expect(transport.bindConnection).not.toHaveBeenCalled(); controller.dispose();
  });
});

describe("explicit binding preserves target-owned draft revisions", () => {
  it("dispatches synchronous repeated bind once using the draft's CAS revision", async () => {
    const { controller, transport } = setup(); await controller.refresh(); const bound = deferred<AgentSettings>(); transport.bindConnection.mockReturnValue(bound.promise);
    const first = controller.bindConnection(); const second = controller.bindConnection(); await flush();
    expect(transport.bindConnection).toHaveBeenCalledTimes(1); expect(transport.bindConnection.mock.calls[0]![0]).toBe(0);
    bound.resolve(settings()); await Promise.all([first, second]); expect(controller.getSnapshot().baseline?.modelConnectionRef).toBe("backend-owned-binding"); controller.dispose();
  });
  it("bind success preserves newer edits and advances only the active draft's baseline", async () => {
    const { controller, transport, edit } = setup(); await controller.refresh();
    controller.selectTarget(piTarget); edit("pi-at-zero"); controller.selectTarget(target); await controller.refreshState(); edit("before-bind");
    const bound = deferred<AgentSettings>(); transport.bindConnection.mockReturnValue(bound.promise); const pending = controller.bindConnection(); await flush(); edit("during-bind");
    bound.resolve(settings(1)); await pending;
    expect(controller.getSnapshot().draft.model).toBe("during-bind"); expect(controller.getSnapshot().revision).toBe(1);
    expect(controller.getSnapshot().hasChanges).toBe(true); expect(controller.getSnapshot().state?.execution).toBeNull();
    controller.selectTarget(piTarget); expect(controller.getSnapshot().draft.model).toBe("pi-at-zero"); expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().savePhase).toBe("conflict"); controller.dispose();
  });
  it("bind conflict retains dirty preferences and old revision until explicit review", async () => {
    const { controller, transport, edit } = setup(); await controller.refresh(); edit("my-draft");
    transport.bindConnection.mockRejectedValue(new ApiResponseError("changed", 409, {})); transport.readSettings.mockResolvedValue(settings(2, "remote")); await controller.bindConnection();
    expect(controller.getSnapshot().draft.model).toBe("my-draft"); expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().baseline?.revision).toBe(2); expect(controller.getSnapshot().savePhase).toBe("conflict");
    await controller.bindConnection(); expect(transport.bindConnection).toHaveBeenCalledTimes(1);
    controller.reviewLatest(); expect(controller.getSnapshot().draft.model).toBe("my-draft"); expect(controller.getSnapshot().revision).toBe(2); controller.dispose();
  });
  it.each([400, 403, 422, 503])("bind rejection HTTP %s retains dirty preferences and the CAS baseline", async status => {
    const { controller, transport, edit } = setup(); await controller.refresh(); edit("my-draft");
    transport.bindConnection.mockRejectedValue(new ApiResponseError("denied", status, {})); await controller.bindConnection();
    expect(controller.getSnapshot().draft.model).toBe("my-draft"); expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().baseline?.revision).toBe(0); expect(controller.getSnapshot().authDetail?.en).toContain("rejected");
    expect(transport.bindConnection).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it("an uncertain bind reads current settings but retains the dirty draft's revision and never retries", async () => {
    const { controller, transport, edit } = setup(); await controller.refresh(); edit("my-draft");
    transport.bindConnection.mockRejectedValue(new Error("response lost")); transport.readSettings.mockResolvedValue(settings(1)); await controller.bindConnection();
    expect(controller.getSnapshot().draft.model).toBe("my-draft"); expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().baseline?.revision).toBe(1); expect(controller.getSnapshot().savePhase).toBe("uncertain");
    expect(controller.getSnapshot().canSave).toBe(false); expect(controller.getSnapshot().reviewable).toBe(true);
    expect(transport.bindConnection).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it.each(["cancel", "harness", "context", "generation"] as const)("%s invalidates an in-flight bind and ignores its late success", async boundary => {
    const { controller, transport, edit } = setup(observed("signed-in", 1)); await controller.refresh(); edit("old-draft");
    const bound = deferred<AgentSettings>(); transport.bindConnection.mockReturnValue(bound.promise); const pending = controller.bindConnection(); await flush();
    if (boundary === "cancel") controller.cancel();
    else if (boundary === "generation") { transport.readHarnessState.mockResolvedValue(observed("signed-in", 2)); await controller.refreshState(); }
    else controller.selectTarget(boundary === "harness" ? piTarget : { ...target, contextKey: "new-context" });
    edit("current-draft"); const before = controller.getSnapshot(); bound.resolve(settings(1)); await pending;
    expect(transport.bindConnection.mock.calls[0]![1].aborted).toBe(true);
    expect(controller.getSnapshot().target).toEqual(before.target); expect(controller.getSnapshot().draft).toEqual(before.draft);
    expect(controller.getSnapshot().baseline?.revision).toBe(0); expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().state).toEqual(before.state); expect(controller.getSnapshot().authDetail).toEqual(before.authDetail); controller.dispose();
  });
});

describe("browser transport carries only narrow authentication intents", () => {
  it("posts reservation, start/close handle and bind revision without credential references", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      const result = String(input).endsWith("/login/reserve") ? { reservation: { attemptHandle, expiresAt: Date.now() + 120_000 } }
        : String(input).endsWith("/login/close") ? { result: closeResult }
        : String(input).endsWith("/login") ? { login: pendingLogin } : String(input).endsWith("/bind") ? { settings: settings() } : {};
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const transport = createAgentConfigurationTransport(fetchImpl); const signal = new AbortController().signal;
    await transport.reserveLogin!(signal); await transport.startLogin!(attemptHandle, signal); await transport.closeLogin!(attemptHandle, signal); await transport.logout!(signal); await transport.bindConnection!(7, signal);
    expect(calls).toEqual([
      { path: "/api/v1/agent-configuration/harnesses/codex/login/reserve", body: {} },
      { path: "/api/v1/agent-configuration/harnesses/codex/login", body: { attemptHandle } },
      { path: "/api/v1/agent-configuration/harnesses/codex/login/close", body: { attemptHandle } },
      { path: "/api/v1/agent-configuration/harnesses/codex/logout", body: {} },
      { path: "/api/v1/agent-configuration/harnesses/codex/bind", body: { expectedRevision: 7 } },
    ]);
  });
});

const knownPiTarget = { harness: "pi" as const, contextKey: "pi-public-context" };
const piHandle = "pi-login-offline-one";
function piAttempt(status: StudioPiLoginAttempt["status"] = "reserved", handle = piHandle): StudioPiLoginAttempt {
  return { harnessId: "pi", handle, status, expiresAt: Date.now() + 300_000,
    canReply: status === "awaiting-user", challenge: status === "awaiting-user" ? { kind: "open-url", url: "https://auth.openai.com/api/accounts/authorize?state=offline" } : null,
    prompt: status === "awaiting-user" ? { promptId: `prompt-${handle}`, kind: "callback-url" } : null, error: null };
}
function piObserved(generation: number | null = null, contextKey = knownPiTarget.contextKey): HarnessState {
  return { ...unavailableHarnessState("pi"), availability: "available", installation: "installed", localAuthentication: "missing",
    scope: { harnessId: "pi", authContextRef: contextKey, ownerGeneration: generation, adapterVersion: "offline-pi", catalogVersion: "offline-pi" } };
}
function setupPi(timeout = 15_000) {
  // Controlled public DTOs are an offline transport fixture, never a PiAccountService
  // or OAuth substitute. The production controller owns every request/lifecycle fence.
  const old = setup(); old.controller.dispose();
  type PiTransport = NonNullable<AgentConfigurationTransport["pi"]>;
  const pi = {
    reserveLogin: vi.fn<PiTransport["reserveLogin"]>().mockResolvedValue(piAttempt()),
    startLogin: vi.fn<PiTransport["startLogin"]>().mockResolvedValue(piAttempt("awaiting-user")),
    readLogin: vi.fn<PiTransport["readLogin"]>().mockResolvedValue(piAttempt("awaiting-user")),
    replyLogin: vi.fn<PiTransport["replyLogin"]>().mockResolvedValue(piAttempt("exchanging")),
    closeLogin: vi.fn<PiTransport["closeLogin"]>().mockResolvedValue({ outcome: "closed", attempt: piAttempt("closed") }),
  };
  const stored = { ...initial, selectedHarnessId: "pi" as const };
  const transport = { ...old.transport, pi,
    readSettings: vi.fn<AgentConfigurationTransport["readSettings"]>().mockResolvedValue(stored),
    readHarnessState: vi.fn<AgentConfigurationTransport["readHarnessState"]>().mockResolvedValue(piObserved()),
  };
  const controller = createAgentConfigurationController(transport, knownPiTarget, timeout);
  const connect = () => controller.connectionIntent({ action: "connect", target: controller.getSnapshot().target });
  const edit = (model: string) => controller.edit({ action: "choose-option", target: controller.getSnapshot().target, field: "model", choiceKey: model });
  const save = () => controller.save({ action: "save-defaults", target: controller.getSnapshot().target, selection: toSelection(controller.getSnapshot().draft) });
  const noCodex = () => { for (const operation of [transport.reserveLogin, transport.startLogin, transport.closeLogin, transport.logout, transport.bindConnection]) expect(operation).not.toHaveBeenCalled(); };
  return { controller, transport, pi, connect, edit, save, noCodex };
}

describe("Pi authentication uses independent public attempts and captured browser intents (offline)", () => {
  it("S2: synchronous scope-busy start refusal survives reserved reads, then explicit Close and new intent replace it", async () => {
    const f = setupPi(); await f.controller.refresh(); f.edit("retained-busy-draft");
    f.pi.startLogin.mockRejectedValueOnce(new ApiResponseError("PRIVATE-REFUSAL", 409, { error: { code: "PI_SCOPE_BUSY", message: "PRIVATE-REFUSAL" } }));
    f.pi.readLogin.mockResolvedValue(piAttempt("reserved")); f.connect(); await flush();
    const before = f.controller.getSnapshot(); expect(before.piAuthDetail?.en).toMatch(/scope.*busy/i);
    for (let index = 0; index < 2; index++) {
      await f.controller.refresh(); const current = f.controller.getSnapshot();
      expect(current.piLoginAttempt).toMatchObject({ handle: piHandle, status: "reserved", error: null });
      expect(current.piAuthBusy).toBeNull(); expect(current.piAuthDetail?.en).toMatch(/scope.*busy/i);
      expect(current.draft).toEqual(before.draft); expect(current.revision).toBe(before.revision); expect(current.savePhase).toBe(before.savePhase);
      expect(current.baseline?.modelConnectionRef).toBe(before.baseline?.modelConnectionRef); expect(JSON.stringify(current)).not.toContain("PRIVATE-REFUSAL");
    }
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); expect(f.pi.replyLogin).not.toHaveBeenCalled();
    f.controller.closePiLogin(knownPiTarget, piHandle); await flush();
    expect(f.controller.getSnapshot().piCloseResult?.outcome).toBe("closed"); expect(f.controller.getSnapshot().piAuthDetail?.en).not.toMatch(/scope.*busy/i);
    const next = "fresh-after-busy"; f.pi.reserveLogin.mockResolvedValue(piAttempt("reserved", next)); f.pi.startLogin.mockResolvedValue(piAttempt("awaiting-user", next));
    f.connect(); await flush(); expect(f.controller.getSnapshot().piLoginAttempt?.handle).toBe(next); expect(f.controller.getSnapshot().piAuthDetail?.en).not.toMatch(/scope.*busy/i);
    f.noCodex(); f.controller.dispose();
  });

  it.each(["PI_ATTEMPT_EXPIRED", "PI_UNKNOWN_HANDLE", "PI_SERVICE_STOPPED"] as const)("S2: authoritative %s read refusal takes priority over an earlier scope-busy start", async code => {
    const f = setupPi(); await f.controller.refresh();
    f.pi.startLogin.mockRejectedValueOnce(new ApiResponseError("PRIVATE-START", 409, { error: { code: "PI_SCOPE_BUSY" } }));
    f.connect(); await flush(); f.pi.readLogin.mockRejectedValue(new ApiResponseError("PRIVATE-READ", 410, { error: { code } }));
    await f.controller.refreshPiLogin(); expect(f.controller.getSnapshot().piAuthDetail?.en).not.toMatch(/scope.*busy/i);
    expect(f.controller.getSnapshot().piAuthDetail?.en).toContain(code.slice(3).toLowerCase().replaceAll("_", "-"));
    const returned = createAgentConfigurationController(f.transport, knownPiTarget); await returned.refresh();
    expect(returned.getSnapshot().piAuthDetail?.en).not.toMatch(/scope.*busy/i); expect(f.pi.startLogin).toHaveBeenCalledTimes(1);
    f.noCodex(); returned.dispose(); f.controller.dispose();
  });

  it("synchronously deduplicates Connect and exposes entry capabilities without online or deployment evidence", async () => {
    const f = setupPi(); await f.controller.refresh(); const reserve = deferred<StudioPiLoginAttempt>(); f.pi.reserveLogin.mockReturnValue(reserve.promise);
    f.connect(); f.connect(); f.controller.connectionIntent({ action: "sign-out", target: knownPiTarget });
    expect(f.controller.getSnapshot().piAuthBusy).toBe("reserve"); expect(f.controller.getSnapshot().authBusy).toBe("login");
    expect(f.controller.getSnapshot().piCapabilities).toEqual({ canStartLogin: true, canCloseAttempt: false, canReply: false, canLogout: false });
    expect(f.controller.getSnapshot().piCanClose).toBe(true); await flush(); expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1);
    reserve.resolve(piAttempt()); await flush(); expect(f.pi.startLogin).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot().piLoginAttempt?.status).toBe("awaiting-user");
    expect(f.controller.getSnapshot().piCapabilities).toEqual({ canStartLogin: true, canCloseAttempt: true, canReply: true, canLogout: false });
    expect(f.controller.getSnapshot().state?.account).toBeNull(); expect(f.controller.getSnapshot().state?.execution).toBeNull(); f.noCodex(); f.controller.dispose();
  });

  it("records Close before a late reservation, closes only that handle after navigation, and never starts it", async () => {
    const f = setupPi(); await f.controller.refresh(); const reserve = deferred<StudioPiLoginAttempt>(); f.pi.reserveLogin.mockReturnValue(reserve.promise);
    f.connect(); await flush(); f.controller.closePiLogin(knownPiTarget); f.controller.closePiLogin(knownPiTarget);
    f.controller.selectTarget(target); f.edit("current-codex-draft"); const before = f.controller.getSnapshot();
    reserve.resolve(piAttempt()); await flush();
    expect(f.pi.closeLogin).toHaveBeenCalledTimes(1); expect(f.pi.closeLogin.mock.calls[0]![0]).toBe(piHandle); expect(f.pi.startLogin).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().target).toEqual(before.target); expect(f.controller.getSnapshot().draft).toEqual(before.draft);
    expect(f.controller.getSnapshot().piLoginAttempt).toBeNull(); expect(f.controller.getSnapshot().piCloseResult).toBeUndefined(); f.noCodex(); f.controller.dispose();
  });

  it("a detached late reserve is recovered only by reads on the same transport and never auto-started or closed", async () => {
    const f = setupPi(); await f.controller.refresh(); const reserve = deferred<StudioPiLoginAttempt>(); f.pi.reserveLogin.mockReturnValue(reserve.promise);
    f.connect(); await flush(); f.controller.cancel(); const reserved = piAttempt(); reserve.resolve(reserved); await flush();
    expect(f.pi.startLogin).not.toHaveBeenCalled(); expect(f.pi.closeLogin).not.toHaveBeenCalled();
    f.pi.readLogin.mockResolvedValue(reserved); const returned = createAgentConfigurationController(f.transport, knownPiTarget); await returned.refresh();
    expect(returned.getSnapshot().piLoginAttempt).toEqual(reserved); expect(f.pi.readLogin).toHaveBeenCalledTimes(1);
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).not.toHaveBeenCalled(); expect(f.pi.closeLogin).not.toHaveBeenCalled(); f.noCodex(); returned.dispose(); f.controller.dispose();
  });

  it("a lost reservation does not replay; only a fresh explicit Connect can create a new attempt", async () => {
    const f = setupPi(); await f.controller.refresh(); f.pi.reserveLogin.mockRejectedValueOnce(new Error("reservation delivery lost"));
    f.connect(); await flush(); await f.controller.refresh();
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).not.toHaveBeenCalled(); expect(f.pi.closeLogin).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().piAuthDetail?.en).toMatch(/uncertain/i);
    f.connect(); await flush(); expect(f.pi.reserveLogin).toHaveBeenCalledTimes(2); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); f.noCodex(); f.controller.dispose();
  });

  it.each(["cancel", "harness", "context"] as const)("%s fences a late start without changing the current draft or association", async edge => {
    const f = setupPi(); await f.controller.refresh(); const start = deferred<StudioPiLoginAttempt>(); f.pi.startLogin.mockReturnValue(start.promise);
    f.edit("pi-dirty-before"); f.connect(); await flush();
    if (edge === "cancel") f.controller.cancel(); else f.controller.selectTarget(edge === "harness" ? target : { ...knownPiTarget, contextKey: "other-pi-context" });
    f.edit("current-dirty"); const before = f.controller.getSnapshot(); start.resolve(piAttempt("awaiting-user")); await flush();
    expect(f.pi.startLogin.mock.calls[0]![1].aborted).toBe(true); expect(f.pi.closeLogin).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().target).toEqual(before.target); expect(f.controller.getSnapshot().draft).toEqual(before.draft);
    expect(f.controller.getSnapshot().state).toEqual(before.state); expect(f.controller.getSnapshot().piLoginAttempt).toBeNull();
    expect(f.controller.getSnapshot().revision).toBe(0); f.noCodex(); f.controller.dispose();
  });

  it("reply requires the exact target, handle and current prompt, deduplicates synchronously and never retains callback text", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush();
    const metadata = { target: knownPiTarget, attemptHandle: piHandle, promptId: piAttempt("awaiting-user").prompt!.promptId };
    for (const invalid of [{ ...metadata, target }, { ...metadata, attemptHandle: "pi-other-handle" }, { ...metadata, promptId: "obsolete-prompt" }]) await f.controller.replyPiLogin(invalid, "synthetic-callback-private");
    expect(f.pi.replyLogin).not.toHaveBeenCalled();
    const reply = deferred<StudioPiLoginAttempt>(); f.pi.replyLogin.mockReturnValue(reply.promise);
    const one = f.controller.replyPiLogin(metadata, "synthetic-callback-private"); const two = f.controller.replyPiLogin(metadata, "synthetic-callback-private"); await flush();
    expect(f.pi.replyLogin).toHaveBeenCalledTimes(1); expect(f.pi.replyLogin.mock.calls[0]!.slice(0, 3)).toEqual([piHandle, metadata.promptId, "synthetic-callback-private"]);
    expect(f.controller.getSnapshot().piAuthBusy).toBe("reply"); expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("synthetic-callback-private");
    reply.resolve(piAttempt("exchanging")); await Promise.all([one, two]); await flush();
    expect(f.controller.getSnapshot().piLoginAttempt?.status).toBe("exchanging"); expect(f.controller.getSnapshot().piCapabilities?.canReply).toBe(false);
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("synthetic-callback-private"); f.noCodex(); f.controller.dispose();
  });

  it("a newer prompt makes the captured old reply metadata inert", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush();
    const previous = piAttempt("awaiting-user"); f.pi.readLogin.mockResolvedValue({ ...previous, prompt: { promptId: "new-prompt", kind: "callback-url" } });
    await f.controller.refreshPiLogin();
    await f.controller.replyPiLogin({ target: knownPiTarget, attemptHandle: piHandle, promptId: previous.prompt!.promptId }, "synthetic-callback-private");
    expect(f.pi.replyLogin).not.toHaveBeenCalled(); expect(f.controller.getSnapshot().piLoginAttempt?.prompt?.promptId).toBe("new-prompt"); f.noCodex(); f.controller.dispose();
  });

  it("a lost reply is observed without automatic replay and navigation prevents its late response from publishing", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush(); const reply = deferred<StudioPiLoginAttempt>(); f.pi.replyLogin.mockReturnValue(reply.promise);
    const pending = f.controller.replyPiLogin({ target: knownPiTarget, attemptHandle: piHandle, promptId: piAttempt("awaiting-user").prompt!.promptId }, "synthetic-callback-private"); await flush();
    f.controller.selectTarget(target); f.edit("codex-after-reply"); const before = f.controller.getSnapshot(); reply.resolve(piAttempt("saved")); await pending; await flush();
    expect(f.pi.replyLogin.mock.calls[0]![3].aborted).toBe(true); expect(f.controller.getSnapshot().draft).toEqual(before.draft); expect(f.controller.getSnapshot().state).toEqual(before.state);
    f.pi.readLogin.mockResolvedValue(piAttempt("saved")); f.controller.selectTarget(knownPiTarget); await f.controller.refresh();
    expect(f.controller.getSnapshot().piLoginAttempt?.status).toBe("saved"); expect(f.pi.replyLogin).toHaveBeenCalledTimes(1); expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1);
    expect(f.controller.getSnapshot().state?.execution).toBeNull(); f.noCodex(); f.controller.dispose();
  });

  it("Close has an independent deadline, deduplicates and restores only its receipt after detach without clearing newer observations", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush(); f.edit("dirty-pi");
    const closing = deferred<StudioPiCloseResult>(); f.pi.closeLogin.mockReturnValue(closing.promise); f.controller.closePiLogin(knownPiTarget, piHandle); f.controller.closePiLogin(knownPiTarget, piHandle); await flush();
    const signal = f.pi.closeLogin.mock.calls[0]![1]; f.controller.cancel(); expect(signal.aborted).toBe(false);
    closing.resolve({ outcome: "already-committed", attempt: piAttempt("saved") }); await flush();
    f.transport.readHarnessState.mockResolvedValue({ ...piObserved(4), localAuthentication: "oauth-present" });
    const returned = createAgentConfigurationController(f.transport, knownPiTarget); await returned.refresh();
    expect(returned.getSnapshot().piCloseResult?.outcome).toBe("already-committed"); expect(returned.getSnapshot().state?.localAuthentication).toBe("oauth-present");
    expect(returned.getSnapshot().ownerGeneration).toBe(4); expect(returned.getSnapshot().state?.execution).toBeNull(); returned.closePiLogin(knownPiTarget, piHandle); await flush();
    expect(f.pi.closeLogin).toHaveBeenCalledTimes(1); expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); f.noCodex(); returned.dispose(); f.controller.dispose();
  });

  it("Close uncertainty permits only an explicit exact-handle recheck and never Reserve/Start replay", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush(); f.pi.closeLogin.mockRejectedValueOnce(new Error("close reply lost"));
    f.controller.closePiLogin(knownPiTarget, piHandle); await flush(); await f.controller.refresh();
    expect(f.controller.getSnapshot().piAuthDetail?.en).toMatch(/uncertain/i); expect(f.pi.closeLogin).toHaveBeenCalledTimes(1); expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).toHaveBeenCalledTimes(1);
    f.controller.closePiLogin(knownPiTarget, "wrong-handle"); await flush(); expect(f.pi.closeLogin).toHaveBeenCalledTimes(1);
    f.controller.closePiLogin(knownPiTarget, piHandle); f.controller.closePiLogin(knownPiTarget, piHandle); await flush();
    expect(f.pi.closeLogin).toHaveBeenCalledTimes(2); expect(f.controller.getSnapshot().piCloseResult?.outcome).toBe("closed"); f.noCodex(); f.controller.dispose();
  });

  it.each(["sdk-unavailable", "login-deployment-unavailable", "scope-busy", "storage-failed", "device-settings-invalid"] as const)("keeps finite $0 non-ready results separate from saved settings and never auto-retries", async error => {
    const f = setupPi(); await f.controller.refresh(); f.edit("dirty-pi"); const failed = { ...piAttempt("failed"), error }; f.pi.startLogin.mockResolvedValue(failed); f.pi.readLogin.mockResolvedValue(failed);
    f.connect(); await flush(); await f.controller.refresh();
    expect(f.controller.getSnapshot().piLoginAttempt).toMatchObject({ status: "failed", error }); expect(f.controller.getSnapshot().piAuthDetail?.en).toBeTruthy();
    expect(f.controller.getSnapshot().draft.model).toBe("dirty-pi"); expect(f.controller.getSnapshot().revision).toBe(0); expect(f.controller.getSnapshot().state?.execution).toBeNull();
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); expect(f.transport.saveSettings).not.toHaveBeenCalled(); f.noCodex(); f.controller.dispose();
  });

  it.each(["save-first", "auth-first"] as const)("Pi authentication and an in-flight preference save settle independently (%s) while newer edits survive", async order => {
    const f = setupPi(); await f.controller.refresh(); f.edit("submitted-pi"); const saved = deferred<AgentSettings>(), started = deferred<StudioPiLoginAttempt>();
    f.transport.saveSettings.mockReturnValue(saved.promise); f.pi.startLogin.mockReturnValue(started.promise);
    const saving = f.save(); await flush(); f.connect(); f.edit("newer-pi"); await flush();
    expect(f.transport.saveSettings.mock.calls[0]![1].aborted).toBe(false); expect(f.controller.getSnapshot().savePhase).toBe("saving");
    const settleSave = async () => { saved.resolve({ ...initial, selectedHarnessId: "pi", revision: 1, harnessPreferences: { ...initial.harnessPreferences, pi: { ...native, model: "submitted-pi" } } }); await saving; };
    const settleAuth = async () => { f.transport.readHarnessState.mockResolvedValue(piObserved(6)); started.resolve(piAttempt("awaiting-user")); await flush(); };
    if (order === "save-first") { await settleSave(); await settleAuth(); } else { await settleAuth(); await settleSave(); }
    expect(f.controller.getSnapshot().draft.model).toBe("newer-pi"); expect(f.controller.getSnapshot().revision).toBe(1); expect(f.controller.getSnapshot().baseline?.revision).toBe(1);
    expect(f.controller.getSnapshot().savePhase).toBe("saved"); expect(f.controller.getSnapshot().ownerGeneration).toBe(6); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); f.noCodex(); f.controller.dispose();
  });

  it.each(["save-first", "auth-first"] as const)("a Pi CAS conflict is claimed independently from authentication (%s) with dirty revision retained", async order => {
    const f = setupPi(); await f.controller.refresh(); f.edit("cas-pi"); const saved = deferred<AgentSettings>(), started = deferred<StudioPiLoginAttempt>();
    f.transport.saveSettings.mockReturnValue(saved.promise); f.pi.startLogin.mockReturnValue(started.promise); const saving = f.save(); await flush(); f.connect(); await flush();
    const stored = { ...initial, revision: 2, selectedHarnessId: "pi" as const }; f.transport.readSettings.mockResolvedValue(stored);
    const settleSave = async () => { saved.reject(new ApiResponseError("Settings changed", 409, { error: { code: "SETTINGS_CONFLICT" } })); await saving; };
    const settleAuth = async () => { f.transport.readHarnessState.mockResolvedValue(piObserved(6)); started.resolve(piAttempt("awaiting-user")); await flush(); };
    if (order === "save-first") { await settleSave(); await settleAuth(); } else { await settleAuth(); await settleSave(); }
    expect(f.controller.getSnapshot().savePhase).toBe("conflict"); expect(f.controller.getSnapshot().revision).toBe(0); expect(f.controller.getSnapshot().baseline?.revision).toBe(2);
    expect(f.controller.getSnapshot().draft.model).toBe("cas-pi"); expect(f.controller.getSnapshot().reviewable).toBe(true); expect(f.transport.saveSettings.mock.calls[0]![1].aborted).toBe(false); f.noCodex(); f.controller.dispose();
  });

  it("the real Pi HTTP group carries only narrow handle/prompt/callback inputs and keeps Close alive independently", async () => {
    const calls: { path: string; method: string; body: unknown; keepalive: boolean | undefined }[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const path = String(input); calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, keepalive: init?.keepalive });
      return Response.json(path.endsWith("/close") ? { result: { outcome: "closed", attempt: piAttempt("closed") } } : { attempt: piAttempt(path.endsWith("/reply") ? "exchanging" : "reserved") });
    });
    const group = createAgentConfigurationTransport(fetchImpl).pi!; const signal = new AbortController().signal;
    await group.reserveLogin(signal); await group.startLogin(piHandle, signal); await group.readLogin(piHandle, signal);
    await group.replyLogin(piHandle, "public-prompt", "synthetic-callback-private", signal); await group.closeLogin(piHandle, signal);
    expect(calls).toEqual([
      { path: "/api/v1/agent-configuration/harnesses/pi/login/reserve", method: "POST", body: {}, keepalive: false },
      { path: "/api/v1/agent-configuration/harnesses/pi/login/start", method: "POST", body: { attemptHandle: piHandle }, keepalive: false },
      { path: `/api/v1/agent-configuration/harnesses/pi/login/attempts/${piHandle}?wait=1`, method: "GET", body: undefined, keepalive: undefined },
      { path: "/api/v1/agent-configuration/harnesses/pi/login/reply", method: "POST", body: { attemptHandle: piHandle, promptId: "public-prompt", callbackUrl: "synthetic-callback-private" }, keepalive: false },
      { path: "/api/v1/agent-configuration/harnesses/pi/login/close", method: "POST", body: { attemptHandle: piHandle }, keepalive: true },
    ]);
  });

  it("an explicit unknown Close receipt is retained distinctly from lost delivery and only the same handle may be rechecked", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush();
    const result: StudioPiCloseResult = { outcome: "unknown", attempt: { ...piAttempt("unknown"), error: "owner-changed" } };
    f.pi.closeLogin.mockResolvedValueOnce(result); f.controller.closePiLogin(knownPiTarget, piHandle); await flush();
    expect(f.controller.getSnapshot().piCloseResult).toEqual(result); expect(f.controller.getSnapshot().piLoginAttempt).toEqual(result.attempt);
    expect(f.controller.getSnapshot().piAuthDetail?.en).toMatch(/uncertain/i); await f.controller.refresh();
    expect(f.controller.getSnapshot().piCloseResult).toEqual(result); expect(f.pi.closeLogin).toHaveBeenCalledTimes(1);
    f.controller.closePiLogin(knownPiTarget, "other-handle"); await flush(); expect(f.pi.closeLogin).toHaveBeenCalledTimes(1);
    f.controller.closePiLogin(knownPiTarget, piHandle); await flush(); expect(f.pi.closeLogin).toHaveBeenCalledTimes(2);
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); f.noCodex(); f.controller.dispose();
  });

  it("a late old Close cannot publish over a newer explicit Connect while its reservation is held", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush(); f.edit("pi-draft");
    const close = deferred<StudioPiCloseResult>(); f.pi.closeLogin.mockReturnValue(close.promise); f.controller.closePiLogin(knownPiTarget, piHandle); await flush();
    const reserve = deferred<StudioPiLoginAttempt>(); f.pi.reserveLogin.mockReturnValue(reserve.promise); f.connect(); await flush();
    expect(f.controller.getSnapshot().piAuthBusy).toBe("reserve"); expect(f.controller.getSnapshot().piLoginAttempt).toBeNull();
    const currentDraft = f.controller.getSnapshot().draft; close.resolve({ outcome: "already-committed", attempt: piAttempt("saved") }); await flush();
    expect(f.controller.getSnapshot().piAuthBusy).toBe("reserve"); expect(f.controller.getSnapshot().piCloseResult).toBeUndefined();
    expect(f.controller.getSnapshot().piLoginAttempt).toBeNull(); expect(f.controller.getSnapshot().draft).toEqual(currentDraft);
    const second = piAttempt("reserved", "new-pi-handle"); f.pi.startLogin.mockResolvedValue(piAttempt("awaiting-user", second.handle)); reserve.resolve(second); await flush();
    expect(f.controller.getSnapshot().piLoginAttempt?.handle).toBe(second.handle); expect(f.pi.closeLogin).toHaveBeenCalledTimes(1); f.noCodex(); f.controller.dispose();
  });

  it("an actual auth-context mismatch fences an in-flight reply without losing dirty preferences or its revision", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush(); f.edit("retained-dirty-pi");
    const reply = deferred<StudioPiLoginAttempt>(); f.pi.replyLogin.mockReturnValue(reply.promise);
    const replying = f.controller.replyPiLogin({ target: knownPiTarget, attemptHandle: piHandle, promptId: piAttempt("awaiting-user").prompt!.promptId }, "synthetic-callback-private"); await flush();
    const current = { ...piObserved(8, "mismatched-pi-auth-context"), localAuthentication: "oauth-present" as const }; f.transport.readHarnessState.mockResolvedValue(current);
    await f.controller.refreshState(); const snapshot = f.controller.getSnapshot(); reply.resolve(piAttempt("saved")); await replying; await flush();
    expect(f.pi.replyLogin.mock.calls[0]![3].aborted).toBe(true); expect(f.controller.getSnapshot().state).toBeNull(); expect(f.controller.getSnapshot().ownerGeneration).toBeNull();
    expect(f.controller.getSnapshot().draft).toEqual(snapshot.draft); expect(f.controller.getSnapshot().revision).toBe(0);
    expect(f.controller.getSnapshot().piLoginAttempt?.status).not.toBe("saved"); expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("synthetic-callback-private"); f.noCodex(); f.controller.dispose();
  });

  it("a lost callback response reads the same attempt but cannot automatically submit the callback again", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush(); f.pi.replyLogin.mockRejectedValueOnce(new TypeError("reply lost"));
    await f.controller.replyPiLogin({ target: knownPiTarget, attemptHandle: piHandle, promptId: piAttempt("awaiting-user").prompt!.promptId }, "synthetic-callback-private");
    expect(f.controller.getSnapshot().piAuthDetail?.en).toMatch(/uncertain/i); f.pi.readLogin.mockResolvedValue(piAttempt("exchanging")); await f.controller.refresh();
    expect(f.controller.getSnapshot().piLoginAttempt?.status).toBe("exchanging"); expect(f.pi.replyLogin).toHaveBeenCalledTimes(1); expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1);
    expect(f.pi.startLogin).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("synthetic-callback-private"); f.noCodex(); f.controller.dispose();
  });


  it.each([
    ["PI_UNKNOWN_HANDLE", 404, /unknown handle|handle is unknown/i], ["PI_ATTEMPT_EXPIRED", 410, /expired/i],
    ["PI_PROMPT_NOT_CURRENT", 409, /prompt.*current/i], ["PI_SCOPE_BUSY", 409, /busy/i],
    ["PI_LOGIN_DEPLOYMENT_UNAVAILABLE", 503, /deployment/i], ["PI_SDK_UNAVAILABLE", 503, /restart/i],
  ] as const)("typed finite HTTP %s is shown without raw SDK details or misleading delivery uncertainty", async (code, status, text) => {
    const f = setupPi(); await f.controller.refresh(); f.pi.reserveLogin.mockRejectedValueOnce(new ApiResponseError("SECRET-SDK-CAUSE", status, { error: { code, message: "SECRET-SDK-CAUSE", cause: "SECRET-SDK-CAUSE" } }));
    f.connect(); await flush();
    expect(f.controller.getSnapshot().piAuthDetail?.en).toMatch(text); expect(f.controller.getSnapshot().piAuthDetail?.zh).toBeTruthy();
    expect(f.controller.getSnapshot().piAuthDetail?.en).not.toMatch(/outcome.*uncertain/i); expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("SECRET-SDK-CAUSE");
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).not.toHaveBeenCalled(); f.noCodex(); f.controller.dispose();
  });

  it("a finite Close HTTP rejection survives read-only recovery as that code rather than lost delivery", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush();
    f.pi.closeLogin.mockRejectedValueOnce(new ApiResponseError("private error", 404, { error: { code: "PI_UNKNOWN_HANDLE" } })); f.controller.closePiLogin(knownPiTarget, piHandle); await flush();
    expect(f.controller.getSnapshot().piAuthDetail?.en).toMatch(/unknown handle|handle is unknown/i); await f.controller.refresh();
    expect(f.controller.getSnapshot().piAuthDetail?.en).toMatch(/unknown handle|handle is unknown/i); expect(f.pi.closeLogin).toHaveBeenCalledTimes(1); f.noCodex(); f.controller.dispose();
  });

  it("detach clears cached authorization challenge and prompt until a real exact-handle read restores them", async () => {
    const f = setupPi(); await f.controller.refresh(); f.connect(); await flush(); f.controller.cancel();
    const read = deferred<StudioPiLoginAttempt>(); f.pi.readLogin.mockReturnValue(read.promise); const returned = createAgentConfigurationController(f.transport, knownPiTarget);
    const refreshing = returned.refresh(); await flush();
    expect(returned.getSnapshot().piLoginAttempt?.handle).toBe(piHandle); expect(returned.getSnapshot().piLoginAttempt?.challenge).toBeNull();
    expect(returned.getSnapshot().piLoginAttempt?.prompt).toBeNull(); expect(returned.getSnapshot().piCapabilities?.canReply).toBe(false);
    read.resolve(piAttempt("awaiting-user")); await refreshing;
    expect(returned.getSnapshot().piLoginAttempt?.challenge).toEqual(piAttempt("awaiting-user").challenge); expect(returned.getSnapshot().piCapabilities?.canReply).toBe(true);
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); f.noCodex(); returned.dispose(); f.controller.dispose();
  });


  it("normal Core-like start generation advancement retains the exact handle, authorization challenge and reply prompt", async () => {
    const f = setupPi(); f.transport.readHarnessState.mockResolvedValue(piObserved(3)); await f.controller.refresh(); f.edit("retained-start-pi");
    f.transport.readHarnessState.mockResolvedValue(piObserved(4)); f.connect(); await flush();
    expect(f.controller.getSnapshot().ownerGeneration).toBe(4); expect(f.controller.getSnapshot().piLoginAttempt).toMatchObject({ handle: piHandle, status: "awaiting-user", canReply: true });
    expect(f.controller.getSnapshot().piLoginAttempt?.challenge).toEqual(piAttempt("awaiting-user").challenge);
    expect(f.controller.getSnapshot().piLoginAttempt?.prompt).toEqual(piAttempt("awaiting-user").prompt); expect(f.controller.getSnapshot().piCapabilities?.canReply).toBe(true);
    expect(f.controller.getSnapshot().draft.model).toBe("retained-start-pi"); expect(f.controller.getSnapshot().revision).toBe(0); expect(f.controller.getSnapshot().state?.execution).toBeNull();
    expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); f.noCodex(); f.controller.dispose();
  });

  it("same-context generation refresh does not abort an exact-handle reply or clear its current prompt", async () => {
    const f = setupPi(); f.transport.readHarnessState.mockResolvedValue(piObserved(3)); await f.controller.refresh(); f.connect(); await flush(); f.edit("retained-reply-pi");
    const reply = deferred<StudioPiLoginAttempt>(); f.pi.replyLogin.mockReturnValue(reply.promise);
    const replying = f.controller.replyPiLogin({ target: knownPiTarget, attemptHandle: piHandle, promptId: piAttempt("awaiting-user").prompt!.promptId }, "synthetic-private-callback"); await flush();
    f.transport.readHarnessState.mockResolvedValue(piObserved(4)); await f.controller.refreshState();
    expect(f.pi.replyLogin.mock.calls[0]![3].aborted).toBe(false); expect(f.controller.getSnapshot().piAuthBusy).toBe("reply");
    expect(f.controller.getSnapshot().piLoginAttempt?.prompt).toEqual(piAttempt("awaiting-user").prompt);
    reply.resolve(piAttempt("exchanging")); await replying; await flush();
    expect(f.controller.getSnapshot().piLoginAttempt?.status).toBe("exchanging"); expect(f.controller.getSnapshot().piAuthBusy).toBeNull(); expect(f.controller.getSnapshot().ownerGeneration).toBe(4);
    expect(f.controller.getSnapshot().draft.model).toBe("retained-reply-pi"); expect(f.controller.getSnapshot().revision).toBe(0); expect(JSON.stringify(f.controller.getSnapshot())).not.toContain("synthetic-private-callback"); f.noCodex(); f.controller.dispose();
  });

  it("a lost-start remount reads its known handle at the newer same-context generation and regains the current prompt without replay", async () => {
    const f = setupPi(); f.transport.readHarnessState.mockResolvedValue(piObserved(3)); await f.controller.refresh();
    const start = deferred<StudioPiLoginAttempt>(); f.pi.startLogin.mockReturnValue(start.promise); f.connect(); await flush(); f.controller.dispose();
    expect(f.pi.startLogin.mock.calls[0]![1].aborted).toBe(true); f.transport.readHarnessState.mockResolvedValue(piObserved(4));
    const returned = createAgentConfigurationController(f.transport, knownPiTarget); await returned.refresh();
    expect(returned.getSnapshot().ownerGeneration).toBe(4); expect(returned.getSnapshot().piLoginAttempt?.handle).toBe(piHandle);
    expect(returned.getSnapshot().piLoginAttempt?.challenge).toEqual(piAttempt("awaiting-user").challenge); expect(returned.getSnapshot().piLoginAttempt?.prompt).toEqual(piAttempt("awaiting-user").prompt);
    expect(returned.getSnapshot().piCapabilities?.canReply).toBe(true); expect(returned.getSnapshot().state?.account).toBeNull(); expect(returned.getSnapshot().state?.execution).toBeNull();
    expect(f.pi.readLogin).toHaveBeenCalledTimes(1); expect(f.pi.reserveLogin).toHaveBeenCalledTimes(1); expect(f.pi.startLogin).toHaveBeenCalledTimes(1); expect(f.pi.closeLogin).not.toHaveBeenCalled();
    start.resolve(piAttempt("awaiting-user")); await flush(); returned.dispose(); f.noCodex();
  });

});
