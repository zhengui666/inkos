import { ApiResponseError, fetchJson } from "./use-api";
import type { SaveIntent, SelectionIntent, TargetView, TextView, ConnectionIntent } from "../components/agent-configuration-ui/view-model";
import { sameTarget } from "../components/agent-configuration-ui/view-model";
import { toPreferences } from "../pages/agent-configuration-adapter";
import { samePreferences, validScope, type AgentSettings, type HarnessId, type HarnessPreferences, type HarnessState, type SettingsUpdate, type DeviceLoginAttemptReservation, type DeviceLoginAttemptCloseResult } from "../shared/agent-configuration";
import type { StudioCodexLogin } from "../shared/codex";

export interface AgentConfigurationTransport {
  readSettings(signal: AbortSignal): Promise<AgentSettings>;
  saveSettings(request: SettingsUpdate, signal: AbortSignal): Promise<AgentSettings>;
  readHarnessState(harness: HarnessId, signal: AbortSignal): Promise<HarnessState>;
  reserveLogin?(signal: AbortSignal): Promise<DeviceLoginAttemptReservation>;
  startLogin?(attemptHandle: string, signal: AbortSignal): Promise<StudioCodexLogin>;
  closeLogin?(attemptHandle: string, signal: AbortSignal): Promise<DeviceLoginAttemptCloseResult>;
  logout?(signal: AbortSignal): Promise<void>;
  bindConnection?(expectedRevision: number, signal: AbortSignal): Promise<AgentSettings>;
}
export function createAgentConfigurationTransport(fetchImpl?: typeof fetch): AgentConfigurationTransport {
  const post = <T>(action: string, body: unknown, signal: AbortSignal, keepalive = false) => fetchJson<T>(`/agent-configuration/harnesses/codex/${action}`, {
    method: "POST", signal, keepalive, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, { fetchImpl });
  return {
    readSettings: async signal => (await fetchJson<{ settings: AgentSettings }>("/agent-configuration/settings", { signal }, { fetchImpl })).settings,
    saveSettings: async (request, signal) => (await fetchJson<{ settings: AgentSettings }>("/agent-configuration/settings", {
      method: "PUT", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    }, { fetchImpl })).settings,
    readHarnessState: async (harness, signal) => (await fetchJson<{ state: HarnessState }>(`/agent-configuration/harnesses/${harness}/state`, { signal }, { fetchImpl })).state,
    reserveLogin: async signal => (await post<{ reservation: DeviceLoginAttemptReservation }>("login/reserve", {}, signal)).reservation,
    startLogin: async (attemptHandle, signal) => (await post<{ login: StudioCodexLogin }>("login", { attemptHandle }, signal)).login,
    closeLogin: async (attemptHandle, signal) => (await post<{ result: DeviceLoginAttemptCloseResult }>("login/close", { attemptHandle }, signal, true)).result,
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
  readonly authCloseResult?: DeviceLoginAttemptCloseResult;
  readonly authCloseScope?: "connection" | "attempt";
  readonly canCloseConnection: boolean;
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

type AttemptGeneration = { readonly source: "verified-reservation" | "matching-login"; readonly value: number | null }
  | { readonly source: "unobserved-reservation" | "unobserved-start" };
interface LoginAttempt {
  readonly target: TargetView;
  reservation?: DeviceLoginAttemptReservation;
  loginId?: string;
  started: boolean;
  detached: boolean;
  closeRequested: boolean;
  closeToken?: { readonly lifetime: number; readonly target: TargetView; readonly ownerGeneration: number | null };
  generation: AttemptGeneration;
  closePromise?: Promise<void>;
  closeResult?: DeviceLoginAttemptCloseResult;
  closeUncertain?: boolean;
}
// In-memory correlation only. Returning to this transport can settle a known attempt;
// no observed login ID is promoted into authority and nothing is persisted in the browser.
const knownAttempts = new WeakMap<AgentConfigurationTransport, Map<string, LoginAttempt>>();
function closeDescription(result: DeviceLoginAttemptCloseResult): TextView {
  if (result.state === "already-terminal") return { zh: "本次登录已完成结算，可能已登录；Close 不会退出账号。请核对连接状态。执行尚未验证。", en: "This sign-in is already terminal and may be signed in. Close does not sign out. Check connection status; execution remains unverified." };
  if (result.state === "unknown-or-expired") return { zh: "本次尝试标识未知或已过期；无法确认取消结果。执行尚未验证。", en: "This attempt is unknown or expired; cancellation cannot be confirmed. Execution remains unverified." };
  if (result.state === "superseded") return { zh: "本次尝试已被替代；不会取消新的登录。执行尚未验证。", en: "This attempt was superseded. A newer sign-in will not be cancelled. Execution remains unverified." };
  if (result.cleanup === "unconfirmed") return { zh: "本次尝试已关闭；提供方清理尚未确认。可再次核对同一尝试。执行尚未验证。", en: "This attempt is closed; provider cleanup is unconfirmed. You can check the same attempt again. Execution remains unverified." };
  if (result.cleanup === "cancel-acknowledged") return { zh: "提供方已确认取消本次登录。执行尚未验证。", en: "The provider acknowledged cancellation of this sign-in. Execution remains unverified." };
  return result.cleanup === "not-started" ? { zh: "本次尝试已关闭，未启动提供方登录。执行尚未验证。", en: "This attempt is closed; provider sign-in was not started. Execution remains unverified." }
    : { zh: "本次尝试已关闭；提供方清理不适用。执行尚未验证。", en: "This attempt is closed; provider cleanup is not applicable. Execution remains unverified." };
}
const closeUncertainDescription = { zh: "Close 结果不确定；可再次核对同一尝试。不会自动登录或退出账号。执行尚未验证。", en: "Close outcome is uncertain. Check the same attempt again; sign-in and logout will not be replayed automatically. Execution remains unverified." };

export function createAgentConfigurationController(transport: AgentConfigurationTransport, initialTarget?: TargetView, timeoutMs = 15_000) {
  let target = Object.freeze({ ...(initialTarget ?? { harness: "codex", contextKey: "unobserved" }) });
  let followSavedHarness = initialTarget === undefined;
  let ownerGeneration: number | null = null;
  // Unlike the cleared UI sentinel, this value came from a validated observation.
  let observedScope: { target: TargetView; generation: number | null } | undefined;
  let contextInvalid = false;
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
  let authCloseResult: DeviceLoginAttemptCloseResult | undefined;
  type AuthenticationOperation = { action: "login" | "logout" | "bind"; token: ReturnType<typeof capture>; closeRequested: boolean; attempt?: LoginAttempt };
  type CloseObservation = { attempt: LoginAttempt; token: ReturnType<typeof capture>; promise: Promise<void>; completion?: Promise<void> };
  let closing: CloseObservation | null = null;
  let closeReceiptOwner: { attempt: LoginAttempt; token: ReturnType<typeof capture> } | null = null;
  const attempts = knownAttempts.get(transport) ?? new Map<string, LoginAttempt>();
  knownAttempts.set(transport, attempts);
  const knownAttempt = () => authentication?.attempt ?? attempts.get(key(target));
  function projectsConnection(attempt: LoginAttempt) {
    return "value" in attempt.generation && observedScope && sameTarget(observedScope.target, attempt.target)
      && attempt.generation.value === observedScope.generation;
  }
  function matchesAttempt(attempt: LoginAttempt | undefined) {
    if (contextInvalid || !attempt || !sameTarget(attempt.target, target)) return false;
    if (authentication && authentication.attempt !== attempt) return false;
    if (knownAttempt() !== attempt) return false;
    const observed = state?.connection?.login;
    if (attempt.loginId && observed && observed.loginId !== attempt.loginId) return false;
    if ("value" in attempt.generation && !projectsConnection(attempt)) return false;
    return true;
  }
  function canCloseAttempt(attempt: LoginAttempt | undefined) {
    if (!matchesAttempt(attempt) || !attempt) return false;
    return !attempt.closeResult || attempt.closeUncertain || attempt.closeResult.cleanup === "unconfirmed";
  }
  let authentication: AuthenticationOperation | null = null;
  const drafts = new Map<string, Draft>();
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  const draft = (): Draft => drafts.get(key(target)) ?? { preferences: baseline?.harnessPreferences[target.harness] ?? empty(), baselineRevision: baseline?.revision ?? null, edits: 0, dirty: false };
  let snapshot: AgentConfigurationSnapshot;
  function publish() {
    const currentDraft = draft();
    // A read or confirmed save for another target cannot rebase this target's edits.
    if (currentDraft.dirty && baseline && currentDraft.baselineRevision !== baseline.revision && !["saving", "uncertain"].includes(savePhase)) {
      savePhase = "conflict"; reviewable = true; detail = changed;
    }
    if (currentDraft.contextConflict && savePhase !== "saving") {
      if (savePhase !== "uncertain") { savePhase = "conflict"; reviewable = baseline !== null; }
      detail = {
        zh: `当前入口草稿：${describePreferences(currentDraft.preferences, true)}。保留的上下文草稿：${currentDraft.retained?.map(value => describePreferences(value.preferences, true)).join("；")}。草稿未合并；请核对当前入口草稿后再保存。${savePhase === "uncertain" ? uncertain.zh : ""}`,
        en: `Current entry draft: ${describePreferences(currentDraft.preferences, false)}. Retained context drafts: ${currentDraft.retained?.map(value => describePreferences(value.preferences, false)).join("; ")}. Drafts remain separate; review the current entry draft before saving. ${savePhase === "uncertain" ? uncertain.en : ""}`,
      };
    }
    const hasChanges = baseline !== null && (baseline.selectedHarnessId !== target.harness || !samePreferences(currentDraft.preferences, baseline.harnessPreferences[target.harness]));
    const closeAttempt = closeReceiptOwner?.attempt ?? (closing && current(closing.token) ? closing.attempt : undefined);
    snapshot = Object.freeze({ target, ownerGeneration, baseline, revision: currentDraft.baselineRevision, draft: currentDraft.preferences, retainedDrafts: currentDraft.retained ?? Object.freeze([]), state, submitted, loading, savePhase, detail, hasChanges, reviewable,
      authBusy: closing && current(closing.token) ? "cancel" : authentication?.action ?? null, authDetail, authCloseResult,
      authCloseScope: closeAttempt ? projectsConnection(closeAttempt) ? "connection" : "attempt" : undefined, canCloseConnection: canCloseAttempt(knownAttempt()),
      canSave: baseline !== null && currentDraft.baselineRevision !== null && !["saving", "conflict", "uncertain"].includes(savePhase) });
    for (const listener of listeners) listener();
  }
  function invalidate() {
    if (authentication?.attempt) authentication.attempt.detached = true;
    lifetime++; readEpoch++; stateEpoch++; saveEpoch++;
    for (const request of requests) request.abort();
    if (savePhase === "saving") { savePhase = "uncertain"; detail = uncertain; reviewable = false; }
    loading = false;
    authentication = null;
    if (closing || closeReceiptOwner) { authDetail = undefined; authCloseResult = undefined; }
    closing = null; closeReceiptOwner = null;
  }
  function capture() { return { lifetime, target, ownerGeneration }; }
  function current(token: ReturnType<typeof capture>) {
    return !disposed && token.lifetime === lifetime && sameTarget(token.target, target) && token.ownerGeneration === ownerGeneration;
  }
  async function request<T>(run: (signal: AbortSignal) => Promise<T>, independent = false): Promise<T> {
    const controller = new AbortController();
    if (!independent) requests.add(controller);
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
      invalidate(); target = Object.freeze({ harness: value.selectedHarnessId, contextKey: "unobserved" }); state = null; ownerGeneration = null; observedScope = undefined; contextInvalid = false;
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
        invalidate(); state = null; ownerGeneration = null; observedScope = undefined; contextInvalid = true;
        if (savePhase !== "uncertain") detail = { zh: "观察目标或上下文不匹配，旧连接状态已失效。", en: "Observation target or context does not match. Previous connection evidence is invalidated." };
        publish(); return;
      }
      if (value.scope && ownerGeneration !== null && value.scope.ownerGeneration !== null && value.scope.ownerGeneration < ownerGeneration) return;
      if (value.availability === "available" && value.scope) {
        contextInvalid = false;
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
        const attempt = knownAttempt();
        // A returned provider ID plus the exact local attempt can establish its
        // generation. A numeric GET alone cannot associate an unknown start.
        if (attempt && sameTarget(attempt.target, target) && attempt.generation.source === "unobserved-start"
          && attempts.get(key(attempt.target)) === attempt && attempt.loginId && value.connection?.login?.loginId === attempt.loginId) {
          attempt.generation = { source: "matching-login", value: value.scope.ownerGeneration };
        }
        observedScope = { target, generation: value.scope.ownerGeneration };
        if (ownerGeneration !== value.scope.ownerGeneration || !sameTarget(token.target, target)) invalidate();
        ownerGeneration = value.scope.ownerGeneration;
      }
      state = value; restoreCloseObservation(); publish();
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
    invalidate(); target = Object.freeze({ ...next }); ownerGeneration = null; state = null; observedScope = undefined; contextInvalid = false;
    authDetail = undefined; authCloseResult = undefined;
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
  function currentCloseObservation(operation: CloseObservation) {
    return closing === operation && current(operation.token) && matchesAttempt(operation.attempt)
      && attempts.get(key(operation.attempt.target)) === operation.attempt;
  }
  function displayCloseReceipt(attempt: LoginAttempt) {
    closeReceiptOwner = { attempt, token: capture() };
    authCloseResult = attempt.closeUncertain ? undefined : attempt.closeResult;
    const receipt = attempt.closeUncertain ? closeUncertainDescription : attempt.closeResult ? closeDescription(attempt.closeResult) : undefined;
    authDetail = projectsConnection(attempt) || !receipt ? receipt : {
      zh: `原尝试的结算结果；其世代尚未与当前连接关联，当前连接观察独立，本回执不证明当前连接已取消。${receipt.zh}`,
      en: `${attempt.closeUncertain ? "Close outcome is uncertain for the original attempt. " : "Original attempt settlement only. "}Its generation is not correlated with the current connection; this receipt does not confirm cancellation of the current connection. ${receipt.en}`,
    };
  }
  function observeClose(attempt: LoginAttempt, token = capture(), fenceRead = false) {
    if (!current(token) || !matchesAttempt(attempt) || attempts.get(key(attempt.target)) !== attempt) return;
    const promise = attempt.closePromise;
    if (!promise) {
      if (attempt.closeResult || attempt.closeUncertain) displayCloseReceipt(attempt);
      return;
    }
    if (closing?.attempt === attempt && closing.promise === promise && currentCloseObservation(closing)) return closing.completion;
    const operation: CloseObservation = { attempt, token, promise };
    closing = operation; closeReceiptOwner = null;
    if (fenceRead) { stateEpoch++; if (projectsConnection(attempt)) state = null; }
    authCloseResult = undefined;
    authDetail = projectsConnection(attempt) ? { zh: "正在结算本次关闭请求…", en: "Settling Close for this attempt…" }
      : { zh: "正在结算原尝试的关闭请求；当前连接观察独立，尚不能确认当前连接已取消…", en: "Settling Close for the original attempt only. Current connection observation is separate; cancellation of the current connection is not confirmed…" }; publish();
    // Each controller observes with its own lifetime; the shared promise owns
    // only network settlement and remains independent of navigation/disposal.
    operation.completion = promise.then(async () => {
      if (!currentCloseObservation(operation)) return;
      displayCloseReceipt(attempt); publish();
      if (!attempt.closeUncertain) await refreshState();
    }).finally(() => {
      if (closing === operation) { closing = null; publish(); }
    });
    return operation.completion;
  }
  function restoreCloseObservation() {
    if (closing && !currentCloseObservation(closing)) { closing = null; authDetail = undefined; authCloseResult = undefined; }
    if (closeReceiptOwner && (!current(closeReceiptOwner.token) || !matchesAttempt(closeReceiptOwner.attempt))) {
      closeReceiptOwner = null; authDetail = undefined; authCloseResult = undefined;
    }
    const attempt = knownAttempt();
    if (attempt?.closeRequested) void observeClose(attempt);
  }
  async function settleClose(attempt: LoginAttempt, reconcile = false) {
    if (!attempt.closePromise && (reconcile || (!attempt.closeResult && !attempt.closeUncertain)) && attempt.reservation && transport.closeLogin) {
      const handle = attempt.reservation.attemptHandle;
      // Close owns its deadline and signal. This promise caches the receipt or
      // uncertainty; it never writes to an initiating controller's local view.
      attempt.closePromise = request(signal => transport.closeLogin!(handle, signal), true).then(result => {
        if (result.attemptHandle !== handle) throw new Error("Close returned a different attempt");
        attempt.closeResult = Object.freeze({ ...result }); attempt.closeUncertain = false;
      }).catch(() => { attempt.closeUncertain = true; }).finally(() => { attempt.closePromise = undefined; });
    }
    return observeClose(attempt, attempt.closeToken ?? { ...capture(), target: attempt.target }, true) ?? attempt.closePromise;
  }
  async function accountAction(action: "login" | "logout") {
    if (disposed || authentication || (closing && current(closing.token) && projectsConnection(closing.attempt)) || target.harness !== "codex") return;
    if ((action === "login" && (!transport.reserveLogin || !transport.startLogin || !transport.closeLogin)) || (action === "logout" && !transport.logout)) {
      authDetail = { zh: "认证接口不可用，请核对连接状态。", en: "Authentication endpoints are unavailable. Check connection status." }; publish(); return;
    }
    const generation: AttemptGeneration = observedScope && sameTarget(observedScope.target, target)
      ? { source: "verified-reservation", value: observedScope.generation } : { source: "unobserved-reservation" };
    invalidate(); state = null; ownerGeneration = null;
    const attempt: LoginAttempt | undefined = action === "login" ? { target, started: false, detached: false, closeRequested: false, generation } : undefined;
    // A newer login intent supersedes local receipt correlation even while its
    // reservation is pending; an older reply cannot become this attempt's view.
    if (attempt) attempts.set(key(attempt.target), attempt);
    const operation: AuthenticationOperation = { action, token: capture(), closeRequested: false, attempt };
    authentication = operation; authDetail = undefined; authCloseResult = undefined; publish();
    try {
      if (attempt) {
        const reservation = await request(signal => {
          const pending = transport.reserveLogin!(signal);
          // A late reserve response can settle a recorded Close, but cannot start
          // after timeout, navigation, disposal or replacement by a newer attempt.
          void pending.then(value => {
            attempt.reservation = value;
            if (attempt.closeRequested) {
              if ((authentication === operation && !attempt.detached) || !attempts.has(key(attempt.target)) || attempts.get(key(attempt.target)) === attempt) attempts.set(key(attempt.target), attempt);
              void settleClose(attempt);
            }
          }, () => undefined);
          return pending;
        });
        attempt.reservation = reservation;
        if (attempt.closeRequested) { await settleClose(attempt); return; }
        if (attempt.detached || !current(operation.token) || authentication !== operation) return;
        attempts.set(key(attempt.target), attempt);
        attempt.started = true; attempt.generation = { source: "unobserved-start" }; observedScope = undefined;
        const login = await request(signal => transport.startLogin!(reservation.attemptHandle, signal));
        attempt.loginId = login.loginId;
        if (attempt.closeRequested) { await settleClose(attempt); return; }
      } else { observedScope = undefined; await request(signal => transport.logout!(signal)); }
      if (!current(operation.token) || authentication !== operation) return;
      authDetail = { zh: "操作已返回，请以当前连接观察为准。执行仍尚未验证。", en: "The operation returned. Check the current connection observation; execution remains unverified." };
      await refreshState();
    } catch {
      if (current(operation.token) && authentication === operation && !attempt?.closeRequested) {
        authDetail = { zh: "认证操作结果不确定，请核对当前状态；不会自动重新登录。", en: "Authentication outcome is uncertain. Check current status; sign-in will not be replayed automatically." };
        await refreshState();
      }
    } finally { if (attempt) attempt.detached = true; if (authentication === operation) authentication = null; publish(); }
  }
  async function bindConnection() {
    if (disposed || authentication || target.harness !== "codex" || !transport.bindConnection || !snapshot.canSave || !baseline
      || baseline.selectedHarnessId !== "codex" || !state?.account || state.scope?.authContextRef !== target.contextKey) return;
    const expectedRevision = draft().baselineRevision!;
    invalidate(); state = null; ownerGeneration = null; observedScope = undefined;
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
    if (intent.action === "cancel-sign-in" && state?.connection?.login?.status === "pending" && state.connection.login.loginId === intent.attemptKey) closeConnection();
  }
  function closeConnection() {
    if (disposed || target.harness !== "codex") return;
    const attempt = knownAttempt();
    if (attempt && matchesAttempt(attempt) && attempt.closeResult && !attempt.closeUncertain && attempt.closeResult.cleanup !== "unconfirmed") {
      // A terminal attempt still has a receipt. Viewing it does not retry Close.
      void observeClose(attempt); publish(); return;
    }
    if (!canCloseAttempt(attempt) || !attempt) {
      authDetail = { zh: "当前页面没有本次尝试的已知标识；无法确认关闭，请刷新连接状态。", en: "This page has no known handle for this attempt. Close cannot be confirmed; refresh connection status." }; publish(); return;
    }
    attempt.closeRequested = true; attempt.closeToken = capture();
    if (!attempt.reservation) {
      closeReceiptOwner = { attempt, token: capture() };
      authDetail = { zh: "关闭请求已记录；收到本次标识后仅关闭，不启动登录。", en: "Close requested. If this attempt's handle returns, it will only be closed; sign-in will not start." }; publish(); return;
    }
    // The handle is retained before starting so a lost start response never
    // forces cancellation to depend on a subsequently returned provider ID.
    attempts.set(key(attempt.target), attempt);
    void settleClose(attempt, true);
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
