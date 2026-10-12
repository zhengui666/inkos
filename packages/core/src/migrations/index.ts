import { readFile, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness, JsonObject } from '@earendil-works/pi-durable';
import { Artifacts, ProjectDoc, Works, type Artifact } from '../works/documents.js';
import { assertId } from '../works/artifacts.js';
import { commitAtomicFileSet, type AtomicFileWrite } from '../utils/atomic-file-set.js';
import { DURABLE_MIGRATION_ID, DURABLE_MIGRATION_VERSION, LegacyArchive, LegacyHistoryEntry, LegacyMaterials, LegacyProgress, LegacyPublishing, legacyProgressKey,
  type LegacyMaterialState, type LegacyRow, type MigrationOptions, type MigrationReport } from './documents.js';
import { archiveFile, array, entries, errorText, exists, fileRef, files, isDatabase, object, optionalJson, persistRevision, posix, readJson, relatedWorkId, rowData, scanDatabase, sourceLocation, stableId, text, workRows,
  type LegacyDatabase, type PlannedRevision } from './source.js';
import { collectPublishing, hasPublishing, publishingRecords } from './publishing.js';
import { discoverWorks, mapProfile, planProgress, planWork, type PlannedWork, type WorkSource } from './works.js';
export * from './documents.js';
export { importLegacyPublishing } from './import-publishing.js';

type HistoryPlan = { sourceFile: string; entries: JsonObject[] };
type MaterialPlan = { doc: LegacyMaterialState; writes: AtomicFileWrite[] };
function reportClone(report: MigrationReport): MigrationReport { return JSON.parse(JSON.stringify(report)) as MigrationReport; }
function alreadyApplied(report: MigrationReport, apply: boolean): MigrationReport {
  const result = reportClone(report);
  result.apply = apply; result.status = 'already-applied';
  result.skipped.push(...result.imported.map(item => ({ ...item, reason: 'Already imported by this migration version; no work, history or task duplicated' })));
  result.imported = [];
  return result;
}
async function finishPublishing(harness: Harness, report: MigrationReport, options: MigrationOptions): Promise<MigrationReport> {
  if (!options.apply || !options.importPublishing || !hasPublishing(report.publishing) || report.publishingImport === 'imported') return report;
  try { await options.importPublishing(report.publishing); report.publishingImport = 'imported'; report.publishingError = null; }
  catch (error) { report.publishingImport = 'failed'; report.publishingError = errorText(error); }
  await harness.commit(async tx => {
    const project = await tx.doc(ProjectDoc), marker = object(project.migrations[report.migrationKey]);
    marker.publishingImport = report.publishingImport; marker.publishingError = report.publishingError;
    const stored = object(marker.report); stored.publishingImport = report.publishingImport; stored.publishingError = report.publishingError;
    marker.report = stored; project.migrations[report.migrationKey] = marker;
  }, BACKGROUND_CONTEXT);
  return report;
}
async function historyFromFile(sourceFile: string, migrationKey: string): Promise<HistoryPlan> {
  const raw = await readFile(sourceFile, 'utf8');
  if (sourceFile.endsWith('.jsonl')) {
    const values: JsonObject[] = [];
    for (const [index, line] of raw.split(/\r?\n/u).entries()) {
      if (!line.trim()) continue;
      let event: unknown = null, error: string | null = null;
      try { event = JSON.parse(line); } catch (failure) { error = errorText(failure); }
      values.push({ migrationKey, sourceFile, line: index + 1, raw: line, event: event as JsonObject, parseError: error });
    }
    return { sourceFile, entries: values };
  }
  let event: unknown = null, error: string | null = null;
  try { event = JSON.parse(raw); } catch (failure) { error = errorText(failure); }
  return { sourceFile, entries: [{ migrationKey, sourceFile, raw, event: event as JsonObject, parseError: error }] };
}
async function materialPlans(harness: Harness, root: string, source: string, migrationKey: string, globalFiles: string[], revisions: PlannedRevision[], report: MigrationReport): Promise<MaterialPlan[]> {
  const plans: MaterialPlan[] = [], owner = stableId('legacy-project', source);
  for (const path of globalFiles.filter(path => posix(relative(source, path)).startsWith('.inkos/materials/') && path.endsWith('.json'))) {
    try {
      const manifest = await readJson(path), id = assertId(text(manifest.id) ?? basename(path, '.json'));
      const prior = await harness.snapshot(LegacyMaterials, id, BACKGROUND_CONTEXT);
      if (prior && prior.migrationKey !== migrationKey) throw new Error(`Material ID already exists: ${id}`);
      const declared = text(manifest.markdownPath), markdownSource = declared ? resolve(source, declared) : join(source, '.inkos', 'materials', `${id}.md`);
      const available = await exists(markdownSource);
      let original = revisions.find(item => item.sourceFile === markdownSource);
      if (available && !original) { original = archiveFile(source, owner, markdownSource, migrationKey); revisions.push(original); }
      if (!available) report.conflicts.push({ workId: null, sourceFile: markdownSource, reason: `Material ${id} file is missing; its ID and bindings remain retained` });
      const sameSource = source === root;
      const markdownPath = available ? sameSource ? posix(relative(root, markdownSource)) : `.inkos/materials/${id}.md` : null;
      const manifestPath = sameSource ? posix(relative(root, path)) : `.inkos/materials/${id}.json`;
      const writes: AtomicFileWrite[] = [];
      if (!sameSource) {
        if (available && markdownPath) writes.push({ relativePath: markdownPath, content: await readFile(markdownSource) });
        writes.push({ relativePath: manifestPath, content: JSON.stringify({ ...manifest, manifestPath, ...(markdownPath ? { markdownPath } : {}) }, null, 2) });
        for (const write of writes) if (await exists(join(root, write.relativePath))) {
          const content = typeof write.content === 'string' ? Buffer.from(write.content) : Buffer.from(write.content);
          if (!(await readFile(join(root, write.relativePath))).equals(content)) throw new Error(`Material destination already contains different data: ${write.relativePath}`);
        }
      }
      plans.push({ doc: { id, migrationKey, manifest, sourceFile: path, markdownPath, manifestPath, original: original ? fileRef(original) : null }, writes });
    } catch (error) { report.conflicts.push({ workId: null, sourceFile: path, reason: errorText(error) }); }
  }
  return plans;
}
function artifactSeed(item: PlannedRevision): Artifact {
  return { id: item.revision.artifactId, workId: item.revision.workId, title: item.revision.title, currentRevision: item.revision.id, revisions: [item.revision] };
}

/** Preview performs only source reads and durable snapshots. Apply never opens a legacy writer/executor. */
export async function migrateToDurable(harness: Harness, rootDir: string, options: MigrationOptions = {}): Promise<MigrationReport> {
  const location = await sourceLocation(rootDir, options.source);
  const source = location.source, root = await exists(rootDir) ? await realpath(rootDir) : resolve(rootDir);
  const migrationKey = `${DURABLE_MIGRATION_ID}:${source}${location.selection ? `:${location.selection}` : ''}`;
  const project = await harness.snapshot(ProjectDoc, BACKGROUND_CONTEXT), previous = object(project?.migrations[migrationKey]);
  if (previous.report) return finishPublishing(harness, alreadyApplied(previous.report as MigrationReport, options.apply === true), options);
  const config = await optionalJson(join(source, 'inkos.json'));
  const report: MigrationReport = { version: DURABLE_MIGRATION_VERSION, migrationId: DURABLE_MIGRATION_ID, migrationKey, source, rootDir: root,
    apply: options.apply === true, status: 'preview', imported: [], skipped: [], conflicts: [], sourceFiles: [], progress: [], history: [],
    publishing: collectPublishing(source, migrationKey, []), publishingImport: 'none', publishingError: null };
  const inputs = await discoverWorks(source, location.selection, report.conflicts);
  const globalFiles = (await files(join(source, '.inkos'), new Set(['artifacts']))).filter(path => !['.inkos/runtime-owner.sqlite', '.inkos/runtime.json', '.inkos/runtime.log', '.inkos/credentials.json'].includes(posix(relative(source, path))));
  if (await exists(join(source, 'inkos.json'))) globalFiles.push(join(source, 'inkos.json'));
  for (const directory of ['skills', '.agents', 'radar']) globalFiles.push(...await files(join(source, directory)));
  for (const entry of await entries(source)) if (entry.isFile() && isDatabase(entry.name)) globalFiles.push(join(source, entry.name));
  const databaseFiles = new Set(globalFiles.filter(isDatabase)), workSourceFiles = new Set<string>(), durableFiles = new Set<string>();
  for (const input of inputs) for (const path of await files(input.directory)) {
    workSourceFiles.add(path); if (isDatabase(path)) databaseFiles.add(path);
  }
  const databases: LegacyDatabase[] = [], rows: LegacyRow[] = [];
  for (const path of databaseFiles) {
    try { const database = scanDatabase(path); if (database.durable) durableFiles.add(path); else { databases.push(database); rows.push(...database.rows); } }
    catch (error) { report.conflicts.push({ workId: null, sourceFile: path, reason: `Cannot read source SQLite: ${errorText(error)}` }); }
  }
  const originals = globalFiles.filter(path => !isDatabase(path) && !/-wal$|-shm$|-journal$/u.test(path));
  for (const path of originals.filter(path => posix(relative(source, path)).startsWith('.inkos/short-revisions/') && path.endsWith('.json'))) {
    try { rows.push({ sourceFile: path, table: 'short_revisions', row: { work_id: basename(path, '.json') }, decoded: { data_json: await readJson(path) } }); }
    catch (error) { report.conflicts.push({ workId: null, sourceFile: path, reason: errorText(error) }); }
  }
  for (const path of originals.filter(path => posix(relative(source, path)).startsWith('.inkos/publishing/') && basename(path) === 'manifest.json')) {
    try {
      const manifest = await readJson(path), id = text(manifest.id) ?? text(manifest.packageId) ?? basename(resolve(path, '..'));
      if (!rows.some(row => row.table === 'publishing_packages' && (row.row.id === id || row.row.package_id === id))) rows.push({ sourceFile: path, table: 'publishing_packages', row: { id }, decoded: { manifest_json: manifest } });
    } catch (error) { report.conflicts.push({ workId: null, sourceFile: path, reason: errorText(error) }); }
  }
  // Ledger-only intake is still a work, not an executable legacy session.
  if (!location.selection) for (const row of rows) {
    const id = relatedWorkId(row);
    if (!id || inputs.some(input => input.id === id) || !['creation_tasks', 'goals', 'scheduler_foundations'].includes(row.table)) continue;
    try {
      assertId(id);
      const data = rowData(row), plan = object(data.plan), profile = mapProfile(text(data.profileId) ?? text(plan.profileId) ?? 'fiction');
      inputs.push({ id, profile, directory: join(source, 'works', id), marker: null, roots: [], manifest: { id, title: plan.title ?? id, status: 'draft', ledgerOnly: true } } satisfies WorkSource);
    } catch (error) { report.conflicts.push({ workId: id, sourceFile: row.sourceFile, reason: errorText(error) }); }
  }
  const plans: PlannedWork[] = [], claimedArtifacts = new Map<string, string>();
  for (const input of inputs) {
    try {
      const existing = await harness.snapshot(Works, input.id, BACKGROUND_CONTEXT);
      if (existing) {
        if (existing.legacy.source === source) { report.skipped.push({ workId: input.id, sourceFiles: array(existing.legacy.sourceFiles) as string[], reason: 'Work was already imported from this source' }); continue; }
        throw new Error(`Durable work ID already exists: ${input.id}`);
      }
      const plan = await planWork(input, source, migrationKey, rows, config);
      for (const artifact of plan.artifacts) {
        const owner = claimedArtifacts.get(artifact.id), prior = await harness.snapshot(Artifacts, artifact.id, BACKGROUND_CONTEXT);
        if (owner || prior) throw new Error(`Artifact ID already exists: ${artifact.id} (work ${owner ?? prior?.workId})`);
      }
      for (const artifact of plan.artifacts) claimedArtifacts.set(artifact.id, plan.work.id);
      plans.push(plan); report.imported.push({ workId: input.id, sourceFiles: plan.sourceFiles, reason: options.apply ? 'Imported with durable domain, artifacts and legacy progress' : 'Will import durable domain, artifacts and legacy progress' });
    } catch (error) { report.conflicts.push({ workId: input.id, sourceFile: input.marker ?? input.directory, reason: errorText(error) }); }
  }
  const archiveOwner = stableId('legacy-project', source), archiveRevisions = originals.map(path => archiveFile(source, archiveOwner, path, migrationKey));
  const materials = await materialPlans(harness, root, source, migrationKey, originals, archiveRevisions, report);
  report.publishing = collectPublishing(source, migrationKey, rows);
  report.publishing.files = archiveRevisions.filter(item => posix(relative(source, item.sourceFile)).startsWith('.inkos/publishing/')).map(fileRef);
  report.publishing.artifactMappings = plans.flatMap(plan => plan.revisions.map(item => ({ workId: plan.work.id, artifactId: item.revision.artifactId,
    revisionId: item.revision.id, sourcePath: text(item.revision.metadata.sourcePath) ?? item.sourceFile, path: item.revision.path })));
  report.publishingImport = hasPublishing(report.publishing) ? 'pending' : 'none';
  for (const plan of plans) {
    const records = publishingRecords(report.publishing).filter(record => record.workId === plan.work.id);
    plan.work.targetIds = [...new Set(records.map(record => record.targetId).filter((id): id is string => id !== null))];
    plan.work.legacy.publishing = { key: migrationKey, recordIds: records.map(record => record.id), needsObservation: records.filter(record => record.disposition === 'needs-observation').map(record => record.id) };
    const unknown = records.filter(record => record.disposition === 'needs-observation');
    for (const record of unknown) plan.progress.unfinished.push({ id: record.id, taskId: null, kind: record.table, status: 'needs-observation', operationKey: text(record.row.operation_key),
      receipt: object(record.decoded.receipt_json), reason: 'Retained unknown remote outcome must be observed, not resubmitted', nextTask: 'inkos.publishing.observe', artifactId: record.artifactId, revisionId: record.revisionId });
    if (unknown.length) {
      plan.progress.resume = { status: 'paused', taskId: null, reason: 'Publication needs observation; no remote operation or legacy task was replayed' };
      if (!['completed', 'cancelled'].includes(plan.work.status)) { plan.work.status = 'paused'; plan.work.pauseRequested = true; }
    }
    report.progress.push({ workId: plan.work.id, key: legacyProgressKey(migrationKey, plan.work.id), status: plan.progress.resume.status,
      reason: plan.progress.resume.reason, unfinished: plan.progress.unfinished });
  }
  const history: HistoryPlan[] = databases.map(database => ({ sourceFile: database.sourceFile, entries: [
    { migrationKey, sourceFile: database.sourceFile, schema: database.schema }, ...database.rows.map(row => ({ migrationKey, ...row })) ] }));
  for (const path of originals.filter(path => /\/\.inkos\/(sessions\/.*\.jsonl|session\.json|chat-requests\/.*\.json|tasks\/.*\.json)$/u.test(posix(path)))) history.push(await historyFromFile(path, migrationKey));
  report.history = history.map(item => ({ sourceFile: item.sourceFile, entryCount: item.entries.length, conversationId: null }));
  report.sourceFiles = [...new Set([...originals, ...archiveRevisions.map(item => item.sourceFile), ...databases.map(database => database.sourceFile), ...workSourceFiles, ...plans.flatMap(plan => plan.sourceFiles), ...report.conflicts.map(item => item.sourceFile)])].filter(path => !durableFiles.has(path)).sort();
  if (!options.apply) return report;
  // Immutable file writes may survive an interrupted apply. Their stable IDs make the next attempt reuse them.
  for (const item of [...plans.flatMap(plan => plan.revisions), ...archiveRevisions]) await persistRevision(root, item);
  const materialWrites = materials.flatMap(plan => plan.writes);
  if (materialWrites.length) await commitAtomicFileSet({ rootDir: root, writes: materialWrites });
  report.status = report.conflicts.length ? 'partial' : 'applied';
  const repeated = await harness.commit(async tx => {
    const doc = await tx.doc(ProjectDoc);
    if (doc.migrations[migrationKey]) return true;
    for (const plan of plans) {
      const work = await tx.doc(Works, plan.work.id, plan.work);
      if (doc.workIds.includes(work.id) || work.legacy.migrationKey !== migrationKey) throw new Error(`Work appeared during migration: ${work.id}`);
      for (const seed of plan.artifacts) {
        const artifact = await tx.doc(Artifacts, seed.id, seed);
        if (artifact.workId !== seed.workId || artifact.revisions.some(revision => revision.metadata.migrationKey !== migrationKey)) throw new Error(`Artifact appeared during migration: ${seed.id}`);
      }
      await tx.doc(LegacyProgress, legacyProgressKey(migrationKey, plan.work.id), plan.progress);
      doc.workIds.push(plan.work.id);
    }
    for (const item of archiveRevisions) await tx.doc(Artifacts, item.revision.artifactId, artifactSeed(item));
    for (const plan of materials) await tx.doc(LegacyMaterials, plan.doc.id, plan.doc);
    await tx.doc(LegacyPublishing, migrationKey, report.publishing);
    const globalProgress = planProgress(source, migrationKey, null, rows);
    await tx.doc(LegacyProgress, legacyProgressKey(migrationKey, null), globalProgress);
    for (const [index, item] of history.entries()) {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      for (const data of item.entries) await tx.appendEntry(LegacyHistoryEntry, conversation.id, { data });
      report.history[index].conversationId = conversation.id;
      for (const plan of plans) if (workRows(rows.filter(row => row.sourceFile === item.sourceFile), plan.work.id).length || item.entries.some(entry => {
        const event = object(entry.event); return event.workId === plan.work.id || event.bookId === plan.work.id || event.activeBook === plan.work.id;
      })) {
        (await tx.doc(Works, plan.work.id, plan.work)).history.push({ kind: LegacyHistoryEntry.kind, conversationId: conversation.id, sourceFile: item.sourceFile });
      }
    }
    await tx.doc(LegacyArchive, migrationKey, { version: DURABLE_MIGRATION_VERSION, source, files: archiveRevisions.map(fileRef), history: report.history });
    if (!Object.keys(doc.legacyConfig).length) doc.legacyConfig = config;
    doc.migrations[migrationKey] = { version: DURABLE_MIGRATION_VERSION, source, selection: location.selection, appliedAt: Date.now(),
      publishingImport: report.publishingImport, publishingError: null, report: report as unknown as JsonObject };
    return false;
  }, BACKGROUND_CONTEXT);
  if (repeated) {
    const current = await harness.snapshot(ProjectDoc, BACKGROUND_CONTEXT);
    return finishPublishing(harness, alreadyApplied(object(current?.migrations[migrationKey]).report as MigrationReport, true), options);
  }
  return finishPublishing(harness, report, options);
}
