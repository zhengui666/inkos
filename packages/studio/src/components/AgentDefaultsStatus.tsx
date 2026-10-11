import { useCallback, useEffect, useRef, useState } from "react";
import { buildApiUrl, fetchJson } from "../hooks/use-api";
import { adaptAgentConfiguration } from "../pages/agent-configuration-adapter";
import type { AgentSettings, HarnessState } from "../shared/agent-configuration";
import { harnessLabel, text } from "./agent-configuration-ui/view-model";

interface Props { readonly isZh: boolean; readonly onSettings: () => void }

function useDefaultsRead<T>(path: string) {
  const [result, setResult] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null });
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const refetch = useCallback(async () => {
    const id = ++sequence.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setResult({ data: null, loading: true, error: null });
    try {
      const data = await fetchJson<T>(path, { signal: controller.signal });
      if (sequence.current === id && !controller.signal.aborted) setResult({ data, loading: false, error: null });
    } catch (error) {
      if (sequence.current === id && !controller.signal.aborted) setResult({ data: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, [path]);
  useEffect(() => {
    void refetch();
    const refresh = () => { void refetch(); };
    const invalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ paths: readonly string[] }>).detail;
      if (detail?.paths.includes(buildApiUrl(path)!)) refresh();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refresh);
      window.addEventListener("inkos:api-invalidate", invalidate);
    }
    return () => {
      ++sequence.current; request.current?.abort(); request.current = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", refresh);
        window.removeEventListener("inkos:api-invalidate", invalidate);
      }
    };
  }, [path, refetch]);
  return result;
}

function SavedHarnessDefaults({ saved, isZh, onSettings }: Props & { readonly saved: AgentSettings }) {
  const harness = saved.selectedHarnessId;
  const observation = useDefaultsRead<{ state: HarnessState }>(`/agent-configuration/harnesses/${harness}/state`);
  const state = observation.data?.state ?? null;
  const preferences = saved.harnessPreferences[harness];
  const view = adaptAgentConfiguration({ target: { harness, contextKey: state?.scope?.authContextRef ?? "unobserved" },
    ownerGeneration: state?.scope?.ownerGeneration ?? null, state, draft: preferences, saved: preferences, savePhase: "saved" });
  const status = observation.loading ? text(isZh, "正在核对状态…", "Checking status…")
    : observation.error ? text(isZh, "状态读取失败", "Status read failed")
    : harness === "pi" ? text(isZh, "在线账号与执行尚未验证", "Online account and execution unverified")
    : view.connection.phase === "signed-out" ? text(isZh, "尚未登录 ChatGPT", "Not signed in to ChatGPT")
    : text(isZh, "执行尚未验证", "Execution unverified");
  const label = [harnessLabel(harness), preferences.model ?? text(isZh, "原生默认模型", "Native default model"), preferences.effort, preferences.speed, status].filter(Boolean).join(" · ");
  return <DefaultsButton isZh={isZh} onSettings={onSettings} label={label} />;
}

function DefaultsButton({ isZh, onSettings, label }: Props & { readonly label: string }) {
  return <button type="button" data-testid="agent-defaults-status" onClick={onSettings}
    className="px-2 py-1.5 text-sm text-muted-foreground hover:text-primary truncate focus-visible:outline-2 focus-visible:outline-primary"
    title={text(isZh, "下次运行默认配置；当前运行保持启动时的配置。", "Next run defaults; the current run keeps its configuration from startup.")}>
    <span role="status" aria-live="polite" aria-atomic="true">{text(isZh, "下次运行默认配置", "Next run defaults")} · {label}</span>
  </button>;
}

export function AgentDefaultsStatus({ isZh, onSettings }: Props) {
  const settings = useDefaultsRead<{ settings: AgentSettings }>("/agent-configuration/settings");
  if (settings.loading || settings.error || !settings.data) return <DefaultsButton isZh={isZh} onSettings={onSettings}
    label={settings.loading ? text(isZh, "正在读取已保存配置…", "Loading saved settings…") : text(isZh, "配置读取失败，请核对设置", "Settings read failed; check settings")} />;
  const saved = settings.data.settings;
  return <SavedHarnessDefaults key={`${saved.selectedHarnessId}:${saved.revision}`} saved={saved} isZh={isZh} onSettings={onSettings} />;
}
