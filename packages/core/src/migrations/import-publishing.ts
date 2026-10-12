import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { configure, type Harness, type JsonObject } from '@earendil-works/pi-durable';
import { Artifacts, ProjectDoc, Works, type Artifact, type ArtifactRevision, type Work } from '../works/documents.js';
import { Distributions, PublishingTargets } from '../publishing/documents.js';
import { distributionKey, emptyMapping, emptyRemote, type BrowserObservation, type Distribution, type DistributionRequest, type PublishingTarget } from '../publishing/contracts.js';
import { LegacyPublishing, type LegacyPublishingData, type LegacyPublishingRecord } from './documents.js';
import { array, object, text, timestamp } from './source.js';
import { publishingRecords } from './publishing.js';

const VERSION = 1;
const body = (record: LegacyPublishingRecord): JsonObject => ({ ...record.row, ...object(record.decoded.target_json ?? record.decoded.manifest_json ?? record.decoded.run_json ?? record.decoded.state_json ?? record.decoded.receipt_json ?? record.decoded.action_json) });
const ref = (record: LegacyPublishingRecord): JsonObject => ({ id: record.id, table: record.table, sourceFile: record.sourceFile });
const unique = (values: (string | null)[]): string[] => [...new Set(values.filter((value): value is string => value !== null))];
const numberOf = (value: JsonObject): number | null => {
  const number = value.number ?? value.chapterNumber ?? value.chapter;
  return typeof number === 'number' && number > 0 ? number : null;
};
const packId = (record: LegacyPublishingRecord): string | null => record.table === 'publishing_packages'
  ? text(record.row.id) ?? text(body(record).id) ?? record.id : text(record.row.package_id) ?? text(body(record).packageId) ?? record.packageId;
const targetId = (record: LegacyPublishingRecord): string | null => record.table === 'publishing_targets'
  ? text(record.row.id) ?? text(body(record).id) ?? record.targetId ?? record.id
  : text(record.row.target_id) ?? text(body(record).targetId) ?? text(object(body(record).target).id) ?? record.targetId;
const workId = (record: LegacyPublishingRecord): string | null => text(record.row.work_id) ?? text(body(record).workId)
  ?? text(object(body(record).target).workId) ?? text(object(body(record).input).workId) ?? record.workId;
const scope = (value: JsonObject): JsonObject => object(value.scope ?? object(value.input).destination ?? value.destination);
const receipt = (value: JsonObject): JsonObject => object(value.receipt);
const accountId = (record: LegacyPublishingRecord): string | null => text(record.row.account_id) ?? text(body(record).observedAccountId)
  ?? text(object(body(record).config).accountId) ?? text(body(record).accountId) ?? text(scope(body(record)).accountId)
  ?? text(object(receipt(body(record)).destination).accountId) ?? record.accountId;
const remoteBookId = (record: LegacyPublishingRecord): string | null => text(record.row.remote_book_id) ?? text(body(record).remoteBookId)
  ?? text(scope(body(record)).remoteBookId) ?? text(receipt(body(record)).remoteBookId) ?? record.remoteBookId;
const remoteChapterId = (record: LegacyPublishingRecord): string | null => text(record.row.remote_chapter_id) ?? text(body(record).remoteChapterId)
  ?? text(receipt(body(record)).remoteChapterId) ?? record.remoteChapterId;
const platform = (record: LegacyPublishingRecord): string | null => text(body(record).platform) ?? text(object(body(record).target).platform)
  ?? text(scope(body(record)).platform) ?? (record.table === 'publishing_fanqie_runs' ? 'fanqie' : record.table === 'publishing_meganovel_runs' ? 'meganovel' : null);
const at = (record: LegacyPublishingRecord): number => {
  const value = body(record);
  return timestamp(value.updatedAt ?? value.observedAt ?? receipt(value).observedAt ?? value.createdAt ?? value.created_at ?? value.attemptedAt);
};
type Issue = { targetId: string | null; sourceFile: string; reason: string };
type TargetPlan = { id: string; value: JsonObject; records: LegacyPublishingRecord[]; definitions: LegacyPublishingRecord[]; work: Work; seed: PublishingTarget; prior?: PublishingTarget };
type Selection = { target: TargetPlan; value: JsonObject; facts: LegacyPublishingRecord[]; source: LegacyPublishingRecord; artifact: Artifact; revision: ArtifactRevision; basis: string };
type Fact = { record: LegacyPublishingRecord; state: string; unknown: boolean; reported: boolean; verified: boolean; evidence: string | null; at: number };
function fact(record: LegacyPublishingRecord, target: PublishingTarget, selection?: Selection): Fact {
  const value = body(record), state = text(value.phase) ?? text(value.status) ?? text(receipt(value).status) ?? 'retained';
  const reported = record.disposition === 'user-reported' || value.provenance === 'user_reported' || receipt(value).provenance === 'user_reported' || state.endsWith('_reported');
  const unknown = record.disposition === 'needs-observation' || /(?:^|_)unknown$/u.test(state) || state === 'awaiting_receipt';
  const evidence = text(value.evidence) ?? text(receipt(value).evidence);
  const browserRun = ['publishing_fanqie_runs', 'publishing_meganovel_runs'].includes(record.table);
  const observed = browserRun || record.disposition === 'observed' || value.provenance === 'independently_observed' || receipt(value).provenance === 'independently_observed';
  const recordedRevision = text(value.revisionId), recordedArtifact = text(value.artifactId);
  const mismatch = !!selection && (recordedRevision !== null && ![text(selection.value.revisionId), selection.revision.id].includes(recordedRevision)
    || recordedArtifact !== null && ![text(selection.value.artifactId), selection.artifact.id].includes(recordedArtifact));
  const verified = observed && !unknown && !reported && !mismatch && !!evidence && !!remoteChapterId(record) && !!remoteBookId(record)
    && !!accountId(record) && accountId(record) === target.config.accountId && (!target.config.remote.workId || remoteBookId(record) === target.config.remote.workId);
  return { record, state, unknown: unknown || mismatch || browserRun && !verified, reported, verified, evidence, at: at(record) };
}
function canonicalPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^.*\/(?=works\/|books\/)/u, '')
    .replace(/^works\/[^/]+\/source\//u, '').replace(/^books\/[^/]+\//u, '').replace(/^source\/(?=chapters\/)/u, '').replace(/^\.\//u, '');
}
function resolveSelection(data: LegacyPublishingData, target: TargetPlan, value: JsonObject, artifacts: Artifact[]): { artifact: Artifact; revision: ArtifactRevision; basis: string } | null {
  const id = text(value.artifactId), revisionId = text(value.revisionId), exact = artifacts.find(artifact => artifact.id === id);
  if (exact) {
    const revision = revisionId ? exact.revisions.find(revision => revision.id === revisionId) : exact.revisions.length === 1 ? exact.revisions[0] : undefined;
    if (revision) return { artifact: exact, revision, basis: 'original-ids' };
    // An explicitly selected historical revision must never become the current revision.
    if (revisionId) return null;
  }
  const sourcePath = text(value.sourcePath) ?? text(value.path), number = numberOf(value);
  const mappings = data.artifactMappings.filter(mapping => mapping.workId === target.work.id);
  let matches = mappings.filter(mapping => sourcePath && canonicalPath(mapping.sourcePath) === canonicalPath(sourcePath));
  let basis = 'source-path';
  if (!matches.length && number !== null) {
    basis = 'chapter-number';
    matches = mappings.filter(mapping => !mapping.sourcePath.includes('/.versions/') && /(?:^|\/)chapters\/\d+[^/]*\.(?:md|txt)$/u.test(mapping.sourcePath)
      && Number(/(?:^|\/)chapters\/(\d+)/u.exec(mapping.sourcePath)?.[1]) === number);
    if (!matches.length) matches = artifacts.flatMap(artifact => artifact.revisions.filter(revision => numberOf(revision.metadata) === number
      && (revision.metadata.kind === 'chapter' || revision.metadata.number !== undefined)).map(revision => ({ workId: artifact.workId, artifactId: artifact.id, revisionId: revision.id, sourcePath: '', path: revision.path })));
  }
  if (revisionId && matches.some(mapping => mapping.revisionId === revisionId)) matches = matches.filter(mapping => mapping.revisionId === revisionId);
  const identities = new Map(matches.map(mapping => [JSON.stringify([mapping.artifactId, mapping.revisionId]), mapping]));
  if (identities.size !== 1) return null;
  const mapping = [...identities.values()][0], artifact = artifacts.find(artifact => artifact.id === mapping.artifactId);
  const revision = artifact?.revisions.find(revision => revision.id === mapping.revisionId);
  return artifact && revision ? { artifact, revision, basis } : null;
}
function request(selection: Selection): DistributionRequest {
  const latest = [...selection.facts].sort((a, b) => Number(['publishing_fanqie_runs', 'publishing_meganovel_runs'].includes(b.table)) - Number(['publishing_fanqie_runs', 'publishing_meganovel_runs'].includes(a.table)) || at(b) - at(a))[0], value = latest ? body(latest) : selection.value;
  const schedule = value.scheduledFor ?? value.scheduledAt ?? selection.value.scheduledAt;
  return { revisionId: selection.revision.id, operation: value.operation === 'update' || selection.value.operation === 'update' ? 'update' : 'publish',
    scheduledAt: schedule === undefined || schedule === null ? null : timestamp(schedule), requestId: text(value.requestId) ?? text(selection.value.requestId) ?? text(body(selection.source).operationKey) ?? text(selection.source.row.operation_key) };
}
function distributionSeed(selections: Selection[]): { seed: Distribution; legacy: JsonObject; retainIntent: boolean } {
  selections.sort((a, b) => at(a.source) - at(b.source) || Number(a.source.row.version ?? 0) - Number(b.source.row.version ?? 0));
  const latest = selections.at(-1)!, target = latest.target.seed;
  const facts = latest.facts.map(record => fact(record, target, latest));
  const rank = (value: Fact) => value.unknown ? 4 : value.verified ? 3 : value.reported ? 2 : 1;
  facts.sort((a, b) => a.at - b.at || rank(a) - rank(b));
  // Old browser runs deliberately left the manual chapter row at awaiting_receipt.
  const browserFacts = facts.filter(value => ['publishing_fanqie_runs', 'publishing_meganovel_runs'].includes(value.record.table));
  const last = (browserFacts.length ? browserFacts : facts).at(-1), desired = request(latest);
  const id = distributionKey(target.id, latest.artifact.id), remote = emptyRemote();
  const state = last?.state ?? 'awaiting_submission';
  const knownStates = ['draft', 'submitted', 'reviewing', 'published', 'rejected', 'user-action'];
  let status: Distribution['status'] = last?.verified && knownStates.includes(state) ? state as Distribution['status']
    : last?.verified && state === 'scheduled' ? 'submitted' : last?.unknown || last?.reported ? 'needs-observation' : 'queued';
  remote.workId = last ? remoteBookId(last.record) : null; remote.workId ??= target.config.remote.workId;
  remote.artifactId = last ? remoteChapterId(last.record) : null;
  const retainedIds = unique(selections.flatMap(selection => selection.facts.map(remoteChapterId)));
  remote.artifactId ??= text(target.config.remote.artifactIds[latest.artifact.id]) ?? (retainedIds.length === 1 ? retainedIds[0] : null);
  const lastValue = last ? body(last.record) : {};
  remote.authorUrl = text(lastValue.authorUrl) ?? text(lastValue.chapterUrl) ?? text(lastValue.remoteChapterUrl) ?? text(object(lastValue.remote).authorUrl) ?? text(target.config.remote.artifactUrls[latest.artifact.id]);
  remote.readerUrl = text(lastValue.readerUrl) ?? text(object(lastValue.remote).readerUrl) ?? text(target.config.remote.readerUrls[latest.artifact.id]);
  let observed: string | null = null, submitted: string | null = null, published: string | null = null;
  for (const selection of selections) for (const record of selection.facts) {
    const proof = fact(record, target, selection);
    if (!proof.verified) continue;
    observed = selection.revision.id;
    if (['submitted', 'reviewing', 'published', 'rejected', 'scheduled'].includes(proof.state)) submitted = selection.revision.id;
    if (proof.state === 'published') published = selection.revision.id;
  }
  const observations: BrowserObservation | null = last?.verified ? { state: status as BrowserObservation['state'], accountId: accountId(last.record), remote,
    title: text(latest.value.title), body: null, complete: false, notApplied: false, evidence: last.evidence!, observedAt: last.at } : null;
  const identityIssue = !target.config.accountId || target.config.metadata.legacy && array(object(target.config.metadata.legacy).issues).length > 0;
  if (identityIssue && status !== 'needs-observation') status = 'needs-observation';
  const retainIntent = status === 'needs-observation' && !!last && (last.unknown || last.reported);
  const error = identityIssue ? 'Legacy publishing identity/setup needs resolution; see target.config.metadata.legacy'
    : status === 'needs-observation' ? 'Legacy remote outcome requires independent observation; user reports are not observations'
      : status === 'queued' ? 'Legacy pending submission retained; no task was started' : null;
  const requests: Distribution['requests'] = {};
  for (const selection of selections) { const value = request(selection); if (value.requestId) requests[value.requestId] = value; }
  return { seed: { id, targetId: target.id, artifactId: latest.artifact.id, workId: latest.target.work.id, desired, taskId: null, status, intent: null,
    observationConversationId: null, remote, lastObservation: observations, observedRevisionId: observed, submittedRevisionId: submitted, publishedRevisionId: published,
    requests, error, createdAt: at(selections[0].source), updatedAt: Math.max(at(latest.source), ...facts.map(fact => fact.at), 0) }, retainIntent,
    legacy: { status: state, sources: selections.map(selection => ({ ...ref(selection.source), selection: selection.value, artifactId: selection.artifact.id,
      revisionId: selection.revision.id, mapping: selection.basis, records: selection.facts.map(ref) })),
      facts: facts.map(fact => ({ ...ref(fact.record), state: fact.state, verified: fact.verified, userReported: fact.reported, unknown: fact.unknown,
        accountId: accountId(fact.record), remoteBookId: remoteBookId(fact.record), remoteChapterId: remoteChapterId(fact.record), evidence: fact.evidence, observedAt: fact.at })),
      retainedIntent: retainIntent, intentOrigin: retainIntent ? 'legacy-business-attempt-not-a-new-model-session' : null } };
}

/** Converts retained local publishing evidence only. Does not resume the Harness, create tasks, or touch source files. */
export async function importLegacyPublishing(harness: Harness, data: LegacyPublishingData): Promise<void> {
  const markerKey = `${data.migrationKey}:publishing-documents-v${VERSION}`;
  const project = await harness.snapshot(ProjectDoc, BACKGROUND_CONTEXT);
  if (project?.migrations[markerKey]) return;
  const records = publishingRecords(data), issues: Issue[] = [];
  const packages = new Map(data.packages.map(record => [packId(record), record]));
  const definitions = new Map<string, { value: JsonObject; definitions: LegacyPublishingRecord[]; records: LegacyPublishingRecord[] }>();
  const addDefinition = (id: string | null, value: JsonObject, record: LegacyPublishingRecord) => {
    if (!id) return;
    const prior = definitions.get(id);
    if (prior) { prior.value = { ...value, ...prior.value }; if (!prior.definitions.includes(record)) prior.definitions.push(record); }
    else definitions.set(id, { value, definitions: [record], records: [] });
  };
  for (const record of data.targets) addDefinition(targetId(record), body(record), record);
  for (const record of [...data.packages, ...data.preparations]) addDefinition(text(object(body(record).target).id) ?? targetId(record), object(body(record).target), record);
  for (const record of [...data.bindings, ...data.remoteWorkRuns]) addDefinition(targetId(record), { workId: workId(record), platform: platform(record) }, record);
  for (const record of records) {
    const id = targetId(record) ?? (packages.get(packId(record)) ? targetId(packages.get(packId(record))!) : null);
    if (id && definitions.has(id)) definitions.get(id)!.records.push(record);
    else {
      const matches = [...definitions.values()].filter(group => {
        const localId = text(group.value.workId) ?? group.definitions.map(workId).find(Boolean);
        const destination = text(group.value.platform) ?? group.definitions.map(platform).find(Boolean);
        return !!localId && localId === workId(record) && (!platform(record) || destination === platform(record));
      });
      if (matches.length === 1) matches[0].records.push(record);
      else if (record.table !== 'publishing_events') issues.push({ targetId: id, sourceFile: record.sourceFile, reason: `No unambiguous original target for ${record.table}/${record.id}` });
    }
  }
  const targets: TargetPlan[] = [], artifactsByWork = new Map<string, Artifact[]>();
  for (const [id, group] of definitions) {
    const localIds = unique([text(group.value.workId), ...group.records.map(workId), ...group.definitions.map(workId)]);
    const localId = localIds.length === 1 ? localIds[0] : null;
    const work = localId ? await harness.snapshot(Works, localId, BACKGROUND_CONTEXT) : undefined;
    if (!work) { issues.push({ targetId: id, sourceFile: group.definitions[0].sourceFile, reason: `Missing or ambiguous durable work identity: ${localIds.join(', ') || '(none)'}` }); continue; }
    const prior = await harness.snapshot(PublishingTargets, id, BACKGROUND_CONTEXT);
    if (prior && object(prior.config.metadata.legacy).migrationKey !== data.migrationKey) throw new Error(`Publishing target ID already exists: ${id}`);
    const all = [...new Set([...group.definitions, ...group.records])], config = object(group.value.config);
    const accounts = unique([text(config.accountId), text(group.value.observedAccountId), ...all.map(accountId)]);
    const books = unique([text(object(config.remote).workId), text(group.value.remoteBookId), ...all.map(remoteBookId)]);
    const targetIssues: string[] = [];
    if (accounts.length !== 1) targetIssues.push(accounts.length ? 'Conflicting actual account IDs; account labels were not used as identity' : 'Missing actual account ID; accountLabel is not an account ID');
    if (books.length !== 1) targetIssues.push(books.length ? 'Conflicting remote work IDs; mappings remain in legacy evidence' : 'Missing remote work identity');
    const destination = text(group.value.platform) ?? all.map(platform).find((value): value is string => !!value) ?? '';
    const entryUrl = text(config.entryUrl) ?? text(group.value.entryUrl) ?? ({ fanqie: 'https://fanqienovel.com/', meganovel: 'https://www.meganovel.com/' } as Record<string, string>)[destination] ?? '';
    if (!entryUrl) targetIssues.push('Missing publisher entry URL');
    else { try { new URL(entryUrl); } catch { targetIssues.push('Invalid retained publisher entry URL'); } }
    const pendingCreation = all.filter(record => record.table === 'publishing_remote_work_runs' && (body(record).phase === 'create_unknown' || record.unknownStates.includes('create_unknown')));
    if (pendingCreation.length) targetIssues.push('Remote work creation needs observation; no creation task was restarted');
    const remote = { ...emptyMapping(), ...object(config.remote), artifactIds: { ...object(object(config.remote).artifactIds) } as Record<string, string>,
      artifactUrls: { ...object(object(config.remote).artifactUrls) } as Record<string, string>, readerUrls: { ...object(object(config.remote).readerUrls) } as Record<string, string> };
    remote.workId = books.length === 1 ? books[0] : text(object(config.remote).workId) ?? text(group.value.remoteBookId);
    remote.workUrl = text(object(config.remote).workUrl) ?? all.map(record => text(receipt(body(record)).verifiedURL) ?? text(body(record).workUrl)).find((value): value is string => !!value) ?? null;
    const metadata: JsonObject = { ...object(config.metadata), legacy: { version: VERSION, migrationKey: data.migrationKey, source: data.source,
      target: group.value, records: all.map(ref), actualAccountIds: accounts, remoteWorkIds: books, issues: targetIssues,
      unverifiedRemoteWorkIds: unique(all.map(record => text(body(record).unverifiedRemoteBookId))), distributions: {}, unresolved: [] } };
    const seed: PublishingTarget = { id, workId: work.id, platform: destination, label: text(group.value.label) ?? text(group.value.accountLabel) ?? destination,
      enabled: group.value.enabled !== false && !targetIssues.length, config: { entryUrl, accountId: accounts.length === 1 ? accounts[0] : '', remote,
        browser: object(config.browser) as PublishingTarget['config']['browser'], skill: text(config.skill) ?? '', metadata },
      conversationId: prior?.conversationId ?? 0, createdAt: timestamp(group.value.createdAt), updatedAt: Math.max(...all.map(at), 0) };
    targets.push({ id, value: group.value, records: group.records, definitions: group.definitions, work, seed, ...(prior ? { prior } : {}) });
    if (!artifactsByWork.has(work.id)) {
      const ids = unique([...work.artifactIds, ...data.artifactMappings.filter(mapping => mapping.workId === work.id).map(mapping => mapping.artifactId)]);
      const artifacts = await Promise.all(ids.map(id => harness.snapshot(Artifacts, id, BACKGROUND_CONTEXT)));
      artifactsByWork.set(work.id, artifacts.filter((artifact): artifact is Artifact => !!artifact && artifact.workId === work.id));
    }
  }
  const selections: Selection[] = [], covered = new Set<LegacyPublishingRecord>();
  const addSelection = (target: TargetPlan, value: JsonObject, source: LegacyPublishingRecord, facts: LegacyPublishingRecord[]) => {
    const mapped = resolveSelection(data, target, value, artifactsByWork.get(target.work.id) ?? []);
    if (!mapped) {
      const issue = { targetId: target.id, sourceFile: source.sourceFile, reason: `No exact retained artifact/revision mapping for ${source.id} chapter ${numberOf(value) ?? '?'} (${text(value.artifactId) ?? ''}/${text(value.revisionId) ?? ''})` };
      issues.push(issue); array(object(target.seed.config.metadata.legacy).unresolved).push({ ...issue, selection: value, records: facts.map(ref) });
      return;
    }
    selections.push({ target, value, source, facts, ...mapped });
  };
  for (const target of targets) {
    for (const pack of data.packages.filter(pack => target.records.includes(pack) || target.definitions.includes(pack))) {
      for (const value of array(body(pack).chapters).map(object)) {
        const related = target.records.filter(record => ['publishing_chapters', 'publishing_fanqie_runs', 'publishing_meganovel_runs'].includes(record.table)
          && packId(record) === packId(pack) && numberOf(body(record)) === numberOf(value));
        related.forEach(record => covered.add(record));
        const runRevision = unique(related.map(record => text(body(record).revisionId)));
        const selection = { ...value, ...(!text(value.revisionId) && runRevision.length === 1 ? { revisionId: runRevision[0] } : {}) };
        addSelection(target, selection, pack, related);
      }
    }
    for (const record of target.records.filter(record => !covered.has(record) && ['publishing_chapters', 'publishing_fanqie_runs', 'publishing_meganovel_runs'].includes(record.table))) {
      const value = body(record);
      addSelection(target, { ...value, artifactId: text(value.artifactId) ?? record.artifactId, revisionId: text(value.revisionId) ?? record.revisionId,
        number: numberOf(value) }, record, [record]);
    }
  }
  const groups = new Map<string, Selection[]>();
  for (const selection of selections) { const key = distributionKey(selection.target.id, selection.artifact.id); groups.set(key, [...groups.get(key) ?? [], selection]); }
  const distributions = [...groups.values()].map(distributionSeed);
  for (const value of distributions) {
    const target = targets.find(target => target.id === value.seed.targetId)!;
    object(object(target.seed.config.metadata.legacy).distributions)[value.seed.id] = value.legacy;
    if (value.seed.remote.artifactId) target.seed.config.remote.artifactIds[value.seed.artifactId] = value.seed.remote.artifactId;
    if (value.seed.remote.authorUrl) target.seed.config.remote.artifactUrls[value.seed.artifactId] = value.seed.remote.authorUrl;
    if (value.seed.remote.readerUrl) target.seed.config.remote.readerUrls[value.seed.artifactId] = value.seed.remote.readerUrl;
    const prior = await harness.snapshot(Distributions, value.seed.id, BACKGROUND_CONTEXT);
    if (prior && !target.prior) throw new Error(`Distribution already exists: ${value.seed.id}`);
  }
  await harness.commit(async tx => {
    const doc = await tx.doc(ProjectDoc);
    if (doc.migrations[markerKey]) return;
    await tx.doc(LegacyPublishing, data.migrationKey, data);
    for (const target of targets) {
      if (!target.prior) {
        if (doc.targetIds.includes(target.id)) throw new Error(`Publishing target appeared during import: ${target.id}`);
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        if (doc.model) await configure(tx, conversation.id, { model: doc.model });
        target.seed.conversationId = conversation.id;
      }
      await tx.doc(PublishingTargets, target.id, target.seed);
      if (!doc.targetIds.includes(target.id)) doc.targetIds.push(target.id);
      const work = await tx.doc(Works, target.work.id, target.work);
      if (!work.targetIds.includes(target.id)) work.targetIds.push(target.id);
    }
    for (const value of distributions) {
      const target = targets.find(target => target.id === value.seed.targetId)!;
      if (value.retainIntent) value.seed.intent = { request: value.seed.desired, target: target.seed, conversationId: target.seed.conversationId, startedAt: value.seed.updatedAt };
      await tx.doc(Distributions, value.seed.id, value.seed);
      if (!doc.distributionIds.includes(value.seed.id)) doc.distributionIds.push(value.seed.id);
    }
    doc.migrations[markerKey] = { version: VERSION, migrationKey: data.migrationKey, source: data.source,
      targetIds: targets.map(target => target.id), distributionIds: distributions.map(value => value.seed.id), unresolved: issues, importedAt: Date.now() };
  }, BACKGROUND_CONTEXT);
}
