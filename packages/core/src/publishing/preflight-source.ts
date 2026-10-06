import {readFile, readdir, realpath, stat} from 'node:fs/promises';
import {isAbsolute, join, relative} from 'node:path';
import {WorkResourceIdSchema} from '../harness/contracts.js';
import {readArtifactRevision} from '../harness/artifact-reader.js';
import {loadWorkManifest} from '../harness/work-store.js';
import {StateManager} from '../state/manager.js';
import {chapterDocumentBody} from '../utils/chapter-document.js';
import {publishingError} from './contracts.js';

async function contained(root: string, path: string) {
  const resolved = await realpath(path), child = relative(root, resolved);
  if (child === '..' || child.startsWith('../') || child.startsWith('..\\') || isAbsolute(child)) {
    throw publishingError('ARTIFACT_PATH_OUTSIDE_WORK', 'The source resolves outside its Work.');
  }
  return resolved;
}

/** Observe pending transactions without acquiring a lock, rolling back or removing anything. */
export async function assertPreflightProjectSettled(root: string): Promise<void> {
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (entry.name.startsWith('.inkos-file-txn-')) {
      throw publishingError('PUBLISHING_LOCAL_RECOVERY_REQUIRED', 'A local transaction requires separate recovery.');
    }
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      await assertPreflightProjectSettled(join(root, entry.name));
    }
  }
}

/** Read actual current retained bytes; never silently substitute an unregistered live edit. */
export async function readPreflightChapter(projectRoot: string, selectedWorkId: string, number: number) {
  const workId = WorkResourceIdSchema.parse(selectedWorkId), root = await realpath(projectRoot);
  const workRoot = await contained(root, join(root, 'works', workId));
  await contained(workRoot, join(workRoot, 'work.json'));
  await contained(workRoot, join(workRoot, 'source', 'chapters', 'index.json'));
  const work = await loadWorkManifest(root, workId);
  if (work.id !== workId) throw publishingError('PUBLISHING_WORK_IDENTITY_CONFLICT', 'The manifest identifies a different Work.');
  const chapters = (await new StateManager(root).loadChapterIndex(workId)).filter(chapter => chapter.number === number);
  const prefix = `source/chapters/${String(number).padStart(4, '0')}_`;
  const matches = work.artifacts.flatMap(artifact => artifact.revisions.filter(revision =>
    revision.id === artifact.currentRevisionId && revision.path.startsWith(prefix) && revision.path.endsWith('.md'))
    .map(revision => ({artifact, revision})));
  if (chapters.length !== 1 || matches.length !== 1) throw publishingError('PUBLISHING_CHAPTER_MISSING', 'Select one indexed current chapter.');
  const {artifact, revision} = matches[0]!, title = chapters[0]!.title;
  if (!revision.snapshotPath && revision.contentBase64 === undefined) {
    throw publishingError('ARTIFACT_SNAPSHOT_UNAVAILABLE', 'No independently retained revision bytes are available.');
  }
  if (!['text/markdown', 'text/plain'].includes(revision.contentType.split(';')[0]!)) {
    throw publishingError('PUBLISHING_SOURCE_UNSUPPORTED', 'Select a retained text chapter.');
  }
  const livePath = await contained(workRoot, join(workRoot, revision.path));
  if (revision.snapshotPath) {
    const snapshotPath = await contained(workRoot, join(workRoot, revision.snapshotPath));
    const [liveInfo, snapshotInfo] = await Promise.all([stat(livePath, {bigint: true}), stat(snapshotPath, {bigint: true})]);
    if (snapshotPath === livePath || liveInfo.dev === snapshotInfo.dev && liveInfo.ino === snapshotInfo.ino) {
      throw publishingError('ARTIFACT_SNAPSHOT_UNAVAILABLE', 'The retained snapshot must be independent from the live source.');
    }
  }
  const retained = await readArtifactRevision({projectRoot: root, workId, artifactId: artifact.id, revisionId: revision.id});
  const live = await readFile(livePath);
  if (!live.equals(retained.bytes)) throw publishingError('CHAPTER_REVISION_CHANGED', 'Unregistered edits remain.');
  const document = retained.bytes.toString('utf8');
  if (!Buffer.from(document).equals(retained.bytes)) throw publishingError('MEGANOVEL_ENCODING_UNSUPPORTED', 'Lossless UTF-8 is required.');
  if (work.language !== 'en' && work.language !== 'zh') throw publishingError('MEGANOVEL_LANGUAGE_UNSUPPORTED', 'Unsupported document language.');
  const content = chapterDocumentBody(document, number, title, work.language);
  if (!content.trim()) throw publishingError('PUBLISHING_EMPTY_CHAPTER', 'The retained body is empty.');
  return {workId, artifactId: artifact.id, revisionId: revision.id, number, title, content,
    bytes: retained.bytes, manifest: JSON.stringify(work), chapter: JSON.stringify(chapters[0])};
}

export function assertSamePreflightChapter(before: Awaited<ReturnType<typeof readPreflightChapter>>,
  after: Awaited<ReturnType<typeof readPreflightChapter>>) {
  if (before.manifest !== after.manifest || before.chapter !== after.chapter || !before.bytes.equals(after.bytes)) {
    throw publishingError('CHAPTER_REVISION_CHANGED', 'The Work changed during observation.');
  }
}
