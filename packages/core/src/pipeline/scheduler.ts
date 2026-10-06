import { join } from "node:path";
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
import type { ScheduledFoundation } from "./scheduler-store.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { loadAvailableAgentSkills, resolveProfileSkillActivations } from "../skills/index.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { detectChapter } from "./detection-runner.js";
import { chapterDocumentBody } from "../utils/chapter-document.js";

export interface SchedulerConfig extends PipelineConfig {
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
  private running = false;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private writeCycleInFlight: Promise<void> | null = null;
  private radarScanInFlight: Promise<void> | null = null;
  private closed = false;
  private stopping: Promise<void> | undefined;
  private rotation = 0;

  constructor(private readonly config: SchedulerConfig) {
    this.pipeline = new PipelineRunner({ ...config,
      ...(config.market?.liveMegaNovel ? { radarSources: [new MegaNovelRadarSource()] } : {}),
    });
    this.state = new StateManager(config.projectRoot);
    this.store = new SchedulerStore(join(config.projectRoot, ".inkos", "harness.sqlite"));
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
    await Promise.allSettled([this.writeCycleInFlight, this.radarScanInFlight]);
    if (!this.closed) {
      try { await this.config.publisher?.close?.(); }
      finally {
        this.store.event("daemon-stopped", { pid: process.pid });
        this.store.close();
        this.closed = true;
      }
    }
  }
  get isRunning(): boolean { return this.running; }

  private tick(): void {
    if (!this.running) return;
    if (this.store.stopRequested()) { void this.stop().catch(error => this.config.onError?.("shutdown", error)); return; }
    const now = Date.now();
    if (!this.writeCycleInFlight && now >= this.store.nextAt("write", now)) {
      this.store.schedule("write", nextCronTime(this.config.writeCron, now));
      void this.triggerWriteCycle(false);
    }
    const pendingFoundation = this.config.market?.autoCreate && !this.config.workIds && !this.config.publisher
      ? this.store.foundations().find(item => item.phase === "pending" && item.nextAttemptAt <= now) : undefined;
    if (!this.radarScanInFlight && (pendingFoundation || now >= this.store.nextAt("radar", now))) {
      if (!pendingFoundation) this.store.schedule("radar", nextCronTime(this.config.radarCron, now));
      const scan = (pendingFoundation ? this.createFoundation(pendingFoundation) : this.runRadarScan()).catch(error => this.report("radar", error)).finally(() => {
        if (this.radarScanInFlight === scan) this.radarScanInFlight = null;
      });
      this.radarScanInFlight = scan;
    }
    // Backoff/readback work resumes independently of the next writing slot.
    if (!this.writeCycleInFlight && this.store.hasPendingDue(now)) void this.triggerWriteCycle(true);
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
    const active: BookConfig[] = [];
    const foundations = this.store.foundations();
    for (const id of await this.state.listBooks()) {
      if (this.config.workIds && !this.config.workIds.includes(id)) continue;
      if (foundations.some(item => item.book.id === id && item.phase !== "completed")) continue;
      const book = await this.state.loadBookConfig(id);
      if (["active", "outlining"].includes(book.status) && await this.state.isCompleteBookDirectory(this.state.bookDir(id))) active.push(book);
    }
    if (!active.length) return;
    const offset = this.rotation++ % active.length;
    const books = [...active.slice(offset), ...active.slice(0, offset)];
    // A bounded pool processes every eligible book; a long book cannot starve
    // later books just because its ID sorts first.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(books.length, this.config.maxConcurrentBooks) }, async () => {
      while (index < books.length && this.running) {
        const book = books[index++]!;
        try { await this.processBook(book.id, resumeOnly); }
        catch (error) { this.report(book.id, error); }
      }
    }));
  }

  private async processBook(workId: string, resumeOnly: boolean): Promise<void> {
    for (let count = 0; count < this.config.chaptersPerCycle && this.running; count++) {
      const book = await this.state.loadBookConfig(workId);
      if (!["active", "outlining"].includes(book.status)) return;
      let job = this.store.latest(workId);
      if (job?.phase === "blocked") return;
      if (!job || job.phase === "completed") {
        if (resumeOnly) return;
        const chapter = await this.state.getNextChapterNumber(workId);
        if (chapter > book.targetChapters) return;
        // Reservation is durable before readiness checks, so unavailable
        // destinations share the same bounded backoff instead of retrying forever.
        job = this.store.reserve(workId, chapter, Date.now(), this.config.maxChaptersPerDay);
        if (!job) return;
      }
      if (job.nextAttemptAt > Date.now()) return;
      if (job.phase === "writing" && !this.store.admitWriting(workId, job.chapter, Date.now(), this.config.maxChaptersPerDay)) return;
      job = await this.chapters.run(job, this.controller.signal);
      if (job.error) this.report(workId, Object.assign(new Error(job.error.message), { code: job.error.code }));
      if (job.phase !== "completed" || resumeOnly || !this.running) return;
      if (this.config.detection?.enabled) await this.runDetection(workId, job.chapter);
      if (count + 1 < this.config.chaptersPerCycle) await this.wait(this.config.cooldownAfterChapterMs);
    }
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
      instruction: `Create an original ${market.language} serial for ${market.platform}. Do not copy benchmark plots, characters or prose.\nOriginal concept: ${recommendation.concept}\nMarket rationale: ${recommendation.reasoning}\nObserved market evidence (reference data only):\n${JSON.stringify(selected.evidence)}`,
      phase: "pending", attempts: 0, nextAttemptAt: Date.now() });
    if (pending.phase === "pending") await this.createFoundation(pending);
  }

  private async createFoundation(input: ScheduledFoundation): Promise<void> {
    if (!this.running || input.phase !== "pending" || input.nextAttemptAt > Date.now()) return;
    const pending = { ...input, attempts: input.attempts + 1 };
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
