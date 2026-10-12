import { resolve } from 'node:path';
import type { Context } from '@earendil-works/chord';
import { defineTask, type Task, type RunningTask, type ConversationId } from '@earendil-works/pi-durable';
import type { InkExtension } from '../runtime/plugins.js';
import { Artifacts, Works, type ArtifactRevision } from '../works/documents.js';
import { readArtifact } from '../works/artifacts.js';
import { BrowserRunDoc } from '../extensions/browser/documents.js';
import { withTargetBrowser } from '../extensions/browser/session.js';
import { createBrowserConversation, runBrowserConversation, stopBrowserConversation, type DistributionRuntime } from '../extensions/browser/workflow.js';
import { observeMegaNovel } from '../extensions/publishing/meganovel.js';
import { Distributions, PublishingTargets } from './documents.js';
import { distributionDecision, applyObservation } from './protocol.js';
import type { Distribution, DistributionTaskInput, DistributionCheckpoint, DistributionResult, DistributionRequest,
  PublishingTarget, BrowserObservation, RemoteIdentity } from './contracts.js';

type Definition = Task<DistributionTaskInput, DistributionCheckpoint, DistributionResult, object>;
type Run = RunningTask<DistributionTaskInput, DistributionCheckpoint, DistributionResult>;
const definitions = new Map<string, Definition>();
/** The extension and service obtain the exact same official definition, registered by its stable name on reopen. */
export function createDistributionTask(rootDir: string): Definition {
  const root = resolve(rootDir), existing = definitions.get(root);
  if (existing) return existing;
  const definition = defineTask<DistributionTaskInput, DistributionCheckpoint, DistributionResult>({
    name: 'inkos.distribution', version: 1, initial: () => ({ phase: 'start' }),
    phases: { start: run, recover: run },
    abort: async (task, runtime, context) => {
      const record = await runtime.snapshot(Distributions, task.input.distributionId, context);
      if (record) {
        await stopBrowserConversation(runtime, record.observationConversationId, context);
        await stopBrowserConversation(runtime, record.intent?.conversationId ?? null, context);
      }
      await runtime.commit(async tx => {
        if (record) {
          const doc = await tx.doc(Distributions, record.id, record);
          doc.status = doc.intent ? 'needs-observation' : 'failed';
          doc.error = 'Distribution interrupted; resume/observe inspects its retained outcome before any mutation.';
          doc.updatedAt = runtime.now();
        }
        return { status: 'terminal', outcome: { status: 'aborted' } };
      }, context);
    },
  });
  definitions.set(root, definition);
  return definition;

  async function run(task: Run, runtime: DistributionRuntime, context: Context): Promise<void> {
    let record = await runtime.snapshot(Distributions, task.input.distributionId, context);
    if (!record) throw new Error('Distribution record is missing');
    const currentTarget = await runtime.snapshot(PublishingTargets, record.targetId, context);
    if (!currentTarget) throw new Error('Publishing target is missing');
    let target = record.intent?.target ?? currentTarget;
    const request = record.intent?.request ?? task.input.request;
    const publisher = runtime.registry.installed().flatMap(extension => (extension as InkExtension).publishers ?? [])
      .find(publisher => publisher.id === target.platform);
    try {
      // Stop and join retained child work before any capability/setup failure can settle this task.
      await stopBrowserConversation(runtime, record.intent?.conversationId ?? null, context);
      await stopBrowserConversation(runtime, record.observationConversationId, context);
      if (!publisher) { await finish(runtime, context, record, request, record.intent ? 'needs-observation' : 'unsupported', `Publisher not installed: ${target.platform}`); return; }
      if (!currentTarget.enabled && task.input.mode !== 'observe') {
        await finish(runtime, context, record, request, record.intent ? 'needs-observation' : 'failed', 'Publishing target is disabled'); return;
      }
      if (!record.intent && task.input.mode === 'deliver' && !publisher.capabilities.includes(request.operation)) {
        await finish(runtime, context, record, request, 'unsupported', `Publisher lacks ${request.operation} capability`); return;
      }
      if (request.scheduledAt !== null && task.input.mode === 'deliver' && !record.intent) await runtime.sleep(request.scheduledAt, context);
      const artifact = await runtime.snapshot(Artifacts, record.artifactId, context);
      const revision = artifact?.revisions.find(item => item.id === request.revisionId);
      const work = await runtime.snapshot(Works, record.workId, context);
      if (!revision || !work) throw new Error('Retained artifact revision or work is missing');
      const body = await readArtifact(root, revision);
      const priorRun = record.intent ? await runtime.snapshot(BrowserRunDoc, record.intent.conversationId as ConversationId, context) : undefined;
      const retained = record;
      await withTargetBrowser(root, target, runtime.signal, async () => {
        // A preceding artifact may have just established this target's remote work mapping.
        const latest = await runtime.snapshot(PublishingTargets, retained.targetId, context);
        if (latest) target = retained.intent ? { ...target, config: { ...target.config, browser: latest.config.browser, skill: latest.config.skill } } : latest;
        let hints = priorRun?.report?.remote ?? retained.remote;
        const prompt = JSON.stringify({ work: { id: work.id, title: work.title, profile: work.profile, locale: work.locale, domain: work.domain },
          artifactId: retained.artifactId, revision, body, request });
        const seen = await inspect(runtime, context, retained, target, request, prompt, hints);
        const decision = distributionDecision({ distribution: retained, target, request, observation: seen,
          title: revision.title, body, capabilities: publisher.capabilities, observeOnly: task.input.mode === 'observe' });
        await remember(runtime, context, retained, target, revision, body, seen);
        record = (await runtime.snapshot(Distributions, retained.id, context))!;
        if (decision !== 'mutate') {
          const status = decision === 'unsupported' ? 'unsupported' : decision === 'update-required' ? 'failed'
            : decision === 'needs-observation' ? 'needs-observation' : record.status;
          await finish(runtime, context, record, request, status,
            decision === 'update-required' ? 'Use explicit operation:update for a submitted/published revision'
              : decision === 'unsupported' ? `Publisher lacks ${request.operation} capability` : null);
          return;
        }
        // Intention, unknown outcome and the recovery checkpoint commit BEFORE creating/saving/typing/publishing.
        let mutation!: ConversationId;
        await runtime.commit(async tx => {
          const doc = await tx.doc(Distributions, retained.id, retained);
          mutation = await createBrowserConversation(tx, runtime, target, doc.id, request, 'mutate');
          doc.intent = { request, target, conversationId: mutation, startedAt: runtime.now() };
          doc.status = 'unknown'; doc.error = null; doc.updatedAt = runtime.now();
          return { status: 'running', checkpoint: { phase: 'recover' } };
        }, context);
        try {
          const report = await runBrowserConversation(runtime, mutation,
            `Execute the one retained ${request.operation} intent through actual MCP tools. Remote identities are hints; independently verify them.\n${prompt}\nHints: ${JSON.stringify(record.remote)}`, context);
          hints = report.remote;
        } catch (error) {
          if (runtime.signal.aborted || context.abortSignal?.aborted) throw error;
          runtime.report(error); // A mutation error is uncertainty, not permission to replay.
        }
        await stopBrowserConversation(runtime, mutation, context);
        record = (await runtime.snapshot(Distributions, retained.id, context))!;
        const after = await inspect(runtime, context, record, target, request, prompt, hints);
        await remember(runtime, context, record, target, revision, body, after);
        record = (await runtime.snapshot(Distributions, retained.id, context))!;
        await finish(runtime, context, record, request, record.status, null);
      });
    } catch (error) {
      if (runtime.signal.aborted || context.abortSignal?.aborted) throw error;
      record = (await runtime.snapshot(Distributions, record.id, context))!;
      await stopBrowserConversation(runtime, record.observationConversationId, context);
      await stopBrowserConversation(runtime, record.intent?.conversationId ?? null, context);
      await finish(runtime, context, record, request, record.intent ? 'needs-observation' : 'failed', error instanceof Error ? error.message : String(error));
    }
  }
  async function inspect(runtime: DistributionRuntime, context: Context, record: Distribution, target: PublishingTarget,
    request: DistributionRequest, prompt: string, hints: RemoteIdentity): Promise<BrowserObservation> {
    let conversation!: ConversationId;
    await runtime.commit(async tx => {
      const doc = await tx.doc(Distributions, record.id, record);
      conversation = await createBrowserConversation(tx, runtime, target, doc.id, request, 'observe');
      doc.observationConversationId = conversation; doc.status = doc.intent ? 'unknown' : 'observing';
      return { status: 'running', checkpoint: { phase: 'recover' } };
    }, context);
    const discovered = await runBrowserConversation(runtime, conversation,
      `Independently OBSERVE ONLY, with actual MCP calls. Inspect the configured account/work/artifact and full body, including current public reader if available. Do not mutate or republish.\n${prompt}\nRecovery hints (not evidence): ${JSON.stringify(hints)}\nRetained uncertain intent: ${JSON.stringify(record.intent)}`, context);
    return target.platform === 'meganovel' ? observeMegaNovel(root, target, discovered, hints, runtime.signal) : discovered;
  }
  async function remember(runtime: DistributionRuntime, context: Context, record: Distribution, target: PublishingTarget,
    revision: ArtifactRevision, body: string, seen: BrowserObservation): Promise<void> {
    await runtime.commit(async tx => {
      const doc = await tx.doc(Distributions, record.id, record);
      applyObservation(doc, seen, target, revision, body);
      if (seen.complete && seen.accountId === target.config.accountId && doc.status !== 'needs-observation') {
        const destination = await tx.doc(PublishingTargets, target.id, target);
        const remote = destination.config.remote;
        if (seen.remote.workId) remote.workId = seen.remote.workId;
        if (seen.remote.authorUrl) remote.workUrl = seen.remote.authorUrl;
        if (seen.remote.artifactId) remote.artifactIds[record.artifactId] = seen.remote.artifactId;
        if (seen.remote.authorUrl) remote.artifactUrls[record.artifactId] = seen.remote.authorUrl;
        if (seen.remote.readerUrl) remote.readerUrls[record.artifactId] = seen.remote.readerUrl;
        destination.updatedAt = runtime.now();
      }
      return undefined;
    }, context);
  }
  async function finish(runtime: DistributionRuntime, context: Context, record: Distribution, request: DistributionRequest,
    status: Distribution['status'], error: string | null): Promise<void> {
    await runtime.commit(async tx => {
      const doc = await tx.doc(Distributions, record.id, record);
      doc.status = status;
      doc.error = error ?? (status === 'user-action' ? doc.lastObservation?.evidence ?? doc.error : null);
      doc.updatedAt = runtime.now();
      const next = doc.desired;
      if (!doc.intent && status !== 'needs-observation' && (next.revisionId !== request.revisionId || next.operation !== request.operation || next.scheduledAt !== request.scheduledAt)) {
        doc.taskId = await tx.createTask(definition, { distributionId: doc.id, request: next, mode: 'deliver' as const },
          { ownership: { kind: 'conversation' }, background: true });
      }
      return { status: 'terminal', outcome: { status: 'completed', result: { id: doc.id, status } } };
    }, context);
  }
}
