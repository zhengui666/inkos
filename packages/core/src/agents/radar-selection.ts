import type { RadarRecommendation, RadarResult } from "./radar.js";
import { canonicalRadarPlatform, isRadarSourceUrl, type RadarEvidence } from "./radar-evidence.js";

export interface RadarSelectionOptions {
  readonly platform: string;
  readonly language: "zh" | "en";
  readonly maxAgeMs: number;
  readonly now?: number;
}

export type RadarSelection = {
  readonly status: "selected";
  readonly index: number;
  readonly recommendation: RadarRecommendation & { readonly title: string; readonly language: "zh" | "en" };
  readonly evidence: ReadonlyArray<RadarEvidence>;
} | { readonly status: "blocked"; readonly reason: string };

function eligibleEvidence(item: RadarEvidence, options: RadarSelectionOptions, now: number): boolean {
  if (typeof item.platform !== "string" || typeof item.title !== "string" || typeof item.id !== "string"
    || typeof item.sourceUrl !== "string" || typeof item.fetchedAt !== "string") return false;
  const observed = Date.parse(item.fetchedAt);
  if (canonicalRadarPlatform(item.platform) !== canonicalRadarPlatform(options.platform)
    || item.language !== options.language || !item.title.trim() || !item.id.trim()
    || !isRadarSourceUrl(item.sourceUrl) || !Number.isFinite(observed)
    || observed > now || now - observed > options.maxAgeMs) return false;
  // A Chinese ranking or unrelated website cannot be relabelled as MegaNovel evidence.
  if (canonicalRadarPlatform(options.platform) === "meganovel") {
    const url = new URL(item.sourceUrl);
    if (url.protocol !== "https:" || url.hostname !== "www.meganovel.com" || url.port || url.hash
      || !/^\/rankings(?:\/[A-Za-z0-9-]+)?\/?$/u.test(url.pathname)) return false;
  }
  return true;
}

/** Select only source-linked recommendations; this function never creates a Work. */
export function selectRadarRecommendation(result: RadarResult, options: RadarSelectionOptions): RadarSelection {
  const now = options.now ?? Date.now();
  const scanned = Date.parse(result.timestamp);
  if (!Number.isFinite(now) || !Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0
    || !Number.isFinite(scanned) || scanned > now || now - scanned > options.maxAgeMs) {
    return { status: "blocked", reason: "The market scan is missing a valid recent observation time." };
  }
  const evidence = result.evidence ?? [];
  const byId = new Map(evidence.map(item => [item.id, item]));
  if (byId.size !== evidence.length) return { status: "blocked", reason: "Market evidence identifiers are ambiguous." };
  for (const [index, recommendation] of result.recommendations.entries()) {
    if (canonicalRadarPlatform(recommendation.platform) !== canonicalRadarPlatform(options.platform)
      || recommendation.language !== options.language || !recommendation.title?.trim()
      || !recommendation.concept.trim() || !recommendation.genre.trim()
      || !recommendation.evidenceIds?.length || !recommendation.benchmarkTitles.length) continue;
    const cited = recommendation.evidenceIds.map(id => byId.get(id));
    if (cited.some(item => !item || !eligibleEvidence(item, options, now))) continue;
    const supported = cited as RadarEvidence[];
    if (recommendation.benchmarkTitles.some(title => !supported.some(item => item.title === title))) continue;
    if (evidence.some(item => item.title.trim().toLowerCase() === recommendation.title!.trim().toLowerCase())) continue;
    return {
      status: "selected", index,
      recommendation: { ...recommendation, title: recommendation.title.trim(), language: options.language },
      evidence: supported,
    };
  }
  return { status: "blocked", reason: `No recent source-supported ${options.language} recommendation matches ${options.platform}.` };
}
