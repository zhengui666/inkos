import { readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import type { JsonObject } from '@earendil-works/pi-durable';
import { assertId } from '../works/artifacts.js';
import { defaultPlan, type Artifact, type Work } from '../works/documents.js';
import { DURABLE_MIGRATION_VERSION, legacyProgressKey, type LegacyProgressState, type LegacyRow, type LegacyUnfinishedStep, type MigrationConflict } from './documents.js';
import { archiveFile, array, entries, errorText, exists, fileRef, files, formatOf, isDatabase, object, optionalJson, plannedRevision, posix, readJson, rowData, scanDatabase, text, timestamp, workRows, type PlannedRevision } from './source.js';

const V1 = [
  ['books', 'fiction', 'book.json'], ['shorts', 'short-fiction', 'outline'], ['dramas', 'script', 'script-spec.md'],
  ['storyboards', 'storyboard', 'storyboard-spec.md'], ['interactive-films', 'interactive-film', 'story-graph.json'],
  ['worlds', 'play', 'world.json'], ['translations', 'translation', 'manifest.json'],
] as const;
export const mapProfile = (id: string): string => ({ 'longform-novel': 'fiction', 'interactive-world': 'play', novel: 'fiction', drama: 'script' }[id] ?? id);
export type WorkSource = { id: string; profile: string; directory: string; marker: string | null; manifest: JsonObject; roots: string[] };
export type PlannedWork = { source: WorkSource; work: Work; artifacts: Artifact[]; revisions: PlannedRevision[]; progress: LegacyProgressState; sourceFiles: string[] };

export async function discoverWorks(source: string, selection: string | null, conflicts: MigrationConflict[]): Promise<WorkSource[]> {
  const works = new Map<string, WorkSource>();
  for (const entry of await entries(join(source, 'works'))) {
    if (!entry.isDirectory()) continue;
    const directory = join(source, 'works', entry.name), marker = join(directory, 'work.json');
    if (!await exists(marker)) continue;
    try {
      const manifest = await readJson(marker), id = assertId(text(manifest.id) ?? entry.name);
      if (manifest.version !== 2) throw new Error(`Unsupported Work manifest version: ${manifest.version}`);
      if (works.has(id)) throw new Error(`Duplicate Work ID: ${id}`);
      works.set(id, { id, profile: mapProfile(text(manifest.profileId) ?? 'fiction'), directory, marker, manifest, roots: [join(directory, 'source')] });
    } catch (error) { conflicts.push({ workId: entry.name, sourceFile: marker, reason: errorText(error) }); }
  }
  for (const [root, profile, markerName] of V1) for (const entry of await entries(join(source, root))) {
    if (!entry.isDirectory()) continue;
    const directory = join(source, root, entry.name), marker = join(directory, markerName);
    if (!await exists(marker)) continue;
    try {
      const manifest = markerName.endsWith('.json') ? await readJson(marker) : {};
      const id = assertId(text(manifest.id) ?? entry.name), existing = works.get(id);
      if (existing) {
        if (existing.profile === profile && object(existing.manifest.metadata).legacySource === `${root}/${entry.name}`) existing.roots.push(directory);
        else conflicts.push({ workId: id, sourceFile: marker, reason: 'Source work ID collides with another content source' });
      } else works.set(id, { id, profile, directory, marker: markerName.endsWith('.json') ? marker : null, manifest, roots: [directory] });
    } catch (error) { conflicts.push({ workId: entry.name, sourceFile: marker, reason: errorText(error) }); }
  }
  return [...works.values()].filter(work => !selection || posix(relative(source, work.directory)) === selection || work.roots.some(root => posix(relative(source, root)) === selection));
}
function withoutInlineBytes(manifest: JsonObject): JsonObject {
  const result = JSON.parse(JSON.stringify(manifest)) as JsonObject;
  if (Array.isArray(result.artifacts)) result.artifacts = result.artifacts.map(value => {
    const artifact = object(value);
    return { ...artifact, revisions: array(artifact.revisions).map(value => { const { contentBase64: _bytes, ...revision } = object(value); return revision; }) };
  });
  return result;
}
async function manifestArtifacts(source: WorkSource, migrationKey: string): Promise<{ artifacts: Artifact[]; revisions: PlannedRevision[] }> {
  const artifacts: Artifact[] = [], revisions: PlannedRevision[] = [];
  for (const input of array(source.manifest.artifacts)) {
    const old = object(input), id = assertId(text(old.id) ?? ''), current = text(old.currentRevisionId) ?? '';
    if (artifacts.some(artifact => artifact.id === id)) throw new Error(`Duplicate artifact ID: ${id}`);
    const artifact: Artifact = { id, workId: source.id, title: text(object(old.metadata).title) ?? text(old.title) ?? id, currentRevision: current, revisions: [] };
    for (const value of array(old.revisions)) {
      const legacy = object(value), revisionId = assertId(text(legacy.id) ?? '');
      if (artifact.revisions.some(revision => revision.id === revisionId)) throw new Error(`Duplicate revision ID: ${revisionId}`);
      const path = text(legacy.path), snapshot = text(legacy.snapshotPath);
      const snapshotFile = snapshot ? resolve(source.directory, snapshot) : null;
      let sourceFile: string, base64: string | undefined;
      if (snapshotFile && await exists(snapshotFile)) sourceFile = snapshotFile;
      else if (typeof legacy.contentBase64 === 'string') { sourceFile = resolve(source.directory, snapshot ?? path ?? `${id}.bin`); base64 = legacy.contentBase64; }
      else {
        // A shared mutable source path is not the bytes of a superseded/candidate revision.
        const sharedPath = array(old.revisions).some(value => object(value).id !== revisionId && object(value).path === path);
        if (revisionId !== current && (snapshot || sharedPath || path?.startsWith('source/'))) throw new Error(`Historical revision bytes unavailable: ${id}/${revisionId}; current source was not substituted`);
        if (!path || !await exists(resolve(source.directory, path))) throw new Error(`Revision bytes unavailable: ${id}/${revisionId}`);
        sourceFile = resolve(source.directory, path);
      }
      const { contentBase64: _bytes, ...revisionMetadata } = legacy;
      const item = plannedRevision({ workId: source.id, artifactId: id, revisionId, title: artifact.title, sourceFile, migrationKey,
        ...(base64 !== undefined ? { base64 } : {}), format: formatOf(path ?? sourceFile, legacy.contentType), createdAt: timestamp(legacy.createdAt),
        metadata: { ...object(old.metadata), legacy: revisionMetadata, kind: old.kind ?? 'unknown', lineage: source.manifest.lineage ?? [],
          sourcePath: path ?? snapshot ?? '', currentRevisionId: old.currentRevisionId ?? null } });
      artifact.revisions.push(item.revision); revisions.push(item);
    }
    if (current && !artifact.revisions.some(revision => revision.id === current)) throw new Error(`Current revision not found: ${id}/${current}`);
    artifacts.push(artifact);
  }
  return { artifacts, revisions };
}
function controlStatus(book: JsonObject, manifest: JsonObject, rows: LegacyRow[]): { status: Work['status']; reason: string } {
  const bookStatus = text(book.status);
  if (bookStatus === 'paused') return { status: 'paused', reason: 'Legacy book was paused' };
  if (bookStatus === 'completed') return { status: 'completed', reason: 'Legacy book was completed' };
  if (bookStatus === 'dropped' || bookStatus === 'cancelled') return { status: 'cancelled', reason: 'Legacy book was dropped/cancelled' };
  const creations = rows.filter(row => row.table === 'creation_tasks').map(rowData);
  if (creations.some(task => task.desiredState === 'paused')) return { status: 'paused', reason: 'Legacy creation desiredState was paused' };
  const goals = rows.filter(row => row.table === 'goals').map(rowData);
  if (goals.some(goal => goal.desiredState === 'cancelled' || goal.status === 'cancelled')) return { status: 'cancelled', reason: 'Legacy goal was cancelled' };
  if (goals.some(goal => goal.desiredState === 'paused' && goal.status !== 'completed')) return { status: 'paused', reason: 'Legacy goal desiredState was paused' };
  if (goals.length && goals.every(goal => goal.status === 'completed')) return { status: 'completed', reason: 'Legacy goals were completed' };
  if (creations.some(task => task.phase === 'completed')) return { status: 'completed', reason: 'Legacy creation was completed' };
  if (rows.some(row => row.table === 'scheduler_control' && Number(row.row.stop_requested) === 1)) return { status: 'paused', reason: 'Legacy scheduler stop_requested was set' };
  if (manifest.status === 'archived') return { status: 'paused', reason: 'Legacy archived status does not identify a completion/cancellation' };
  return { status: bookStatus === 'active' || manifest.status === 'active' ? 'active' : 'draft', reason: 'Legacy controls retained' };
}
function unfinishedStep(data: JsonObject, taskId: string | null, kind: string, fallbackId: string): LegacyUnfinishedStep | null {
  const status = text(data.status) ?? text(data.phase) ?? 'unknown';
  if (['completed', 'cancelled', 'dropped', 'skipped'].includes(status)) return null;
  const stepKind = text(data.kind) ?? kind;
  const publishing = /publish|observ|remote/u.test(stepKind) || data.publicationStartedAt !== undefined;
  const content = /write|writing|review|revis|compose|draft|chapter/u.test(stepKind);
  return { id: text(data.id) ?? fallbackId, taskId, kind: stepKind, status, operationKey: text(data.operationKey),
    receipt: data.receipt ? object(data.receipt) : data.reviewReceipt ? object(data.reviewReceipt) : null,
    nextTask: publishing ? 'inkos.publishing.observe' : content ? 'inkos.content' : null,
    artifactId: text(data.artifactId), revisionId: text(data.revisionId),
    reason: publishing ? 'Observe retained remote state before any submission; no old executor is resumed'
      : 'No equivalent new task checkpoint is recorded; retain receipts/content and pause rather than replay the old step' };
}
export function planProgress(source: string, migrationKey: string, workId: string | null, rows: LegacyRow[]): LegacyProgressState {
  const records = rows.filter(row => /^(goals|goal_|creation_tasks|scheduler_|creative_episode|short_revision)/u.test(row.table) && !row.table.endsWith('_events'));
  const unfinished: LegacyUnfinishedStep[] = [], taskIds = new Set<string>(), seen = new Set<string>();
  const add = (data: JsonObject, taskId: string | null, kind: string, id: string) => {
    const step = unfinishedStep(data, taskId, kind, id), identity = JSON.stringify([taskId, text(data.operationKey) ?? text(data.id) ?? id]);
    if (step && !seen.has(identity)) { unfinished.push(step); seen.add(identity); }
  };
  for (const record of records) {
    const data = rowData(record), id = text(record.row.id) ?? text(data.id) ?? text(record.row.episode_id) ?? text(data.goalId);
    if (['goals', 'creation_tasks', 'creative_episodes'].includes(record.table) && id) taskIds.add(id);
    const linkedTask = text(record.row.goal_id) ?? text(data.goalId) ?? text(data.operationId);
    if (linkedTask) taskIds.add(linkedTask);
    if (record.table === 'goals') {
      const sqlSteps = records.filter(row => row.table === 'goal_steps' && row.row.goal_id === record.row.id);
      if (!sqlSteps.length) for (const step of array(data.steps).map(object)) add(step, id, 'goal-step', `${id}:step`);
    } else if (record.table === 'goal_steps') add({ ...data, operationKey: data.operationKey ?? record.row.operation_key ?? null }, text(record.row.goal_id), 'goal-step', text(record.row.id) ?? 'step');
    else if (record.table === 'creation_tasks') add(data, id, text(data.phase) ?? 'creation', id ?? 'creation');
    else if (record.table === 'scheduler_chapters') add(data, text(data.goalId), text(data.phase) ?? 'chapter', `chapter:${record.row.chapter}`);
    else if (record.table === 'scheduler_foundations') add(data, null, 'foundation', text(record.row.scan_id) ?? 'foundation');
    else if (record.table === 'creative_episodes' && record.row.status === 'running') add({ ...data, status: 'running' }, id, 'legacy-episode', id ?? 'episode');
    else if (record.table === 'short_revisions') add(object(data.progress), text(data.operationId), 'short-revision', text(data.operationId) ?? 'short-revision');
  }
  return { version: DURABLE_MIGRATION_VERSION, migrationKey, source, workId, records, taskIds: [...taskIds], unfinished,
    resume: { status: unfinished.length ? 'paused' : records.length ? 'terminal' : 'none', taskId: null,
      reason: unfinished.length ? 'Business progress retained; old model sessions are history only. No safe new checkpoint, so no task was created.' : 'No unfinished legacy business step recorded' } };
}

export async function planWork(input: WorkSource, source: string, migrationKey: string, allRows: LegacyRow[], config: JsonObject): Promise<PlannedWork> {
  const manifests = await manifestArtifacts(input, migrationKey), sourceFiles = new Set<string>();
  if (input.marker) sourceFiles.add(input.marker);
  for (const root of input.roots) for (const path of await files(root)) sourceFiles.add(path);
  // Include revision stores and the raw manifest even when they are outside source/.
  if (input.manifest.version === 2) for (const path of await files(input.directory)) sourceFiles.add(path);
  const bookFiles = input.roots.map(root => join(root, 'book.json'));
  const book = Object.assign({}, ...await Promise.all([...bookFiles].reverse().map(optionalJson))) as JsonObject;
  const rows = workRows(allRows, input.id);
  rows.push(...allRows.filter(row => row.table === 'scheduler_control' || row.table === 'scheduler_timers'));
  const domain: JsonObject = {}, fileIndex: JsonObject = {}, structured: JsonObject = {};
  const artifacts = manifests.artifacts, revisions = manifests.revisions;
  for (const path of sourceFiles) {
    if (/-wal$|-shm$|-journal$/u.test(path)) continue;
    const existing = revisions.find(item => item.base64 === undefined && item.sourceFile === path);
    const item = existing ?? archiveFile(source, input.id, path, migrationKey);
    if (!existing) { revisions.push(item); artifacts.push({ id: item.revision.artifactId, workId: input.id, title: item.revision.title, currentRevision: item.revision.id, revisions: [item.revision] }); }
    fileIndex[posix(relative(source, path))] = fileRef(item);
    for (const root of input.roots) {
      const name = posix(relative(root, path));
      if (name.startsWith('../')) continue;
      if (isDatabase(path)) {
        const database = scanDatabase(path), tables: JsonObject = {};
        for (const row of database.rows) {
          const values = array(tables[row.table]); values.push({ ...row.row, decoded: row.decoded }); tables[row.table] = values as JsonObject[];
        }
        const databases = object(domain.databases); databases[name] = { sourceFile: path, schema: database.schema, tables }; domain.databases = databases;
        if (database.schema.some(table => table.name === 'entities')) {
          const play = object(domain.play), runs = object(play.runs), runId = name.split('/').at(-2) ?? 'main';
          runs[runId] = { sourceFile: path, entities: tables.entities ?? [], edges: tables.edges ?? [], stateSlots: tables.state_slots ?? [], events: tables.events ?? [], tables };
          domain.play = { ...play, runs };
        }
      } else if (name.endsWith('.json') && (/^(story\/state\/|story\/runtime\/.*\.plan\.json$)/u.test(name) || ['book.json', 'chapters/index.json', 'story/book_rules.json', 'story/reference_bindings.json', 'story-graph.json', 'authoring-state.json', 'world.json', 'manifest.json', 'glossary.json', 'script.json', 'storyboard.json', 'production-state.json'].includes(name))) {
        const value = JSON.parse(await readFile(path, 'utf8'));
        structured[name] ??= value;
        if (name.startsWith('story/state/')) domain[basename(name, '.json')] ??= value;
        if (name === 'story/book_rules.json') { domain.bookRules = { ...object(value), ...object(domain.bookRules) }; if (object(value).readerContract !== undefined) domain.readerContract ??= object(value).readerContract; }
        if (name === 'story/reference_bindings.json') domain.referenceBindings ??= value;
        if (name === 'chapters/index.json') domain.chapters ??= value;
        if (name === 'story-graph.json') domain.graph ??= value;
        if (name === 'world.json') domain.world ??= value;
        if (name === 'authoring-state.json') domain.authoringState ??= value;
        if (name === 'script.json') domain.script ??= value;
        if (name === 'storyboard.json') domain.storyboard ??= value;
      } else if (name === 'story/book_rules.md') {
        const markdown = await readFile(path, 'utf8'), frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
        if (frontmatter) {
          const rules = object(JSON.parse(JSON.stringify(loadYaml(frontmatter[1]) ?? {})));
          domain.bookRules = { ...rules, ...object(domain.bookRules) };
          if (rules.readerContract !== undefined) domain.readerContract ??= rules.readerContract;
        }
      }
      if (name === 'story/author_intent.md') domain.authorIntent ??= fileRef(item);
      if (name === 'story/current_focus.md') domain.focus ??= fileRef(item);
      if (name.startsWith('story/outline/')) { const outline = object(domain.outline); outline[name] ??= fileRef(item); domain.outline = outline; }
    }
  }
  domain.files = fileIndex; domain.structured = structured;
  const metadata = object(input.manifest.metadata);
  if (domain.readerContract === undefined && (book.readerContract ?? metadata.readerContract) !== undefined) domain.readerContract = book.readerContract ?? metadata.readerContract;
  if (input.profile === 'translation') {
    const translationFiles = Object.entries(fileIndex).filter(([path]) => /\/(source|translated)\/chapter-.*\.json$/u.test(path));
    const manifest = object(structured['manifest.json'] ?? input.manifest);
    domain.translation = { manifest, glossary: structured['glossary.json'] ?? {},
      source: translationFiles.filter(([path]) => /\/source\/chapter-/u.test(path)).map(([, ref]) => ref), target: translationFiles.filter(([path]) => /\/translated\/chapter-/u.test(path)).map(([, ref]) => ref),
      sourceLanguage: manifest.sourceLanguage ?? metadata.sourceLanguage ?? null, targetLanguage: manifest.targetLanguage ?? metadata.targetLanguage ?? null };
  }
  const creation = rowData(rows.find(row => row.table === 'creation_tasks') ?? { sourceFile: '', table: '', row: {}, decoded: {} });
  const creationPlan = object(creation.plan), request = object(creation.request);
  const progress = planProgress(source, migrationKey, input.id, rows);
  for (const step of progress.unfinished) if (step.revisionId && !step.artifactId) step.artifactId = artifacts.find(artifact => artifact.revisions.some(revision => revision.id === step.revisionId))?.id ?? null;
  const controls = controlStatus(book, input.manifest, rows);
  const terminal = controls.status === 'completed' || controls.status === 'cancelled';
  const status = !terminal && (progress.unfinished.length || controls.status === 'active') ? 'paused' : controls.status;
  if (terminal) progress.resume = { status: 'terminal', taskId: null, reason: controls.reason };
  else if (status === 'paused') progress.resume = { status: 'paused', taskId: null,
    reason: progress.unfinished.length ? `${controls.reason}. ${progress.resume.reason}` : `${controls.reason}. No explicit next new task input/checkpoint is saved; imported content will not be replayed.` };
  const plan = defaultPlan(text(request.brief) ?? text(metadata.brief) ?? text(book.brief) ?? '');
  const targetUnits = creationPlan.targetChapters ?? book.targetChapters ?? metadata.targetChapters;
  plan.serial = input.profile === 'fiction';
  plan.units = typeof targetUnits === 'number' && targetUnits > 0 ? targetUnits : plan.serial ? null : 1;
  plan.needsPlanning = metadata.migrationNeedsReconstruction !== undefined || (!artifacts.length && !terminal);
  const locale = new Intl.Locale((text(book.language) ?? text(creationPlan.language) ?? text(object(domain.translation).targetLanguage) ?? text(input.manifest.targetLanguage) ?? text(input.manifest.language) ?? text(config.language) ?? 'zh').replaceAll('_', '-')).toString();
  const bindings = array(object(domain.referenceBindings).bindings).map(object);
  const work: Work = { id: input.id, title: text(book.title) ?? text(creationPlan.title) ?? text(input.manifest.title) ?? input.id,
    profile: input.profile, locale, status, plan, artifactIds: artifacts.map(artifact => artifact.id), targetIds: [], materialIds: [...new Set(bindings.map(binding => text(binding.materialId)).filter((id): id is string => id !== null))],
    domain, history: [], legacy: { migrationKey, source, sourceFiles: [...sourceFiles], manifest: withoutInlineBytes(input.manifest), book,
      lineage: input.manifest.lineage ?? [], controls: { status: controls.status, reason: controls.reason },
      progress: { key: legacyProgressKey(migrationKey, input.id), taskIds: progress.taskIds, unfinished: progress.unfinished },
      ...(creation.request ? { request: creation.request, effectiveDeliveryMode: request.deliveryMode ?? 'publish' } : {}) },
    pauseRequested: status === 'paused', createdAt: timestamp(book.createdAt ?? input.manifest.createdAt ?? creation.createdAt),
    updatedAt: timestamp(book.updatedAt ?? input.manifest.updatedAt ?? creation.updatedAt) };
  return { source: input, work, artifacts, revisions, progress, sourceFiles: [...sourceFiles] };
}
