import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadWorkManifest } from '../harness/work-store.js';
import { safeChildPath } from '../utils/path-safety.js';
import { creationError, type CreationTask } from './contracts.js';

/** Read-only adoption of the interrupted task's own committed foundation.
 * Presence alone is insufficient: every required file must match a registered snapshot. */
export async function verifyCreationFoundation(root: string, task: CreationTask): Promise<void> {
  const work = await loadWorkManifest(root, task.workId), directory = join(root, 'works', task.workId);
  const required = ['source/book.json', 'source/chapters/index.json', 'source/story/brief.md',
    'source/story/outline/story_frame.md', 'source/story/outline/volume_map.md', 'source/story/book_rules.md',
    'source/story/current_state.md', 'source/story/pending_hooks.md', 'source/story/book_rules.json',
    'source/story/state/manifest.json', 'source/story/state/current_state.json', 'source/story/state/hooks.json', 'source/story/state/chapter_summaries.json'];
  // Other registered foundation/authority files are also protected, including roles and reader contracts.
  for (const artifact of work.artifacts) {
    const revision = artifact.revisions.find(item => item.id === artifact.currentRevisionId);
    if (revision?.path.startsWith('source/story/') && !required.includes(revision.path)) required.push(revision.path);
  }
  for (const path of required) {
    const matches = work.artifacts.flatMap(artifact => artifact.revisions.filter(revision =>
      revision.id === artifact.currentRevisionId && revision.path === path && revision.status === 'current'));
    const revision = matches[0];
    if (matches.length !== 1 || !revision?.snapshotPath) throw creationError('CREATION_FOUNDATION_RECONCILIATION_REQUIRED', `Foundation file lacks a unique committed revision: ${path}`);
    const bytes = await readFile(safeChildPath(directory, path));
    if (!bytes.equals(await readFile(safeChildPath(directory, revision.snapshotPath)))) {
      throw creationError('CREATION_FOUNDATION_RECONCILIATION_REQUIRED', `Retained foundation changed after commit: ${path}`);
    }
  }
  const brief = await readFile(join(directory, 'source/story/brief.md'), 'utf8');
  if (!brief.includes(task.request.brief)) throw creationError('CREATION_FOUNDATION_RECONCILIATION_REQUIRED', 'Retained foundation does not identify this task’s original brief.');
  const index = JSON.parse(await readFile(join(directory, 'source/chapters/index.json'), 'utf8'));
  if (!Array.isArray(index) || index.length) throw creationError('CREATION_FOUNDATION_RECONCILIATION_REQUIRED', 'Chapter progress exists before foundation acceptance. Reconcile it without rewriting.');
}
