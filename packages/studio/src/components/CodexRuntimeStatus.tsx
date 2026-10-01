import { useEffect } from "react";
import { useApi } from "../hooks/use-api";
import type { StudioCodexAccount, StudioCodexSettings } from "../shared/codex";

export function CodexRuntimeStatus({ isZh, onSettings }: { readonly isZh: boolean; readonly onSettings: () => void }) {
  const account = useApi<StudioCodexAccount>("/codex/account");
  const settings = useApi<{ settings: StudioCodexSettings }>("/codex/settings");
  useEffect(() => {
    const refresh = () => { void account.refetch(); void settings.refetch(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [account.refetch, settings.refetch]);
  const saved = settings.data?.settings;
  const label = account.loading ? (isZh ? "连接 Codex…" : "Connecting to Codex…")
    : account.error || settings.error ? (isZh ? "检查 Codex 设置 →" : "Check Codex settings →")
    : !account.data?.connected ? (isZh ? "使用 ChatGPT 登录 Codex →" : "Sign in to Codex with ChatGPT →")
    : [saved?.model ?? "Codex", saved?.reasoningEffort, saved?.serviceTier !== "default" ? saved?.serviceTier : null].filter(Boolean).join(" · ");
  return <button type="button" data-testid="codex-runtime-status" onClick={onSettings} className="px-2 py-1.5 text-sm text-muted-foreground hover:text-primary truncate" title={isZh ? "Codex 账户与运行设置" : "Codex account and runtime settings"}>{label}</button>;
}
