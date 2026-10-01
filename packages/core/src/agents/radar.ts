import { BaseAgent } from "./base.js";
import type { Platform, Genre } from "../models/book.js";
import type { RadarSource, PlatformRankings } from "./radar-source.js";
import { FanqieRadarSource, QidianRadarSource } from "./radar-source.js";
import { RadarResultToolSchema } from "./radar-tool.js";

export interface RadarScanOptions {
  readonly onProgress?: (phase: "fetching" | "analyzing") => void;
  readonly sourceTimeoutMs?: number;
}

export interface RadarResult {
  readonly recommendations: ReadonlyArray<RadarRecommendation>;
  readonly marketSummary: string;
  readonly timestamp: string;
}

export interface RadarRecommendation {
  readonly platform: Platform;
  readonly genre: Genre;
  readonly concept: string;
  readonly reasoning: string;
  readonly benchmarkTitles: ReadonlyArray<string>;
}

const DEFAULT_SOURCES: ReadonlyArray<RadarSource> = [
  new FanqieRadarSource(),
  new QidianRadarSource(),
];

function formatRankingsForPrompt(rankings: ReadonlyArray<PlatformRankings>): string {
  const sections = rankings
    .filter((r) => r.entries.length > 0)
    .map((r) => {
      const lines = r.entries.map(
        (e) => `- ${e.title}${e.author ? ` (${e.author})` : ""}${e.category ? ` [${e.category}]` : ""} ${e.extra}`,
      );
      return `### ${r.platform}\n${lines.join("\n")}`;
    });

  return sections.join("\n\n");
}

export class RadarAgent extends BaseAgent {
  private readonly sources: ReadonlyArray<RadarSource>;

  constructor(
    ctx: ConstructorParameters<typeof BaseAgent>[0],
    sources?: ReadonlyArray<RadarSource>,
  ) {
    super(ctx);
    this.sources = sources ?? DEFAULT_SOURCES;
  }

  get name(): string {
    return "radar";
  }

  async scan(options: RadarScanOptions = {}): Promise<RadarResult> {
    this.ctx.signal?.throwIfAborted();
    options.onProgress?.("fetching");
    const rankings = await Promise.all(this.sources.map(source => fetchSource(source, this.ctx.signal, options.sourceTimeoutMs)));
    this.ctx.signal?.throwIfAborted();
    const rankingsText = formatRankingsForPrompt(rankings);
    if (!rankingsText) {
      throw new Error("Market radar has no source evidence to analyze.");
    }

    const systemPrompt = `按已激活的长篇市场研究 Skill 分析以下实时排行榜。每条判断必须引用输入中的具体证据。

## 实时排行榜数据

${rankingsText}

通过结果工具提交建议和整体市场概述。`;

    options.onProgress?.("analyzing");
    const { result } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `请基于上面的实时排行榜数据，分析当前网文市场热度，给出开书建议。`,
        },
      ],
      {
        name: "submit_market_radar",
        label: "Submit market radar",
        description: "Submit evidence-grounded market recommendations in ranked order.",
        parameters: RadarResultToolSchema,
      },
      { temperature: 0.6 },
    );

    return {
      recommendations: result.recommendations,
      marketSummary: result.marketSummary,
      timestamp: new Date().toISOString(),
    };
  }
}

/** Bound even custom read-only sources that do not implement AbortSignal yet. */
async function fetchSource(source: RadarSource, parent?: AbortSignal, timeoutMs = 15_000): Promise<PlatformRankings> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Radar source timed out")), timeoutMs);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let onAbort: () => void = () => {};
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([source.fetch(signal), aborted]);
  } catch {
    parent?.throwIfAborted();
    // An unavailable source contributes no evidence. Other available sources
    // remain usable; if all are empty scan() fails before invoking the model.
    return { platform: source.name, entries: [] };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
