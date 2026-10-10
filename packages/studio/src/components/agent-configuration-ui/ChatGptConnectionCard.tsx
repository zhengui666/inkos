import { connectionLabels } from "./display-state";
import { buttonClass, harnessLabel, localize, sameTarget, sectionClass, text, type ConnectionIntent, type ConnectionView, type TargetView } from "./view-model";

export interface ChatGptConnectionCardProps {
  readonly target: TargetView;
  readonly connection: ConnectionView;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly onIntent: (intent: ConnectionIntent) => void;
}

export function ChatGptConnectionCard({ target, connection, isZh, disabled, onIntent }: ChatGptConnectionCardProps) {
  const matches = sameTarget(target, connection.target);
  const phase = matches ? connection.phase : "unverified";
  const signedIn = phase === "signed-in";
  const pending = phase === "signing-in";
  const canConnect = matches && !["unverified", "uncertain"].includes(phase);
  const error = ["expired", "failed", "uncertain"].includes(phase) || !matches || (pending && !connection.attemptKey);
  const emit = (intent: ConnectionIntent) => { if (!disabled) onIntent(intent); };
  return <section className={sectionClass} aria-label={`${harnessLabel(target.harness)} · ${text(isZh, "ChatGPT 连接", "ChatGPT connection")}`}>
    <h3 className="text-sm font-medium">{harnessLabel(target.harness)} · ChatGPT</h3>
    <p role="status" aria-live="polite" aria-atomic="true" className="text-sm">
      {localize(isZh, connectionLabels[phase])}
      {signedIn && connection.accountLabel ? ` · ${connection.accountLabel}` : ""}
    </p>
    <p className="text-xs text-muted-foreground">{text(isZh, "登录成功后仍需核对模型目录与执行验证。", "After sign-in, the model catalog and execution still need verification.")}</p>
    {error && <p role="alert" className="text-sm text-destructive">{matches && connection.detail ? localize(isZh, connection.detail) : text(isZh,
      "连接或登录操作尚未验证，请核对当前执行器的状态。", "The connection or sign-in operation is unverified. Check this harness's status.")}</p>}
    {!error && matches && connection.detail && <p className="text-xs text-muted-foreground">{localize(isZh, connection.detail)}</p>}
    <div className="flex flex-wrap gap-2">
      {signedIn
        ? <button type="button" className={buttonClass} disabled={disabled} onClick={() => emit({ action: "sign-out", target: { ...target } })}>{text(isZh, "退出 ChatGPT", "Sign out of ChatGPT")}</button>
        : pending
          ? <button type="button" className={buttonClass} disabled={disabled || !connection.attemptKey} onClick={() => {
            if (matches && connection.attemptKey) emit({ action: "cancel-sign-in", target: { ...connection.target }, attemptKey: connection.attemptKey });
          }}>{text(isZh, "取消登录", "Cancel sign-in")}</button>
          : <button type="button" className={buttonClass} disabled={disabled || !canConnect} onClick={() => { if (canConnect) emit({ action: "connect", target: { ...target } }); }}>{text(isZh, "使用 ChatGPT 登录", "Sign in with ChatGPT")}</button>}
      <button type="button" className={buttonClass} disabled={disabled} aria-label={`${harnessLabel(target.harness)} · ${text(isZh, "核对连接状态", "Check connection status")}`}
        onClick={() => emit({ action: "refresh-connection", target: { ...target } })}>{text(isZh, "核对状态", "Check status")}</button>
    </div>
  </section>;
}
