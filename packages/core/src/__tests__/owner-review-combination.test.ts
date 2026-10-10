import { afterEach, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { SchedulerStore, type ScheduledChapter } from '../pipeline/scheduler-store.js';
import { readChapterReviewInputs } from '../pipeline/review-inputs.js';
vi.mock('../pipeline/runner.js', () => ({ PipelineRunner: class {} }));
import { Scheduler } from '../pipeline/scheduler.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

it('keeps v2 authority, policy and frozen publication identity across a real SQLite owner crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-owner-review-combination-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const compiled = join(root, 'compiled');
  for (const part of ['pipeline/scheduler-store', 'harness/sqlite', 'harness/ownership-lock']) {
    await mkdir(join(compiled, part.split('/')[0]), { recursive: true });
    const source = await readFile(new URL(`../${part}.ts`, import.meta.url), 'utf8');
    await writeFile(join(compiled, `${part}.js`), ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText);
  }
  const bookDir = join(root, 'book');
  await mkdir(join(bookDir, 'story'), { recursive: true });
  await writeFile(join(bookDir, 'story/style_guide.md'), '文风 café\r\n');
  await writeFile(join(bookDir, 'story/author_intent.md'), '');
  const inputs = await readChapterReviewInputs(bookDir, 4);
  expect(inputs.version).toBe(2);
  expect(inputs.authorIntent).toBe('');
  expect(inputs.parentCanon).toBeNull();
  const path = join(root, 'harness.sqlite');
  const ledger = new SchedulerStore(path);
  cleanups.push(() => ledger.close());
  const child = spawn(process.execPath, ['-e', `
    const {SchedulerStore} = require(process.argv[1]);
    const store = new SchedulerStore(process.argv[2]);
    store.acquire();
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `, join(compiled, 'pipeline/scheduler-store.js'), path], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => kill(child));
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr!.on('data', data => { stderr += String(data); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Owner exited before readiness: ${code}; ${stderr}`)));
    child.stdout!.once('data', () => resolve());
  });
  const owner = ledger.runningOwner()!;
  expect(owner.pid).toBe(child.pid);
  expect(() => ledger.acquire()).toThrow('already owns');
  expect(ledger.runningOwner()).toEqual(owner);
  const now = Date.now();
  const reserved = ledger.reserve('book', 4, now, 1)!;
  const retained: ScheduledChapter = { ...reserved, phase: 'publishing', revisionId: 'reviewed-revision',
    writingCompleted: true, reviewAttempts: 2, reviewChecks: 4, reviewUnavailableChecks: 1,
    reviewAttempt: { revisionId: 'reviewed-revision', startedAt: now - 2000 },
    reviewRepair: { revisionId: 'reviewed-revision', startedAt: now - 1000 },
    failures: 3, nextAttemptAt: now + 1000, publicationStartedAt: now - 500,
    publication: { status: 'pending', remoteChapterId: 'frozen-remote', evidence: 'synthetic unknown readback' },
    reviewReceipt: { inputs, reviewPolicy: { requireStoryClosure: true, language: 'en' },
      revisionId: 'reviewed-revision', reviewedAt: now - 1000, summary: 'Synthetic accepted audit', observations: [] } };
  ledger.save(retained, 'offline-combination');
  ledger.schedule('write', now + 3600000);
  expect(ledger.latest('book')).toEqual(retained);
  await kill(child);
  // A live unrelated PID cannot override the released kernel owner lock.
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE scheduler_owner SET pid=? WHERE id=1').run(process.pid); }
  finally { db.close(); }
  ledger.acquire();
  expect(ledger.runningOwner()?.token).not.toBe(owner.token);
  expect(ledger.latest('book')).toEqual(retained);
  expect(ledger.nextAt('write', 0)).toBe(now + 3600000);
  expect(ledger.reserve('another-book', 1, now, 1)).toBeUndefined();
});

it('holds the real owner until the publisher close has drained and completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkos-owner-review-shutdown-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ledger = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
  cleanups.push(() => ledger.close());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const closingGate = new Promise<void>(resolve => { release = resolve; });
  const close = vi.fn(async () => {
    expect(ledger.runningOwner()).toBeDefined();
    enter();
    await closingGate;
    expect(ledger.runningOwner()).toBeDefined();
  });
  const config = { projectRoot: root, client: {} as any, model: 'fixture', radarCron: '0 */6 * * *',
    writeCron: '*/15 * * * *', maxConcurrentBooks: 1, chaptersPerCycle: 1, retryDelayMs: 1000,
    cooldownAfterChapterMs: 0, maxChaptersPerDay: 1, creationTasksOnly: true,
    publisher: { ready: vi.fn(), publish: vi.fn(), close } };
  const scheduler = new Scheduler(config);
  cleanups.push(async () => { release(); await scheduler.stop(); });
  await scheduler.start();
  const owner = ledger.runningOwner();
  const stopping = scheduler.stop();
  await entered;
  expect(scheduler.stop()).toBe(stopping);
  const contender = new SchedulerStore(join(root, '.inkos/harness.sqlite'));
  try {
    expect(() => contender.acquire()).toThrow('already owns');
    expect(ledger.runningOwner()).toEqual(owner);
  } finally { contender.close(); }
  release();
  await stopping;
  expect(close).toHaveBeenCalledOnce();
  expect(ledger.runningOwner()).toBeUndefined();
  expect(ledger.events().filter(event => event.type === 'daemon-stopped')).toHaveLength(1);
});
