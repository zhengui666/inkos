import { defineDocFamily, defineEntry, type JsonObject } from '@earendil-works/pi-durable';

export const DURABLE_MIGRATION_VERSION = 1;
export const DURABLE_MIGRATION_ID = 'inkos-to-pi-durable-v1';

/** The original SQL values and decoded JSON coexist; unknown columns are not discarded. */
export type LegacyRow = {
  sourceFile: string; table: string; row: JsonObject; decoded: JsonObject;
};
export type LegacyFileRef = {
  sourceFile: string; artifactId: string; revisionId: string; path: string; format: string;
};
export type LegacyPublishingRecord = LegacyRow & {
  id: string; workId: string | null; targetId: string | null; packageId: string | null;
  accountId: string | null; remoteBookId: string | null; remoteChapterId: string | null;
  artifactId: string | null; revisionId: string | null;
  disposition: 'needs-observation' | 'user-reported' | 'observed' | 'retained';
  unknownStates: string[];
};
export type LegacyPublishingData = {
  version: number; migrationKey: string; source: string;
  targets: LegacyPublishingRecord[]; preparations: LegacyPublishingRecord[];
  packages: LegacyPublishingRecord[]; chapters: LegacyPublishingRecord[]; events: LegacyPublishingRecord[];
  fanqieRuns: LegacyPublishingRecord[]; meganovelRuns: LegacyPublishingRecord[];
  remoteWorkRuns: LegacyPublishingRecord[]; bindings: LegacyPublishingRecord[];
  other: LegacyPublishingRecord[]; files: LegacyFileRef[];
  artifactMappings: { workId: string; artifactId: string; revisionId: string; sourcePath: string; path: string }[];
};
export type LegacyUnfinishedStep = {
  id: string; taskId: string | null; kind: string; status: string;
  operationKey: string | null; receipt: JsonObject | null; reason: string;
  nextTask: 'inkos.content' | 'inkos.publishing.observe' | null;
  artifactId: string | null; revisionId: string | null;
};
export type LegacyProgressState = {
  version: number; migrationKey: string; source: string; workId: string | null;
  records: LegacyRow[]; taskIds: string[]; unfinished: LegacyUnfinishedStep[];
  resume: { status: 'paused' | 'terminal' | 'none'; reason: string; taskId: number | null };
};
export type MigrationItem = { workId: string; sourceFiles: string[]; reason: string };
export type MigrationConflict = { workId: string | null; sourceFile: string; reason: string };
export type MigrationReport = {
  version: number; migrationId: string; migrationKey: string; source: string; rootDir: string;
  apply: boolean; status: 'preview' | 'applied' | 'partial' | 'already-applied';
  imported: MigrationItem[]; skipped: MigrationItem[]; conflicts: MigrationConflict[]; sourceFiles: string[];
  progress: { workId: string; key: string; status: string; reason: string; unfinished: LegacyUnfinishedStep[] }[];
  history: { sourceFile: string; entryCount: number; conversationId: number | null }[];
  publishing: LegacyPublishingData; publishingImport: 'none' | 'pending' | 'imported' | 'failed';
  publishingError: string | null;
};
export type MigrationOptions = {
  /** A source project directory, or a legacy work path relative to rootDir. */
  source?: string; apply?: boolean;
  /** Must import by the retained source IDs / migrationKey; never perform a remote action here. */
  importPublishing?: (legacy: LegacyPublishingData) => Promise<void>;
};
export const LegacyHistoryEntry = defineEntry<JsonObject>('inkos.legacy-history');
export const LegacyProgress = defineDocFamily<LegacyProgressState, LegacyProgressState>({
  kind: 'inkos.legacy-progress', version: 1, scope: 'session', family: true, initial: seed => seed,
});
export const LegacyPublishing = defineDocFamily<LegacyPublishingData, LegacyPublishingData>({
  kind: 'inkos.legacy-publishing', version: 1, scope: 'session', family: true, initial: seed => seed,
});
export type LegacyArchiveState = {
  version: number; source: string; files: LegacyFileRef[];
  history: { sourceFile: string; entryCount: number; conversationId: number | null }[];
};
export const LegacyArchive = defineDocFamily<LegacyArchiveState, LegacyArchiveState>({
  kind: 'inkos.legacy-archive', version: 1, scope: 'session', family: true, initial: seed => seed,
});
export type LegacyMaterialState = {
  id: string; migrationKey: string; manifest: JsonObject; sourceFile: string;
  markdownPath: string | null; manifestPath: string; original: LegacyFileRef | null;
};
export const LegacyMaterials = defineDocFamily<LegacyMaterialState, LegacyMaterialState>({
  kind: 'inkos.legacy-material', version: 1, scope: 'session', family: true, initial: seed => seed,
});
export const legacyProgressKey = (migrationKey: string, workId: string | null): string => JSON.stringify([migrationKey, workId]);
