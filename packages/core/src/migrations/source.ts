import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '@earendil-works/pi-durable';
import { assertId, savedRevision } from '../works/artifacts.js';
import type { ArtifactRevision } from '../works/documents.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import type { LegacyFileRef, LegacyRow } from './documents.js';

export const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
export const text = (value: unknown): string | null => typeof value === 'string' && value.length ? value : null;
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const posix = (value: string): string => value.split(sep).join('/');
export const stableId = (kind: string, value: string): string => `${kind}:${encodeURIComponent(value)}`;
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const timestamp = (value: unknown, fallback = 0): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(number) ? number : fallback;
};
export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export async function entries(path: string) {
  try { return (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
/** Hidden author archives are intentional input, not temporary files to filter out. */
export async function files(path: string, skip: Set<string> = new Set()): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await entries(path)) {
    if (skip.has(entry.name) || entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await files(child, skip));
    else if (entry.isFile() || (entry.isSymbolicLink() && (await stat(child)).isFile())) result.push(child);
  }
  return result;
}
export async function readJson(path: string): Promise<JsonObject> {
  return object(JSON.parse(await readFile(path, 'utf8')));
}
export async function optionalJson(path: string): Promise<JsonObject> {
  return await exists(path) ? readJson(path) : {};
}
export async function sourceLocation(rootDir: string, source?: string): Promise<{ source: string; selection: string | null }> {
  const candidate = resolve(rootDir, source ?? '.');
  const parent = basename(resolve(candidate, '..'));
  const roots = ['works', 'books', 'shorts', 'dramas', 'storyboards', 'interactive-films', 'worlds', 'translations'];
  if (roots.includes(parent)) return { source: await realpath(resolve(candidate, '../..')), selection: `${parent}/${basename(candidate)}` };
  return { source: await realpath(candidate), selection: null };
}

export type LegacyDatabase = { sourceFile: string; schema: JsonObject[]; rows: LegacyRow[]; durable: boolean };
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
function sqlValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : { type: 'integer', value: value.toString() };
  if (value instanceof Uint8Array) return { type: 'blob', encoding: 'base64', value: Buffer.from(value).toString('base64') };
  return value;
}
/** No legacy store constructor: even their read APIs create tables and recover executor ownership. */
export function scanDatabase(sourceFile: string): LegacyDatabase {
  const db = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => object(row));
    const durable = schema.some(row => row.name === 'durable_metadata') && schema.some(row => row.name === 'durable_schema');
    if (durable) return { sourceFile, schema: [], rows: [], durable: true };
    const rows: LegacyRow[] = [];
    for (const definition of schema) {
      const name = String(definition.name);
      const primary = db.prepare(`PRAGMA table_info(${quote(name)})`).all().filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
      const order = primary.length ? ` ORDER BY ${primary.map(column => quote(String(column.name))).join(', ')}` : '';
      const statement = db.prepare(`SELECT * FROM ${quote(name)}${order}`);
      statement.setReadBigInts(true);
      for (const input of statement.all()) {
        const row = object(Object.fromEntries(Object.entries(input).map(([key, value]) => [key, sqlValue(value)])));
        const decoded: JsonObject = {};
        for (const [key, value] of Object.entries(row)) if (key.endsWith('_json') && typeof value === 'string') {
          try { decoded[key] = JSON.parse(value); } catch { /* Retain malformed historical JSON verbatim in row. */ }
        }
        rows.push({ sourceFile, table: name, row, decoded });
      }
    }
    return { sourceFile, schema, rows, durable: false };
  } finally { db.close(); }
}
export const isDatabase = (path: string): boolean => ['.sqlite', '.sqlite3', '.db'].includes(extname(path).toLowerCase());
export const rowData = (record: LegacyRow): JsonObject => {
  for (const name of ['data_json', 'run_json', 'state_json', 'target_json', 'manifest_json', 'receipt_json', 'payload_json']) {
    if (record.decoded[name]) return object(record.decoded[name]);
  }
  return {};
};
export function relatedWorkId(record: LegacyRow): string | null {
  const data = rowData(record);
  return text(record.row.work_id) ?? text(record.row.book_id) ?? text(data.workId) ?? text(data.bookId) ?? text(object(data.book).id);
}
export function workRows(rows: LegacyRow[], workId: string): LegacyRow[] {
  const direct = rows.filter(row => relatedWorkId(row) === workId);
  const goalIds = new Set(direct.filter(row => row.table === 'goals').map(row => text(row.row.id)).filter(Boolean));
  const episodeIds = new Set(direct.filter(row => row.table === 'creative_episodes').map(row => text(row.row.episode_id)).filter(Boolean));
  const packageIds = new Set(direct.filter(row => row.table === 'publishing_packages').map(row => text(row.row.id) ?? text(rowData(row).id)).filter(Boolean));
  return rows.filter(row => direct.includes(row) || goalIds.has(text(row.row.goal_id)) || episodeIds.has(text(row.row.episode_id)) || packageIds.has(text(row.row.package_id)));
}

export type PlannedRevision = {
  revision: ArtifactRevision; sourceFile: string; base64?: string;
};
export const formatOf = (path: string, contentType?: unknown): string => {
  if (text(contentType)) return String(contentType);
  const extension = extname(path).toLowerCase();
  if (extension === '.json') return 'json';
  if (extension === '.md') return 'markdown';
  if (['.txt', '.jsonl', '.yaml', '.yml', '.csv', '.html', '.xml', '.js', '.ts', '.css'].includes(extension)) return 'text';
  return extension.slice(1) || 'binary';
};
export function plannedRevision(input: {
  workId: string; artifactId: string; revisionId: string; title: string; sourceFile: string;
  migrationKey: string; format?: string; createdAt?: number; metadata?: JsonObject; base64?: string;
}): PlannedRevision {
  const { workId, artifactId, revisionId, sourceFile } = input;
  [workId, artifactId, revisionId].forEach(assertId);
  const format = input.format ?? formatOf(sourceFile);
  const extension = extname(sourceFile) || (format === 'json' ? '.json' : '.bin');
  return {
    sourceFile, ...(input.base64 !== undefined ? { base64: input.base64 } : {}),
    revision: { id: revisionId, artifactId, workId, title: input.title, format, createdAt: input.createdAt ?? 0,
      path: posix(join('.inkos', 'artifacts', workId, artifactId, revisionId, `content${extension}`)),
      metadata: { ...input.metadata, migrationKey: input.migrationKey, sourceFile, encoding: 'original-bytes' } },
  };
}
export const fileRef = (item: PlannedRevision): LegacyFileRef => ({ sourceFile: item.sourceFile, artifactId: item.revision.artifactId,
  revisionId: item.revision.id, path: item.revision.path, format: item.revision.format });
export async function persistRevision(rootDir: string, item: PlannedRevision): Promise<void> {
  const revision = item.revision;
  const prior = await savedRevision(rootDir, revision.workId, revision.artifactId, revision.id);
  if (prior) {
    if (prior.metadata.migrationKey !== revision.metadata.migrationKey || prior.metadata.sourceFile !== revision.metadata.sourceFile) throw new Error(`Revision ID already belongs to another source: ${revision.id}`);
    if (await exists(join(rootDir, prior.path))) { revision.path = prior.path; return; }
  }
  const content = item.base64 !== undefined ? Buffer.from(item.base64, 'base64') : await readFile(item.sourceFile);
  const directory = resolve(rootDir, revision.path, '..');
  await commitAtomicFileSet({ rootDir: directory, writes: [
    { relativePath: basename(revision.path), content },
    { relativePath: 'revision.json', content: JSON.stringify(revision, null, 2) },
  ] });
}
export function archiveFile(source: string, workId: string, path: string, migrationKey: string): PlannedRevision {
  const identity = posix(relative(source, path));
  return plannedRevision({ workId, artifactId: stableId('legacy-file', `${workId}:${identity}`), revisionId: 'legacy-original-v1',
    title: identity, sourceFile: path, migrationKey, metadata: { sourcePath: identity } });
}
