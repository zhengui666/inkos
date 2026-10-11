import type { ConfigurationView, SelectionView, TargetView, TextView } from "../components/agent-configuration-ui/view-model";
import { isExecutionReady } from "../components/agent-configuration-ui/display-state";
import { catalogMatchesState, samePreferences, sameScope, validScope, type HarnessPreferences, type HarnessState } from "../shared/agent-configuration";

export const toSelection = (value: HarnessPreferences): SelectionView => ({ modelKey: value.model, reasoningKey: value.effort, speedKey: value.speed });
export const toPreferences = (value: SelectionView): HarnessPreferences => ({ model: value.modelKey, effort: value.reasoningKey, speed: value.speedKey });
const label = (value: string): TextView => ({ zh: value, en: value });

export interface ConfigurationAdapterInput {
  readonly target: TargetView;
  readonly ownerGeneration: number | null;
  readonly state: HarnessState | null;
  readonly draft: HarnessPreferences;
  readonly saved: HarnessPreferences | null;
  readonly savePhase: ConfigurationView["save"]["phase"];
  readonly saveDetail?: TextView;
  readonly submitted?: HarnessPreferences;
}
/** Pure mapping of actual owner observations. No doctor, save, descriptor or resolver implies execution. */
export function adaptAgentConfiguration(input: ConfigurationAdapterInput): ConfigurationView {
  const { target, ownerGeneration, draft, saved, savePhase, saveDetail, submitted } = input;
  const candidate = input.state;
  const installation = candidate?.harnessId === target.harness ? candidate.installation : "unknown";
  const state = candidate?.availability === "available" && candidate.harnessId === target.harness
    && candidate.scope?.harnessId === target.harness && validScope(candidate.scope) && candidate.scope.authContextRef === target.contextKey
    && candidate.scope.ownerGeneration === ownerGeneration ? candidate : null;
  const catalog = state && catalogMatchesState(state) ? state.catalog : null;
  const models = catalog?.value.models ?? [];
  const native = catalog?.value.nativeDefaults.modelId;
  const nativeValid = native !== undefined && models.some(model => model.modelId === native);
  const execution = state?.execution && state.scope && sameScope(state.scope, state.execution.scope)
    && samePreferences(draft, state.execution.preferences) ? state.execution : null;
  const connectionObserved = state?.account?.type === "chatgpt";
  const localPhase = target.harness === "pi" && state?.localAuthentication
    ? state.localAuthentication === "oauth-present" ? "oauth-present" : state.localAuthentication === "missing" ? "signed-out" : "unverified" : undefined;
  const connectionPhase = localPhase ?? (state?.connection?.phase === "signing-in" ? "signing-in" : connectionObserved ? "signed-in"
    : state?.connection && state.connection.phase !== "signed-in" ? state.connection.phase : "unverified");
  const ready = execution?.phase === "ready" && connectionObserved && state?.installation === "installed" && catalog !== null && nativeValid
    && catalog.value.supportsChatGptOauth && catalog.value.supportsTools && catalog.value.supportsStreaming;
  const view: ConfigurationView = {
    target, selection: toSelection(draft),
    installation: { target, phase: installation === "installed" ? "installed" : installation === "missing" ? "missing" : "unverified" },
    connection: { target, phase: connectionPhase,
      ...(state?.connection?.phase === "signing-in" && state.connection.login?.status === "pending" ? { attemptKey: state.connection.login.loginId } : {}),
      ...(connectionPhase === "signed-in" && state?.account?.label ? { accountLabel: state.account.label } : {}),
      ...(localPhase === "oauth-present" ? { detail: { zh: "本地授权与模型目录不证明在线账号权限或实际执行。", en: "Local authorization and the model catalog do not verify online account entitlement or actual execution." } } : {}),
      ...(!state ? { detail: { zh: "真实连接观察接口尚不可用。", en: "Actual connection observation is unavailable." } } : {}) },
    catalog: { target, phase: catalog && nativeValid ? "available" : "unavailable", models: nativeValid ? models.map(model => ({
      key: model.modelId, label: label(model.modelId), reasoningOptions: model.efforts.map(key => ({ key, label: label(key) })),
      speed: { evidence: catalog!.speedSupport[model.modelId] === "backend" ? "backend" : catalog!.speedSupport[model.modelId] === "unsupported" ? "unsupported" : "unverified",
        options: catalog!.speedSupport[model.modelId] === "backend" ? model.serviceTiers.map(key => ({ key, label: label(key) })) : [] },
    })) : [], ...(catalog && nativeValid ? { nativeDefaults: { target, evidence: "backend", modelKey: native! } } : {}) },
    execution: { target, selection: toSelection(execution?.preferences ?? draft), phase: ready ? "ready" : execution && execution.phase !== "ready" && execution.phase !== "unknown" ? execution.phase : "unverified",
      evidence: ready ? "backend" : "unverified" },
    save: { target, phase: savePhase, selection: toSelection(savePhase === "saving" && submitted ? submitted : saved ?? draft), ...(saveDetail ? { detail: saveDetail } : {}) },
  };
  return view.execution.phase === "ready" && !isExecutionReady(view)
    ? { ...view, execution: { ...view.execution, phase: "unverified", evidence: "unverified" } } : view;
}
