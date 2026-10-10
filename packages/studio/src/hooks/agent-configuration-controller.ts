import { ApiResponseError, fetchJson } from "./use-api";
import type { SaveIntent, SelectionIntent, TargetView, TextView, ConnectionIntent } from "../components/agent-configuration-ui/view-model";
import { sameTarget } from "../components/agent-configuration-ui/view-model";
import { toPreferences } from "../pages/agent-configuration-adapter";
import { samePreferences, validScope, type AgentSettings, type HarnessId, type HarnessPreferences, type HarnessState, type SettingsUpdate } from "../shared/agent-configuration";

export interface AgentConfigurationTransport {
  readSettings(signal: AbortSignal): Promise<AgentSettings>;
  saveSettings(request: SettingsUpdate, signal: AbortSignal): Promise<AgentSettings>;
  readHarnessState(harness: HarnessId, signal: AbortSignal): Promise<HarnessState>;
}
export function createAgentConfigurationTransport(fetchImpl?: typeof fetch): AgentConfigurationTransport {
  return {
    readSettings: async signal => (await fetchJson<{ settings: AgentSettings }>("/agent-configuration/settings", { signal }, { fetchImpl })).settings,
    saveSettings: async (request, signal) => (await fetchJson<{ settings: AgentSettings }>("/agent-configuration/settings", {
      method: "PUT", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    }, { fetchImpl })).settings,
    readHarnessState: async (harness, signal) => (await fetchJson<{ state: HarnessState }>(`/agent-configuration/harnesses/${harness}/state`, { signal }, { fetchImpl })).state,
  };
}
interface Draft { readonly preferences: HarnessPreferences; readonly edits: number; readonly dirty: boolean }
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
  readonly state: HarnessState | null;
  readonly submitted: SubmittedConfiguration | null;
  readonly loading: boolean;
  readonly savePhase: "unverified" | "unsaved" | "saving" | "saved" | "conflict" | "failed" | "uncertain";
  readonly detail?: TextView;
  readonly hasChanges: boolean;
  readonly canSave: boolean;
  readonly reviewable: boolean;
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

export function createAgentConfigurationController(transport: AgentConfigurationTransport, initialTarget?: TargetView, timeoutMs = 15_000) {
  let target = Object.freeze({ ...(initialTarget ?? { harness: "codex", contextKey: "unobserved" }) });
  let followSavedHarness = initialTarget === undefined;
  let ownerGeneration: number | null = null;
  let baseline: AgentSettings | null = null;
  let revision: number | null = null;
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
  const drafts = new Map<string, Draft>();
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  const draft = () => drafts.get(key(target)) ?? { preferences: baseline?.harnessPreferences[target.harness] ?? empty(), edits: 0, dirty: false };
  let snapshot: AgentConfigurationSnapshot;
  function publish() {
    const current = draft();
    const hasChanges = baseline !== null && (baseline.selectedHarnessId !== target.harness || !samePreferences(current.preferences, baseline.harnessPreferences[target.harness]));
    snapshot = Object.freeze({ target, ownerGeneration, baseline, revision, draft: current.preferences, state, submitted, loading, savePhase, detail, hasChanges, reviewable,
      canSave: baseline !== null && revision !== null && !["saving", "conflict", "uncertain"].includes(savePhase) });
    for (const listener of listeners) listener();
  }
  function invalidate() {
    lifetime++; readEpoch++; stateEpoch++; saveEpoch++;
    for (const request of requests) request.abort();
    if (savePhase === "saving") { savePhase = "uncertain"; detail = uncertain; reviewable = false; }
    loading = false;
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
    baseline = freezeSettings(value);
    const currentDraft = draft();
    if (!currentDraft.dirty && !reconcile && savePhase !== "saving") {
      drafts.set(key(target), { preferences: preferences(value.harnessPreferences[target.harness]), edits: currentDraft.edits, dirty: false });
      revision = value.revision;
    } else if (revision === null) revision = value.revision;
  }
  async function refreshSettings(reconcile = false): Promise<ReturnType<typeof capture> | undefined> {
    const token = capture(); const epoch = ++readEpoch;
    loading = true; publish();
    try {
      const value = await request(signal => transport.readSettings(signal));
      if (!current(token) || epoch !== readEpoch) return;
      const previous = revision;
      receiveSettings(value, reconcile);
      if (["conflict", "uncertain"].includes(savePhase) || reconcile) reviewable = true;
      if (!reconcile && draft().dirty && previous !== null && value.revision !== previous && savePhase !== "saving") {
        savePhase = "conflict"; reviewable = true; detail = { zh: "存储配置已更新；草稿保留，请核对后再保存。", en: "Stored settings changed. Your draft is retained; review before saving." };
      }
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
      if (value.scope && ownerGeneration !== null && value.scope.ownerGeneration < ownerGeneration) return;
      if (value.availability === "available" && value.scope) {
        if (target.contextKey === "unobserved") {
          const previous = draft();
          target = Object.freeze({ harness: target.harness, contextKey: value.scope.authContextRef });
          if (!drafts.has(key(target))) drafts.set(key(target), previous);
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
    submitted = null;
    if (!["uncertain", "conflict"].includes(savePhase)) { savePhase = "unsaved"; detail = undefined; }
    publish();
  }
  function edit(intent: SelectionIntent) {
    if (disposed || !sameTarget(intent.target, target)) return;
    const previous = draft();
    const field = { model: "model", reasoning: "effort", speed: "speed" }[intent.field];
    const next = preferences({ ...previous.preferences, [field]: intent.choiceKey });
    drafts.set(key(target), { preferences: next, edits: previous.edits + 1, dirty: !baseline || !samePreferences(next, baseline.harnessPreferences[target.harness]) });
    if (!["saving", "conflict", "uncertain"].includes(savePhase)) savePhase = "unsaved";
    publish();
  }
  async function save(intent: SaveIntent) {
    if (!sameTarget(intent.target, target) || !snapshot.canSave || !snapshot.hasChanges || !samePreferences(toPreferences(intent.selection), draft().preferences)) return;
    const token = capture(); const epoch = ++saveEpoch;
    submitted = Object.freeze({ target: Object.freeze({ ...target }), preferences: preferences(draft().preferences), expectedRevision: revision!, edits: draft().edits,
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
      baseline = freezeSettings(result); revision = result.revision;
      const latest = draft();
      if (latest.edits === sent.edits) drafts.set(key(target), { preferences: preferences(result.harnessPreferences[target.harness]), edits: latest.edits, dirty: false });
      else drafts.set(key(target), { ...latest, dirty: !samePreferences(latest.preferences, result.harnessPreferences[target.harness]) });
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
      revision = baseline.revision; savePhase = "unsaved"; detail = undefined; publish();
    }
  }
  function connectionIntent(intent: ConnectionIntent) {
    if (disposed || !sameTarget(target, intent.target)) return;
    if (intent.action === "refresh-connection") { void refreshState(); return; }
    detail = { zh: "认证操作尚未接线；未发送登录、退出或取消请求。", en: "Authentication operations are not wired. No sign-in, sign-out or cancel request was sent." }; publish();
  }
  publish();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh, refreshSettings, refreshState, selectTarget, edit, save, reviewLatest, connectionIntent,
    cancel: () => { if (!disposed) { invalidate(); publish(); } },
    dispose: () => { invalidate(); disposed = true; listeners.clear(); },
  };
}
