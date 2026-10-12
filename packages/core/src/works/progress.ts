import type { Context } from '@earendil-works/chord';
import type { DocumentReader } from '@earendil-works/pi-durable';
import { Artifacts, type Work } from './documents.js';
import { Distributions, PublishingTargets } from '../publishing/documents.js';
import { distributionKey } from '../publishing/contracts.js';

export async function contentUnits(reader: DocumentReader, work: Work, context: Context): Promise<string[]> {
  const ids: string[] = [];
  for (const id of work.artifactIds) {
    const artifact = await reader.snapshot(Artifacts, id, context);
    const revision = artifact?.revisions.find(item => item.id === artifact.currentRevision);
    if (revision && (revision.metadata.role === 'content' || revision.metadata.kind === 'chapter' || /\/(?:chapters|translated|final)\//u.test(revision.path) && !revision.format.startsWith('image/'))) ids.push(id);
  }
  return ids;
}
export async function completedUnits(reader: DocumentReader, work: Work, context: Context): Promise<number> {
  return (await contentUnits(reader, work, context)).length;
}
/** A logical content unit leaves the buffer when all enabled targets have accepted a version, not when review ends. */
export async function bufferedUnits(reader: DocumentReader, work: Work, context: Context): Promise<number> {
  const targets = (await Promise.all(work.targetIds.map(id => reader.snapshot(PublishingTargets, id, context)))).filter(target => target?.enabled);
  let count = 0;
  for (const id of await contentUnits(reader, work, context)) {
    const records = await Promise.all(targets.map(target => reader.snapshot(Distributions, distributionKey(target!.id, id), context)));
    if (!targets.length || records.some(record => !record?.submittedRevisionId && !record?.publishedRevisionId)) count++;
  }
  return count;
}
/** Publishing limits apply only when a real enabled destination exists. Offline serials must keep writing. */
export async function publishingBufferFull(reader: DocumentReader, work: Work, context: Context): Promise<boolean> {
  const targets = await Promise.all(work.targetIds.map(id => reader.snapshot(PublishingTargets, id, context)));
  return targets.some(target => target?.enabled) && await bufferedUnits(reader, work, context) >= work.plan.production.backlog;
}
