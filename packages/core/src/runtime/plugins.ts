import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Extension, Registry, JsonObject } from '@earendil-works/pi-durable';
import type { RankingSource } from '../extensions/research/ranking.js';

export type ContentProfile = {
  id: string; label: string; format: string; countingUnit: 'word' | 'grapheme';
  instructions: string; domainKind: string; parseDomain?: (text: string) => JsonObject;
};
export type PublisherDescription = { id: string; label: string; capabilities: string[] };
export type InkExtension = Extension & { profiles?: ContentProfile[]; publishers?: PublisherDescription[]; rankingSources?: RankingSource[] };
export type PluginContext = { rootDir: string };
export async function loadPlugins(registry: Registry, modules: string[], context: PluginContext): Promise<void> {
  const require = createRequire(resolve(context.rootDir, 'package.json'));
  for (const name of modules) {
    const path = isAbsolute(name) || name.startsWith('.') ? resolve(context.rootDir, name) : require.resolve(name);
    const module = await import(pathToFileURL(path).href);
    const exported = module.default ?? module.extension;
    const extension: InkExtension = typeof exported === 'function' ? await exported(context) : exported;
    if (!extension?.name) throw new Error(`Plugin ${name} must export an official Extension or factory`);
    registry.install(extension);
  }
}
export function describePlugins(registry: Registry) {
  return registry.snapshot().installed().map(extension => {
    const ink = extension as InkExtension;
    return { name: ink.name, tools: ink.tools?.map(tool => tool.name) ?? [], tasks: ink.tasks?.map(task => task.definition.name) ?? [],
      profiles: ink.profiles ?? [], publishers: ink.publishers ?? [], rankingSources: (ink.rankingSources ?? []).map(({ id, label, description }) => ({ id, label, description })) };
  });
}
export function findProfile(registry: { installed(): readonly Extension[] }, id: string): ContentProfile {
  const profile = registry.installed().flatMap(ext => (ext as InkExtension).profiles ?? []).find(item => item.id === id);
  if (!profile) throw new Error(`Content profile not installed: ${id}`);
  return profile;
}
export function measureLength(text: string, locale: string, unit: ContentProfile['countingUnit']): number {
  const segmenter = new Intl.Segmenter(locale, { granularity: unit === 'word' ? 'word' : 'grapheme' });
  return [...segmenter.segment(text)].filter(item => unit === 'word' ? item.isWordLike : !/^\s+$/u.test(item.segment)).length;
}
