import type { PlatformRankings, RadarSource, RankingEntry } from "./radar-source.js";

export const MEGANOVEL_RANKINGS_URL = "https://www.meganovel.com/rankings";

export interface MegaNovelRankingSnapshot {
  readonly html: string;
  readonly sourceUrl: string;
  /** Time the HTML was actually acquired, not the time it was imported. */
  readonly fetchedAt: string;
}

function rankingsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.meganovel.com"
    || url.username || url.password || url.port || url.hash
    || !/^\/rankings(?:\/[A-Za-z0-9-]+)?\/?$/u.test(url.pathname)) {
    throw new Error("MegaNovel radar requires an official HTTPS rankings URL.");
  }
  return url;
}

/** Read only the JSON object; never evaluate the site's surrounding JavaScript. */
function initialState(html: string): Record<string, unknown> {
  const match = /<script\b[^>]*>\s*window\.__INITIAL_STATE__\s*=\s*/iu.exec(html);
  if (!match) throw new Error("MegaNovel ranking snapshot has no supported ranking data.");
  const start = match.index + match[0].length;
  if (html[start] !== "{") throw new Error("MegaNovel ranking state is not a JSON object.");
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(html.slice(start, index + 1));
  }
  throw new Error("MegaNovel ranking state is incomplete.");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function rankingEntry(value: unknown, rank: number): RankingEntry | null {
  const item = record(value);
  if (item.language !== "ENGLISH" || typeof item.bookName !== "string" || !item.bookName.trim()
    || typeof item.bookResourceUrl !== "string" || !/^[A-Za-z0-9_-]+$/u.test(item.bookResourceUrl)) return null;
  return {
    title: item.bookName.trim(),
    author: typeof item.pseudonym === "string" ? item.pseudonym.trim() : "",
    category: strings(item.genreNames).join(", "),
    extra: `[MegaNovel ranking #${rank}] ${strings(item.newTagsNames).join(", ")}`,
    rank,
    url: new URL(`/story/${item.bookResourceUrl}`, MEGANOVEL_RANKINGS_URL).href,
  };
}

export function parseMegaNovelRankingSnapshot(snapshot: MegaNovelRankingSnapshot): PlatformRankings {
  const url = rankingsUrl(snapshot.sourceUrl);
  if (!Number.isFinite(Date.parse(snapshot.fetchedAt))) throw new Error("MegaNovel snapshot requires its acquisition time.");
  if (Buffer.byteLength(snapshot.html, "utf8") > 2 * 1024 * 1024) throw new Error("MegaNovel ranking snapshot exceeds 2 MiB.");
  const state = initialState(snapshot.html);
  const route = record(state.route);
  const path = url.pathname.replace(/\/$/u, "");
  if (route.path !== path) throw new Error("MegaNovel ranking snapshot does not match its source URL.");
  const list = record(record(state.BookStoreModule).bookList)[path];
  if (!Array.isArray(list)) throw new Error("MegaNovel ranking snapshot contains no ranked book list.");
  const page = Number(url.searchParams.get("pageIndex") ?? "1");
  if (!Number.isInteger(page) || page < 1) throw new Error("MegaNovel ranking page is invalid.");
  if (Number(record(route.query).pageIndex ?? 1) !== page) throw new Error("MegaNovel ranking snapshot page does not match its source URL.");
  // The verified page lists ten books per page. Unknown pagination is not inferred.
  const entries = list.slice(0, 10).flatMap((item, index) => {
    const entry = rankingEntry(item, (page - 1) * 10 + index + 1);
    return entry ? [entry] : [];
  });
  return { platform: "meganovel", language: "en", sourceUrl: url.href, fetchedAt: snapshot.fetchedAt, acquisition: "snapshot", entries };
}

/** For an uploaded snapshot or a snapshot acquired by an authorized integration. */
export class MegaNovelSnapshotRadarSource implements RadarSource {
  readonly name = "meganovel";
  private readonly rankings: PlatformRankings;
  constructor(snapshot: MegaNovelRankingSnapshot) { this.rankings = parseMegaNovelRankingSnapshot(snapshot); }
  async fetch(signal?: AbortSignal): Promise<PlatformRankings> {
    signal?.throwIfAborted();
    return structuredClone(this.rankings);
  }
}

/**
 * Opt-in live source for callers whose platform authorization covers automated
 * ranking access. Not included in default sources: MegaNovel terms section 6.2
 * restrict automated access to authorized means. This is not a publishing API.
 */
export class MegaNovelRadarSource implements RadarSource {
  readonly name = "meganovel";
  constructor(private readonly sourceUrl = MEGANOVEL_RANKINGS_URL) { rankingsUrl(sourceUrl); }
  async fetch(signal?: AbortSignal): Promise<PlatformRankings> {
    const response = await globalThis.fetch(this.sourceUrl, {
      signal, headers: { Accept: "text/html", "Accept-Language": "en", "User-Agent": "InkOS market research" },
    });
    if (!response.ok) throw new Error(`MegaNovel ranking request failed (${response.status}).`);
    const html = await response.text();
    return {
      ...parseMegaNovelRankingSnapshot({ html, sourceUrl: response.url || this.sourceUrl, fetchedAt: new Date().toISOString() }),
      acquisition: "live",
    };
  }
}
