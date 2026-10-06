import type { PlatformRankings, RankingEntry } from "./radar-source.js";

export interface RadarEvidence extends RankingEntry {
  readonly id: string;
  readonly platform: string;
  readonly language: "zh" | "en";
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly acquisition?: "live" | "snapshot";
}

export function canonicalRadarPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  if (["tomato", "fanqie", "番茄小说"].includes(normalized)) return "fanqie";
  if (normalized === "起点中文网") return "qidian";
  return normalized;
}

export function isRadarSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** A missing provenance field must not be filled using the current scan time. */
export function collectRadarEvidence(rankings: ReadonlyArray<PlatformRankings>): RadarEvidence[] {
  return rankings.flatMap((source, sourceIndex) => {
    if (!["en", "zh"].includes(source.language ?? "")) return [];
    return source.entries.flatMap((entry, entryIndex) => {
      const sourceUrl = entry.sourceUrl ?? source.sourceUrl;
      const fetchedAt = entry.fetchedAt ?? source.fetchedAt;
      if (!entry.title.trim() || !sourceUrl || !isRadarSourceUrl(sourceUrl)
        || !fetchedAt || !Number.isFinite(Date.parse(fetchedAt))) return [];
      return [{
        ...entry, id: `S${sourceIndex + 1}E${entryIndex + 1}`,
        platform: canonicalRadarPlatform(source.platform), language: source.language as "zh" | "en",
        sourceUrl, fetchedAt, ...(source.acquisition ? { acquisition: source.acquisition } : {}),
      }];
    });
  });
}
