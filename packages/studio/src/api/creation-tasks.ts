import type { Hono, Context } from 'hono';
import { join } from 'node:path';
import { CreationTaskStore, CreationRequestSchema, CreationControlSchema, CreationPlanUpdateSchema, inferCreationPlan,
  creationTaskView, RemoteWorkStore, remoteWorkView, SchedulerStore, ChapterGoalService,
  createDefaultSchedulerPublisherRegistry, type ProjectConfig } from '@actalk/inkos-core';

export function registerCreationTaskRoutes(app: Hono, options: {
  root: string; loadConfig(): Promise<ProjectConfig>;
  start(refreshPublisher?: boolean): Promise<void>; status(): object;
}) {
  let closed = false;
  type Stores = { tasks: CreationTaskStore; scheduler: SchedulerStore; remoteWorks: RemoteWorkStore };
  // Route registration is not a database owner. Keep these synchronous reads and
  // writes scoped, especially across config/publisher startup waits. The daemon
  // owns its separate long-lived connections and drains them on its own lifecycle.
  const withStores = <T>(use: (stores: Stores) => T): T => {
    if (closed) throw Object.assign(new Error('Studio is shutting down.'), { code: 'STUDIO_SHUTTING_DOWN' });
    const owned: Array<{ close(): void }> = [];
    const own = <S extends { close(): void }>(store: S): S => { owned.push(store); return store; };
    const path = join(options.root, '.inkos', 'harness.sqlite');
    try {
      return use({ tasks: own(new CreationTaskStore(path)), scheduler: own(new SchedulerStore(path)),
        remoteWorks: own(new RemoteWorkStore(path)) });
    } finally {
      const errors: unknown[] = [];
      for (const store of owned.reverse()) { try { store.close(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, 'Creation route database cleanup failed.');
    }
  };
  let runtimeError: string | undefined;
  const start = async (refreshPublisher = false) => {
    try {
      if (closed) throw new Error('Studio is shutting down.');
      await options.start(refreshPublisher); runtimeError = undefined;
    }
    catch (error) { runtimeError = String(error); }
  };
  const view = ({ tasks, scheduler, remoteWorks }: Stores, id: string) => { const task = tasks.get(id); const remote = remoteWorks.forWork(task.workId); return {...creationTaskView(task, scheduler.chapters(task.workId)), remoteWork: remote ? remoteWorkView(remote) : null}; };
  const control = CreationControlSchema;
  const fail = (c: Context, error: unknown) => {
    const code = (error as { code?: string }).code;
    return c.json({ error: error instanceof Error ? error.message : String(error), code },
      code === 'STUDIO_SHUTTING_DOWN' ? 503 : code === 'CREATION_NOT_FOUND' ? 404 : code ? 409 : 400);
  };
  app.get('/api/v1/creation-tasks', async c => {
    try {
      const config = await options.loadConfig();
      const tasks = withStores(stores => stores.tasks.list().map(task => view(stores, task.id)));
      return c.json({ tasks,
        defaults: { language: config.daemon.market?.language ?? config.language, platform: config.daemon.market?.platform ?? null },
        runtime: { ...options.status(), error: runtimeError },
        publication: { configured: Boolean(config.daemon.publisherConfig),
          // A supplied path is not evidence of authentication, a usable binding or platform acceptance.
          configurationStatus: config.daemon.publisherConfig ? 'path_provided' : 'missing',
          automaticChapterProviders: createDefaultSchedulerPublisherRegistry().list()
            .filter(provider => provider.mode === 'automatic').map(provider => provider.provider),
          remoteBookCreation: false, remoteBookCreationProtocol: true, emptyBookFirstChapter: false, requiresExistingRemoteBook: true,
          note: 'New-book creation requires an installed verified creation adapter and explicit default account/session. Built-in MegaNovel new-book creation and empty-book chapter bootstrap remain unsupported. Login, identity/tax forms and new contracts require necessary confirmation.' } });
    } catch (error) { return fail(c, error); }
  });
  app.post('/api/v1/creation-tasks/runner/start', async c => { await start(); return c.json({ runtimeError }); });
  app.post('/api/v1/creation-tasks', async c => {
    try {
      const request = CreationRequestSchema.parse(await c.req.json());
      const plan = inferCreationPlan(request, await options.loadConfig());
      const task = withStores(({ tasks }) => tasks.create(request, plan));
      if (task.plan.platform) await start();
      return c.json({ task: withStores(stores => view(stores, task.id)), runtimeError }, 201);
    } catch (error) { return fail(c, error); }
  });
  app.post('/api/v1/creation-tasks/:id/pause', async c => {
    try {
      const { version } = control.parse(await c.req.json());
      const task = withStores(stores => {
        stores.tasks.control(c.req.param('id'), 'paused', version);
        return view(stores, c.req.param('id'));
      });
      return c.json({ task });
    } catch (error) { return fail(c, error); }
  });
  app.post('/api/v1/creation-tasks/:id/resume', async c => {
    try {
      const { version } = control.parse(await c.req.json());
      const { task, refreshPublisher } = withStores(({ tasks, scheduler }) => {
        const previous = tasks.get(c.req.param('id'));
        const retained = scheduler.latest(previous.workId);
        if (previous.version !== version) throw Object.assign(new Error('Task changed. Refresh before retrying.'), { code: 'CREATION_VERSION_CONFLICT' });
        if (retained?.error?.code === 'CREATION_TRANSIENT_WRITE_PAUSED') {
          const goals = new ChapterGoalService({ projectRoot: options.root });
          try { const goal = goals.get(retained.goalId, previous.workId); goals.retryTransientFailure(goal.id, goal.version, previous.workId); }
          finally { goals.close(); }
          scheduler.save({ ...retained, phase: 'writing', error: undefined, nextAttemptAt: Date.now() }, 'explicit-transient-writing-retry');
        }
        if (retained?.error?.code === 'CREATION_TRANSIENT_BACKOFF') scheduler.save({ ...retained, nextAttemptAt: Date.now() }, 'transient-retry-expedited');
        const task = tasks.control(c.req.param('id'), 'run', version);
        const job = scheduler.latest(task.workId);
        if (job?.error && ['CREATION_PUBLISHER_REQUIRED', 'PUBLISHING_BINDING_MISSING', 'PUBLISHING_MANUAL_REQUIRED', 'PUBLISHING_TARGET_CONFLICT'].includes(job.error.code)) {
          scheduler.save({ ...job, phase: job.reviewReceipt ? 'publishing' : job.phase === 'blocked' ? 'writing' : job.phase,
            failures: 0, error: undefined, nextAttemptAt: Date.now() }, 'publication-setup-resumed');
        }
        return { task, refreshPublisher: Boolean(job?.error && /(?:PUBLISHING_|CREATION_PUBLISHER_REQUIRED)/u.test(job.error.code)) };
      });
      await start(refreshPublisher);
      return c.json({ task: withStores(stores => view(stores, task.id)), runtimeError });
    } catch (error) { return fail(c, error); }
  });
  app.put('/api/v1/creation-tasks/:id/plan', async c => {
    try {
      const input = CreationPlanUpdateSchema.parse(await c.req.json());
      const task = withStores(stores => {
        const task = stores.tasks.get(c.req.param('id'));
        const job = stores.scheduler.latest(task.workId);
        stores.tasks.editPlan(task.id, input.plan, input.version, job?.chapter ?? 0, Boolean(job && job.phase !== 'completed'));
        return view(stores, task.id);
      });
      return c.json({ task });
    } catch (error) { return fail(c, error); }
  });
  return {
    async recover() { if (!closed && withStores(({ tasks }) => tasks.list().some(task => task.desiredState === 'run' && !['completed', 'blocked'].includes(task.phase)))) await start(); },
    pauseAll() { withStores(({ tasks }) => { for (const task of tasks.list()) if (task.desiredState === 'run' && task.phase !== 'completed') tasks.control(task.id, 'paused', task.version); }); },
    close() { closed = true; },
  };
}
