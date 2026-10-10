import { AgentConfigurationPanel } from "../components/agent-configuration-ui/AgentConfigurationPanel";
import { adaptAgentConfiguration } from "./agent-configuration-adapter";
import { useAgentConfiguration } from "../hooks/use-agent-configuration";
import { buttonClass, localize, text } from "../components/agent-configuration-ui/view-model";
import { isCodexVerificationUrl } from "../shared/codex";

export function AgentSettings({ isZh }: { readonly isZh: boolean }) {
  const { controller, snapshot } = useAgentConfiguration();
  const view = adaptAgentConfiguration({ target: snapshot.target, ownerGeneration: snapshot.ownerGeneration, state: snapshot.state, draft: snapshot.draft,
    saved: snapshot.baseline?.harnessPreferences[snapshot.target.harness] ?? null, savePhase: snapshot.savePhase, saveDetail: snapshot.detail,
    submitted: snapshot.submitted?.preferences });
  const login = view.connection.phase === "signing-in" ? snapshot.state?.connection?.login : null;
  const bound = snapshot.state?.connection?.connectionRef && snapshot.state.connection.connectionRef === snapshot.baseline?.modelConnectionRef;
  return <div className="space-y-3">
    <AgentConfigurationPanel id="agent-settings" view={view} isZh={isZh} canSave={snapshot.canSave} hasChanges={snapshot.hasChanges} disabled={snapshot.authBusy !== null}
      onHarnessChange={harness => { controller.selectTarget({ harness, contextKey: "unobserved" }); void controller.refresh(); }}
      onConnectionIntent={controller.connectionIntent} onSelectionIntent={controller.edit} onSaveIntent={intent => { void controller.save(intent); }} />
    {login?.status === "pending" && login.verificationUrl && isCodexVerificationUrl(login.verificationUrl) && <div role="status" aria-live="polite" className="rounded-lg border border-border p-3 space-y-2">
      <p>{text(isZh, "在 ChatGPT 页面输入本次登录码：", "Enter this attempt's code on the ChatGPT page:")} <strong>{login.userCode}</strong></p>
      <a className={buttonClass} href={login.verificationUrl} target="_blank" rel="noopener noreferrer">{text(isZh, "打开 ChatGPT 登录页面", "Open ChatGPT sign-in page")}</a>
    </div>}
    {(snapshot.authBusy === "login" || login?.status === "pending") && <button type="button" className={buttonClass} onClick={controller.closeConnection}>{text(isZh, "关闭并取消登录", "Close and cancel sign-in")}</button>}
    <p role="status" aria-live="polite">{snapshot.target.harness === "pi"
      ? text(isZh, "Pi 生产执行尚未接入；可保存偏好，待连接。", "Pi production execution is unavailable. Preferences can be saved pending connection.")
      : bound ? text(isZh, "当前模型连接已绑定；执行尚未验证。", "Current model connection is bound; execution remains unverified.")
        : text(isZh, "模型连接尚未绑定。登录后需显式绑定当前项目。", "Model connection is unbound. After sign-in, explicitly bind this project.")}</p>
    {snapshot.target.harness === "codex" && <button type="button" className={buttonClass} disabled={!!snapshot.authBusy || snapshot.loading || !snapshot.canSave || !snapshot.state?.account || snapshot.baseline?.selectedHarnessId !== "codex"}
      onClick={() => { void controller.bindConnection(); }}>{text(isZh, "绑定当前 ChatGPT 模型连接", "Bind current ChatGPT model connection")}</button>}
    {snapshot.authBusy && <p role="status" aria-live="polite">{text(isZh, "连接操作处理中…", "Connection operation in progress…")}</p>}
    {snapshot.authDetail && <p role="alert" aria-live="polite">{localize(isZh, snapshot.authDetail)}</p>}
    <button type="button" className={buttonClass} disabled={snapshot.loading} onClick={() => { void controller.refresh(); }}>{text(isZh, "刷新配置与观察状态", "Refresh settings and observations")}</button>
    {["conflict", "uncertain"].includes(snapshot.savePhase) && <button type="button" className={buttonClass} disabled={!snapshot.reviewable || snapshot.loading} onClick={controller.reviewLatest}>
      {text(isZh, "已核对当前配置，允许再次保存", "Reviewed current settings; allow another save")}
    </button>}
    {snapshot.detail && <p role="alert" aria-live="polite" className="text-sm">{localize(isZh, snapshot.detail)}</p>}
    <p role="status" aria-live="polite" className="text-xs text-muted-foreground">{text(isZh, "保存仅设置下次运行的偏好，当前运行配置保持冻结。", "Saving sets preferences for the next run. Current run configuration remains frozen.")}</p>
  </div>;
}
