import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync, backup } from "node:sqlite";
import { recordExecutionEvidence, updateExecutionWork } from "./execution-evidence.js";
import { basename, extname, join, relative } from "node:path";
import { toPosixPath } from "../utils/posix-path.js";
import { BOOK_LOCK_GUARD_FILE } from "../state/book-lock-guard.js";
import {
  ArtifactManifestSchema,
  ArtifactRevisionSchema,
  WorkManifestSchema,
  type ArtifactManifest,
  type WorkManifest,
} from "./contracts.js";
import { loadWorkManifest, workDirectory } from "./work-store.js";
import { createWorkManifest } from "./work-store.js";
import { createCurrentArtifact } from "./artifact-revisions.js";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";

const SOURCE_KIND_VERSION="storage-path-v1";

export function createInitialWorkManifestWrite(input: {
  readonly workId: string;
  readonly title: string;
  readonly profileId: string;
  readonly language: string;
  readonly writes: ReadonlyArray<AtomicFileWrite>;
  readonly createdAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly lineage?: WorkManifest["lineage"];
}): { readonly manifest: WorkManifest; readonly write: AtomicFileWrite } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const workRoot = join("works", input.workId);
  const work = createWorkManifest({
    id: input.workId,
    title: input.title,
    profileId: input.profileId,
    language: input.language,
    status: "active",
    now: createdAt,
    metadata: input.metadata,
    lineage: input.lineage,
  });
  const artifacts = input.writes.map((write) => {
    const workPath = toPosixPath(relative(workRoot, write.relativePath));
    if (workPath === ".." || workPath.startsWith("../")) {
      throw new Error(`Initial work artifact is outside ${workRoot}: ${write.relativePath}`);
    }
    return createCurrentArtifact({
      artifactId: artifactIdFor(workPath),
      artifactKind: artifactKindFor(workPath),
      path: workPath,
      content: write.content,
      contentType: contentTypeFor(workPath),
      createdAt,
      metadata: { sourcePath: toPosixPath(write.relativePath),kindSource:SOURCE_KIND_VERSION },
    });
  });
  const manifest = WorkManifestSchema.parse({ ...work, artifacts });
  return {
    manifest,
    write: {
      relativePath: join(workRoot, "work.json"),
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  };
}

export async function syncWorkSourceArtifacts(input: {
  readonly projectRoot: string;
  readonly workId: string;
  readonly accept: boolean;
  readonly acceptPaths?: ReadonlyArray<string>;
  readonly episodeId?: string;
  readonly updatedAt?: string;
  readonly writes?: ReadonlyArray<AtomicFileWrite>;
  readonly title?: string;
  readonly lineage?: WorkManifest["lineage"];
  readonly status?: WorkManifest["status"];
}): Promise<WorkManifest> {
  const manifest = await loadWorkManifest(input.projectRoot, input.workId);
  const root = workDirectory(input.projectRoot, input.workId);
  const sourceRoot = join(root, "source");
  const pending = new Map<string, AtomicFileWrite>();
  for (const write of input.writes ?? []) {
    const path = toPosixPath(relative(join("works", input.workId, "source"), write.relativePath));
    if (path.startsWith("../") || path === ".." || path.startsWith("/")) throw new Error("Artifact write must remain inside Work source");
    pending.set(path, write);
  }
  // An explicit write set owns its own revisions, not every candidate in the Work.
  const acceptPaths = (input.acceptPaths ?? (input.writes
    ? [...pending.keys()].map(path => toPosixPath(join("source", path)))
    : undefined))?.map(toPosixPath);
  const files = [...new Set([...(await listFiles(sourceRoot)), ...pending.keys()])].sort();
  const presentWorkPaths = new Set(files.map((file) => toPosixPath(join("source", file))));
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  const artifacts = [...manifest.artifacts];
  const snapshotWrites: AtomicFileWrite[] = [];

  for (const file of files) {
    const workPath = toPosixPath(join("source", file));
    const accept = input.accept && (!acceptPaths || acceptPaths.includes(workPath));
    const update = pending.get(toPosixPath(file));
    const bytes = update ? Buffer.from(update.content) : await readArtifactBytes(join(sourceRoot, file));
    const existingIndex = artifacts.findIndex(artifact => artifact.revisions.some(revision => revision.path === workPath));
    const existing = existingIndex >= 0 ? artifacts[existingIndex]! : undefined;
    const artifactId = existing?.id ?? artifactIdFor(file);
    let revisions = [...(existing?.revisions ?? [])];
    const current = revisions.find(revision => revision.id === existing?.currentRevisionId);
    let currentBytes: Buffer | undefined = current?.contentBase64 === undefined ? undefined : Buffer.from(current.contentBase64, "base64");
    if (current) {
      if (!current.snapshotPath && currentBytes) {
        const path = revisionSnapshotPath(artifactId, current.id, file);
        snapshotWrites.push(snapshotWrite(input.workId, path, currentBytes));
        revisions = revisions.map(revision => revision.id === current.id ? { ...revision, snapshotPath: path } : revision);
      }
      if (current.snapshotPath) currentBytes = await readFile(join(root, current.snapshotPath))
        .catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (!currentBytes && !current.snapshotPath && current.path === workPath) {
        // A legacy current revision may predate snapshots. Preserve its actual
        // source before a pending write, keeping its existing id and references.
        currentBytes = update ? await readArtifactBytes(join(sourceRoot, file)) : bytes;
        const path = revisionSnapshotPath(artifactId, current.id, file);
        snapshotWrites.push(snapshotWrite(input.workId, path, currentBytes));
        revisions = revisions.map(revision => revision.id === current.id ? { ...revision, snapshotPath: path } : revision);
      }
    }
    if (currentBytes?.equals(bytes)) {
      artifacts[existingIndex] = ArtifactManifestSchema.parse({ ...existing!,
        kind: existing!.kind, revisions,
        metadata: existing!.metadata });
      continue;
    }
    let prior = undefined as typeof current;
    for (const revision of [...revisions].reverse()) {
      const saved = revision.id === current?.id && currentBytes ? currentBytes
        : revision.snapshotPath ? await readFile(join(root, revision.snapshotPath)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; })
        : revision.contentBase64 === undefined ? undefined : Buffer.from(revision.contentBase64, "base64");
      if (saved?.equals(bytes)) { prior = revision; break; }
    }
    const revisionId = prior?.id ?? `rev-${randomUUID()}`;
    const snapshotPath = prior?.snapshotPath ?? revisionSnapshotPath(artifactId, revisionId, file);
    const revision = prior ?? ArtifactRevisionSchema.parse({
      id: revisionId, parentRevisionId: current?.id ?? null, path: workPath, snapshotPath,
      contentType: contentTypeFor(file), status: accept ? "current" : "candidate",
      byteLength: bytes.byteLength, episodeId: input.episodeId, createdAt: updatedAt,
    });
    const updatedRevisions = revisions.map(item => ({ ...item,
      ...(accept && item.id === revisionId ? { status: "current" as const } :
        accept && item.status === "current" ? { status: "superseded" as const } : {}),
    }));
    if (!prior) { updatedRevisions.push(revision); snapshotWrites.push(snapshotWrite(input.workId, snapshotPath, bytes)); }
    const next = ArtifactManifestSchema.parse({
      id: artifactId, kind: existing?.kind ?? artifactKindFor(workPath),
      currentRevisionId: accept ? revisionId : existing?.currentRevisionId ?? null,
      revisions: updatedRevisions,
      metadata: { ...existing?.metadata, sourcePath: toPosixPath(join("works", input.workId, workPath)), ...(existing ? {} : { kindSource: SOURCE_KIND_VERSION }) },
    });
    if (existingIndex >= 0) artifacts[existingIndex] = next; else artifacts.push(next);
  }

  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = artifacts[index]!;
    const current = artifact.revisions.find((revision) => revision.id === artifact.currentRevisionId);
    if (!input.accept || !current?.path.startsWith("source/") || (acceptPaths && !acceptPaths.includes(current.path)) || presentWorkPaths.has(current.path)) continue;
    artifacts[index] = ArtifactManifestSchema.parse({
      ...artifact,
      currentRevisionId: null,
      revisions: artifact.revisions.map((revision) => (
        revision.id === artifact.currentRevisionId && revision.status === "current"
          ? { ...revision, status: "superseded" as const }
          : revision
      )),
      metadata: { ...artifact.metadata, removedAt: updatedAt, removedPath: current.path },
    });
  }

  const next = WorkManifestSchema.parse({
    ...manifest,
    title: input.title ?? manifest.title,
    lineage: input.lineage ?? manifest.lineage,
    status: input.status ?? (manifest.status === "archived" ? "archived" : input.accept ? "active" : manifest.status),
    artifacts,
    updatedAt,
  });
  // Check only the directories actually receiving writes, not the whole Work.
  const checked = new Set<string>();
  for (const write of [...(input.writes ?? []), ...snapshotWrites,
    { relativePath: join("works", input.workId, "work.json"), content: "" }]) {
    const parts = toPosixPath(write.relativePath).split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = join(input.projectRoot, ...parts.slice(0, depth));
      if (checked.has(path)) continue;
      checked.add(path);
      const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
      if (info?.isSymbolicLink()) throw Object.assign(new Error("A write target points outside its normal Work path"), { code: "ARTIFACT_PATH_OUTSIDE_WORK" });
    }
  }
  await commitAtomicFileSet({
    rootDir: input.projectRoot,
    writes: [
      ...(input.writes ?? []),
      ...snapshotWrites,
      {
        relativePath: join("works", input.workId, "work.json"),
        content: `${JSON.stringify(next, null, 2)}\n`,
      },
    ],
  });
  updateExecutionWork(next);
  recordExecutionEvidence("work-artifacts-synced", {workId:next.id,profileId:next.profileId,accepted:input.accept,
    artifacts:next.artifacts.map(artifact=>({artifactId:artifact.id,currentRevisionId:artifact.currentRevisionId,latestRevisionId:artifact.revisions.at(-1)?.id})),
  });
  return next;
}

/** A baseline for operations that still write source files before registering them. */
export async function captureWorkSourceState(projectRoot: string, workId: string): Promise<ReadonlyMap<string, Buffer>> {
  const root = join(workDirectory(projectRoot, workId), "source");
  try { await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
  const files = await listFiles(root);
  const state = new Map<string, Buffer>();
  for (const file of files) {
    const path = join(root, file);
    let bytes = await readFile(path);
    if ([".db", ".sqlite"].includes(extname(path))) {
      // Committed SQLite changes can live in WAL until checkpointed. Do not
      // create a database backup merely to observe whether an operation wrote it.
      try { const wal = await readFile(`${path}-wal`); bytes = Buffer.concat([Buffer.from(`${bytes.length}:`), bytes, wal]); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    state.set(toPosixPath(join("source", file)), bytes);
  }
  return state;
}

export async function changedWorkSourcePaths(projectRoot: string, workId: string, before: ReadonlyMap<string, Buffer>): Promise<string[]> {
  const after = await captureWorkSourceState(projectRoot, workId);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => { const previous = before.get(path), current = after.get(path); return !previous || !current || !previous.equals(current); }).sort();
}

function revisionSnapshotPath(artifactId: string, revisionId: string, sourcePath: string): string {
  const extension = extname(sourcePath).toLowerCase();
  return toPosixPath(join("revisions", artifactId, `${revisionId}${extension}`));
}

function snapshotWrite(workId: string, snapshotPath: string, content: Uint8Array): AtomicFileWrite {
  return {
    relativePath: join("works", workId, snapshotPath),
    content,
  };
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".write.lock" || entry.name === BOOK_LOCK_GUARD_FILE || entry.name.startsWith(`${BOOK_LOCK_GUARD_FILE}-`)
        || entry.name.endsWith(".db-wal") || entry.name.endsWith(".db-shm") || entry.name.endsWith(".sqlite-wal") || entry.name.endsWith(".sqlite-shm")) continue;
      const path = join(directory, entry.name);
      if ((await lstat(path)).isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      // Discovery and pending writes must share one key before deduplication.
      else if (entry.isFile()) files.push(toPosixPath(relative(root, path)));
    }
  };
  await visit(root);
  return files;
}

async function readArtifactBytes(path: string): Promise<Buffer> {
  if (![".db", ".sqlite"].includes(extname(path))) return readFile(path);
  const directory = await mkdtemp(join(tmpdir(), "inkos-sqlite-snapshot-"));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const snapshot = join(directory, "snapshot.db");
    await backup(db, snapshot);
    return await readFile(snapshot);
  } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
}


function artifactIdFor(path: string): string {
  const readable = basename(path, extname(path))
    .replace(/[^a-z0-9\u4e00-\u9fff._-]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "artifact";
  return `${readable}-${randomUUID()}`;
}

const ARTIFACT_FILE_KINDS=new Map([
  ["manifest.json","manifest"],["glossary.json","glossary"],["review-report.md","review"],
  ["script.md","script"],["storyboard.md","storyboard"],["image-prompts.md","image-prompt"],
  ["assets.json","asset-manifest"],["story-graph.json","story-graph"],
]);

/** Both registration paths supply the same Work-relative storage address. */
function artifactKindFor(workPath: string): string {
  const normalized=toPosixPath(workPath);
  const path=normalized.startsWith("source/")?normalized.slice("source/".length):normalized;
  const namedKind=ARTIFACT_FILE_KINDS.get(path);
  if(namedKind)return namedKind;
  if (/\.(?:png|jpe?g|webp|gif)$/iu.test(path)) return "image";
  if(path.startsWith("translated/")&&path.endsWith(".json"))return "translation-chapter";
  if(path.startsWith("source/")&&path.endsWith(".json"))return "source-chapter";
  if(/^chapters\/\d+(?:_[^/]+)?\.md$/.test(path))return "chapter";
  return "file";
}

function contentTypeFor(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if (extension === ".txt") return "text/plain";
  if (extension === ".html") return "text/html";
  if (extension === ".ink") return "text/plain";
  if (extension === ".json" || extension === ".jsonl") return "application/json";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}
