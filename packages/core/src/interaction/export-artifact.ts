import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EPub } from "epub-gen-memory";
import {renderChapterDocument} from '../utils/chapter-document.js';
import {readChapterHeading} from '../utils/chapter-splitter.js';

export interface ExportStateLike {
  /** Live StateManager callers share the existing writer lock; frozen package readers need none. */
  readonly acquireBookLock?: (bookId: string) => Promise<() => Promise<void>>;
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{ readonly title: string; readonly language?: string }>;
  readonly loadChapterIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly number: number;
    readonly title?: string;
    readonly wordCount: number;
  }>>;
}

export interface ExportArtifact {
  readonly outputPath: string;
  readonly fileName: string;
  readonly chaptersExported: number;
  readonly totalWords: number;
  readonly format: "txt" | "md" | "epub";
  readonly contentType: string;
  readonly payload: string | Buffer;
}

export class ChapterExportSourceError extends Error {
  readonly code = "CHAPTER_EXPORT_SOURCE_MISMATCH";
  constructor(readonly details: {
    readonly missingChapterNumbers: number[];
    readonly duplicateChapterNumbers: number[];
    readonly duplicateIndexNumbers: number[];
    readonly unindexedFiles: string[];
  }) {
    super(`Chapter index and source files differ: ${JSON.stringify(details)}. Inspect these files and reconcile the chapter index through chapter import before exporting.`);
    this.name = "ChapterExportSourceError";
  }
}

export function buildChapterFileLookup(files: ReadonlyArray<string>, chapters: ReadonlyArray<{ readonly number: number }>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  const indexed = new Set<number>();
  const duplicateIndexNumbers = new Set<number>();
  for (const chapter of chapters) {
    if (indexed.has(chapter.number)) duplicateIndexNumbers.add(chapter.number);
    indexed.add(chapter.number);
  }
  const duplicateChapterNumbers = new Set<number>();
  const unindexedFiles: string[] = [];
  for (const file of [...files].sort()) {
    if (!file.endsWith(".md")) continue;
    const match = /^(\d+)_.*\.md$/u.exec(file);
    const chapterNumber = match ? Number(match[1]) : undefined;
    if (chapterNumber === undefined || !indexed.has(chapterNumber)) {
      unindexedFiles.push(file);
      continue;
    }
    if (lookup.has(chapterNumber)) duplicateChapterNumbers.add(chapterNumber);
    lookup.set(chapterNumber, file);
  }
  const details = {
    missingChapterNumbers: [...indexed].filter(number => !lookup.has(number)).sort((a,b) => a-b),
    duplicateChapterNumbers: [...duplicateChapterNumbers].sort((a,b) => a-b),
    duplicateIndexNumbers: [...duplicateIndexNumbers].sort((a,b) => a-b),
    unindexedFiles,
  };
  if (Object.values(details).some(items => items.length > 0)) throw new ChapterExportSourceError(details);
  return lookup;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownToSimpleHtml(markdown: string): { title: string; html: string } {
  const title = markdown.match(/^#\s+(.+)/m)?.[1]?.trim() ?? "Untitled Chapter";
  const html = markdown
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("\n");
  return { title, html };
}

/** Freeze live prose only for the short filesystem read, before any export formatting or write. */
async function readExportSnapshot(state: ExportStateLike, bookId: string) {
  const bookDir = state.bookDir(bookId);
  // A read of an unknown Work must not create the directory as a side effect of locking.
  if (state.acquireBookLock) await access(bookDir);
  const release = await state.acquireBookLock?.(bookId);
  try {
    const chapters = await state.loadChapterIndex(bookId);
    const book = await state.loadBookConfig(bookId);
    if (chapters.length === 0) throw new Error("No chapters to export.");
    const chaptersDir = join(bookDir, "chapters");
    const chapterFiles = buildChapterFileLookup(await readdir(chaptersDir), chapters);
    const sources: Array<{chapter: typeof chapters[number]; file: string; raw: string}> = [];
    for (const chapter of chapters) {
      const file = chapterFiles.get(chapter.number)!;
      const raw = await readFile(join(chaptersDir, file), 'utf-8');
      sources.push({chapter, file, raw});
    }
    return { book, chapters, bookDir, sources };
  } finally { await release?.(); }
}

export async function buildExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub";
    readonly outputPath?: string;
  },
): Promise<ExportArtifact> {
  const format = options.format ?? "txt";
  const { book, chapters, bookDir, sources } = await readExportSnapshot(state, bookId);
  const documents = sources.map(({chapter, file, raw}) => {
    const heading = readChapterHeading(raw.trimStart().split(/\r?\n/u)[0] ?? '');
    return renderChapterDocument(chapter.number,
      chapter.title ?? heading?.title ?? file.replace(/^\d+_/u, '').replace(/\.md$/u, ''), raw,
      book.language === 'en' || book.language === undefined && heading?.language === 'en' ? 'en' : 'zh');
  });
  const outputPath = options.outputPath ?? join(bookDir, "exports", `${bookId}.${format}`);
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

  if (format === "epub") {
    const epubChapters: Array<{ title: string; content: string }> = [];
    for (const markdown of documents) {
      const { title, html } = markdownToSimpleHtml(markdown);
      epubChapters.push({ title, content: html });
    }
    const epubInstance = new EPub(
      { title: book.title, lang: book.language === "en" ? "en" : "zh-CN" },
      epubChapters,
    );
    return {
      outputPath,
      fileName: `${bookId}.epub`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: "application/epub+zip",
      payload: await epubInstance.genEpub(),
    };
  }

  const parts: string[] = [];
  parts.push(format === "md" ? `# ${book.title}` : book.title);
  parts.push(...documents);

  return {
    outputPath,
    fileName: `${bookId}.${format}`,
    chaptersExported: chapters.length,
    totalWords,
    format,
    contentType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    payload: parts.join("\n\n"),
  };
}

export async function writeExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub";
    readonly outputPath?: string;
  },
): Promise<Omit<ExportArtifact, "payload" | "contentType" | "fileName">> {
  const artifact = await buildExportArtifact(state, bookId, options);
  await mkdir(dirname(artifact.outputPath), { recursive: true });
  await writeFile(artifact.outputPath, artifact.payload);
  return {
    outputPath: artifact.outputPath,
    chaptersExported: artifact.chaptersExported,
    totalWords: artifact.totalWords,
    format: artifact.format,
  };
}
