import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { configure, type Harness, type DocumentReader, type Tx, type TaskId, type ConversationId } from '@earendil-works/pi-durable';
import { Artifacts, ProjectDoc, Works, type Work, type ArtifactRevision } from '../works/documents.js';
import { assertId } from '../works/artifacts.js';
import { Distributions, PublishingTargets } from './documents.js';
import { createDistributionTask } from './task.js';
import { distributionKey, emptyRemote, emptyMapping, type CreateTargetInput, type UpdateTargetInput,
  type PublishingTarget, type Distribution, type DistributionRequest, type QueueDistributionInput } from './contracts.js';
import { CronExpressionParser } from 'cron-parser';

type PublishingHost = DocumentReader & Pick<Harness, 'commit'>;
export async function listPublishingTargets(host: DocumentReader): Promise<PublishingTarget[]> {
  const project = await host.snapshot(ProjectDoc, BACKGROUND_CONTEXT);
  const values = await Promise.all((project?.targetIds ?? []).map(id => host.snapshot(PublishingTargets, id, BACKGROUND_CONTEXT)));
  return values.filter((value): value is PublishingTarget => value !== undefined);
}
export async function listDistributions(host: DocumentReader): Promise<Distribution[]> {
  const project = await host.snapshot(ProjectDoc, BACKGROUND_CONTEXT);
  const values = await Promise.all((project?.distributionIds ?? []).map(id => host.snapshot(Distributions, id, BACKGROUND_CONTEXT)));
  return values.filter((value): value is Distribution => value !== undefined);
}
export async function getDistribution(host: DocumentReader, id: string): Promise<Distribution> {
  const value = await host.snapshot(Distributions, id, BACKGROUND_CONTEXT);
  if (!value) throw new Error(`Distribution not found: ${id}`);
  return value;
}
async function getTarget(host: DocumentReader, id: string): Promise<PublishingTarget> {
  const value = await host.snapshot(PublishingTargets, id, BACKGROUND_CONTEXT);
  if (!value) throw new Error(`Publishing target not found: ${id}`);
  return value;
}
function checkConfig(config: PublishingTarget['config']): void {
  if (!config.accountId.trim()) throw new Error('A visible account ID is required');
  new URL(config.entryUrl);
  if (config.cadence) CronExpressionParser.parse(config.cadence.cron, { tz: config.cadence.timeZone }).next();
}
export async function createPublishingTarget(host: PublishingHost, input: CreateTargetInput): Promise<PublishingTarget> {
  const id = assertId(input.id ?? randomUUID());
  if (!input.platform.trim()) throw new Error('Publisher ID is required');
  const work = await host.snapshot(Works, input.workId, BACKGROUND_CONTEXT);
  if (!work) throw new Error(`Work not found: ${input.workId}`);
  const config = { ...input.config, remote: { ...emptyMapping(), ...input.config.remote },
    browser: input.config.browser ?? {}, skill: input.config.skill ?? '', metadata: input.config.metadata ?? {} };
  checkConfig(config);
  await host.commit(async tx => {
    const project = await tx.doc(ProjectDoc);
    if (project.targetIds.includes(id)) throw new Error(`Publishing target already exists: ${id}`);
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    if (project.model) await configure(tx, conversation.id, { model: project.model });
    const now = Date.now();
    await tx.doc(PublishingTargets, id, { id, workId: work.id, platform: input.platform,
      label: input.label ?? input.platform, enabled: input.enabled ?? true, config,
      conversationId: conversation.id, createdAt: now, updatedAt: now });
    project.targetIds.push(id);
    const doc = await tx.doc(Works, work.id, work);
    if (!doc.targetIds.includes(id)) doc.targetIds.push(id);
  }, BACKGROUND_CONTEXT);
  return getTarget(host, id);
}
export async function updatePublishingTarget(host: PublishingHost, id: string, changes: UpdateTargetInput): Promise<PublishingTarget> {
  const target = await getTarget(host, id);
  const config = { ...target.config, ...changes.config, remote: { ...target.config.remote, ...changes.config?.remote } };
  checkConfig(config);
  // An account is part of a target's identity; rebinding it would put old receipts in the new account's record.
  if (config.accountId !== target.config.accountId) throw new Error('Create a separate target for another account');
  await host.commit(async tx => {
    const doc = await tx.doc(PublishingTargets, id, target);
    if (changes.label !== undefined) doc.label = changes.label;
    if (changes.enabled !== undefined) doc.enabled = changes.enabled;
    if (changes.config) doc.config = { ...doc.config, ...changes.config, remote: { ...doc.config.remote, ...changes.config.remote } };
    doc.updatedAt = Date.now();
  }, BACKGROUND_CONTEXT);
  return getTarget(host, id);
}
function sameRequest(a: DistributionRequest, b: DistributionRequest): boolean {
  return a.revisionId === b.revisionId && a.operation === b.operation && a.scheduledAt === b.scheduledAt;
}
export async function queueDistribution(host: PublishingHost, rootDir: string, input: QueueDistributionInput): Promise<Distribution> {
  const target = await getTarget(host, input.targetId);
  const artifact = await host.snapshot(Artifacts, input.artifactId, BACKGROUND_CONTEXT);
  if (!artifact || artifact.workId !== target.workId) throw new Error('Artifact must belong to the target work');
  const revisionId = input.revisionId ?? artifact.currentRevision;
  if (!artifact.revisions.some(revision => revision.id === revisionId)) throw new Error(`Revision not found: ${revisionId}`);
  if (input.operation && !['publish', 'update'].includes(input.operation)) throw new Error('Unknown distribution operation');
  if (input.scheduledAt !== undefined && !Number.isFinite(input.scheduledAt)) throw new Error('scheduledAt must be epoch milliseconds');
  const request: DistributionRequest = { revisionId, operation: input.operation ?? 'publish',
    scheduledAt: input.scheduledAt ?? null, requestId: input.requestId ?? null };
  const id = distributionKey(target.id, artifact.id);
  const definition = createDistributionTask(rootDir);
  await host.commit(async tx => {
    const project = await tx.doc(ProjectDoc), now = Date.now();
    const doc = await tx.doc(Distributions, id, { id, targetId: target.id, artifactId: artifact.id, workId: artifact.workId,
      desired: request, taskId: null, status: 'queued', intent: null, observationConversationId: null,
      remote: emptyRemote(), lastObservation: null, observedRevisionId: null, submittedRevisionId: null, publishedRevisionId: null,
      requests: {}, error: null, createdAt: now, updatedAt: now });
    const task = doc.taskId === null ? undefined : await tx.task(doc.taskId as TaskId);
    if (request.requestId && Object.hasOwn(doc.requests, request.requestId)) {
      if (!sameRequest(doc.requests[request.requestId]!, request)) throw new Error('requestId already names a different revision/operation');
      return;
    }
    if (request.operation !== 'update' && (doc.submittedRevisionId && doc.submittedRevisionId !== revisionId
      || doc.publishedRevisionId && doc.publishedRevisionId !== revisionId
      || doc.intent && doc.intent.request.revisionId !== revisionId)) throw new Error('A submitted/published artifact revision requires explicit operation:update');
    if (request.requestId) doc.requests[request.requestId] = request;
    doc.desired = request;
    doc.updatedAt = now;
    if (!project.distributionIds.includes(id)) project.distributionIds.push(id);
    if (task && task.state.status !== 'terminal') return;
    // Same established revision needs observation, not another publish action.
    const alreadySubmitted = doc.submittedRevisionId === revisionId || doc.publishedRevisionId === revisionId;
    doc.taskId = await tx.createTask(definition, { distributionId: id, request, mode: alreadySubmitted ? 'observe' as const : 'deliver' as const },
      { conversationId: target.conversationId as ConversationId, ownership: { kind: 'conversation' }, background: true });
    doc.status = doc.intent ? 'needs-observation' : 'queued';
    doc.error = null;
  }, BACKGROUND_CONTEXT);
  return getDistribution(host, id);
}

/** Persist independent native tasks in the same save transaction. A later edit never implicitly republishes. */
export async function deriveDistributions(tx: Tx, rootDir: string, work: Work, revision: ArtifactRevision): Promise<void> {
  if (revision.metadata.role !== 'content') return;
  const project = await tx.doc(ProjectDoc);
  for (const targetId of work.targetIds) {
    const target = await tx.doc(PublishingTargets, targetId, null);
    if (!target.enabled) continue;
    const id = distributionKey(targetId, revision.artifactId);
    if (project.distributionIds.includes(id)) continue;
    const now = Date.now();
    let scheduledAt: number | null = null;
    let cadenceError: string | null = null;
    if (target.config.cadence) {
      let from = now;
      for (const priorId of project.distributionIds) {
        const prior = await tx.doc(Distributions, priorId, null);
        if (prior.targetId === targetId) from = Math.max(from, prior.desired.scheduledAt ?? 0);
      }
      try {
        scheduledAt = CronExpressionParser.parse(target.config.cadence.cron, { currentDate: from, tz: target.config.cadence.timeZone }).next().getTime();
      } catch (error) { cadenceError = `Invalid publishing cadence: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const request: DistributionRequest = { revisionId: revision.id, operation: 'publish', scheduledAt, requestId: `auto:${targetId}:${revision.artifactId}` };
    const taskId = cadenceError ? null : await tx.createTask(createDistributionTask(rootDir), { distributionId: id, request, mode: 'deliver' as const },
      { conversationId: target.conversationId as ConversationId, ownership: { kind: 'conversation' }, background: true });
    await tx.doc(Distributions, id, { id, targetId, artifactId: revision.artifactId, workId: work.id, desired: request, taskId,
      status: cadenceError ? 'failed' : 'queued', intent: null, observationConversationId: null, remote: emptyRemote(), lastObservation: null,
      observedRevisionId: null, submittedRevisionId: null, publishedRevisionId: null, requests: { [request.requestId!]: request },
      error: cadenceError, createdAt: now, updatedAt: now });
    project.distributionIds.push(id);
  }
}
export class PublishingService {
  constructor(readonly harness: Harness, readonly rootDir: string) {}
  listTargets(): Promise<PublishingTarget[]> { return listPublishingTargets(this.harness); }
  createTarget(input: CreateTargetInput): Promise<PublishingTarget> { return createPublishingTarget(this.harness, input); }
  updateTarget(id: string, changes: UpdateTargetInput): Promise<PublishingTarget> { return updatePublishingTarget(this.harness, id, changes); }
  listDistributions(): Promise<Distribution[]> { return listDistributions(this.harness); }
  async queue(input: QueueDistributionInput): Promise<Distribution> {
    const value = await queueDistribution(this.harness, this.rootDir, input);
    this.harness.resume(); return value;
  }
  async resume(id: string): Promise<Distribution> {
    const record = await getDistribution(this.harness, id);
    const task = record.taskId === null ? undefined : await this.harness.getTask(record.taskId as TaskId, BACKGROUND_CONTEXT);
    if (!task || task.state.status === 'terminal') await this.start(record, 'deliver');
    this.harness.resume(); return getDistribution(this.harness, id);
  }
  async observe(id: string): Promise<Distribution> {
    const record = await getDistribution(this.harness, id);
    if (record.taskId !== null) {
      const task = await this.harness.getTask(record.taskId as TaskId, BACKGROUND_CONTEXT);
      if (task && task.state.status !== 'terminal') {
        await this.harness.abortTask(record.taskId as TaskId, BACKGROUND_CONTEXT);
        await this.harness.waitForTask(record.taskId as TaskId, BACKGROUND_CONTEXT);
      }
    }
    await this.start(await getDistribution(this.harness, id), 'observe');
    this.harness.resume(); return getDistribution(this.harness, id);
  }
  private async start(record: Distribution, mode: 'deliver' | 'observe'): Promise<void> {
    const target = await getTarget(this.harness, record.targetId);
    await this.harness.commit(async tx => {
      const doc = await tx.doc(Distributions, record.id, record);
      const task = doc.taskId === null ? undefined : await tx.task(doc.taskId as TaskId);
      if (task && task.state.status !== 'terminal') return;
      doc.taskId = await tx.createTask(createDistributionTask(this.rootDir), { distributionId: doc.id, request: doc.desired, mode },
        { conversationId: target.conversationId as ConversationId, ownership: { kind: 'conversation' }, background: true });
      doc.error = null; doc.updatedAt = Date.now();
    }, BACKGROUND_CONTEXT);
  }
}
