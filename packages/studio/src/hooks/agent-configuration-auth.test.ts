import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentConfigurationController, createAgentConfigurationTransport, type AgentConfigurationTransport } from "./agent-configuration-controller";
import { ApiResponseError } from "./use-api";
import { unavailableHarnessState, type AgentSettings, type HarnessState } from "../shared/agent-configuration";
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
