import { ApiResponseError, fetchJson } from "./use-api";
import type { SaveIntent, SelectionIntent, TargetView, TextView, ConnectionIntent } from "../components/agent-configuration-ui/view-model";
import { sameTarget } from "../components/agent-configuration-ui/view-model";
import { toPreferences } from "../pages/agent-configuration-adapter";
import { samePreferences, validScope, type AgentSettings, type HarnessId, type HarnessPreferences, type HarnessState, type SettingsUpdate } from "../shared/agent-configuration";
import type { StudioCodexLogin } from "../shared/codex";

export interface AgentConfigurationTransport {
  readSettings(signal: AbortSignal): Promise<AgentSettings>;
  saveSettings(request: SettingsUpdate, signal: AbortSignal): Promise<AgentSettings>;
  readHarnessState(harness: HarnessId, signal: AbortSignal): Promise<HarnessState>;
  startLogin?(signal: AbortSignal): Promise<StudioCodexLogin>;
  cancelLogin?(loginId: string, signal: AbortSignal): Promise<void>;
  logout?(signal: AbortSignal): Promise<void>;
  bindConnection?(expectedRevision: number, signal: AbortSignal): Promise<AgentSettings>;
}
export function createAgentConfigurationTransport(fetchImpl?: typeof fetch): AgentConfigurationTransport {
  const post = <T>(action: string, body: unknown, signal: AbortSignal) => fetchJson<T>(`/agent-configuration/harnesses/codex/${action}`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, { fetchImpl });
  return {
    readSettings: async signal => (await fetchJson<{ settings: AgentSettings }>("/agent-configuration/settings", { signal }, { fetchImpl })).settings,
    saveSettings: async (request, signal) => (await fetchJson<{ settings: AgentSettings }>("/agent-configuration/settings", {
      method: "PUT", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    }, { fetchImpl })).settings,
    readHarnessState: async (harness, signal) => (await fetchJson<{ state: HarnessState }>(`/agent-configuration/harnesses/${harness}/state`, { signal }, { fetchImpl })).state,
    startLogin: async signal => (await post<{ login: StudioCodexLogin }>("login", {}, signal)).login,
    cancelLogin: async (loginId, signal) => { await post("login/cancel", { loginId }, signal); },
    logout: async signal => { await post("logout", {}, signal); },
    bindConnection: async (expectedRevision, signal) => (await post<{ settings: AgentSettings }>("bind", { expectedRevision }, signal)).settings,
  };
}
interface DraftVersion { readonly preferences: HarnessPreferences; readonly baselineRevision: number | null; readonly edits: number; readonly dirty: boolean }
interface Draft extends DraftVersion { readonly retained?: readonly DraftVersion[]; readonly contextConflict?: boolean }
export interface SubmittedConfiguration {
  readonly target: TargetView;
  readonly preferences: HarnessPreferences;
  readonly expectedRevision: number;
  readonly edits: number;
  readonly requestEpoch: number;
  readonly ownerGeneration: number | null;
}
export interface AgentConfigurationSnapshot {
  readonly target: TargetView;
  readonly ownerGeneration: number | null;
  readonly baseline: AgentSettings | null;
  readonly revision: number | null;
  readonly draft: HarnessPreferences;
  readonly retainedDrafts: readonly DraftVersion[];
  readonly state: HarnessState | null;
  readonly submitted: SubmittedConfiguration | null;
  readonly loading: boolean;
  readonly savePhase: "unverified" | "unsaved" | "saving" | "saved" | "conflict" | "failed" | "uncertain";
  readonly detail?: TextView;
  readonly hasChanges: boolean;
  readonly canSave: boolean;
  readonly reviewable: boolean;
  readonly authBusy: "login" | "cancel" | "logout" | "bind" | null;
  readonly authDetail?: TextView;
}
class RequestTimeout extends Error {}
const key = (target: TargetView) => JSON.stringify([target.harness, target.contextKey]);
const preferences = (value: HarnessPreferences): HarnessPreferences => Object.freeze({ ...value });
const empty = (): HarnessPreferences => preferences({ model: null, effort: null, speed: null });
function freezeSettings(value: AgentSettings): AgentSettings {
  return Object.freeze({ ...value, harnessPreferences: Object.freeze({ codex: preferences(value.harnessPreferences.codex), pi: preferences(value.harnessPreferences.pi) }) });
}
const unavailable = { zh: "请求未完成，草稿已保留。", en: "The request did not complete. Your draft is retained." };
const uncertain = { zh: "保存结果不确定；请核对当前存储值后再决定是否重试。", en: "Save result uncertain. Review current stored values before deciding whether to retry." };
const changed = { zh: "存储配置已更新；草稿保留，请核对后再保存。", en: "Stored settings changed. Your draft is retained; review before saving." };
function describePreferences(value: HarnessPreferences, isZh: boolean) {
  const native = isZh ? "原生默认" : "Native default";
  return isZh ? `模型 ${value.model ?? native}，推理强度 ${value.effort ?? native}，速度 ${value.speed ?? native}`
    : `Model ${value.model ?? native}, reasoning ${value.effort ?? native}, speed ${value.speed ?? native}`;
}

export function createAgentConfigurationController(transport: AgentConfigurationTransport, initialTarget?: TargetView, timeoutMs = 15_000) {
  let target = Object.freeze({ ...(initialTarget ?? { harness: "codex", contextKey: "unobserved" }) });
  let followSavedHarness = initialTarget === undefined;
  let ownerGeneration: number | null = null;
  let baseline: AgentSettings | null = null;
  let state: HarnessState | null = null;
  let submitted: SubmittedConfiguration | null = null;
  let savePhase: AgentConfigurationSnapshot["savePhase"] = "unverified";
  let detail: TextView | undefined;
  let loading = false;
  let reviewable = false;
  let disposed = false;
  let lifetime = 0;
  let readEpoch = 0;
  let stateEpoch = 0;
  let saveEpoch = 0;
  let entryEdits = 0;
  let authDetail: TextView | undefined;
  type AuthenticationOperation = { action: "login" | "cancel" | "logout" | "bind"; token: ReturnType<typeof capture>; closeRequested: boolean;
    loginId?: string; cancelReturnedLogin?: (id: string) => Promise<void>; cancellation?: Promise<void>; reconciliation?: Promise<void> };
  let authentication: AuthenticationOperation | null = null;
  const drafts = new Map<string, Draft>();
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  const draft = (): Draft => drafts.get(key(target)) ?? { preferences: baseline?.harnessPreferences[target.harness] ?? empty(), baselineRevision: baseline?.revision ?? null, edits: 0, dirty: false };
  let snapshot: AgentConfigurationSnapshot;
  function publish() {
    const current = draft();
    // A read or confirmed save for another target cannot rebase this target's edits.
    if (current.dirty && baseline && current.baselineRevision !== baseline.revision && !["saving", "uncertain"].includes(savePhase)) {
      savePhase = "conflict"; reviewable = true; detail = changed;
    }
    if (current.contextConflict && savePhase !== "saving") {
      if (savePhase !== "uncertain") { savePhase = "conflict"; reviewable = baseline !== null; }
      detail = {
        zh: `当前入口草稿：${describePreferences(current.preferences, true)}。保留的上下文草稿：${current.retained?.map(value => describePreferences(value.preferences, true)).join("；")}。草稿未合并；请核对当前入口草稿后再保存。${savePhase === "uncertain" ? uncertain.zh : ""}`,
        en: `Current entry draft: ${describePreferences(current.preferences, false)}. Retained context drafts: ${current.retained?.map(value => describePreferences(value.preferences, false)).join("; ")}. Drafts remain separate; review the current entry draft before saving. ${savePhase === "uncertain" ? uncertain.en : ""}`,
      };
    }
    const hasChanges = baseline !== null && (baseline.selectedHarnessId !== target.harness || !samePreferences(current.preferences, baseline.harnessPreferences[target.harness]));
    snapshot = Object.freeze({ target, ownerGeneration, baseline, revision: current.baselineRevision, draft: current.preferences, retainedDrafts: current.retained ?? Object.freeze([]), state, submitted, loading, savePhase, detail, hasChanges, reviewable,
      authBusy: authentication?.action ?? null, authDetail,
      canSave: baseline !== null && current.baselineRevision !== null && !["saving", "conflict", "uncertain"].includes(savePhase) });
    for (const listener of listeners) listener();
  }
  function invalidate() {
    lifetime++; readEpoch++; stateEpoch++; saveEpoch++;
    for (const request of requests) request.abort();
    if (savePhase === "saving") { savePhase = "uncertain"; detail = uncertain; reviewable = false; }
    loading = false;
    authentication = null;
  }
  function capture() { return { lifetime, target, ownerGeneration }; }
  function current(token: ReturnType<typeof capture>) {
    return !disposed && token.lifetime === lifetime && sameTarget(token.target, target) && token.ownerGeneration === ownerGeneration;
  }
  async function request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    requests.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(() => run(controller.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new RequestTimeout()); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function receiveSettings(value: AgentSettings, reconcile = false) {
    if (baseline && value.revision < baseline.revision) return;
    if (!baseline && followSavedHarness && !draft().dirty && value.selectedHarnessId !== target.harness) {
      invalidate(); target = Object.freeze({ harness: value.selectedHarnessId, contextKey: "unobserved" }); state = null; ownerGeneration = null;
    }
    const currentDraft = draft();
    baseline = freezeSettings(value);
    if (!currentDraft.dirty && !currentDraft.contextConflict && !reconcile && savePhase !== "saving") {
      drafts.set(key(target), { ...currentDraft, preferences: preferences(value.harnessPreferences[target.harness]), baselineRevision: value.revision, dirty: false });
    }
  }
  async function refreshSettings(reconcile = false): Promise<ReturnType<typeof capture> | undefined> {
    const token = capture(); const epoch = ++readEpoch;
    loading = true; publish();
    try {
      const value = await request(signal => transport.readSettings(signal));
      if (!current(token) || epoch !== readEpoch) return;
      receiveSettings(value, reconcile);
      if (["conflict", "uncertain"].includes(savePhase) || reconcile) reviewable = true;
      if (savePhase === "unverified") savePhase = "unsaved";
      if (!current(token)) { loading = false; publish(); }
      return capture();
    } catch {
      if (current(token) && epoch === readEpoch) detail = unavailable;
    } finally {
      if (current(token) && epoch === readEpoch) { loading = false; publish(); }
    }
  }
  async function refreshState() {
    const token = capture(); const epoch = ++stateEpoch;
    try {
      const value = await request(signal => transport.readHarnessState(token.target.harness, signal));
      if (!current(token) || epoch !== stateEpoch) return;
      if (value.harnessId !== target.harness || (value.scope && (!validScope(value.scope) || value.scope.harnessId !== target.harness
        || (target.contextKey !== "unobserved" && value.scope.authContextRef !== target.contextKey)))) {
        invalidate(); state = null; ownerGeneration = null;
        if (savePhase !== "uncertain") detail = { zh: "观察目标或上下文不匹配，旧连接状态已失效。", en: "Observation target or context does not match. Previous connection evidence is invalidated." };
        publish(); return;
      }
      if (value.scope && ownerGeneration !== null && value.scope.ownerGeneration !== null && value.scope.ownerGeneration < ownerGeneration) return;
      if (value.availability === "available" && value.scope) {
        if (target.contextKey === "unobserved") {
          const previous = draft(); const entryKey = key(target);
          target = Object.freeze({ harness: target.harness, contextKey: value.scope.authContextRef });
          const existing = drafts.get(key(target));
          if (!existing || previous.dirty || previous.edits > entryEdits) {
            const collision = existing && (existing.dirty || existing.contextConflict) && (!samePreferences(existing.preferences, previous.preferences) || existing.baselineRevision !== previous.baselineRevision);
            const retained = [...(previous.retained ?? []), ...(existing?.retained ?? [])];
            if (collision) retained.push(Object.freeze({ preferences: existing.preferences, baselineRevision: existing.baselineRevision, edits: existing.edits, dirty: existing.dirty }));
            drafts.set(key(target), { ...previous, retained: Object.freeze(retained), contextConflict: previous.contextConflict || existing?.contextConflict || !!collision });
          }
          // Move the entry draft so a later unobserved entry cannot revive stale edits.
          drafts.delete(entryKey); entryEdits = draft().edits;
        }
        if (ownerGeneration !== value.scope.ownerGeneration || !sameTarget(token.target, target)) invalidate();
        ownerGeneration = value.scope.ownerGeneration;
      }
      state = value; publish();
    } catch { if (current(token) && epoch === stateEpoch) { state = null; detail = unavailable; publish(); } }
  }
  async function refresh() {
    // Read settings before adopting the real owner context; neither read starts authentication.
    const token = await refreshSettings();
    if (token && current(token)) await refreshState();
  }
  function selectTarget(next: TargetView) {
    followSavedHarness = false;
    if (disposed || sameTarget(target, next)) return;
    invalidate(); target = Object.freeze({ ...next }); ownerGeneration = null; state = null;
    authDetail = undefined;
    submitted = null;
    const currentDraft = draft();
    if (baseline && !currentDraft.dirty && !currentDraft.contextConflict) drafts.set(key(target), { ...currentDraft, preferences: baseline.harnessPreferences[target.harness], baselineRevision: baseline.revision });
    entryEdits = draft().edits;
    if (!["uncertain", "conflict"].includes(savePhase)) { savePhase = "unsaved"; detail = undefined; }
    publish();
  }
  function edit(intent: SelectionIntent) {
    if (disposed || !sameTarget(intent.target, target)) return;
    const previous = draft();
    const field = { model: "model", reasoning: "effort", speed: "speed" }[intent.field];
    const next = preferences({ ...previous.preferences, [field]: intent.choiceKey });
    drafts.set(key(target), { ...previous, preferences: next, edits: previous.edits + 1, dirty: !baseline || !samePreferences(next, baseline.harnessPreferences[target.harness]) });
    if (!["saving", "conflict", "uncertain"].includes(savePhase)) savePhase = "unsaved";
    publish();
  }
  async function save(intent: SaveIntent) {
    if (!sameTarget(intent.target, target) || !snapshot.canSave || !snapshot.hasChanges || !samePreferences(toPreferences(intent.selection), draft().preferences)) return;
    const token = capture(); const epoch = ++saveEpoch;
    submitted = Object.freeze({ target: Object.freeze({ ...target }), preferences: preferences(draft().preferences), expectedRevision: draft().baselineRevision!, edits: draft().edits,
      requestEpoch: epoch, ownerGeneration });
    const sent = submitted;
    savePhase = "saving"; detail = undefined; reviewable = false; publish();
    try {
      const result = await request(signal => transport.saveSettings({ expectedRevision: sent.expectedRevision,
        patch: { selectedHarnessId: sent.target.harness, harnessPreferences: { [sent.target.harness]: { ...sent.preferences } } } }, signal));
      if (!current(token) || epoch !== saveEpoch) return;
      if (baseline && result.revision < baseline.revision) {
        savePhase = "conflict"; detail = unavailable; publish(); return;
      }
      const latest = draft();
      baseline = freezeSettings(result);
      if (latest.edits === sent.edits) drafts.set(key(target), { ...latest, preferences: preferences(result.harnessPreferences[target.harness]), baselineRevision: result.revision, dirty: false });
      else drafts.set(key(target), { ...latest, baselineRevision: result.revision, dirty: !samePreferences(latest.preferences, result.harnessPreferences[target.harness]) });
      savePhase = "saved"; publish();
    } catch (error) {
      if (!current(token) || epoch !== saveEpoch) return;
      saveEpoch++; // A transport that ignores abort cannot apply a late result after reconciliation.
      if (error instanceof ApiResponseError && error.status === 409) {
        savePhase = "conflict"; reviewable = false;
        detail = { zh: "保存冲突；草稿保留，请核对最新配置。", en: "Save conflict. Your draft is retained; review the latest settings." };
        publish(); await refreshSettings(true);
      } else if (error instanceof ApiResponseError && [400, 403, 415, 422, 503].includes(error.status)) {
        savePhase = "failed"; detail = unavailable; publish();
      } else {
        savePhase = "uncertain"; reviewable = false; detail = uncertain; publish(); await refreshSettings(true);
        if (current(token)) {
          if (baseline && samePreferences(baseline.harnessPreferences[sent.target.harness], sent.preferences) && baseline.selectedHarnessId === sent.target.harness) {
            detail = { zh: "当前存储值与提交一致；仍不能确认本次保存是否成功。", en: "Current stored values match the submission; this save's outcome is still uncertain." };
          }
          publish();
        }
      }
    }
  }
  function reviewLatest() {
    if (!disposed && baseline && reviewable && ["conflict", "uncertain"].includes(savePhase)) {
      const currentDraft = draft();
      drafts.set(key(target), { ...currentDraft, baselineRevision: baseline.revision, contextConflict: false, dirty: !samePreferences(currentDraft.preferences, baseline.harnessPreferences[target.harness]) });
      savePhase = "unsaved"; detail = undefined; publish();
    }
  }
  async function accountAction(action: "login" | "cancel" | "logout", loginId?: string) {
    if (disposed || authentication || target.harness !== "codex") return;
    if (!transport.startLogin || !transport.cancelLogin || !transport.logout) {
      authDetail = { zh: "认证接口不可用，请核对连接状态。", en: "Authentication endpoints are unavailable. Check connection status." }; publish(); return;
    }
    invalidate(); state = null; ownerGeneration = null;
    const operation: AuthenticationOperation = { action, token: capture(), closeRequested: false };
    authentication = operation; authDetail = undefined; publish();
    const cancelClosedLogin = (id: string) => operation.cancellation ??= request(signal => transport.cancelLogin!(id, signal));
    operation.cancelReturnedLogin = cancelClosedLogin;
    try {
      if (action === "login") {
        const login = await request(signal => {
          const pending = transport.startLogin!(signal);
          // Explicit Close can outlive an aborted/timed-out HTTP response. Cancel only its returned attempt.
          void pending.then(value => {
            operation.loginId = value.loginId;
            if (operation.closeRequested) void cancelClosedLogin(value.loginId).catch(() => undefined);
          }, () => undefined);
          return pending;
        });
        if (operation.closeRequested) await cancelClosedLogin(login.loginId);
      } else if (action === "cancel") await request(signal => transport.cancelLogin!(loginId!, signal));
      else await request(signal => transport.logout!(signal));
      if (!current(operation.token) || authentication !== operation) return;
      authDetail = { zh: "操作已返回，请以当前连接观察为准。执行仍尚未验证。", en: "The operation returned. Check the current connection observation; execution remains unverified." };
      await refreshState();
      if (operation.reconciliation) await operation.reconciliation;
    } catch {
      if (current(operation.token) && authentication === operation) {
        authDetail = { zh: "认证操作结果不确定，请核对当前状态；不会自动重新登录。", en: "Authentication outcome is uncertain. Check current status; sign-in will not be replayed automatically." };
        await refreshState();
      }
    } finally { if (authentication === operation) authentication = null; publish(); }
  }
  async function bindConnection() {
    if (disposed || authentication || target.harness !== "codex" || !transport.bindConnection || !snapshot.canSave || !baseline
      || baseline.selectedHarnessId !== "codex" || !state?.account || state.scope?.authContextRef !== target.contextKey) return;
    const expectedRevision = draft().baselineRevision!;
    invalidate(); state = null; ownerGeneration = null;
    const operation = { action: "bind" as const, token: capture(), closeRequested: false };
    authentication = operation; authDetail = undefined; publish();
    try {
      const result = await request(signal => transport.bindConnection!(expectedRevision, signal));
      if (!current(operation.token) || authentication !== operation) return;
      if (baseline && result.revision < baseline.revision) throw new ApiResponseError("Settings changed", 409, undefined);
      const latest = draft(); baseline = freezeSettings(result);
      drafts.set(key(target), { ...latest, baselineRevision: result.revision, dirty: !samePreferences(latest.preferences, result.harnessPreferences[target.harness]) });
      authDetail = { zh: "模型连接绑定已保存；执行尚未验证。", en: "Model connection binding saved; execution remains unverified." };
      await refreshState();
    } catch (error) {
      if (!current(operation.token) || authentication !== operation) return;
      if (error instanceof ApiResponseError && error.status === 409) {
        savePhase = "conflict"; reviewable = false; detail = changed; publish(); await refreshSettings(true);
      } else if (error instanceof ApiResponseError && [400, 403, 422, 503].includes(error.status)) {
        authDetail = { zh: "绑定被拒绝或不可用，草稿已保留。", en: "Binding was rejected or unavailable. Your draft is retained." };
      } else {
        savePhase = "uncertain"; reviewable = false; detail = uncertain; publish(); await refreshSettings(true);
      }
    } finally { if (authentication === operation) authentication = null; publish(); }
  }
  function connectionIntent(intent: ConnectionIntent) {
    if (disposed || !sameTarget(target, intent.target)) return;
    if (intent.action === "refresh-connection") { void refreshState(); return; }
    if (target.harness !== "codex") return;
    if (intent.action === "connect" && ["signed-out", "failed"].includes(state?.connection?.phase ?? "")) void accountAction("login");
    if (intent.action === "sign-out" && state?.account?.type === "chatgpt") void accountAction("logout");
    if (intent.action === "cancel-sign-in" && state?.connection?.login?.status === "pending" && state.connection.login.loginId === intent.attemptKey) void accountAction("cancel", intent.attemptKey);
  }
  function closeConnection() {
    if (authentication?.action === "login") {
      const operation = authentication;
      operation.closeRequested = true;
      authDetail = { zh: "关闭请求已记录；收到本次登录标识后将取消此尝试。", en: "Close requested. This attempt will be cancelled when its sign-in ID is returned." }; publish();
      if (operation.loginId && operation.cancelReturnedLogin && !operation.reconciliation) {
        // The ID may already have returned while the earlier observation is still in flight.
        // Fence that read and reconcile only this explicit Close, retaining the target token.
        stateEpoch++; state = null;
        operation.reconciliation = operation.cancelReturnedLogin(operation.loginId).then(async () => {
          if (!current(operation.token) || (authentication !== operation && authentication !== null)) return;
          authDetail = { zh: "取消请求已返回，请核对当前连接状态。", en: "Cancellation returned. Check the current connection state." };
          await refreshState();
        }).catch(() => {
          if (current(operation.token) && (authentication === operation || authentication === null)) {
            authDetail = { zh: "取消结果不确定，请核对当前连接状态。", en: "Cancellation outcome is uncertain. Check the current connection state." }; publish();
          }
        });
        publish();
      }
    } else if (state?.connection?.login?.status === "pending") void accountAction("cancel", state.connection.login.loginId);
  }
  publish();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, refreshSettings, refreshState, selectTarget, edit, save, reviewLatest, connectionIntent, closeConnection, bindConnection,
    cancel: () => { if (!disposed) { invalidate(); publish(); } },
    dispose: () => { invalidate(); disposed = true; listeners.clear(); },
  };
}
