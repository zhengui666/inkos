import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { WriterAgent } from "../agents/writer.js";
import type { StateValidatorAgent, ValidationResult } from "../agents/state-validator.js";
import { RuntimeStateDeltaSchema } from "../models/runtime-state.js";
import { ObservationSchema, type Observation } from "../models/observation.js";
import type { ChapterMeta } from "../models/chapter.js";
import { loadWorkManifest } from "../harness/work-store.js";
import { syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { commitAtomicFileSet, recoverAtomicFileSets, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import { runInWorkMutationQueue, withWorkMutationScope, ownsWorkMutation } from "../utils/work-mutation-scope.js";
import { readStoryFrame } from "../utils/outline-paths.js";
import { toPosixPath } from "../utils/posix-path.js";
import { StateManager } from "./manager.js";
import { BOOK_LOCK_GUARD_FILE } from "./book-lock-guard.js";
import { applyRuntimeStateDelta, type RuntimeStateSnapshot } from "./state-reducer.js";
import { loadRuntimeStateSnapshot, loadRuntimeStateSnapshotAtChapter } from "./runtime-state-store.js";
import { renderChapterSummariesProjection, renderCurrentStateProjection, renderHooksProjection } from "./state-projections.js";

const ValidationSchema = z.object({
  consistent: z.literal(true), reconciliationRequired: z.literal(false),
  observations: z.array(ObservationSchema),
}).strict();
const ReplayChapterSchema = z.object({
  number: z.number().int().positive(), sourcePath: z.string(), sourceText: z.string().optional(), sourceRevisionId: z.string().optional(),
  sourceHash: z.string().optional(), // Read old plans without interpreting their former digest.
  delta: RuntimeStateDeltaSchema, validation: ValidationSchema,
}).strict();
export const StateReplayPlanSchema = z.object({
  version: z.union([z.literal(2), z.literal(3)]), id: z.string().optional(), inputs: z.record(z.string()).optional(), bookId: z.string().min(1), baselineChapter: z.number().int().nonnegative(),
  targetChapter: z.number().int().positive(), sourceVersion: z.string().optional(),
  createdAt: z.string().datetime(), chapters: z.array(ReplayChapterSchema).min(1),
}).strict();
export type StateReplayPlan = z.infer<typeof StateReplayPlanSchema>;
export interface StateReplayWorkers {
  readonly writer: Pick<WriterAgent, "settleChapterState">;
  readonly validator: Pick<StateValidatorAgent, "validate">;
}
export interface PrepareStateReplayInput {
  readonly projectRoot: string;
  readonly bookId: string;
  /** Explicitly reviewed, already validated canonical checkpoint. Never inferred from a directory name. */
  readonly baselineChapter: number;
  readonly expectedVersion?: string;
  readonly signal?: AbortSignal;
  readonly createWorkers: (isolatedProjectRoot: string) => StateReplayWorkers;
}
const replacedCodes = new Set(["state-validation-unavailable", "state-validation", "state-sync-required", "state-reconciliation"]);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
function fail(code: string, message: string, details?: unknown): never {
  throw Object.assign(new Error(message), { code, details });
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail("STATE_REPLAY_ABORTED", "State replay was cancelled; no live projection was committed.");
}
function assertBookId(bookId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(bookId)) fail("STATE_REPLAY_BOOK_ID", "Invalid book id.");
}

/** Ordinary plan identity; retained alias keeps existing CLI callers source-compatible. */
export function stateReplayPlanId(plan: unknown): string {
  return StateReplayPlanSchema.parse(plan).id ?? "legacy-plan";
}
/** @deprecated Use stateReplayPlanId. This does not compute a digest. */
export const hashStateReplayPlan = stateReplayPlanId;

async function withBook<T>(root: string, bookId: string, task: (state: StateManager) => Promise<T>): Promise<T> {
  assertBookId(bookId);
  const state = new StateManager(root);
  for (const path of [root, join(root, "works"), join(root, "works", bookId), state.bookDir(bookId), join(root, "works", bookId, "work.json"), join(root, "works", bookId, "revisions")]) {
    if ((await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }))?.isSymbolicLink()) fail("STATE_REPLAY_UNSAFE_SOURCE", `Symlinked replay root: ${path}`);
  }
  // Resolve before acquireBookLock (which otherwise creates a missing source directory).
  const work = await loadWorkManifest(root, bookId);
  if (work.id !== bookId) fail("STATE_REPLAY_BOOK_ID", "Work manifest identity does not match the selected book.");
  if (ownsWorkMutation(root, bookId)) return task(state);
  return runInWorkMutationQueue(`${resolve(root)}\0${bookId}`, () =>
    withWorkMutationScope(root, bookId, () => state.acquireBookLock(bookId), async () => {
      await recoverAtomicFileSets(root);
      await recoverAtomicFileSets(state.bookDir(bookId));
      return task(state);
    }));
}

async function collectSource(directory: string, prefix = ""): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && (entry.name === ".write.lock" || entry.name === BOOK_LOCK_GUARD_FILE || entry.name.startsWith(`${BOOK_LOCK_GUARD_FILE}-`))) continue;
    if (entry.name.startsWith(".inkos-file-txn-")) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) fail("STATE_REPLAY_UNSAFE_SOURCE", `Replay does not follow symlinks: ${join(prefix, entry.name)}`);
    if (entry.isDirectory()) {
      for (const [name, bytes] of await collectSource(path, join(prefix, entry.name))) files.set(name, bytes);
    } else if (entry.isFile()) files.set(toPosixPath(join(prefix, entry.name)), await readFile(path));
    else fail("STATE_REPLAY_UNSAFE_SOURCE", `Unsupported source file: ${path}`);
  }
  return files;
}

async function capture(root: string, state: StateManager, bookId: string) {
  const files = await collectSource(state.bookDir(bookId));
  const work = await readFile(join(root, "works", bookId, "work.json"));
  return { files, work };
}

function replayInputs(files: ReadonlyMap<string, Buffer>, baseline: number): Record<string, string> {
  const selected = new Set(["story/outline/story_frame.md", "story/book_rules.md", "story/book_rules.json"]);
  for (const file of ["manifest.json", "current_state.json", "hooks.json", "chapter_summaries.json"]) {
    selected.add(`story/state/${file}`);
    selected.add(`story/snapshots/${baseline}/state/${file}`);
  }
  return Object.fromEntries([...selected].filter(path => files.has(path)).map(path => [path, files.get(path)!.toString("utf8")]));
}

async function requireUnchangedInputs(bookDir: string, plan: StateReplayPlan): Promise<void> {
  if (!plan.inputs || plan.chapters.some(chapter => chapter.sourceText === undefined)) {
    fail("STATE_REPLAY_SOURCE_UNAVAILABLE", "This older plan has no retained source text. Keep it as history and prepare from the current retained chapters.");
  }
  for (const [path, content] of [...Object.entries(plan.inputs), ...plan.chapters.map(chapter => [chapter.sourcePath, chapter.sourceText!] as const)]) {
    if (path.startsWith("/") || path.split(/[\\/]+/).includes("..")) fail("STATE_REPLAY_UNSAFE_SOURCE", "Plan source must stay inside its selected book.");
    if (await readFile(join(bookDir, path), "utf8") !== content) fail("STATE_REPLAY_VERSION_CHANGED", "Source used by this plan changed. The current manuscript and state were kept.");
  }
}

function assertCheckpoint(snapshot: RuntimeStateSnapshot, chapter: number): void {
  const summaryChapters = snapshot.chapterSummaries.rows.map(row => row.chapter).sort((a, b) => a - b);
  if (snapshot.manifest.lastAppliedChapter !== chapter || snapshot.currentState.chapter !== chapter
    || summaryChapters.length !== chapter || summaryChapters.some((value, i) => value !== i + 1)) {
    fail("STATE_REPLAY_BASELINE_MISMATCH", `Checkpoint content must exactly cover chapters 1–${chapter}.`);
  }
}

async function inspect(state: StateManager, bookId: string, baselineChapter: number, files: ReadonlyMap<string, Buffer>) {
  if (!Number.isInteger(baselineChapter) || baselineChapter < 0) fail("STATE_REPLAY_BASELINE_MISMATCH", "An explicit nonnegative baseline chapter is required.");
  const book = await state.loadBookConfig(bookId);
  if (book.id !== bookId) fail("STATE_REPLAY_BOOK_ID", "Book config identity does not match the selected book.");
  const index = [...await state.loadChapterIndex(bookId)].sort((a, b) => a.number - b.number);
  if (index.some((chapter, i) => chapter.number !== i + 1) || index.length <= baselineChapter) {
    fail("STATE_REPLAY_CHAPTER_GAP", "Replay requires contiguous indexed chapters after the baseline through the latest chapter.");
  }
  const baseline = await loadRuntimeStateSnapshotAtChapter({ bookDir: state.bookDir(bookId), chapterNumber: baselineChapter, language: book.language });
  assertCheckpoint(baseline, baselineChapter);
  if (index.slice(0, baselineChapter).some(chapter => chapter.observations.some(observation => replacedCodes.has(observation.code)))) {
    fail("STATE_REPLAY_BASELINE_UNVERIFIED", "The baseline still contains unresolved state validation observations.");
  }
  const chapters = index.map(meta => {
    const matches = [...files.keys()].filter(path => path.startsWith(`chapters/${String(meta.number).padStart(4, "0")}_`) && path.endsWith(".md") && path.split("/").length === 2);
    if (matches.length !== 1) fail("STATE_REPLAY_CHAPTER_AMBIGUOUS", `Chapter ${meta.number} needs exactly one prose file, found ${matches.length}.`);
    const sourcePath = matches[0]!;
    const raw = files.get(sourcePath)!.toString("utf8");
    if (!raw.trim()) fail("STATE_REPLAY_EMPTY_CHAPTER", `Chapter ${meta.number} is empty.`);
    return { meta, sourcePath, sourceText: raw, content: raw };
  });
  // Unindexed body files are a concurrent/incomplete write, not permission to ignore them.
  const known = new Set(chapters.map(chapter => chapter.sourcePath));
  if ([...files.keys()].some(path => /^chapters\/\d+_.*\.md$/.test(path) && !known.has(path))) {
    fail("STATE_REPLAY_CHAPTER_GAP", "Unindexed chapter prose exists; reconcile the chapter index first.");
  }
  return { book, index, baseline, chapters: chapters.slice(baselineChapter) };
}

function projectionWrites(snapshot: RuntimeStateSnapshot, prefix = "story"): AtomicFileWrite[] {
  const language = snapshot.manifest.language;
  return [
    { relativePath: join(prefix, "state/manifest.json"), content: json(snapshot.manifest) },
    { relativePath: join(prefix, "state/current_state.json"), content: json(snapshot.currentState) },
    { relativePath: join(prefix, "state/hooks.json"), content: json(snapshot.hooks) },
    { relativePath: join(prefix, "state/chapter_summaries.json"), content: json(snapshot.chapterSummaries) },
    { relativePath: join(prefix, "current_state.md"), content: renderCurrentStateProjection(snapshot.currentState, language) },
    { relativePath: join(prefix, "pending_hooks.md"), content: renderHooksProjection(snapshot.hooks, language) },
    { relativePath: join(prefix, "chapter_summaries.md"), content: renderChapterSummariesProjection(snapshot.chapterSummaries, language) },
  ];
}

function applyChapter(baseline: RuntimeStateSnapshot, chapter: StateReplayPlan["chapters"][number]): RuntimeStateSnapshot {
  if (chapter.number !== baseline.manifest.lastAppliedChapter + 1 || chapter.delta.chapter !== chapter.number || !chapter.delta.chapterSummary) {
    fail("STATE_REPLAY_CHAPTER_GAP", "Replay deltas must advance exactly one chapter with a chapter summary.");
  }
  const next = applyRuntimeStateDelta({ snapshot: baseline, delta: chapter.delta });
  assertCheckpoint(next, chapter.number);
  return next;
}

/** Model-assisted dry run in disposable storage. Never saves prose or changes live state. */
export async function prepareStateReplay(input: PrepareStateReplayInput): Promise<StateReplayPlan> {
  return withBook(input.projectRoot, input.bookId, async state => {
    checkAbort(input.signal);
    const frozen = await capture(input.projectRoot, state, input.bookId);
    const { book, baseline, chapters } = await inspect(state, input.bookId, input.baselineChapter, frozen.files);
    const isolatedRoot = await mkdtemp(join(tmpdir(), "inkos-state-replay-"));
    try {
      const isolatedBook = new StateManager(isolatedRoot).bookDir(input.bookId);
      for (const [path, content] of frozen.files) {
        const destination = join(isolatedBook, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content);
      }
      await writeFile(join(isolatedRoot, "works", input.bookId, "work.json"), frozen.work);
      await commitAtomicFileSet({ rootDir: isolatedBook, writes: projectionWrites(baseline) });
      const workers = input.createWorkers(isolatedRoot);
      const storyFrame = await readStoryFrame(isolatedBook);
      const bookRules = await readFile(join(isolatedBook, "story/book_rules.md"), "utf8");
      let current = baseline;
      const results: StateReplayPlan["chapters"] = [];
      for (const chapter of chapters) {
        checkAbort(input.signal);
        const chapterNumber = chapter.meta.number;
        const authority = { storyFrame, bookRules, chapterSummaries: renderChapterSummariesProjection(current.chapterSummaries, book.language) };
        const output = await workers.writer.settleChapterState({
          book, bookDir: isolatedBook, chapterNumber, baselineChapter: chapterNumber - 1,
          title: chapter.meta.title, content: chapter.content,
          chapterIntent: `Reconstruct only chapter ${chapterNumber}'s completed facts from its unchanged prose. Do not invent, edit, or continue the story.`,
          contextPackage: { chapter: chapterNumber, selectedContext: [
            { source: "story/outline/story_frame.md", reason: "Authoritative story frame", excerpt: storyFrame, protection: "protected" },
            { source: "story/book_rules.md", reason: "Authoritative book rules", excerpt: bookRules, protection: "protected" },
            { source: "story/chapter_summaries.md", reason: "Previously verified chapters only", excerpt: authority.chapterSummaries, protection: "protected" },
          ] },
        });
        checkAbort(input.signal);
        if (output.content !== chapter.content || output.title !== chapter.meta.title || output.chapterNumber !== chapterNumber) {
          fail("STATE_REPLAY_PROSE_CHANGED", "The settlement worker changed chapter identity or prose.");
        }
        const delta = RuntimeStateDeltaSchema.parse(output.runtimeStateDelta);
        // Recompute on the host rather than trusting a worker-provided snapshot or Markdown.
        const next = applyChapter(current, { number: chapterNumber, sourcePath: chapter.sourcePath, sourceText: chapter.sourceText, delta,
          validation: { consistent: true, reconciliationRequired: false, observations: [] } });
        let validation: ValidationResult;
        try {
          validation = await workers.validator.validate(chapter.content, chapterNumber,
            renderCurrentStateProjection(current.currentState, book.language), renderCurrentStateProjection(next.currentState, book.language),
            renderHooksProjection(current.hooks, book.language), renderHooksProjection(next.hooks, book.language), book.language, authority,
            { chapterSummary: next.chapterSummaries.rows.find(row => row.chapter === chapterNumber)! });
        } catch (error) {
          fail("STATE_REPLAY_VALIDATION_UNAVAILABLE", `Chapter ${chapterNumber} validation unavailable: ${String(error)}`, { chapterNumber });
        }
        checkAbort(input.signal);
        if (!validation.consistent || validation.reconciliationRequired) {
          fail("STATE_REPLAY_VALIDATION_FAILED", `Chapter ${chapterNumber} needs reconciliation; replay stopped before the next chapter.`, { chapterNumber, observations: validation.observations });
        }
        const checked = ValidationSchema.parse(validation);
        results.push({ number: chapterNumber, sourcePath: chapter.sourcePath, sourceText: chapter.sourceText, delta, validation: checked });
        await commitAtomicFileSet({ rootDir: isolatedBook, writes: [
          ...projectionWrites(next), ...projectionWrites(next, join("story/snapshots", String(chapterNumber))),
        ] });
        current = next;
      }
      const plan = StateReplayPlanSchema.parse({ version: 3, id: `replay-${randomUUID()}`,
        bookId: input.bookId, baselineChapter: input.baselineChapter,
        targetChapter: current.manifest.lastAppliedChapter, inputs: replayInputs(frozen.files, input.baselineChapter),
        createdAt: new Date().toISOString(), chapters: results });
      await requireUnchangedInputs(state.bookDir(input.bookId), plan);
      return plan;
    } finally { await rm(isolatedRoot, { recursive: true, force: true }); }
  });
}

function replayObservations(meta: ChapterMeta, chapter: StateReplayPlan["chapters"][number]): Observation[] {
  return [
    ...meta.observations.filter(observation => !replacedCodes.has(observation.code)),
    ...chapter.validation.observations.map(({ targetHash: _legacy, ...observation }) => ({ ...observation, scope: `chapter:${chapter.number}` })),
  ];
}

/** Commit an explicitly selected dry-run plan, without any model calls or prose writes. */
export async function commitStateReplay(input: {
  readonly projectRoot: string; readonly plan: unknown; readonly expectedPlanHash?: string; readonly expectedPlanId?: string; readonly signal?: AbortSignal;
}): Promise<{ bookId: string; baselineChapter: number; targetChapter: number; planId: string; planHash: string; committed: true }> {
  const plan = StateReplayPlanSchema.parse(input.plan);
  const planId = stateReplayPlanId(plan);
  if (input.expectedPlanId && input.expectedPlanId !== planId) fail("STATE_REPLAY_PLAN_CHANGED", "A different replay plan was selected.");
  return withBook(input.projectRoot, plan.bookId, async state => {
    checkAbort(input.signal);
    const frozen = await capture(input.projectRoot, state, plan.bookId);
    await requireUnchangedInputs(state.bookDir(plan.bookId), plan);
    const { index, baseline, chapters } = await inspect(state, plan.bookId, plan.baselineChapter, frozen.files);
    if (chapters.length !== plan.chapters.length || plan.targetChapter !== chapters.at(-1)!.meta.number) fail("STATE_REPLAY_CHAPTER_GAP", "Plan must cover every persisted chapter after the baseline.");
    let current = baseline;
    const writes: AtomicFileWrite[] = [];
    const patchedIndex = new Map(index.map(meta => [meta.number, meta]));
    for (const [i, chapter] of plan.chapters.entries()) {
      const source = chapters[i]!;
      if (source.meta.number !== chapter.number || source.content !== chapter.sourceText || source.sourcePath !== chapter.sourcePath) fail("STATE_REPLAY_VERSION_CHANGED", "Chapter identity or prose changed.");
      current = applyChapter(current, chapter);
      writes.push(...projectionWrites(current, join("story/snapshots", String(chapter.number))));
      // Keep all original metadata, counts, provenance and timestamps. Only validation observations change.
      patchedIndex.set(chapter.number, { ...source.meta, observations: replayObservations(source.meta, chapter) });
      writes.push({ relativePath: join("story/runtime", `chapter-${String(chapter.number).padStart(4, "0")}.state-replay.json`),
        content: json({ version: 2, planId, baselineChapter: chapter.number - 1, chapterNumber: chapter.number, validation: chapter.validation }) });
    }
    writes.push(...projectionWrites(current), { relativePath: "chapters/index.json", content: json(index.map(meta => patchedIndex.get(meta.number)!)) });
    checkAbort(input.signal);
    await requireUnchangedInputs(state.bookDir(plan.bookId), plan);
    await syncWorkSourceArtifacts({ projectRoot: input.projectRoot, workId: plan.bookId, accept: true,
      writes: writes.map(write => ({ ...write, relativePath: join("works", plan.bookId, "source", write.relativePath) })) });
    return { bookId: plan.bookId, baselineChapter: plan.baselineChapter, targetChapter: plan.targetChapter, planId, planHash: planId, committed: true };
  });
}
