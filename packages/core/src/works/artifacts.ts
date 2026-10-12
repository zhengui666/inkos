import { mkdir, readFile, access } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import type { ArtifactRevision } from './documents.js';

export function assertId(id: string): string {
  if (!id || id === '.' || id === '..' || /[\\/\u0000]/u.test(id)) throw new Error(`Invalid domain ID: ${id}`);
  return id;
}
export function artifactPath(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Artifact path escapes project');
  return absolute;
}
export async function readArtifact(root: string, revision: ArtifactRevision): Promise<string> {
  return readFile(artifactPath(root, revision.path), 'utf8');
}
export async function savedRevision(root: string, workId: string, artifactId: string, revisionId: string): Promise<ArtifactRevision | undefined> {
  const dir = join(root, '.inkos', 'artifacts', assertId(workId), assertId(artifactId), assertId(revisionId));
  try { return JSON.parse(await readFile(join(dir, 'revision.json'), 'utf8')) as ArtifactRevision; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** The stable ID, not a content digest, identifies an interrupted write's already completed artifact. */
export async function saveArtifact(root: string, input: Omit<ArtifactRevision, 'path' | 'createdAt'> & { content: string | Uint8Array; createdAt?: number }): Promise<ArtifactRevision> {
  const existing = await savedRevision(root, input.workId, input.artifactId, input.id);
  if (existing) { await access(artifactPath(root, existing.path)); return existing; }
  const dir = join('.inkos', 'artifacts', assertId(input.workId), assertId(input.artifactId), assertId(input.id));
  const file = input.format.startsWith('image/') ? 'image.bin' : input.format === 'json' ? 'content.json' : 'content.txt';
  const revision: ArtifactRevision = {
    id: input.id, workId: input.workId, artifactId: input.artifactId, title: input.title,
    format: input.format, metadata: input.metadata, createdAt: input.createdAt ?? Date.now(), path: join(dir, file).split(sep).join('/'),
  };
  await mkdir(join(root, dir), { recursive: true });
  await commitAtomicFileSet({ rootDir: join(root, dir), writes: [
    { relativePath: file, content: input.content },
    { relativePath: 'revision.json', content: JSON.stringify(revision, null, 2) },
  ] });
  return revision;
}
