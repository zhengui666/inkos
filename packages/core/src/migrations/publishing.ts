import { DURABLE_MIGRATION_VERSION, type LegacyPublishingData, type LegacyPublishingRecord, type LegacyRow } from './documents.js';
import { object, rowData, stableId, text } from './source.js';

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}
/** Only IDs, never accountLabel or a guessed platform-wide remote identity. */
function findId(value: unknown, names: string[]): string | null {
  const input = object(value);
  for (const name of names) if (text(input[name])) return String(input[name]);
  for (const child of Object.values(input)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const result = findId(child, names); if (result) return result;
    }
  }
  return null;
}
export function publishingRecord(record: LegacyRow): LegacyPublishingRecord {
  const data = rowData(record), values = [record.row, data, record.decoded];
  const id = (names: string[]) => values.map(value => findId(value, names)).find(value => value !== null) ?? null;
  const evidence = [...strings(record.decoded), ...Object.entries(record.row).filter(([key]) => !key.endsWith('_json')).flatMap(([, value]) => strings(value))];
  const unknownStates = [...new Set(evidence.filter(value => /(?:^|_)unknown$/u.test(value)))];
  const userReported = evidence.some(value => value === 'user_reported' || value.endsWith('_reported'));
  const observed = !userReported && (data.remoteVerified === true || evidence.includes('browser_observed') || evidence.includes('observed'));
  const packageId = id(['package_id', 'packageId']);
  const number = record.row.number ?? record.row.chapter ?? record.row.seq ?? data.number ?? '';
  const compoundIdentity = [id(['work_id', 'workId']), id(['target_id', 'targetId']), id(['account_id', 'accountId']), id(['remote_book_id', 'remoteBookId']), packageId, number];
  return { ...record,
    id: text(record.row.id) ?? text(record.row.event_id) ?? text(record.row.operation_id) ?? text(data.id) ?? stableId(record.table, JSON.stringify(compoundIdentity)),
    workId: id(['work_id', 'workId', 'book_id', 'bookId']), targetId: id(['target_id', 'targetId']), packageId,
    accountId: id(['account_id', 'accountId']), remoteBookId: id(['remote_book_id', 'remoteBookId']), remoteChapterId: id(['remote_chapter_id', 'remoteChapterId']),
    artifactId: id(['artifact_id', 'artifactId']), revisionId: id(['revision_id', 'revisionId']),
    disposition: unknownStates.length || evidence.includes('awaiting_receipt') ? 'needs-observation' : userReported ? 'user-reported' : observed ? 'observed' : 'retained', unknownStates,
  };
}
export function collectPublishing(source: string, migrationKey: string, rows: LegacyRow[]): LegacyPublishingData {
  const result: LegacyPublishingData = { version: DURABLE_MIGRATION_VERSION, source, migrationKey,
    targets: [], preparations: [], packages: [], chapters: [], events: [], fanqieRuns: [], meganovelRuns: [], remoteWorkRuns: [], bindings: [], other: [], files: [], artifactMappings: [] };
  const groups: Record<string, keyof Pick<LegacyPublishingData, 'targets' | 'preparations' | 'packages' | 'chapters' | 'events' | 'fanqieRuns' | 'meganovelRuns' | 'remoteWorkRuns' | 'bindings'>> = {
    publishing_targets: 'targets', publishing_preparations: 'preparations', publishing_packages: 'packages', publishing_chapters: 'chapters', publishing_events: 'events',
    publishing_fanqie_runs: 'fanqieRuns', publishing_meganovel_runs: 'meganovelRuns', publishing_remote_work_runs: 'remoteWorkRuns', publishing_remote_work_bindings: 'bindings',
  };
  for (const row of rows) if (row.table.startsWith('publishing_')) (result[groups[row.table] ?? 'other'] as LegacyPublishingRecord[]).push(publishingRecord(row));
  for (const record of publishingRecords(result)) {
    const pack = result.packages.find(pack => pack.id === record.packageId);
    if (pack) { record.workId ??= pack.workId; record.targetId ??= pack.targetId; }
    // Primary target/package identity columns are not always named target_id/package_id.
    if (record.table === 'publishing_targets') record.targetId ??= record.id;
    if (record.table === 'publishing_packages') record.packageId ??= record.id;
  }
  return result;
}
export function publishingRecords(data: LegacyPublishingData): LegacyPublishingRecord[] {
  return [...data.targets, ...data.preparations, ...data.packages, ...data.chapters, ...data.events,
    ...data.fanqieRuns, ...data.meganovelRuns, ...data.remoteWorkRuns, ...data.bindings, ...data.other];
}
export const hasPublishing = (data: LegacyPublishingData): boolean => publishingRecords(data).length > 0 || data.files.length > 0;
