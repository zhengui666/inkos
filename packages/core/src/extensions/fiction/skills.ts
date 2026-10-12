import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { assertId } from '../../works/artifacts.js';

const profileSkills: Record<string, string> = {
  fiction: 'inkos-long-writing', 'short-fiction': 'inkos-short-writing', script: 'inkos-script-writing', storyboard: 'inkos-storyboard',
  'interactive-film': 'inkos-interactive-film', play: 'inkos-play-world', translation: 'inkos-translation',
};
/** Skill text enriches an official extension/task; it does not run another Agent framework. */
export async function profileGuidance(rootDir: string, profile: string, requested: string[] = []): Promise<string> {
  const builtinDir = fileURLToPath(new URL('../../../skills/', import.meta.url));
  const ids = [...new Set([...(profileSkills[profile] ? [profileSkills[profile]!] : []), ...requested])];
  const guidance: string[] = [];
  for (const id of ids) {
    assertId(id);
    for (const dir of [join(rootDir, '.agents', 'skills'), join(rootDir, 'skills'), builtinDir]) {
      try { guidance.push((await readFile(join(dir, id, 'SKILL.md'), 'utf8')).replace(/^---[\s\S]*?---\s*/u, '')); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return guidance.join('\n\n');
}
