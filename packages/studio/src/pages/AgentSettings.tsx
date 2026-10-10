import { AgentConfigurationPanel } from "../components/agent-configuration-ui/AgentConfigurationPanel";
import { adaptAgentConfiguration } from "./agent-configuration-adapter";
import { useAgentConfiguration } from "../hooks/use-agent-configuration";
import { buttonClass, localize, text } from "../components/agent-configuration-ui/view-model";

// Standalone component for review. ProjectSettings keeps its existing production entry.
export function AgentSettings({ isZh }: { readonly isZh: boolean }) {
  const { controller, snapshot } = useAgentConfiguration();
  const view = adaptAgentConfiguration({ target: snapshot.target, ownerGeneration: snapshot.ownerGeneration, state: snapshot.state, draft: snapshot.draft,
    saved: snapshot.baseline?.harnessPreferences[snapshot.target.harness] ?? null, savePhase: snapshot.savePhase, saveDetail: snapshot.detail,
    submitted: snapshot.submitted?.preferences });
  return <div className="space-y-3">
    <AgentConfigurationPanel id="agent-settings" view={view} isZh={isZh} canSave={snapshot.canSave} hasChanges={snapshot.hasChanges}
      onHarnessChange={harness => { controller.selectTarget({ harness, contextKey: "unobserved" }); void controller.refresh(); }}
      onConnectionIntent={controller.connectionIntent} onSelectionIntent={controller.edit} onSaveIntent={intent => { void controller.save(intent); }} />
    <button type="button" className={buttonClass} disabled={snapshot.loading} onClick={() => { void controller.refresh(); }}>{text(isZh, "刷新配置与观察状态", "Refresh settings and observations")}</button>
    {["conflict", "uncertain"].includes(snapshot.savePhase) && <button type="button" className={buttonClass} disabled={!snapshot.reviewable || snapshot.loading} onClick={controller.reviewLatest}>
      {text(isZh, "已核对当前配置，允许再次保存", "Reviewed current settings; allow another save")}
    </button>}
    {snapshot.detail && <p role="alert" aria-live="polite" className="text-sm">{localize(isZh, snapshot.detail)}</p>}
    <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{text(isZh, "认证操作等待真实接口接线。当前保存仅设置下次运行的偏好。", "Authentication operations await actual integration. Saving only sets preferences for the next run.")}</p>
  </div>;
}
