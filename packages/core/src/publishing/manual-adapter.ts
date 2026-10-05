import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { buildExportArtifact } from '../interaction/export-artifact.js';
import { readArtifactRevision } from '../harness/artifact-reader.js';
import { loadWorkManifest } from '../harness/work-store.js';
import { HarnessIdSchema } from '../harness/contracts.js';
import { runInWorkMutationQueue } from '../utils/work-mutation-scope.js';
import {
  PublishingSelectionSchema, PublishingFormatsSchema, PublishingManifestSchema, publishingManifestValue, publishingError,
  type PublishingSelection, type PublishingManifest, type PublishingPackage, type PublishingTarget,
} from './contracts.js';
import { getPublishingCapability } from './platforms.js';
import { PublishingStore, type PublishingPreparation } from './store.js';

function selectionKey(input: Pick<PublishingManifest, 'target' | 'title' | 'language' | 'chapters' | 'formats'>): string {
  return JSON.stringify({target: input.target, title: input.title, language: input.language,
    chapters: input.chapters.map(({artifactId, revisionId, number, title, sourcePath, packagePath}) =>
      ({artifactId, revisionId, number, title, sourcePath, packagePath})), formats: input.formats});
}

/** A local, resumable handoff. This adapter never logs in, transmits a manuscript, or claims remote verification. */
export class ManualPublishingAdapter {
  constructor(private readonly projectRoot: string, private readonly store: PublishingStore) {}

  async mapBook(input: Parameters<PublishingStore['mapBook']>[0]): Promise<PublishingTarget> {
    await loadWorkManifest(this.projectRoot, input.workId);
    return this.store.mapBook(input);
  }

  async prepare(input: {
    targetId: string; chapters: PublishingSelection; formats?: Array<'txt' | 'md' | 'epub'>;
  }): Promise<PublishingPackage> {
    const target = this.store.getTarget(input.targetId);
    const selections = PublishingSelectionSchema.parse(input.chapters).sort((a, b) => a.number - b.number);
    const formats = [...new Set(PublishingFormatsSchema.parse(input.formats ?? ['txt', 'md', 'epub']))].sort();
    const sources = await Promise.all(selections.map(async selection => {
      const source = await readArtifactRevision({projectRoot: this.projectRoot, workId: target.workId, ...selection});
      if (!['text/markdown', 'text/plain'].some(type => source.revision.contentType.split(';')[0] === type)
        || !/\.(md|txt)$/u.test(source.revision.path)) {
        throw publishingError('PUBLISHING_SOURCE_UNSUPPORTED', 'Select exact text or Markdown manuscript chapter revisions.');
      }
      if (!source.bytes.toString('utf8').trim()) throw publishingError('PUBLISHING_EMPTY_CHAPTER', 'Cannot prepare an empty chapter.');
      return {...selection, ...source};
    }));
    const work = sources[0]!.work;
    const chapters: PublishingManifest['chapters'] = sources.map(source => ({
      artifactId: source.artifact.id, revisionId: source.revision.id, number: source.number, title: source.title,
      sourcePath: source.revision.path,
      packagePath: `chapters/${String(source.number).padStart(6, '0')}_chapter.md`,
    }));
    const operationKey = selectionKey({target, title: work.title, language: work.language, chapters, formats});
    // Existing records retain their package/revision IDs, including pre-migration records.
    const existing = this.store.findPackage(operationKey) ?? this.store.listPackages(target.id).find(pkg => selectionKey(pkg.manifest) === operationKey);
    if (existing) { await this.verify(existing.manifest.id); return existing; }
    const id = `manual-${randomUUID()}`;
    const root = await this.packagesDirectory();
    const directory = join(root, id);
    const pending = this.store.findPreparation(operationKey) ?? this.store.listPreparations().find(item => selectionKey(item.manifest) === operationKey);
    if (pending) return this.finishPreparation(pending, root);
    if (await this.readExistingManifest(directory)) {
      // A concurrent preparer can commit between the DB lookup and this filesystem observation.
      // Read pending first, then completed: finalization atomically moves authority between the two tables.
      const concurrentPending = this.store.findPreparation(operationKey);
      if (concurrentPending) return this.finishPreparation(concurrentPending, root);
      const concurrentPackage = this.store.findPackage(operationKey);
      if (concurrentPackage) { await this.verify(concurrentPackage.manifest.id); return concurrentPackage; }
      throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'Orphan package has no authoritative preparation record. Inspect its recorded source selection before using it.');
    }
    // A legacy/crashed package retains its own ID; do not silently create a
    // second submission bundle when only its SQLite record went missing.
    for (const name of await readdir(root)) {
      if (!name.startsWith('manual-') || name === id) continue;
      // Unrelated damaged packages do not prevent preparing another selection.
      const old = await this.readExistingManifest(join(root, name)).catch(() => undefined);
      if (!old || selectionKey(old) !== operationKey) continue;
      const reserved = this.store.findPreparation(old.operationKey);
      if (reserved) return this.finishPreparation(reserved, root);
      const registered = this.store.findPackage(old.operationKey);
      if (registered) { await this.verify(registered.manifest.id); return registered; }
      throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'An existing package has no recorded submission state. Inspect its receipt before preparing another copy.');
    }
    const staging = await mkdtemp(join(root, '.prepare-'));
    try {
      await mkdir(join(staging, 'chapters')); await mkdir(join(staging, 'exports'));
      const files: PublishingManifest['files'] = [];
      const save = async (path: string, content: string | Buffer) => {
        await writeFile(join(staging, path), content, {flag: 'wx', mode: 0o600});
        files.push({path, contentBase64: Buffer.from(content).toString('base64'), byteLength: Buffer.byteLength(content)});
      };
      for (const [i, chapter] of chapters.entries()) await save(chapter.packagePath, sources[i]!.bytes);
      const state = {
        bookDir: () => staging,
        loadBookConfig: async () => ({title: work.title, language: work.language}),
        loadChapterIndex: async () => sources.map(s => ({number: s.number, title: s.title, wordCount: s.bytes.toString('utf8').length})),
      };
      for (const format of formats) {
        const artifact = await buildExportArtifact(state, 'book', {format});
        await save(`exports/book.${format}`, artifact.payload);
      }
      await save('README.txt', this.instructions(target));
      const manifest = PublishingManifestSchema.parse({
        version: 1, adapter: 'manual', id, operationKey, createdAt: new Date().toISOString(), target,
        title: work.title, language: work.language, chapters, formats, files, remoteVerified: false,
      });
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
      // Retain actual file bytes in the SQLite record before promotion.
      const pending = this.store.reservePreparation(manifest, basename(staging));
      return await this.finishPreparation(pending, root);
    } finally {
      // Keep an authoritative pending directory after interruption; unreserved staging is disposable.
      if (this.store.findPreparation(operationKey)?.stagingDirectory !== basename(staging)) {
        await rm(staging, {recursive: true, force: true});
      }
    }
  }

  private async finishPreparation(preparation: PublishingPreparation, root: string): Promise<PublishingPackage> {
    // Separate adapters must not read a staging directory while another local
    // caller promotes it. Each queued caller still checks its own frozen record.
    return runInWorkMutationQueue(`publishing-promotion\0${join(root, preparation.manifest.id)}`,
      () => this.promotePreparation(preparation, root));
  }

  private async promotePreparation(preparation: PublishingPreparation, root: string): Promise<PublishingPackage> {
    const {manifest, stagingDirectory} = preparation;
    const directory = join(root, manifest.id);
    if (!await this.readExistingManifest(directory)) {
      if (!stagingDirectory || !/^\.prepare-[a-zA-Z0-9]+$/u.test(stagingDirectory)) {
        throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'Pending package has no valid staging directory.');
      }
      const staging = join(root, stagingDirectory);
      try {
        await this.verifyExpectedManifest(staging, manifest);
        await rename(staging, directory);
      } catch (error) {
        // A competing preparer may just have promoted the same reserved directory.
        // Accept only that complete, independently verified destination; otherwise preserve the original failure.
        if (!await this.readExistingManifest(directory)) throw error;
      }
    }
    await this.verifyExpectedManifest(directory, manifest);
    return this.store.registerPackage(manifest);
  }

  private async verifyExpectedManifest(directory: string, expected: PublishingManifest): Promise<void> {
    const manifest = await this.readExistingManifest(directory);
    if (!manifest || publishingManifestValue(manifest) !== publishingManifestValue(expected)) {
      throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'Package manifest differs from its authoritative SQLite record. Do not submit it.');
    }
    await this.verifyManifest(directory, expected);
  }

  async verify(packageId: string): Promise<{directory: string; package: PublishingPackage; legacyFilesWithoutSnapshot: string[]}> {
    const pkg = this.store.getPackage(packageId);
    const directory = join(await this.packagesDirectory(), HarnessIdSchema.parse(packageId));
    await this.verifyExpectedManifest(directory, pkg.manifest);
    return {directory, package: pkg, legacyFilesWithoutSnapshot: pkg.manifest.files.filter(file => file.contentBase64 === undefined && !pkg.manifest.chapters.some(chapter => chapter.packagePath === file.path)).map(file => file.path)};
  }
  async beginSubmission(input: Parameters<PublishingStore['beginSubmission']>[0]): Promise<PublishingPackage> {
    await this.verify(input.packageId);
    return this.store.beginSubmission(input);
  }
  recordReceipt(input: Parameters<PublishingStore['recordReceipt']>[0]): PublishingPackage {
    return this.store.recordReceipt(input);
  }
  private instructions(target: PublishingTarget): string {
    const capability = getPublishingCapability(target.platform);
    return [
      `Manual publication package for ${capability.name}`,
      `Work: ${target.workId}; local account label: ${target.accountLabel}; user-supplied platform book ID: ${target.remoteBookId}`,
      'No content has been uploaded or published. No login or agreement has been accepted.',
      'The chapter files preserve exact selected revisions. Exports reuse InkOS TXT/Markdown/EPUB rendering.',
      'Use only the formats currently supported by the author portal. EPUB is for review; platform import support is not assumed.',
      'Check current platform rules, AI disclosure, originality, rights/exclusivity and chapter requirements yourself.',
      'Before each manual submission, run publishing begin. Then upload/copy the selected chapter in the author portal yourself.',
      'Record the result with publishing receipt. Submitted is not published. All manual receipts remain user-reported, not remotely verified.',
      'If the result is unknown, inspect the author portal first. Do not resend. Record not_submitted_reported only after checking that no submission exists.',
      ...capability.guidance, ...capability.sources, '',
    ].join('\n');
  }
  private async packagesDirectory(): Promise<string> {
    let directory = await realpath(this.projectRoot);
    for (const part of ['.inkos', 'publishing']) {
      directory = join(directory, part);
      await mkdir(directory, {recursive: true, mode: 0o700});
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw publishingError('PUBLISHING_UNSAFE_PATH', 'Publishing storage must be a real directory inside the project.');
    }
    return directory;
  }
  private async readExistingManifest(directory: string): Promise<PublishingManifest | undefined> {
    let directoryInfo;
    try { directoryInfo = await lstat(directory); }
    catch (error) {
      // Observe a missing directory once. A concurrent promotion after this point is handled by reservation reconciliation.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!directoryInfo.isDirectory()) throw publishingError('PUBLISHING_UNSAFE_PATH', 'Package path is not a real directory.');
    try {
      const info = await lstat(join(directory, 'manifest.json'));
      if (!info.isFile()) throw publishingError('PUBLISHING_UNSAFE_PATH', 'Package manifest must be a regular file.');
      return PublishingManifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'Existing package has no manifest. Inspect it instead of regenerating it.');
      }
      throw error;
    }
  }
  private async verifyManifest(directory: string, manifest: PublishingManifest): Promise<void> {
    const expectedFiles = [...manifest.chapters.map(c => c.packagePath), ...manifest.formats.map(f => `exports/book.${f}`), 'README.txt'].sort();
    if (JSON.stringify(manifest.files.map(f => f.path).sort()) !== JSON.stringify(expectedFiles)) {
      throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'Package inventory is incomplete or duplicated.');
    }
    for (const file of manifest.files) {
      // All allowed paths are schema-constrained; reject symlink parents and files as well.
      for (const parent of file.path.split('/').slice(0, -1)) {
        if (!(await lstat(join(directory, parent))).isDirectory()) throw publishingError('PUBLISHING_UNSAFE_PATH', 'Package file parent is not a real directory.');
      }
      if (!(await lstat(join(directory, file.path))).isFile()) throw publishingError('PUBLISHING_UNSAFE_PATH', 'Package content must be a regular file.');
      const bytes = await readFile(join(directory, file.path));
      if (file.contentBase64 !== undefined && !bytes.equals(Buffer.from(file.contentBase64, 'base64'))) {
        throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', `Frozen package file changed: ${file.path}`);
      }
    }
    for (const chapter of manifest.chapters) {
      const file = manifest.files.find(file => file.path === chapter.packagePath)!;
      if (file.contentBase64 !== undefined) continue;
      // Old packages have no stored file bodies. Bind their manuscript to the
      // retained selected revision without recalculating their legacy metadata.
      const source = await readArtifactRevision({projectRoot: this.projectRoot, workId: manifest.target.workId,
        artifactId: chapter.artifactId, revisionId: chapter.revisionId});
      if (!source.bytes.equals(await readFile(join(directory, chapter.packagePath)))) {
        throw publishingError('PUBLISHING_PACKAGE_INTEGRITY', 'Frozen chapter differs from the selected retained revision.');
      }
    }
  }
}
