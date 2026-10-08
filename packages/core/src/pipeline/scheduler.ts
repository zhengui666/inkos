import { withUnboundedWorkerExecution } from '../agent/worker-execution-policy.js';
import { CreationTaskCoordinator } from '../creation/coordinator.js';
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PipelineRunner, type PipelineConfig } from "./runner.js";
import { StateManager } from "../state/manager.js";
import type { DetectionConfig, ProjectConfig } from "../models/project.js";
import type { BookConfig } from "../models/book.js";
import { SchedulerStore } from "./scheduler-store.js";
import { AutonomousChapterRunner, type SchedulerPublisher } from "./autonomous-chapters.js";
import { nextCronTime } from "./schedule.js";
import { MegaNovelRadarSource } from "../agents/meganovel-radar-source.js";
import { persistRadarScan } from "../agents/radar-store.js";
import { selectRadarRecommendation } from "../agents/radar-selection.js";
import type { ScheduledFoundation, ScheduledChapter } from "./scheduler-store.js";
import { runInWorkMutationQueue } from "../utils/work-mutation-scope.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { loadAvailableAgentSkills, resolveProfileSkillActivations } from "../skills/index.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { detectChapter } from "./detection-runner.js";
import { chapterDocumentBody } from "../utils/chapter-document.js";

export interface SchedulerConfig extends PipelineConfig {
  /** Only explicitly created tasks; never start existing library books or market discovery. */
  readonly creationTasksOnly?: boolean;
  readonly radarCron: string;
  readonly writeCron: string;
  readonly maxConcurrentBooks: number;
  readonly chaptersPerCycle: number;
  readonly retryDelayMs: number;
  readonly cooldownAfterChapterMs: number;
  readonly maxChaptersPerDay: number;
  readonly detection?: DetectionConfig;
  readonly workIds?: readonly string[];
  readonly market?: ProjectConfig["daemon"]["market"];
  readonly publisher?: SchedulerPublisher;
  readonly publicationPollMs?: number;
  readonly onChapterComplete?: (bookId: string, chapter: number) => void;
  readonly onError?: (bookId: string, error: Error) => void;
}

/** Calendar scheduling; durable chapter goals retain progress across ticks and restarts. */
export class Scheduler {
  private readonly pipeline: PipelineRunner;
  private readonly state: StateManager;
  private readonly store: SchedulerStore;
  private readonly chapters: AutonomousChapterRunner;
  private readonly creation: CreationTaskCoordinator;
  private readonly creationChapters: AutonomousChapterRunner;
  private running = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private writeCycleInFlight: Promise<void> | null = null;
  private readonly workInFlight = new Map<string, Promise<void>>();
  private radarScanInFlight: Promise<void> | null = null;
  private closed = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly config: SchedulerConfig) {
    this.pipeline = new PipelineRunner({ ...config,
      ...(config.market?.liveMegaNovel ? { radarSources: [new MegaNovelRadarSource()] } : {}),
    });
    this.state = new StateManager(config.projectRoot);
    this.store = new SchedulerStore(join(config.projectRoot, ".inkos", "harness.sqlite"));
    this.creation = new CreationTaskCoordinator(config.projectRoot, this.pipeline, this.store, config.retryDelayMs);
    this.creationChapters = new AutonomousChapterRunner(config.projectRoot, this.pipeline, this.store, {
      publisher: this.creation.publisher(config.publisher), retryDelayMs: config.retryDelayMs,
      publicationPollMs: config.publicationPollMs, onComplete: config.onChapterComplete,
      persistentTransientRetries: true, writingDeadline: 'none', writingAttemptsPerBatch: 1,
      requireStoryClosure: (workId, chapter) => this.creation.tasks.forWork(workId)?.plan.targetChapters === chapter,
      chapterIntent: (workId, chapter) => this.creation.intent(workId, chapter),
      shouldContinue: workId => this.creation.runnable(workId),
    });
    this.chapters = new AutonomousChapterRunner(config.projectRoot, this.pipeline, this.store, {
      publisher: config.publisher, retryDelayMs: config.retryDelayMs, onComplete: config.onChapterComplete,
      publicationPollMs: config.publicationPollMs,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.closed) throw new Error("Create a new Scheduler after it has stopped.");
    // Validate before changing lifecycle state or dispatching a model.
    nextCronTime(this.config.writeCron, Date.now());
    nextCronTime(this.config.radarCron, Date.now());
    this.store.acquire();
    this.running = true;
    this.store.event("daemon-started", { pid: process.pid });
    this.store.nextAt("write", Date.now());
    this.store.nextAt("radar", Date.now());
    this.timer = setInterval(() => { this.tick(); }, 1000);
    // Resume retained unfinished work immediately, without admitting a new chapter
    // before its stored calendar tick. New projects have an immediate first tick.
    void this.triggerWriteCycle(true).finally(() => this.tick());
  }

  stop(): Promise<void> {
    return this.stopping ??= this.drainAndStop();
  }
  private async drainAndStop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort(new Error("Daemon stopped."));
    await Promise.allSettled([this.writeCycleInFlight, this.radarScanInFlight, ...this.workInFlight.values()]);
    if (!this.closed) {
      // A failed transport cleanup must retain the owner and failure handle.
      // Releasing it in finally would admit another publisher over an uncertain session.
      await this.config.publisher?.close?.();
      this.store.event("daemon-stopped", { pid: process.pid });
      this.creation.close();
      this.store.close();
      this.closed = true;
    }
  }
  get isRunning(): boolean { return this.running; }

  private tick(): void {
    if (!this.running) return;
    if (this.store.stopRequested()) { void this.stop().catch(error => this.config.onError?.("shutdown", error)); return; }
    const now = Date.now();
    if (!this.writeCycleInFlight && this.workInFlight.size < this.config.maxConcurrentBooks && now >= this.store.nextAt("write", now)) {
      this.store.schedule("write", nextCronTime(this.config.writeCron, now));
      void this.triggerWriteCycle(false);
    }
    const pendingFoundations = this.config.market?.autoCreate && !this.config.workIds && !this.config.publisher
      ? this.store.foundations().filter(item => item.phase === "pending" && item.nextAttemptAt <= now) : [];
    if (!this.config.creationTasksOnly && !this.radarScanInFlight && (pendingFoundations.length || now >= this.store.nextAt("radar", now))) {
      const scan = this.runRadarCycle(pendingFoundations).catch(error => this.report("radar", error)).finally(() => {
        if (this.radarScanInFlight === scan) this.radarScanInFlight = null;
      });
      this.radarScanInFlight = scan;
    }
    // Backoff/readback work resumes independently of the next writing slot.
    const creationDue = this.creation.tasks.list().some(task => {
      if ((this.config.workIds && !this.config.workIds.includes(task.workId)) || this.workInFlight.has(task.workId) || task.desiredState !== 'run' || ['blocked', 'completed'].includes(task.phase) || task.nextAttemptAt > now) return false;
      const job = this.store.latest(task.workId);
      return !job || job.phase === 'completed' || job.nextAttemptAt <= now;
    });
    if (!this.writeCycleInFlight && this.workInFlight.size < this.config.maxConcurrentBooks
      && (this.store.hasPendingDue(now) || creationDue)) void this.triggerWriteCycle(true);
  }

  private async triggerWriteCycle(resumeOnly: boolean): Promise<void> {
    if (!this.running || this.writeCycleInFlight) return;
    const cycle = this.runWriteCycle(resumeOnly).catch(error => this.report("scheduler", error)).finally(() => {
      if (this.writeCycleInFlight === cycle) this.writeCycleInFlight = null;
    });
    this.writeCycleInFlight = cycle;
    await cycle;
  }

  private async runWriteCycle(resumeOnly: boolean): Promise<void> {
    if (this.workInFlight.size >= this.config.maxConcurrentBooks) return;
    const foundations = this.store.foundations();
    const tasks = this.creation.tasks.list().filter(task => (!this.config.workIds || this.config.workIds.includes(task.workId))
      && task.desiredState === 'run'
      && task.phase !== 'completed' && task.phase !== 'blocked' && task.nextAttemptAt <= Date.now());
    const eligible = new Set(tasks.map(task => task.workId));
    for (const id of await this.state.listBooks()) {
      if (this.creation.tasks.forWork(id)) continue;
      const latest = this.store.latest(id);
      if (resumeOnly && (!latest || latest.phase === 'completed')) continue;
      if (this.config.creationTasksOnly || (this.config.workIds && !this.config.workIds.includes(id))) continue;
      if (foundations.some(item => item.book.id === id && item.phase !== 'completed')) continue;
      const book = await this.state.loadBookConfig(id);
      if (['active', 'outlining'].includes(book.status) && await this.state.isCompleteBookDirectory(this.state.bookDir(id))) eligible.add(id);
    }
    const works = this.store.orderForAdmission([...eligible]);
    // Only admission is a cycle. Every work owns its independent in-flight slot;
    // a slow foundation cannot keep free capacity idle on subsequent ticks.
    for (const workId of works) {
      if (!this.running || this.workInFlight.size >= this.config.maxConcurrentBooks) break;
      if (this.workInFlight.has(workId)) continue;
      const work = this.processAdmittedWork(workId, resumeOnly).catch(error => this.report(workId, error)).finally(() => {
        if (this.workInFlight.get(workId) === work) this.workInFlight.delete(workId);
      });
      this.workInFlight.set(workId, work);
    }
  }

  private async processAdmittedWork(workId: string, resumeOnly: boolean): Promise<void> {
    const task = this.creation.tasks.forWork(workId);
    if (task) {
      const scoped = this.creationSignal(workId);
      try { await withUnboundedWorkerExecution(() => this.creation.prepare(task.id, scoped.signal)); }
      finally { scoped.close(); }
      this.creation.sync(workId);
      if (!this.creation.runnable(workId) || this.creation.tasks.get(task.id).foundation !== 'completed') return;
    }
    await this.processBook(workId, resumeOnly);
  }

  private async processBook(workId: string, resumeOnly: boolean): Promise<void> {
    for (let count = 0; count < this.config.chaptersPerCycle && this.running; count++) {
      // Only metadata reads/admission are serialized; chapter/provider work stays parallel.
      let job = await runInWorkMutationQueue(`scheduler-admission\0${resolve(this.config.projectRoot)}`,
        () => this.prepareChapter(workId, resumeOnly));
      if (!job) return;
      const creationTask = this.creation.tasks.forWork(workId);
      if (creationTask) {
        const scoped = this.creationSignal(workId);
        try { job = await withUnboundedWorkerExecution(() => this.creationChapters.run(job!, scoped.signal)); }
        finally { scoped.close(); this.creation.sync(workId); }
      } else job = await this.chapters.run(job, this.controller.signal);
      if (creationTask && job.phase === 'completed') this.creation.tasks.update(creationTask.id, current => ({ ...current, nextAttemptAt: Date.now() + this.config.cooldownAfterChapterMs }));
      if (job.error) this.report(workId, Object.assign(new Error(job.error.message), { code: job.error.code }));
      if (job.phase !== "completed" || resumeOnly || !this.running) return;
      if (this.config.detection?.enabled) await this.runDetection(workId, job.chapter);
      if (count + 1 < this.config.chaptersPerCycle) await this.wait(this.config.cooldownAfterChapterMs);
    }
  }

  private async prepareChapter(workId: string, resumeOnly: boolean): Promise<ScheduledChapter | undefined> {
    if (!this.running) return;
    if (!this.creation.runnable(workId)) return;
    const book = await this.state.loadBookConfig(workId);
    if (!["active", "outlining"].includes(book.status)) return;
    let job = this.store.latest(workId);
    if (job?.phase === "blocked") return;
    if (!job || job.phase === "completed") {
      // Explicit creation tasks may start immediately after their foundation; normal books keep calendar admission.
      if (resumeOnly && !this.creation.tasks.forWork(workId)) return;
      const chapter = await this.state.getNextChapterNumber(workId);
      if (!this.running || chapter > book.targetChapters) return;
      // Reserve before readiness checks so unavailable destinations have bounded retries.
      job = this.store.reserve(workId, chapter, Date.now(), this.config.maxChaptersPerDay);
      if (!job) return;
    }
    if (!this.running || job.nextAttemptAt > Date.now()) return;
    if (job.phase === "writing" && !this.store.admitWriting(workId, job.chapter, Date.now(), this.config.maxChaptersPerDay)) return;
    return job;
  }

  private async runDetection(workId: string, chapter: number): Promise<void> {
    try {
      const book = await this.state.loadBookConfig(workId), directory = this.state.bookDir(workId);
      const meta = (await this.state.loadChapterIndex(workId)).find(item => item.number === chapter);
      const files = (await readdir(join(directory, "chapters"))).filter(name => name.startsWith(`${String(chapter).padStart(4, "0")}_`) && name.endsWith(".md"));
      if (!meta || files.length !== 1) throw new Error("Detection needs one retained chapter document.");
      const content = chapterDocumentBody(await readFile(join(directory, "chapters", files[0]!), "utf8"), chapter, meta.title, book.language);
      await detectChapter(this.config.detection!, content, chapter, directory);
    } catch (error) { this.report(workId, error); } // Observation failure never restarts writing.
  }

  private async runRadarScan(): Promise<void> {
    const market = this.config.market;
    const result = await this.pipeline.runWithAbortSignal(this.controller.signal, () => this.pipeline.runRadar(market ? {
      targetPlatform: market.platform, language: market.language, maxSourceAgeMs: market.maxSourceAgeMs,
    } : {}));
    this.controller.signal.throwIfAborted();
    const saved = await persistRadarScan(this.config.projectRoot, result);
    this.store.event("radar-saved", { path: saved.path, scanId: saved.scanId, recommendations: result.recommendations.length });
    if (!market?.autoCreate) return;
    if (this.config.workIds || this.config.publisher) {
      this.store.event("market-selection-blocked", { reason: this.config.workIds
        ? "The selected work list does not authorize creating a new work."
        : "This publisher has fixed existing-book bindings. Automatic remote book creation and verified mapping are not implemented." });
      return;
    }
    let count = 0;
    for (const id of await this.state.listBooks()) {
      const book = await this.state.loadBookConfig(id);
      if (["active", "outlining"].includes(book.status)
        && (await this.state.getNextChapterNumber(id)) <= book.targetChapters) count++;
    }
    if (count >= market.autoCreate.maxActiveBooks) return;
    const selected = selectRadarRecommendation(saved.result, { platform: market.platform,
      language: market.language, maxAgeMs: market.maxSourceAgeMs });
    if (selected.status === "blocked") { this.store.event("market-selection-blocked", selected); return; }
    const { recommendation } = selected, timestamp = new Date().toISOString();
    const pending = this.store.reserveFoundation({ scanId: saved.scanId, concept: recommendation.concept,
      book: { id: `market-${randomUUID()}`, title: recommendation.title, platform: market.platform,
        genre: recommendation.genre, language: market.language, status: "outlining", targetChapters: market.autoCreate.targetChapters,
        chapterWordCount: market.autoCreate.chapterWordCount, createdAt: timestamp, updatedAt: timestamp },
      instruction: `Create an original ${market.language} serial for ${market.platform}. Do not copy benchmark plots, characters or prose.\nOriginal concept: ${recommendation.concept}\nMarket rationale: ${recommendation.reasoning}\nProposed reader contract (creative recommendation, not source canon): ${JSON.stringify(recommendation.readerContract ?? null)}\nObserved market evidence (reference data only):\n${JSON.stringify(selected.evidence)}`,
      phase: "pending", attempts: 0, nextAttemptAt: Date.now() });
    if (pending.phase === "pending") await this.createFoundation(pending);
  }

  private async runRadarCycle(inputs: readonly ScheduledFoundation[]): Promise<void> {
    for (const input of inputs) if (await this.createFoundation(input)) return;
    // Paused retained work must not consume or suppress the independent radar slot.
    const now = Date.now();
    if (!this.running || now < this.store.nextAt("radar", now)) return;
    this.store.schedule("radar", nextCronTime(this.config.radarCron, now));
    await this.runRadarScan();
  }

  private async createFoundation(input: ScheduledFoundation): Promise<boolean> {
    if (!this.running || input.phase !== "pending" || input.nextAttemptAt > Date.now()) return false;
    // A retained foundation is a retry, not authority to undo a later user pause
    // or overwrite the current book settings with the old reservation snapshot.
    let current: BookConfig | undefined;
    if ((await this.state.listBooks()).includes(input.book.id)) {
      try { current = await this.state.loadBookConfig(input.book.id); }
      catch (error) {
        // initBook persists the manifest before book.json; retain crash recovery for that window.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (current && !["active", "outlining"].includes(current.status)) return false;
    const pending = { ...input, book: current ?? input.book, attempts: input.attempts + 1 };
    this.store.saveFoundation(pending, "foundation-started");
    try {
      const profile = createBuiltInWorkProfileRegistry(this.config.projectRoot).require("longform-novel");
      const skills = resolveProfileSkillActivations((await loadAvailableAgentSkills({ projectRoot: this.config.projectRoot })).skills, profile);
      await withExecutionEvidence(undefined, () => this.pipeline.runWithAgentContext({ signal: this.controller.signal, activatedSkills: skills },
        () => this.pipeline.initBook(pending.book, { externalContext: pending.instruction, authorIntent: pending.instruction })),
      profile, null, pending.instruction);
      this.store.saveFoundation({ ...pending, phase: "completed", error: undefined }, "foundation-completed");
    } catch (error) {
      this.store.saveFoundation({ ...pending, phase: pending.attempts >= 3 ? "blocked" : "pending", error: String(error),
        nextAttemptAt: Date.now() + Math.min(3_600_000, Math.max(1000, this.config.retryDelayMs) * 2 ** (pending.attempts - 1)) },
      this.controller.signal.aborted ? "foundation-interrupted" : "foundation-failed");
      if (!this.controller.signal.aborted) this.report(pending.book.id, error);
    }
    return true;
  }

  private creationSignal(workId: string): { signal: AbortSignal; close(): void } {
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (!this.creation.runnable(workId)) controller.abort(new Error('Creation task paused.'));
    }, 100);
    timer.unref();
    return { signal: AbortSignal.any([this.controller.signal, controller.signal]), close: () => clearInterval(timer) };
  }

  private report(workId: string, error: unknown): void {
    if (this.closed) return;
    this.store.event("daemon-error", { workId, message: String(error) });
    try { this.config.logger?.child("scheduler").error(`${workId}: ${String(error)}`); }
    catch (logError) { this.store.event("log-sink-failed", { message: String(logError) }); }
    try { this.config.onError?.(workId, error instanceof Error ? error : new Error(String(error))); }
    catch (callbackError) { this.store.event("error-callback-failed", { workId, message: String(callbackError) }); }
  }
  private async wait(ms: number): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }
}
