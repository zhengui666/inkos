import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentConfigurationController, createAgentConfigurationTransport, type AgentConfigurationTransport } from "./agent-configuration-controller";
import { ApiResponseError } from "./use-api";
import { unavailableHarnessState, type AgentSettings, type HarnessState } from "../shared/agent-configuration";
import { toSelection } from "../pages/agent-configuration-adapter";

const native = { model: null, effort: null, speed: null };
const initial: AgentSettings = { schemaVersion: 1, revision: 0, selectedHarnessId: "codex", modelConnectionRef: null, harnessPreferences: { codex: native, pi: native } };
const target = { harness: "codex" as const, contextKey: "real-context" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(timeout = 15_000) {
  const transport = {
    readSettings: vi.fn<AgentConfigurationTransport["readSettings"]>().mockResolvedValue(initial),
    readHarnessState: vi.fn<AgentConfigurationTransport["readHarnessState"]>().mockImplementation(async harness => unavailableHarnessState(harness)),
    saveSettings: vi.fn<AgentConfigurationTransport["saveSettings"]>(),
  };
  const controller = createAgentConfigurationController(transport, target, timeout);
  const edit = (choiceKey: string | null) => controller.edit({ action: "choose-option", target: controller.getSnapshot().target, field: "model", choiceKey });
  const save = () => controller.save({ action: "save-defaults", target: controller.getSnapshot().target, selection: toSelection(controller.getSnapshot().draft) });
  return { controller, transport, edit, save };
}
function settings(model: string | null, revision = 1): AgentSettings { return { ...initial, revision, harnessPreferences: { ...initial.harnessPreferences, codex: { ...native, model } } }; }
function observed(generation: number, context = target.contextKey): HarnessState {
  return { ...unavailableHarnessState("codex"), availability: "available", installation: "installed", account: { type: "chatgpt", label: `generation-${generation}` },
    scope: { harnessId: "codex", authContextRef: context, ownerGeneration: generation, adapterVersion: "1", catalogVersion: "1" } };
}
afterEach(() => { vi.useRealTimers(); });

describe("controlled drafts and real request ownership", () => {
  it("initially displays the persisted selected harness without treating the page load as an edit", async () => {
    const { transport } = setup(); transport.readSettings.mockResolvedValue({ ...initial, selectedHarnessId: "pi" });
    const controller = createAgentConfigurationController(transport); await controller.refresh();
    expect(controller.getSnapshot().target.harness).toBe("pi");
    expect(controller.getSnapshot().hasChanges).toBe(false);
    expect(controller.getSnapshot().loading).toBe(false);
    expect(transport.readHarnessState.mock.calls[0]![0]).toBe("pi"); controller.dispose();
  });
  it("retains dirty drafts on refresh and keeps each target's draft separate", async () => {
    const { controller, transport, edit } = setup(); await controller.refresh(); edit("codex-draft");
    transport.readSettings.mockResolvedValue(settings("remote", 1)); await controller.refreshSettings();
    expect(controller.getSnapshot().draft.model).toBe("codex-draft");
    expect(controller.getSnapshot().baseline?.harnessPreferences.codex.model).toBe("remote");
    expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().savePhase).toBe("conflict");
    expect(controller.getSnapshot().reviewable).toBe(true);
    controller.selectTarget({ harness: "pi", contextKey: "pi-context" }); edit("pi-draft");
    controller.selectTarget(target);
    expect(controller.getSnapshot().draft.model).toBe("codex-draft");
    controller.selectTarget({ harness: "pi", contextKey: "pi-context" });
    expect(controller.getSnapshot().draft.model).toBe("pi-draft"); controller.dispose();
  });
  it("refreshes clean drafts without borrowing the first model or altering null", async () => {
    const { controller, transport } = setup(); await controller.refresh();
    expect(controller.getSnapshot().draft).toEqual(native);
    transport.readSettings.mockResolvedValue(settings("remote", 1)); await controller.refreshSettings();
    expect(controller.getSnapshot().draft.model).toBe("remote");
    expect(controller.getSnapshot().revision).toBe(1); controller.dispose();
  });
  it("freezes a narrow submitted snapshot and retains newer edits when that save succeeds", async () => {
    const { controller, transport, edit, save } = setup(); await controller.refresh(); edit("submitted");
    const reply = deferred<AgentSettings>(); transport.saveSettings.mockReturnValue(reply.promise);
    const pending = save(); await flush();
    const submitted = controller.getSnapshot().submitted!;
    expect(Object.isFrozen(submitted)).toBe(true);
    expect(Object.isFrozen(submitted.preferences)).toBe(true);
    expect(transport.saveSettings.mock.calls[0]![0]).toEqual({ expectedRevision: 0, patch: { selectedHarnessId: "codex", harnessPreferences: { codex: { ...native, model: "submitted" } } } });
    edit("newer-edit"); reply.resolve(settings("submitted")); await pending;
    expect(submitted.preferences.model).toBe("submitted");
    expect(controller.getSnapshot().draft.model).toBe("newer-edit");
    expect(controller.getSnapshot().baseline?.harnessPreferences.codex.model).toBe("submitted");
    expect(controller.getSnapshot().hasChanges).toBe(true);
    expect(controller.getSnapshot().revision).toBe(1); controller.dispose();
  });
  it("409 reads the latest values, preserves the draft and requires explicit review before another submission", async () => {
    const { controller, transport, edit, save } = setup(); await controller.refresh(); edit("my-draft");
    transport.saveSettings.mockRejectedValue(new ApiResponseError("conflict", 409, {}));
    transport.readSettings.mockResolvedValue(settings("other-owner", 2)); await save();
    expect(controller.getSnapshot().savePhase).toBe("conflict");
    expect(controller.getSnapshot().draft.model).toBe("my-draft");
    expect(controller.getSnapshot().baseline?.revision).toBe(2);
    expect(controller.getSnapshot().revision).toBe(0);
    await save(); expect(transport.saveSettings).toHaveBeenCalledTimes(1);
    controller.reviewLatest();
    expect(controller.getSnapshot().revision).toBe(2);
    expect(controller.getSnapshot().canSave).toBe(true);
    expect(transport.saveSettings).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it.each([422, 503])("retains the draft on HTTP %s without automatic resubmit", async status => {
    const { controller, transport, edit, save } = setup(); await controller.refresh(); edit("draft");
    transport.saveSettings.mockRejectedValue(new ApiResponseError("rejected", status, {})); await save();
    expect(controller.getSnapshot().draft.model).toBe("draft");
    expect(controller.getSnapshot().savePhase).toBe("failed");
    expect(controller.getSnapshot().revision).toBe(0);
    expect(transport.saveSettings).toHaveBeenCalledTimes(1); controller.dispose();
  });
  it("does not acknowledge a conflict when reconciliation GET failed", async () => {
    const { controller, transport, edit, save } = setup(); await controller.refresh(); edit("draft");
    transport.saveSettings.mockRejectedValue(new ApiResponseError("conflict", 409, {})); transport.readSettings.mockRejectedValue(new Error("unavailable")); await save();
    controller.reviewLatest(); expect(controller.getSnapshot().savePhase).toBe("conflict");
    expect(controller.getSnapshot().canSave).toBe(false); expect(controller.getSnapshot().draft.model).toBe("draft"); controller.dispose();
  });
  it("keeps edits made while the 409 readback is pending", async () => {
    const { controller, transport, edit, save } = setup(); await controller.refresh(); edit("sent");
    const readback = deferred<AgentSettings>(); transport.readSettings.mockReturnValue(readback.promise);
    transport.saveSettings.mockRejectedValue(new ApiResponseError("conflict", 409, {}));
    const pending = save(); await flush(); edit("edited-during-readback"); readback.resolve(settings("someone-else", 4)); await pending;
    expect(controller.getSnapshot().draft.model).toBe("edited-during-readback");
    expect(controller.getSnapshot().revision).toBe(0); expect(controller.getSnapshot().savePhase).toBe("conflict"); controller.dispose();
  });
  it("times out as uncertain, reads back matching values, and never attributes a later revision to this request", async () => {
    vi.useFakeTimers();
    const { controller, transport, edit, save } = setup(20); await controller.refresh(); edit("same-value");
    const late = deferred<AgentSettings>(); transport.saveSettings.mockReturnValue(late.promise);
    transport.readSettings.mockResolvedValue(settings("same-value", 8));
    const pending = save(); await flush(); await vi.advanceTimersByTimeAsync(21); await pending;
    expect(transport.readSettings).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().savePhase).toBe("uncertain");
    expect(controller.getSnapshot().detail?.en).toContain("still uncertain");
    expect(controller.getSnapshot().draft.model).toBe("same-value");
    expect(controller.getSnapshot().revision).toBe(0);
    expect(controller.getSnapshot().canSave).toBe(false);
    late.resolve(settings("same-value", 1)); await flush();
    expect(controller.getSnapshot().baseline?.revision).toBe(8);
    expect(controller.getSnapshot().savePhase).toBe("uncertain"); controller.dispose();
  });
  it("retains edits made during timeout reconciliation", async () => {
    vi.useFakeTimers();
    const { controller, transport, edit, save } = setup(20); await controller.refresh(); edit("sent");
    transport.saveSettings.mockReturnValue(deferred<AgentSettings>().promise);
    const readback = deferred<AgentSettings>(); transport.readSettings.mockReturnValue(readback.promise);
    const pending = save(); await flush(); await vi.advanceTimersByTimeAsync(21); edit("new-edit");
    readback.resolve(settings("sent", 1)); await pending;
    expect(controller.getSnapshot().draft.model).toBe("new-edit"); expect(controller.getSnapshot().savePhase).toBe("uncertain"); controller.dispose();
  });
  it.each(["harness", "context", "cancel", "dispose"])("isolates a late save after %s invalidation even if abort is ignored", async change => {
    const { controller, transport, edit, save } = setup(); await controller.refresh(); edit("sent");
    const reply = deferred<AgentSettings>(); transport.saveSettings.mockReturnValue(reply.promise);
    const pending = save(); await flush();
    if (change === "harness") controller.selectTarget({ harness: "pi", contextKey: "pi-context" });
    else if (change === "context") controller.selectTarget({ ...target, contextKey: "different-context" });
    else if (change === "cancel") controller.cancel(); else controller.dispose();
    reply.resolve(settings("sent")); await pending;
    expect(controller.getSnapshot().baseline?.revision).toBe(0);
    expect(controller.getSnapshot().savePhase).not.toBe("saved");
    expect(transport.saveSettings.mock.calls[0]![1].aborted).toBe(true); controller.dispose();
  });
  it("isolates older refreshes and never lets old settings clear newer drafts", async () => {
    const { controller, transport, edit } = setup(); await controller.refresh(); edit("draft");
    const old = deferred<AgentSettings>(); transport.readSettings.mockReturnValueOnce(old.promise).mockResolvedValueOnce(settings("new-baseline", 2));
    const first = controller.refreshSettings(); await flush(); await controller.refreshSettings();
    old.resolve(settings("old-baseline", 1)); await first;
    expect(controller.getSnapshot().baseline?.revision).toBe(2); expect(controller.getSnapshot().draft.model).toBe("draft"); controller.dispose();
  });
  it.each(["harness", "context", "cancel", "dispose"])("isolates a late settings read after %s", async change => {
    const { controller, transport, edit } = setup(); await controller.refresh(); edit("retained-draft");
    const old = deferred<AgentSettings>(); transport.readSettings.mockReturnValue(old.promise);
    const pending = controller.refreshSettings(); await flush();
    if (change === "harness") controller.selectTarget({ harness: "pi", contextKey: "pi-context" });
    else if (change === "context") controller.selectTarget({ ...target, contextKey: "other-context" });
    else if (change === "cancel") controller.cancel(); else controller.dispose();
    old.resolve(settings("stale", 9)); await pending;
    expect(controller.getSnapshot().baseline?.revision).toBe(0);
    expect(controller.getSnapshot().draft.model).not.toBe("stale"); controller.dispose();
  });
  it.each(["harness", "context", "cancel", "dispose"])("isolates a late observation after %s", async change => {
    const { controller, transport } = setup(); await controller.refresh();
    const old = deferred<HarnessState>(); transport.readHarnessState.mockReturnValue(old.promise);
    const pending = controller.refreshState(); await flush();
    if (change === "harness") controller.selectTarget({ harness: "pi", contextKey: "pi-context" });
    else if (change === "context") controller.selectTarget({ ...target, contextKey: "other-context" });
    else if (change === "cancel") controller.cancel(); else controller.dispose();
    old.resolve(observed(1)); await pending;
    expect(controller.getSnapshot().state?.account).not.toEqual({ type: "chatgpt", label: "generation-1" });
    expect(controller.getSnapshot().ownerGeneration).toBeNull(); controller.dispose();
  });
  it("invalidates a pending save when owner generation changes and rejects old generation observations", async () => {
    const { controller, transport, edit, save } = setup(); transport.readHarnessState.mockResolvedValue(observed(1)); await controller.refresh(); edit("sent");
    const reply = deferred<AgentSettings>(); transport.saveSettings.mockReturnValue(reply.promise);
    const pending = save(); await flush();
    transport.readHarnessState.mockResolvedValue(observed(2)); await controller.refreshState();
    reply.resolve(settings("sent")); await pending;
    expect(controller.getSnapshot().ownerGeneration).toBe(2); expect(controller.getSnapshot().baseline?.revision).toBe(0);
    expect(controller.getSnapshot().savePhase).toBe("uncertain");
    transport.readHarnessState.mockResolvedValue(observed(1)); await controller.refreshState();
    expect(controller.getSnapshot().ownerGeneration).toBe(2); controller.dispose();
  });
  it.each(["harness", "context"])("invalidates prior account evidence when a current refresh reports another %s", async mismatch => {
    const { controller, transport } = setup(); transport.readHarnessState.mockResolvedValue(observed(1)); await controller.refresh();
    expect(controller.getSnapshot().state?.account?.type).toBe("chatgpt");
    transport.readHarnessState.mockResolvedValue(mismatch === "context" ? observed(2, "changed-real-context") : unavailableHarnessState("pi"));
    await controller.refreshState();
    expect(controller.getSnapshot().state).toBeNull(); expect(controller.getSnapshot().ownerGeneration).toBeNull();
    expect(controller.getSnapshot().detail?.en).toContain("invalidated"); controller.dispose();
  });
  it("adopts only a server-observed context and sends no browser context as evidence", async () => {
    const { transport } = setup(); transport.readHarnessState.mockResolvedValue(observed(1));
    const controller = createAgentConfigurationController(transport); await controller.refresh();
    expect(controller.getSnapshot().target.contextKey).toBe("real-context");
    expect(transport.readHarnessState.mock.calls[0]![0]).toBe("codex"); controller.dispose();
  });
  it("does not dispatch unsupported authentication actions or another target's connection intent", async () => {
    const { controller, transport } = setup(); await controller.refresh();
    for (const action of ["connect", "sign-out"] as const) controller.connectionIntent({ action, target });
    controller.connectionIntent({ action: "cancel-sign-in", target, attemptKey: "unknown-operation" });
    controller.connectionIntent({ action: "refresh-connection", target: { harness: "pi", contextKey: "other" } });
    expect(transport.readHarnessState).toHaveBeenCalledTimes(1);
    expect(transport.saveSettings).not.toHaveBeenCalled(); controller.dispose();
  });
  it("uses only the independent config and observation endpoints with null roundtrip payloads", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ settings: initial, state: unavailableHarnessState("pi") }), { headers: { "Content-Type": "application/json" } }));
    const transport = createAgentConfigurationTransport(fetchImpl); const signal = new AbortController().signal;
    await transport.readSettings(signal); await transport.saveSettings({ expectedRevision: 0, patch: { selectedHarnessId: "pi", harnessPreferences: { pi: native } } }, signal); await transport.readHarnessState("pi", signal);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(["/api/v1/agent-configuration/settings", "/api/v1/agent-configuration/settings", "/api/v1/agent-configuration/harnesses/pi/state"]);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string).patch.harnessPreferences.pi).toEqual(native);
  });
});
