import type { Extension } from '@earendil-works/pi-durable';
import type { InkExtension } from '../../runtime/plugins.js';
import { fetchUrl } from '../../utils/web-search.js';

export type RankingSourceConfig = { id: string; source: string; url: string; label?: string };
export type RankingSnapshot = { id: string; source: string; url: string; label: string; fetchedAt: number; text: string };
export type RankingSource = {
  id: string; label: string; description: string;
  read(config: RankingSourceConfig, signal: AbortSignal): Promise<string>;
};
export const publicRankingSource: RankingSource = {
  id: 'public-page', label: 'Public ranking page',
  description: 'Read a public ranking URL as source evidence. For authenticated, dynamic or structured sources, install a ranking-source extension.',
  read: (config, signal) => fetchUrl(config.url, signal),
};
export function findRankingSource(registry: { installed(): readonly Extension[] }, id: string): RankingSource {
  const source = registry.installed().flatMap(extension => (extension as InkExtension).rankingSources ?? []).find(item => item.id === id);
  if (!source) throw new Error(`Ranking source extension is not installed: ${id}`);
  return source;
}
export async function readRanking(registry: { installed(): readonly Extension[] }, config: RankingSourceConfig, signal: AbortSignal): Promise<RankingSnapshot> {
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ranking source needs an HTTP(S) URL');
  const text = (await findRankingSource(registry, config.source).read(config, signal)).trim();
  if (text.length < 80 || /^(?:Just a moment|Access denied)|Enable JavaScript and cookies to continue/i.test(text)) throw new Error(`Ranking source is empty or unreadable: ${config.url}`);
  return { id: config.id, source: config.source, url: config.url, label: config.label || config.url, fetchedAt: Date.now(), text: text.slice(0, 32000) };
}
