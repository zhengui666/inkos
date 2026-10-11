import { realpathSync } from 'node:fs';
import type { CodexClient } from '../../codex/client.js';
import { CodexFixture, type CodexFixtureOptions, type FixtureAccountResponse, type FixtureReply, type FixtureTurn } from '../codex-fixture.js';
import { DrainedTestScope } from './drained-test-scope.js';

export interface RegisteredCodexProject {
  readonly projectRoot: string;
  readonly fixture: CodexFixture;
  setAccountResponse(response: FixtureAccountResponse): void;
}

/** Explicit synthetic transport only. The consumer owns vi.mock and reversible env stubs. */
export class CodexRuntimeFixtureScope {
  private readonly projects = new Map<string, RegisteredCodexProject>();
  private readonly creating = new Set<Promise<CodexClient>>();
  private readonly tasks = new DrainedTestScope();
  private closing = false;

  registerProject(projectRoot: string, options: CodexFixtureOptions & {
    reply?: (turn: FixtureTurn) => FixtureReply | Promise<FixtureReply>;
  } = {}): RegisteredCodexProject {
    if (this.closing) throw new Error('Offline fixture scope is closed');
    if (process.env.INKOS_CODEX_HOME || process.env.INKOS_CODEX_STATE_ROOT !== undefined) {
      throw new Error('Clear inherited Codex home/state-root with reversible env stubs before registration');
    }
    const root = realpathSync(projectRoot);
    if (this.projects.has(root)) throw new Error(`Offline fixture project already registered: ${root}`);
    const fixture = new CodexFixture(options.reply, options);
    const project: RegisteredCodexProject = { projectRoot: root, fixture,
      setAccountResponse: response => fixture.setAccountResponse(root, response) };
    this.projects.set(root, project);
    return project;
  }

  // Resolve synchronously: unknown roots fail before transport or filesystem creation.
  createClient = (projectRoot: string): Promise<CodexClient> => {
    if (this.closing) throw new Error('Offline fixture scope is closed');
    const project = this.projects.get(realpathSync(projectRoot));
    if (!project) throw new Error(`Unregistered offline fixture project: ${projectRoot}`);
    const work = project.fixture.createClient(project.projectRoot).then(async client => {
      if (this.closing) { await client.close(); throw new Error('Offline fixture scope is closed'); }
      return client;
    });
    this.creating.add(work);
    void work.then(() => this.creating.delete(work), () => this.creating.delete(work));
    return work;
  };

  /** Observe owned runtime promises immediately; callers still assert their outcomes. */
  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> { return this.tasks.run(task); }

  /** Call before restoring mocks, closing stores, or removing roots; release custom gates in finally. */
  async drain(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.creating]);
    await Promise.all([...this.projects.values()].map(project => project.fixture.close()));
    await this.tasks.drain();
    await Promise.all([...this.projects.values()].map(project => project.fixture.drain()));
  }
}
