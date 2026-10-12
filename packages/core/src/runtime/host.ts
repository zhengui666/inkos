import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry, type ConversationId, type TaskId, type SubmissionId, type ModelRef, type Extension, type Task, type JsonObject } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai';
import { FileCredentialStore } from './credentials.js';
import { projectModels } from './models.js';
import { acquireProjectOwner } from './owner.js';
import { describePlugins, findProfile, loadPlugins } from './plugins.js';
import { connectMcp, mcpExtension, type McpConfig } from './mcp.js';
import { ProjectDoc, Works } from '../works/documents.js';
import { WorksService } from '../works/service.js';
import { createContentTask, type ContentInput } from '../extensions/fiction/task.js';
import { createProductionTask } from '../extensions/fiction/production.js';
import { createCapabilities } from '../extensions/capabilities.js';
import { createPublishingExtension } from '../extensions/publishing/index.js';
import { PublishingService } from '../publishing/service.js';
import { migrateToDurable, importLegacyPublishing } from '../migrations/index.js';
import { ingestMaterial } from '../materials/ingest.js';
import { retrieveMaterials } from '../materials/retrieve.js';
import { exportArtifact, editArtifact } from '../extensions/export.js';
import { commitAtomicFileSet, recoverAtomicFileSets } from '../utils/atomic-file-set.js';

const ctx = BACKGROUND_CONTEXT;
type LoginState = { status: 'running' | 'done' | 'failed'; events: AuthEvent[]; prompt?: AuthPrompt; error?: string; respond?: (value: string) => void };
export class RuntimeHost {
  readonly works: WorksService;
  readonly publishing: PublishingService;
  readonly logins = new Map<string, LoginState>();
  private constructor(readonly rootDir: string, readonly harness: Harness, readonly registry: ReturnType<typeof createRegistry>,
    readonly models: ReturnType<typeof projectModels>, readonly credentials: FileCredentialStore,
    private readonly release: () => void, private readonly clients: Awaited<ReturnType<typeof connectMcp>>[]) {
    this.works = new WorksService(harness, rootDir); this.publishing = new PublishingService(harness, rootDir);
  }
  static async open(rootDir: string, options: { extensions?: Extension[]; resume?: boolean } = {}): Promise<RuntimeHost> {
    const owner = acquireProjectOwner(rootDir); rootDir = owner.rootDir;
    const clients: Awaited<ReturnType<typeof connectMcp>>[] = [];
    let harness: Harness | undefined;
    try {
      await recoverAtomicFileSets(rootDir, true);
      let config: any = {};
      try { config = JSON.parse(await readFile(join(rootDir, 'inkos.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const credentials = new FileCredentialStore(join(rootDir, '.inkos', 'credentials.json'));
      const models = projectModels(credentials);
      const registry = createRegistry(); let host: RuntimeHost;
      registry.install(CodingTools);
      registry.install(createCapabilities(rootDir, () => host));
      registry.install(createPublishingExtension(rootDir));
      for (const extension of options.extensions ?? []) registry.install(extension);
      await loadPlugins(registry, config.plugins ?? [], { rootDir });
      for (const [name, connection] of Object.entries(config.mcp ?? {})) {
        const client = await connectMcp(name, connection as McpConfig); clients.push(client); registry.install(await mcpExtension(name, client));
      }
      harness = await Harness.open(await openNodeSqliteStorage(join(rootDir, '.inkos', 'durable.sqlite')), {
        models, registry, settings: config.durable ?? {},
        env: target => new NodeExecutionEnv({ cwd: target.cwd ?? rootDir }),
        onReport: error => console.error('[durable]', error),
      }, ctx);
      const project = await harness.snapshot(ProjectDoc, ctx);
      const model: ModelRef | undefined = project?.model ?? config.model;
      const root = await harness.root(ctx, { agent: { cwd: rootDir, ...(model ? { model } : {}) } });
      await harness.commit(async tx => { const doc = await tx.doc(ProjectDoc); if (model && !doc.model) doc.model = model; }, ctx);
      host = new RuntimeHost(rootDir, harness, registry, models, credentials, owner.release, clients);
      if (options.resume !== false) harness.resume();
      return host;
    } catch (error) { await harness?.close(ctx); for (const client of clients) await client.close(); owner.release(); throw error; }
  }
  async close(): Promise<void> {
    try { await this.harness.close(ctx); for (const client of this.clients) await client.close(); }
    finally { this.release(); }
  }
  async status() {
    const graph = await this.harness.watchTaskGraph(ctx);
    try {
      const project = await this.harness.snapshot(ProjectDoc, ctx);
      return { pid: process.pid, rootDir: this.rootDir, model: project?.model ?? null,
        works: await this.works.list(), targets: await this.publishing.listTargets(), distributions: await this.publishing.listDistributions(),
        tasks: await this.tasks(), taskGraph: graph.value, usage: await this.harness.usage(ctx), plugins: describePlugins(this.registry) };
    } finally { await graph.stop(); }
  }
  async tasks() { return this.harness.commit(async tx => (await tx.scanTasks({}, 1000)).items, ctx); }
  async startContent(input: Partial<ContentInput> & { workId: string; requestId?: string }) {
    const work = await this.works.get(input.workId); findProfile(this.registry.snapshot(), work.profile);
    const root = await this.harness.root(ctx); const key = JSON.stringify(['content', input.requestId ?? randomUUID()]);
    const result = await root.commit(async tx => {
      const project = await tx.doc(ProjectDoc);
      if (Object.hasOwn(project.requests, key)) return { ...project.requests[key] };
      const current = await tx.doc(Works, work.id, work); if (current.status === 'cancelled') current.status = 'active';
      const artifactId = input.artifactId ?? randomUUID();
      const taskId = await tx.createTask(createContentTask(this.rootDir), { ...input, workId: work.id, artifactId,
        revisionId: input.revisionId ?? randomUUID(), title: input.title ?? `${work.title} — ${work.artifactIds.length + 1}` }, { ownership: { kind: 'conversation' }, background: true });
      return project.requests[key] = { taskId, artifactId };
    }, ctx);
    this.harness.resume(); return result;
  }
  async rpc(method: string, p: any = {}): Promise<any> {
    switch (method) {
      case 'status': return this.status();
      case 'works.list': return this.works.list();
      case 'works.create': findProfile(this.registry.snapshot(), p.profile ?? 'fiction'); return this.works.create(p);
      case 'works.get': return this.works.get(p.id);
      case 'works.update': return this.works.update(p.id, p.changes);
      case 'works.pause': return this.works.pause(p.id, p.paused);
      case 'creation.start': return this.startContent(p);
      case 'creation.produce': {
        const work = await this.works.get(p.workId); const root = await this.harness.root(ctx); const key = JSON.stringify(['production', p.requestId ?? randomUUID()]);
        const result = await root.commit(async tx => {
          const project = await tx.doc(ProjectDoc); if (Object.hasOwn(project.requests, key)) return { ...project.requests[key] };
          const taskId = await tx.createTask(createProductionTask(this.rootDir), { workId: work.id }, { ownership: { kind: 'conversation' }, background: true });
          return project.requests[key] = { taskId, artifactId: '' };
        }, ctx);
        this.harness.resume(); return result;
      }
      case 'tasks.list': return this.tasks();
      case 'tasks.create': {
        const definition = this.registry.snapshot().task(p.kind);
        if (!definition) throw new Error(`Task extension is not installed: ${p.kind}`);
        const root = await this.harness.root(ctx);
        const taskId = await root.commit(tx => tx.createTask(definition as Task<JsonObject, { phase: string }, JsonObject, {}>, p.input ?? {}, { ownership: { kind: 'conversation' }, background: true }), ctx);
        this.harness.resume(); return { taskId };
      }
      case 'tasks.get': return this.harness.getTask(p.id as TaskId, ctx);
      case 'tasks.wait': return this.harness.waitForTask(p.id as TaskId, ctx);
      case 'tasks.abort': return this.harness.abortTask(p.id as TaskId, ctx);
      case 'tasks.pause': {
        const task = await this.harness.getTask(p.id as TaskId, ctx);
        const input = task?.input as { workId?: string } | undefined;
        if (!input?.workId) throw new Error('This task has no pausable work; use native cancellation');
        return this.works.pause(input.workId, p.paused);
      }
      case 'tasks.retry': {
        const task = await this.harness.getTask(p.id as TaskId, ctx);
        if (!task || task.kind !== 'inkos.content' || task.state.status !== 'terminal' || task.state.outcome.status === 'completed') throw new Error('Only failed/aborted content tasks can be explicitly retried');
        const input = task.input as ContentInput, existing = await this.works.get(input.workId);
        await this.harness.commit(async tx => { const work = await tx.doc(Works, input.workId, existing); work.pauseRequested = false; if (work.status === 'cancelled') work.status = 'active'; }, ctx);
        return this.startContent({ ...input, requestId: p.requestId ?? randomUUID() });
      }
      case 'conversations.list': return this.harness.commit(async tx => (await tx.scanConversations({}, 1000)).items, ctx);
      case 'conversations.create': {
        const model = p.model ?? (await this.harness.snapshot(ProjectDoc, ctx))?.model ?? undefined;
        return { id: (await this.harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { cwd: this.rootDir, model, instructions: p.instructions } }, ctx)).id };
      }
      case 'conversations.get': {
        const conversation = await this.harness.conversation(p.id as ConversationId, ctx); if (!conversation) throw new Error('Conversation not found');
        const watch = await conversation.watch(ctx); try { return watch.value; } finally { await watch.stop(); }
      }
      case 'conversations.submit': {
        const conversation = await this.harness.conversation(p.id as ConversationId, ctx); if (!conversation) throw new Error('Conversation not found');
        return (await conversation.submit(p.draft, ctx)).status(ctx);
      }
      case 'conversations.configure': { const conversation = await this.harness.conversation(p.id as ConversationId, ctx); if (!conversation) throw new Error('Conversation not found'); await conversation.configure(p.changes, ctx); return { id: conversation.id }; }
      case 'conversations.abort': { const conversation = await this.harness.conversation(p.id as ConversationId, ctx); if (!conversation) throw new Error('Conversation not found'); await conversation.abort(ctx, { background: p.background === true }); return { id: conversation.id }; }
      case 'submissions.get': return (await this.harness.submission(p.id as SubmissionId, ctx))?.status(ctx);
      case 'submissions.wait': return (await this.harness.submission(p.id as SubmissionId, ctx))?.wait(ctx);
      case 'submissions.abort': return this.harness.abortSubmission(p.id as SubmissionId, ctx);
      case 'artifacts.read': return this.works.read(p.id, p.revisionId);
      case 'artifacts.save': return this.works.save(p);
      case 'artifacts.edit': return editArtifact(this.works, p);
      case 'artifacts.export': return exportArtifact(this.works, p);
      case 'materials.ingest': return ingestMaterial(this.rootDir, p);
      case 'materials.query': return retrieveMaterials(this.rootDir, p);
      case 'materials.list': {
        const dir = join(this.rootDir, '.inkos', 'materials');
        let files: string[]; try { files = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
        return Promise.all(files.filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(join(dir, file), 'utf8'))));
      }
      case 'work.migrate': return migrateToDurable(this.harness, this.rootDir, { ...p, importPublishing: data => importLegacyPublishing(this.harness, data) });
      case 'publishing.targets': return this.publishing.listTargets();
      case 'publishing.createTarget': return this.publishing.createTarget(p.config ? p : {
        id: p.id, workId: p.workId, platform: p.publisher ?? p.platform ?? 'browser', label: p.accountLabel ?? p.label, enabled: p.enabled,
        config: { entryUrl: p.entryUrl ?? p.metadata?.entryUrl ?? (p.publisher === 'meganovel' ? 'https://www.meganovel.com/uc' : undefined), accountId: p.accountId,
          browser: p.browser, metadata: p.metadata, skill: p.skill, remote: { workId: p.remoteWorkId ?? null, workUrl: p.remoteWorkUrl ?? null } },
      });
      case 'publishing.updateTarget': return this.publishing.updateTarget(p.id, p.changes);
      case 'publishing.list': return this.publishing.listDistributions();
      case 'publishing.queue': return this.publishing.queue(p);
      case 'publishing.resume': return this.publishing.resume(p.id);
      case 'publishing.observe': return this.publishing.observe(p.id);
      case 'models.list': {
        const providers = await Promise.all(this.models.getProviders().map(async provider => ({ id: provider.id, name: provider.name,
          configured: !!await this.models.checkAuth(provider.id), authTypes: [...(provider.auth.apiKey ? ['api_key'] : []), ...(provider.auth.oauth ? ['oauth'] : [])] })));
        return { providers, models: this.models.getModels(p.provider), selected: (await this.harness.snapshot(ProjectDoc, ctx))?.model ?? null };
      }
      case 'models.set': {
        if (!this.models.getModel(p.provider, p.modelId)) throw new Error('Model not found in pi-ai catalog');
        const model = { provider: p.provider, modelId: p.modelId }; await (await this.harness.root(ctx)).configure({ model }, ctx);
        await this.harness.commit(async tx => { (await tx.doc(ProjectDoc)).model = model; }, ctx); return model;
      }
      case 'models.login.start': return this.startLogin(p.providerId, p.type);
      case 'models.login.status': { const state = this.logins.get(p.id); if (!state) throw new Error('Login not found'); const { respond, ...view } = state; return view; }
      case 'models.login.respond': { const state = this.logins.get(p.id); if (!state?.respond) throw new Error('Login is not awaiting input'); const respond = state.respond; delete state.respond; delete state.prompt; respond(p.value); return { id: p.id }; }
      case 'models.logout': await this.models.logout(p.providerId); return { providerId: p.providerId };
      case 'plugins.list': return describePlugins(this.registry);
      case 'plugins.configure': {
        const path = join(this.rootDir, 'inkos.json'); let config: any = {};
        try { config = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await loadPlugins(this.registry, p.modules, { rootDir: this.rootDir });
        config.plugins = p.modules; await commitAtomicFileSet({ rootDir: this.rootDir, writes: [{ relativePath: 'inkos.json', content: JSON.stringify(config, null, 2) }] });
        return describePlugins(this.registry);
      }
      default: throw new Error(`Unknown runtime method: ${method}`);
    }
  }
  private startLogin(providerId: string, type: AuthType) {
    const id = randomUUID(); const state: LoginState = { status: 'running', events: [] }; this.logins.set(id, state);
    void this.models.login(providerId, type, {
      prompt: prompt => new Promise(resolve => { state.prompt = prompt; state.respond = resolve; }),
      notify: event => { state.events.push(event); },
    }).then(() => { state.status = 'done'; delete state.prompt; delete state.respond; }, error => { state.status = 'failed'; state.error = error.message; delete state.prompt; delete state.respond; });
    return { id };
  }
}
