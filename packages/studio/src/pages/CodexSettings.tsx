import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { fetchJson, postApi, putApi } from "../hooks/use-api";
import { isCodexVerificationUrl, type StudioCodexAccount, type StudioCodexLogin, type StudioCodexModel, type StudioCodexSettings } from "../shared/codex";
import { changeCodexModel, selectedCodexModel, validCodexSettings } from "./codex-settings-state";

const fieldClass = "w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none focus:border-primary/50 disabled:opacity-50";
const buttonClass = "rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed";

export function CodexSettings({ isZh }: { readonly isZh: boolean }) {
  const [account, setAccount] = useState<StudioCodexAccount | null>(null);
  const [models, setModels] = useState<readonly StudioCodexModel[]>([]);
  const [settings, setSettings] = useState<StudioCodexSettings | null>(null);
  const [draft, setDraft] = useState<StudioCodexSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const action = useRef(false);
  const generation = useRef(0);
  const t = (zh: string, en: string) => isZh ? zh : en;

  const loadCatalog = useCallback(async (version = generation.current) => {
    try {
      const result = await fetchJson<{ models: StudioCodexModel[] }>("/codex/models");
      if (mounted.current && generation.current === version) { setModels(result.models); setCatalogError(null); }
    } catch (cause) {
      if (mounted.current && generation.current === version) setCatalogError(cause instanceof Error ? cause.message : "Codex catalog unavailable.");
    }
  }, []);

  const refresh = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [status, saved] = await Promise.all([
        fetchJson<StudioCodexAccount>("/codex/account"),
        fetchJson<{ settings: StudioCodexSettings }>("/codex/settings"),
      ]);
      if (!mounted.current || generation.current !== version) return;
      setAccount(status); setSettings(saved.settings); setDraft(saved.settings);
      await loadCatalog(version);
    } catch (cause) {
      if (mounted.current && generation.current === version) setError(cause instanceof Error ? cause.message : "Codex unavailable.");
    } finally {
      if (mounted.current && generation.current === version) setLoading(false);
    }
  }, [loadCatalog]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; generation.current++; };
  }, [refresh]);

  const login = account?.login;
  useEffect(() => {
    if (login?.status !== "pending" || busy || loading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const version = generation.current;
      try {
        const status = await fetchJson<StudioCodexAccount>("/codex/account");
        if (cancelled || !mounted.current || version !== generation.current) return;
        setAccount(status); setError(null);
        if (status.connected) { await loadCatalog(); return; }
        if (status.login?.status !== "pending") return;
      } catch (cause) {
        if (cancelled || !mounted.current || version !== generation.current) return;
        setError(cause instanceof Error ? cause.message : "Codex unavailable.");
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [login?.loginId, login?.status, busy, loading, loadCatalog]);

  const run = async (kind: string, work: () => Promise<void>) => {
    // Synchronous lock also catches double clicks before React disables the button.
    if (action.current) return;
    action.current = true; generation.current++;
    setBusy(kind); setError(null); setNotice(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Codex unavailable."); }
    finally { action.current = false; if (mounted.current) setBusy(null); }
  };

  const start = () => run("login", async () => {
    const pending = await postApi<StudioCodexLogin>("/codex/login", {});
    if (mounted.current) setAccount({ connected: false, account: null, requiresOpenaiAuth: true, login: pending });
  });
  const cancel = () => run("cancel", async () => {
    if (!login) return;
    await postApi("/codex/login/cancel", { loginId: login.loginId });
    const status = await fetchJson<StudioCodexAccount>("/codex/account");
    if (mounted.current) { setAccount(status); setNotice(t("登录已取消", "Sign-in cancelled")); }
  });
  const logout = () => run("logout", async () => {
    await postApi("/codex/logout", {});
    if (mounted.current) {
      setAccount({ connected: false, account: null, requiresOpenaiAuth: true, login: null });
      setModels([]); setNotice(t("已退出 Codex", "Signed out of Codex"));
    }
  });
  const save = () => run("save", async () => {
    if (!draft || !validCodexSettings(models, draft)) return;
    const result = await putApi<{ settings: StudioCodexSettings }>("/codex/settings", { ...draft, model: draft.model ?? null });
    if (mounted.current) { setSettings(result.settings); setDraft(result.settings); setNotice(t("Codex 设置已保存，下次运行生效", "Codex settings saved for the next run")); }
  });

  const selected = draft ? selectedCodexModel(models, draft) : undefined;
  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);
  const pending = login?.status === "pending";
  const verificationUrl = login?.verificationUrl && isCodexVerificationUrl(login.verificationUrl) ? login.verificationUrl : undefined;

  return (
    <section data-testid="codex-settings" className="rounded-2xl border border-border/50 bg-card/70 p-5 shadow-sm space-y-5">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-primary/10 p-2 text-primary"><Bot size={18} /></div>
        <div className="flex-1">
          <h2 className="text-base font-bold">ChatGPT / Codex</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("使用 ChatGPT 账户运行 Codex Agent。登录信息仅由官方 Codex 保存在本机专用账户目录。", "Run Codex agents with your ChatGPT account. The official Codex CLI keeps credentials in a dedicated account directory on this machine.")}</p>
        </div>
        <button type="button" aria-label={t("刷新 Codex 状态", "Refresh Codex status")} className={buttonClass} disabled={loading || !!busy} onClick={() => void refresh()}><RefreshCw size={16} /></button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-emerald-600">{notice}</p>}
      {loading ? <p className="text-sm text-muted-foreground flex gap-2"><Loader2 size={16} className="animate-spin" />{t("正在读取 Codex 状态…", "Loading Codex status…")}</p> : (
        <div className="space-y-3">
          <p data-testid="codex-account-status" className="text-sm font-medium">{account?.connected
            ? `${t("已登录", "Signed in")}${account.account?.email ? ` · ${account.account.email}` : ""}${account.account?.planType ? ` · ${account.account.planType}` : ""}`
            : t("尚未登录 ChatGPT", "Not signed in to ChatGPT")}</p>
          {pending && <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3" data-testid="codex-device-login">
            <p className="text-sm">{t("打开官方登录页，输入下面的一次性代码。请勿向他人分享此代码。", "Open the official sign-in page and enter this one-time code. Do not share this code with anyone.")}</p>
            <p className="font-mono text-xl tracking-widest select-all" aria-label={t("设备登录代码", "Device sign-in code")}>{login.userCode}</p>
            {verificationUrl && <a className="inline-flex items-center gap-2 text-sm text-primary underline" href={verificationUrl} target="_blank" rel="noopener noreferrer">{t("打开 ChatGPT 登录页", "Open ChatGPT sign-in")}<ExternalLink size={14} /></a>}
            <p className="text-xs text-muted-foreground" role="status">{t("等待登录完成… 页面会自动更新。可离开此页后回来继续。", "Waiting for sign-in… This page updates automatically. You can return here to continue.")}</p>
          </div>}
          {login?.status === "failed" && <p role="alert" className="text-sm text-destructive">{t("登录失败或已过期，请重新登录。", "Sign-in failed or expired. Please try again.")}</p>}
          <div className="flex gap-2">
            {account?.connected
              ? <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void logout()}>{t("退出 Codex", "Sign out of Codex")}</button>
              : pending
                ? <button type="button" className={buttonClass} disabled={!!busy} onClick={() => void cancel()}>{t("取消登录", "Cancel sign-in")}</button>
                : <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={!!busy} onClick={() => void start()}>{busy === "login" ? t("正在启动登录…", "Starting sign-in…") : t("使用 ChatGPT 登录", "Sign in with ChatGPT")}</button>}
          </div>
        </div>
      )}
      <div className="border-t border-border/50 pt-4 space-y-4">
        <p className="text-sm text-muted-foreground">{t("以下设置用于 Codex Agent，下次运行生效。推理强度与运行速度是独立选项；模型列表和可选档位来自 Codex。", "These settings apply to the next Codex agent run. Reasoning effort and service speed are separate options, supplied by the Codex model catalog.")}</p>
        {catalogError && <p role="alert" className="text-sm text-destructive">{catalogError}</p>}
        {!models.length && !catalogError && !loading && <p className="text-sm text-muted-foreground">{t("登录后刷新以加载可用模型。", "Sign in and refresh to load available models.")}</p>}
        {draft && <div className="grid gap-4 md:grid-cols-3">
          <label className="space-y-1 text-sm">{t("Codex 模型", "Codex model")}
            <select aria-label={t("Codex 模型", "Codex model")} value={draft.model ?? ""} disabled={!!busy || !models.length} className={fieldClass} onChange={(event) => setDraft(changeCodexModel(models, draft, event.target.value))}>
              <option value="">{t("Codex 默认模型", "Codex default model")}</option>
              {draft.model && !selected && <option value={draft.model} disabled>{draft.model} ({t("不可用", "unavailable")})</option>}
              {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">{t("推理强度", "Reasoning effort")}
            <select aria-label={t("推理强度", "Reasoning effort")} value={draft.reasoningEffort} disabled={!!busy || !selected} className={fieldClass} onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}>
              {!selected?.supportedReasoningEfforts.some((option) => option.reasoningEffort === draft.reasoningEffort) && <option disabled value={draft.reasoningEffort}>{draft.reasoningEffort} ({t("不可用", "unavailable")})</option>}
              {selected?.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">{t("运行速度", "Service speed")}
            <select aria-label={t("运行速度", "Service speed")} value={draft.serviceTier} disabled={!!busy || !selected} className={fieldClass} onChange={(event) => setDraft({ ...draft, serviceTier: event.target.value })}>
              <option value="default">{t("默认", "Default")}</option>
              {draft.serviceTier !== "default" && !selected?.serviceTiers.some((tier) => tier.id === draft.serviceTier) && <option disabled value={draft.serviceTier}>{draft.serviceTier} ({t("不可用", "unavailable")})</option>}
              {selected?.serviceTiers.filter((tier) => tier.id !== "default").map((tier) => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
            </select>
          </label>
        </div>}
        {selected && <div className="space-y-1 text-xs text-muted-foreground">
          <p>{selected.description}</p>
          <p>{selected.supportedReasoningEfforts.find((option) => option.reasoningEffort === draft?.reasoningEffort)?.description}</p>
          <p>{selected.serviceTiers.find((tier) => tier.id === draft?.serviceTier)?.description}</p>
        </div>}
        <button type="button" className={buttonClass} onClick={() => void save()} disabled={!!busy || loading || !draft || !dirty || !validCodexSettings(models, draft)}>{busy === "save" ? t("保存中…", "Saving…") : t("保存 Codex 设置", "Save Codex settings")}</button>
      </div>
    </section>
  );
}
