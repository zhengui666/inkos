import { useEffect, useRef, useState } from "react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { fetchJson } from "../hooks/use-api";
import { TrendingUp, Loader2, Target, Clock } from "lucide-react";

interface Recommendation {
  readonly platform: string;
  readonly genre: string;
  readonly concept: string;
  readonly reasoning: string;
  readonly benchmarkTitles: ReadonlyArray<string>;
}

interface RadarResult {
  readonly marketSummary: string;
  readonly recommendations: ReadonlyArray<Recommendation>;
}

interface RadarHistoryItem {
  readonly file: string;
  readonly timestamp: string;
  readonly summaryPreview: string;
  readonly result: RadarResult;
}

interface Nav { toDashboard: () => void }

export function RadarView({ nav, theme, t }: { nav: Nav; theme: Theme; t: TFunction }) {
  const c = useColors(theme);
  const [result, setResult] = useState<RadarResult | null>(null);
  const [history, setHistory] = useState<ReadonlyArray<RadarHistoryItem>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState("fetching");
  const [elapsed, setElapsed] = useState(0);
  const posting = useRef(false);
  const following = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const restored = useRef(false);
  const reconciling = useRef(false);
  const reconcileStatus = useRef<() => Promise<void>>(async () => {});

  const loadHistory = async () => {
    const version = generation.current;
    try {
      const data = await fetchJson<{ items: ReadonlyArray<RadarHistoryItem> }>("/radar/history");
      if (mounted.current && generation.current === version) setHistory(data.items ?? []);
    } catch {
      if (mounted.current && generation.current === version) setHistory([]);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void loadHistory();
    let stopped = false;
    let inFlight = false;
    const checkStatus = async () => {
      if (inFlight || stopped || (restored.current && !posting.current && !following.current)) return;
      inFlight = true;
      const version = generation.current;
      try {
        const status = await fetchJson<{ running: boolean; phase: string; startedAt?: number; result?: RadarResult; error?: string }>("/radar/status", { cache: "no-store" });
        if (stopped || !mounted.current || generation.current !== version) return;
        reconciling.current = false;
        if (status.running) {
          setError("");
          following.current = true;
          setLoading(true);
          setPhase(status.phase);
          setElapsed(Math.max(0, Math.floor((Date.now() - (status.startedAt ?? Date.now())) / 1000)));
        } else if ((following.current || !restored.current) && !posting.current) {
          following.current = false;
          setLoading(false);
          if (status.result) { setResult(status.result); setError(""); void loadHistory(); }
          else if (status.error) { setResult(null); setError(status.error); }
        }
        restored.current = true;
      } catch {
        // If both the POST and status transport failed, retain its error and
        // allow manual retry. A previously observed running scan stays active.
        if (!stopped && generation.current === version && !posting.current && !following.current) {
          reconciling.current = false;
          setLoading(false);
        }
      } finally {
        inFlight = false;
        if (!stopped && generation.current !== version && reconciling.current) void checkStatus();
      }
    };
    reconcileStatus.current = checkStatus;
    void checkStatus();
    const timer = setInterval(() => { void checkStatus(); }, 1500);
    return () => { stopped = true; mounted.current = false; clearInterval(timer); };
  }, []);

  const handleScan = async () => {
    if (posting.current || following.current || reconciling.current) return;
    posting.current = true;
    restored.current = true;
    generation.current += 1;
    setPhase("fetching");
    setElapsed(0);
    setLoading(true);
    setError("");
    setResult(null);
    let failed = false;
    try {
      const data = await fetchJson<RadarResult>("/radar/scan", { method: "POST" });
      if (mounted.current) setResult(data);
      await loadHistory();
    } catch (e) {
      failed = true;
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Invalidate status requests started before this authoritative POST ended.
      generation.current += 1;
      posting.current = false;
      following.current = false;
      if (mounted.current) {
        restored.current = !failed;
        reconciling.current = failed;
        setLoading(failed);
        if (failed) void reconcileStatus.current();
      }
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
        <span className="text-border">/</span>
        <span>{t("nav.radar")}</span>
      </div>

      <div className="flex items-center justify-between">
        <h1 className="font-serif text-3xl flex items-center gap-3">
          <TrendingUp size={28} className="text-primary" />
          {t("radar.title")}
        </h1>
        <button
          onClick={handleScan}
          disabled={loading}
          className={`px-5 py-2.5 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30 flex items-center gap-2`}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Target size={14} />}
          {loading ? t("radar.scanning") : t("radar.scan")}
        </button>
      </div>

      {loading && (
        <div role="status" className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          {t(phase === "analyzing" ? "radar.analyzing" : phase === "saving" ? "radar.saving" : "radar.fetching")} · {elapsed}s
          <p className="mt-1 text-xs">{t("radar.deadline")}</p>
        </div>
      )}

      {error && (
        <div role="alert" className="bg-destructive/10 text-destructive px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {result && (
        <div className="space-y-6">
          <div className={`border ${c.cardStatic} rounded-lg p-5`}>
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">{t("radar.summary")}</h3>
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{result.marketSummary}</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {result.recommendations.map((rec, i) => (
              <div key={i} className={`border ${c.cardStatic} rounded-lg p-5 space-y-3`}>
                <div className="flex items-center">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                    {rec.platform} · {rec.genre}
                  </span>
                </div>
                <p className="text-sm font-semibold">{rec.concept}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{rec.reasoning}</p>
                {rec.benchmarkTitles.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {rec.benchmarkTitles.map((bt) => (
                      <span key={bt} className="px-2 py-0.5 text-[10px] bg-secondary rounded">{bt}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className={`border ${c.cardStatic} rounded-lg p-5 space-y-3`}>
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
            <Clock size={14} />
            {t("radar.history")}
          </h3>
          <div className="space-y-2">
            {history.slice(0, 10).map((item) => (
              <button
                key={item.file}
                onClick={() => setResult(item.result)}
                className="w-full rounded-md border border-border/40 px-3 py-2 text-left text-xs hover:bg-muted/30"
              >
                <div className="font-medium text-foreground">{new Date(item.timestamp).toLocaleString()}</div>
                <div className="mt-1 line-clamp-2 text-muted-foreground">{item.summaryPreview || item.file}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {!result && !loading && !error && (
        <div className={`border border-dashed ${c.cardStatic} rounded-lg p-12 text-center text-muted-foreground text-sm italic`}>
          {t("radar.emptyHint")}
        </div>
      )}
    </div>
  );
}
