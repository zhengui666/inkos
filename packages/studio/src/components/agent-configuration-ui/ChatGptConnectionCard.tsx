import { useEffect, useRef, useState } from "react";
import { connectionLabels } from "./display-state";
import { buttonClass, fieldClass, harnessLabel, localize, sameTarget, sectionClass, text, type ConnectionIntent, type ConnectionView, type PiAuthenticationView, type TargetView } from "./view-model";

export interface ChatGptConnectionCardProps {
  readonly id?: string;
  readonly target: TargetView;
  readonly connection: ConnectionView;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly connectDisabled?: boolean;
  readonly authManagementAvailable?: boolean;
  readonly onIntent: (intent: ConnectionIntent) => void;
  readonly piAuthentication?: PiAuthenticationView;
  readonly onPiReply?: (target: TargetView, handle: string, promptId: string, callbackArg: string) => void;
  readonly onPiClose?: (target: TargetView, handle?: string) => void;
}

function officialPiUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin === "https://auth.openai.com" && url.pathname === "/api/accounts/authorize" && !url.username && !url.password && !url.hash ? value : null;
  } catch { return null; }
}
const piPhaseLabels: Record<PiAuthenticationView["phase"], { zh: string; en: string }> = {
  idle: { zh: "Pi 登录尚未开始。", en: "Pi sign-in has not started." },
  reserved: { zh: "正在准备本次 Pi 登录。", en: "Preparing this Pi sign-in." },
  starting: { zh: "正在启动官方 ChatGPT 登录。", en: "Starting official ChatGPT sign-in." },
  "awaiting-user": { zh: "等待手动完成 ChatGPT 登录并粘贴最终回调网址。", en: "Waiting for you to complete ChatGPT sign-in and paste the final callback URL." },
  exchanging: { zh: "正在交换本次授权并保存本地凭证，结果尚未确认。", en: "Exchanging this authorization and saving local credentials; outcome unconfirmed." },
  closing: { zh: "正在关闭本次 Pi 登录，关闭结果尚未确认。", en: "Closing this Pi sign-in; Close outcome unconfirmed." },
  saved: { zh: "本次 Pi 凭证已在本地保存。", en: "This Pi credential has been saved locally." },
  closed: { zh: "本次 Pi 登录已关闭；执行尚未验证。", en: "This Pi sign-in is closed; execution remains unverified." },
  failed: { zh: "本次 Pi 登录未完成，请核对错误。", en: "This Pi sign-in did not complete. Review the error." },
  unknown: { zh: "本次 Pi 登录结果不确定，请核对同一尝试。", en: "This Pi sign-in outcome is unknown. Check the same attempt." },
};
function PiConnectionControls({ id = "pi-chatgpt", target, connection, piAuthentication, isZh, disabled, onIntent, onPiReply, onPiClose }: ChatGptConnectionCardProps) {
  const auth = piAuthentication!;
  const [callbackArg, setCallbackArg] = useState("");
  const local = useRef({ active: true, value: "" });
  const matches = sameTarget(target, auth.target);
  const clear = () => { local.current.value = ""; setCallbackArg(""); };
  useEffect(() => { local.current.active = true; clear(); return () => { local.current.active = false; local.current.value = ""; }; }, [target.harness, target.contextKey, auth.handle, auth.promptId]);
  const phase = matches ? auth.busy === "close" ? "closing" : auth.busy === "reply" ? "exchanging" : auth.busy === "reserve" ? "reserved" : auth.busy === "start" ? "starting" : auth.phase : "idle";
  const pending = ["reserved", "starting", "awaiting-user", "exchanging", "closing"].includes(phase);
  const url = matches && pending && phase !== "closing" ? officialPiUrl(auth.authorizationUrl) : null;
  const replyAllowed = matches && phase === "awaiting-user" && !!auth.handle && !!auth.promptId && !!url && auth.capabilities.canReply && !auth.busy && !disabled && !!onPiReply;
  const closeAllowed = matches && auth.canClose && (auth.handle ? auth.capabilities.canCloseAttempt : auth.busy === "reserve") && !disabled && auth.busy !== "close" && !!onPiClose;
  const connectAllowed = matches && auth.capabilities.canStartLogin && !pending && !auth.busy && !disabled;
  const saved = matches && (phase === "saved" || auth.closeOutcome === "already-committed" || (sameTarget(target, connection.target) && connection.phase === "oauth-present"));
  return <div className="space-y-3">
    <p role="status" aria-live="polite" aria-atomic="true">{localize(isZh, piPhaseLabels[phase])}</p>
    {matches && auth.closeOutcome === "already-committed" && <p role="status" aria-live="polite">{text(isZh, "登录已经提交，本地凭证已保存；关闭不会退出账号。", "Sign-in already committed and local credentials saved; Close does not sign out.")}</p>}
    {matches && auth.closeOutcome === "unknown" && <p role="alert">{text(isZh, "关闭结果不确定；请核对同一尝试，不会自动重放登录或退出。", "Close outcome is unknown. Check the same attempt; sign-in or logout is not replayed automatically.")}</p>}
    {saved && <p role="status" aria-live="polite">{auth.catalogConfirmed ? text(isZh, "模型目录已观察，在线账号与执行尚未验证。", "Model catalog observed; online account and execution remain unverified.") : text(isZh, "本地凭证已保存，模型目录待确认；在线账号与执行尚未验证。", "Local credentials saved; model catalog unconfirmed. Online account and execution remain unverified.")}</p>}
    <p className="text-xs text-muted-foreground">{text(isZh, "登录请求入口不证明部署或执行条件已验证。保存默认配置与认证分别处理。", "A sign-in request entry point does not verify deployment or execution. Saving defaults and authentication are handled separately.")}</p>
    {url && <a className={buttonClass} href={url} target="_blank" rel="noopener noreferrer" aria-label={text(isZh, "Pi · 打开官方 ChatGPT 登录页面", "Pi · Open official ChatGPT sign-in page")}>{text(isZh, "打开官方 ChatGPT 登录页面", "Open official ChatGPT sign-in page")}</a>}
    {matches && pending && auth.authorizationUrl && !url && phase !== "closing" && <p role="alert">{text(isZh, "官方登录网址尚未核实，请核对状态。", "The official sign-in URL is unverified. Check status.")}</p>}
    {matches && pending && auth.promptId && auth.handle && phase !== "closing" && <form aria-label={text(isZh, "Pi · 完成 ChatGPT 登录", "Pi · Complete ChatGPT sign-in")} className="space-y-2" onSubmit={event => {
      event.preventDefault(); const value = local.current.value; clear();
      if (local.current.active && replyAllowed && value.trim()) onPiReply!({ ...target }, auth.handle!, auth.promptId!, value);
    }}>
      <label htmlFor={`${id}-callback`}>{text(isZh, "最终登录回调网址", "Final sign-in callback URL")}</label>
      <input id={`${id}-callback`} type="text" className={fieldClass} value={callbackArg} autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={!replyAllowed}
        aria-label={text(isZh, "Pi · 登录回调网址", "Pi · Sign-in callback URL")} aria-describedby={`${id}-callback-help`} onChange={event => {
          if (local.current.active && replyAllowed) { local.current.value = event.target.value; setCallbackArg(event.target.value); }
        }} />
      <p id={`${id}-callback-help`} className="text-xs text-muted-foreground">{text(isZh, "手动粘贴登录后的最终重定向网址。浏览器的 127.0.0.1 不一定是运行 Pi 的服务器；无需在浏览器收到本地成功页面。", "Manually paste the final redirect URL after sign-in. Your browser's 127.0.0.1 may differ from the Pi server; a local success page in the browser is not required.")}</p>
      <button type="submit" className={buttonClass} disabled={!replyAllowed || !callbackArg.trim()} aria-label={text(isZh, "Pi · 提交登录回调", "Pi · Submit sign-in callback")}>{text(isZh, "提交登录回调", "Submit sign-in callback")}</button>
    </form>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={!connectAllowed} aria-label={text(isZh, "Pi · 使用 ChatGPT 登录", "Pi · Sign in with ChatGPT")} onClick={() => { clear(); if (local.current.active && connectAllowed) onIntent({ action: "connect", target: { ...target } }); }}>{text(isZh, "使用 ChatGPT 登录", "Sign in with ChatGPT")}</button>
      {(pending || auth.handle || auth.canClose) && <button type="button" className={buttonClass} disabled={!closeAllowed} aria-label={text(isZh, "Pi · 关闭本次登录", "Pi · Close this sign-in")} onClick={() => { clear(); if (local.current.active && closeAllowed) onPiClose!({ ...target }, auth.handle); }}>{text(isZh, "关闭本次 Pi 登录", "Close this Pi sign-in")}</button>}
      <button type="button" className={buttonClass} disabled aria-describedby={`${id}-logout-reason`} aria-label={text(isZh, "Pi · 退出 ChatGPT（暂不可用）", "Pi · Sign out of ChatGPT (unavailable)")}>{text(isZh, "退出 ChatGPT", "Sign out of ChatGPT")}</button>
      <button type="button" className={buttonClass} disabled={disabled} aria-label={text(isZh, "Pi · 核对连接状态", "Pi · Check connection status")} onClick={() => { if (!disabled) onIntent({ action: "refresh-connection", target: { ...target } }); }}>{text(isZh, "核对状态", "Check status")}</button>
    </div>
    <p id={`${id}-logout-reason`} className="text-xs text-muted-foreground">{text(isZh, "Pi 暂不支持在此页面退出 ChatGPT。", "Pi sign-out is unavailable on this page.")}</p>
    {matches && auth.detail && <p role="alert" aria-live="polite">{localize(isZh, auth.detail)}</p>}
  </div>;
}

export function ChatGptConnectionCard(props: ChatGptConnectionCardProps) {
  const { target, connection, isZh, disabled, connectDisabled, authManagementAvailable = true, onIntent } = props;
  if (target.harness === "pi" && props.piAuthentication) return <section className={sectionClass} aria-label={`Pi · ${text(isZh, "ChatGPT 连接", "ChatGPT connection")}`}>
    <h3 className="text-sm font-medium">Pi · ChatGPT</h3>
    <PiConnectionControls key={JSON.stringify([target.harness, target.contextKey, props.piAuthentication.handle, props.piAuthentication.promptId])} {...props} />
  </section>;
  const matches = sameTarget(target, connection.target);
  const phase = matches ? connection.phase : "unverified";
  const signedIn = phase === "signed-in";
  const pending = phase === "signing-in";
  const canConnect = matches && !["unverified", "uncertain", "oauth-present"].includes(phase);
  const error = ["expired", "failed", "uncertain"].includes(phase) || !matches || (pending && !connection.attemptKey);
  const authDisabled = disabled || !authManagementAvailable;
  const connectBlocked = !authManagementAvailable || (connectDisabled ?? disabled);
  const emit = (intent: ConnectionIntent) => {
    if (!(intent.action === "connect" ? connectBlocked : intent.action === "refresh-connection" ? disabled : authDisabled)) onIntent(intent);
  };
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
        ? <button type="button" className={buttonClass} disabled={authDisabled} onClick={() => emit({ action: "sign-out", target: { ...target } })}>{text(isZh, "退出 ChatGPT", "Sign out of ChatGPT")}</button>
        : pending
          ? <button type="button" className={buttonClass} disabled={authDisabled || !connection.attemptKey} onClick={() => {
            if (matches && connection.attemptKey) emit({ action: "cancel-sign-in", target: { ...connection.target }, attemptKey: connection.attemptKey });
          }}>{text(isZh, "取消登录", "Cancel sign-in")}</button>
          : <button type="button" className={buttonClass} disabled={connectBlocked || !canConnect} onClick={() => { if (canConnect) emit({ action: "connect", target: { ...target } }); }}>{text(isZh, "使用 ChatGPT 登录", "Sign in with ChatGPT")}</button>}
      <button type="button" className={buttonClass} disabled={disabled} aria-label={`${harnessLabel(target.harness)} · ${text(isZh, "核对连接状态", "Check connection status")}`}
        onClick={() => emit({ action: "refresh-connection", target: { ...target } })}>{text(isZh, "核对状态", "Check status")}</button>
    </div>
  </section>;
}
