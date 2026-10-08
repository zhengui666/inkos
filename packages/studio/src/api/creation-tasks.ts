import type { Hono, Context } from 'hono';
import { join } from 'node:path';
import { CreationTaskStore, CreationRequestSchema, CreationControlSchema, CreationPlanUpdateSchema, inferCreationPlan,
  creationTaskView, RemoteWorkStore, remoteWorkView, SchedulerStore, ChapterGoalService,
  createDefaultSchedulerPublisherRegistry, type ProjectConfig } from '@actalk/inkos-core';

export function registerCreationTaskRoutes(app: Hono, options: {
  root: string; loadConfig(): Promise<ProjectConfig>;
  start(refreshPublisher?: boolean): Promise<void>; status(): object;
}) {
  const tasks = new CreationTaskStore(join(options.root, '.inkos', 'harness.sqlite'));
  const scheduler = new SchedulerStore(join(options.root, '.inkos', 'harness.sqlite'));
  const remoteWorks = new RemoteWorkStore(join(options.root, '.inkos', 'harness.sqlite'));
  let runtimeError: string | undefined;
  const start = async (refreshPublisher = false) => {
    try { await options.start(refreshPublisher); runtimeError = undefined; }
    catch (error) { runtimeError = String(error); }
  };
  const view = (id: string) => { const task = tasks.get(id); const remote = remoteWorks.forWork(task.workId); return {...creationTaskView(task, scheduler.chapters(task.workId)), remoteWork: remote ? remoteWorkView(remote) : null}; };
  const control = CreationControlSchema;
  const fail = (c: Context, error: unknown) => {
    const code = (error as { code?: string }).code;
    return c.json({ error: error instanceof Error ? error.message : String(error), code },
      code === 'CREATION_NOT_FOUND' ? 404 : code ? 409 : 400);
  };
  app.get('/api/v1/creation-tasks', async c => {
    const config = await options.loadConfig();
    return c.json({ tasks: tasks.list().map(task => view(task.id)),
      defaults: { language: config.daemon.market?.language ?? config.language, platform: config.daemon.market?.platform ?? null },
      runtime: { ...options.status(), error: runtimeError },
      publication: { configured: Boolean(config.daemon.publisherConfig),
        // A supplied path is not evidence of authentication, a usable binding or platform acceptance.
        configurationStatus: config.daemon.publisherConfig ? 'path_provided' : 'missing',
        automaticChapterProviders: createDefaultSchedulerPublisherRegistry().list()
          .filter(provider => provider.mode === 'automatic').map(provider => provider.provider),
        remoteBookCreation: false, remoteBookCreationProtocol: true, emptyBookFirstChapter: false, requiresExistingRemoteBook: true,
        note: 'New-book creation requires an installed verified creation adapter and explicit default account/session. Built-in MegaNovel new-book creation and empty-book chapter bootstrap remain unsupported. Login, identity/tax forms and new contracts require necessary confirmation.' } });
  });
  app.post('/api/v1/creation-tasks/runner/start', async c => { await start(); return c.json({ runtimeError }); });
  app.post('/api/v1/creation-tasks', async c => {
    try {
      const request = CreationRequestSchema.parse(await c.req.json());
      const task = tasks.create(request, inferCreationPlan(request, await options.loadConfig()));
      if (task.plan.platform) await start();
      return c.json({ task: view(task.id), runtimeError }, 201);
    } catch (error) { return fail(c, error); }
  });
  app.post('/api/v1/creation-tasks/:id/pause', async c => {
    try {
      const { version } = control.parse(await c.req.json());
      tasks.control(c.req.param('id'), 'paused', version);
      return c.json({ task: view(c.req.param('id')) });
    } catch (error) { return fail(c, error); }
  });
  app.post('/api/v1/creation-tasks/:id/resume', async c => {
    try {
      const { version } = control.parse(await c.req.json());
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
      await start(Boolean(job?.error && /(?:PUBLISHING_|CREATION_PUBLISHER_REQUIRED)/u.test(job.error.code)));
      return c.json({ task: view(task.id), runtimeError });
    } catch (error) { return fail(c, error); }
  });
  app.put('/api/v1/creation-tasks/:id/plan', async c => {
    try {
      const input = CreationPlanUpdateSchema.parse(await c.req.json());
      const task = tasks.get(c.req.param('id'));
      const job = scheduler.latest(task.workId);
      tasks.editPlan(task.id, input.plan, input.version, job?.chapter ?? 0, Boolean(job && job.phase !== 'completed'));
      return c.json({ task: view(task.id) });
    } catch (error) { return fail(c, error); }
  });
  return {
    async recover() { if (tasks.list().some(task => task.desiredState === 'run' && !['completed', 'blocked'].includes(task.phase))) await start(); },
    pauseAll() { for (const task of tasks.list()) if (task.desiredState === 'run' && task.phase !== 'completed') tasks.control(task.id, 'paused', task.version); },
    close() { tasks.close(); scheduler.close(); remoteWorks.close(); },
  };
}
