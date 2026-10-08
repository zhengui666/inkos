import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { loadRuntimeStateSnapshot, loadRuntimeStateSnapshotAtChapter } from "../state/runtime-state-store.js";
import { buildChapterFileLookup } from "../interaction/export-artifact.js";
import { loadWorkManifest } from "../harness/work-store.js";
import { recoverAtomicFileSets } from "../utils/atomic-file-set.js";
import { runInWorkMutationQueue, withWorkMutationScope } from "../utils/work-mutation-scope.js";
import { safeChildPath } from "../utils/path-safety.js";
import {
  goalError, goalFailure, goalInputValue, type GoalInput, type GoalReconciliation, type GoalStepAdapter, type GoalStepContext,
} from "./contracts.js";

export const CHAPTER_GOAL_KIND = "longform.write_chapter";
const ChapterInput = z.object({
  chapterNumber: z.number().int().min(1), wordCount: z.number().int().positive().optional(),
}).strict();
const unknown = (code: string, message: string): GoalReconciliation => ({ status: "unknown", error: { code, message } });

/** Authorizes a fixed range. The goal accepts committed chapters, not literary quality. */
export function chapterGoalInput(input: {
  readonly id: string; readonly workId: string; readonly intent: string;
  readonly startChapter: number; readonly endChapter: number; readonly wordCount?: number;
  readonly expiresAt: number | null; readonly maxAttemptsPerChapter?: number;
}): GoalInput {
  const start = z.number().int().positive().parse(input.startChapter);
  const end = z.number().int().min(start).parse(input.endChapter);
  const maxAttempts = input.maxAttemptsPerChapter ?? 3;
  return { id: input.id, workId: input.workId, intent: input.intent,
    budget: { maxAttempts: (end - start + 1) * maxAttempts, expiresAt: input.expiresAt },
    steps: Array.from({ length: end - start + 1 }, (_, offset) => ({
      id: `chapter-${start + offset}`, kind: CHAPTER_GOAL_KIND,
      input: { chapterNumber: start + offset, ...(input.wordCount === undefined ? {} : { wordCount: input.wordCount }) }, maxAttempts,
    })),
  };
}

export function createChapterGoalAdapter(options: {
  readonly projectRoot: string;
  readonly pipeline: Pick<PipelineRunner, "writeChapters" | "runWithAbortSignal">;
}): GoalStepAdapter {
  const root = resolve(options.projectRoot), state = new StateManager(root);
  return {
    kind: CHAPTER_GOAL_KIND, retrySafe: true,
    withScope: (context, task) => runInWorkMutationQueue(`${root}\0${context.goal.workId}`,
      () => withWorkMutationScope(root, context.goal.workId, () => state.acquireBookLock(context.goal.workId), async () => {
        await recoverAtomicFileSets(root);
        await recoverAtomicFileSets(state.bookDir(context.goal.workId));
        return task();
      })),
    reconcile: context => reconcileChapter(root, state, context),
    execute: async context => {
      const input = ChapterInput.parse(context.step.input);
      context.signal.throwIfAborted();
      await options.pipeline.runWithAbortSignal(context.signal, () => options.pipeline.writeChapters(context.goal.workId, 1, {
        startChapterNumber: input.chapterNumber, wordCount: input.wordCount, externalContext: context.goal.intent,
      }));
    },
    // Only transient provider failures with positively confirmed absence retry.
    isRetryable: error => ["MODEL_UNAVAILABLE", "WORKER_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "RATE_LIMITED"].includes(goalFailure(error).code),
  };
}

async function reconcileChapter(root: string, state: StateManager, context: GoalStepContext): Promise<GoalReconciliation> {
  try {
    const number = ChapterInput.parse(context.step.input).chapterNumber;
    const selected = (await state.loadChapterIndex(context.goal.workId)).find(chapter => chapter.number === number);
    if (selected?.observations.some(observation => observation.code === "state-sync-required")) {
      return unknown("CHAPTER_STATE_SYNC_REQUIRED", `Chapter ${number} was edited; its existing state is not reported as settled.`);
    }
    return await inspectChapter(root, state, context);
  }
  catch (error) {
    const failure = goalFailure(error);
    return unknown(failure.code === "GOAL_EXECUTION_FAILED" ? "CHAPTER_RECONCILIATION_REQUIRED" : failure.code, failure.message);
  }
}

async function readChapterState(root: string, state: StateManager, workId: string) {
  const bookDir = state.bookDir(workId), index = await state.loadChapterIndex(workId);
  const files = await readdir(join(bookDir, "chapters")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && index.length === 0) return [];
    throw error;
  });
  const lookup = buildChapterFileLookup(files, index);
  const numbers = index.map(chapter => chapter.number).sort((a, b) => a - b);
  if (numbers.some((number, position) => number !== position + 1)) {
    throw goalError("CHAPTER_INDEX_GAP", "Chapter index is not contiguous from chapter one. Reconcile the index before continuing.");
  }
  const latest = numbers.at(-1) ?? 0, runtime = await loadRuntimeStateSnapshot(bookDir);
  if (runtime.manifest.lastAppliedChapter !== latest) {
    throw goalError("CHAPTER_STATE_BEHIND", `Chapter index ends at ${latest}, but runtime state ends at ${runtime.manifest.lastAppliedChapter}. Settle retained chapters before continuing.`);
  }
  if (latest > 0) {
    const checkpoint = await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber: latest, language: runtime.manifest.language });
    if (goalInputValue(checkpoint) !== goalInputValue(runtime)) {
      throw goalError("CHAPTER_STATE_CHECKPOINT_MISMATCH", "Current runtime state differs from the latest chapter checkpoint. Reconcile state before continuing.");
    }
  }
  const work = await loadWorkManifest(root, workId);
  return { bookDir, index, lookup, numbers, latest, runtime, work };
}

type ChapterState = Awaited<ReturnType<typeof readChapterState>>;

async function checkAcceptedInputs(root: string, state: ChapterState, context: GoalStepContext): Promise<void> {
  const { bookDir, runtime, work } = state, workId = context.goal.workId;
  // Every earlier accepted chapter remains a protected input of later writing.
  // Reads are bounded to four checkpoints at once under the same mutation scope.
  // Settle the whole batch before throwing, preserving the earliest step's error
  // without leaving open reads behind when the scope releases its lock.
  const accepted = context.goal.steps.filter(step => step.receipt && step.kind === CHAPTER_GOAL_KIND);
  for (let offset = 0; offset < accepted.length; offset += 4) {
    const results = await Promise.allSettled(accepted.slice(offset, offset + 4).map(async step => {
      const acceptedChapter = ChapterInput.parse(step.input).chapterNumber;
      const checkpoint = await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber: acceptedChapter, language: runtime.manifest.language });
      const retainedCheckpoint = step.receipt!.evidence.checkpointState;
      if (typeof retainedCheckpoint !== "string" || goalInputValue(checkpoint) !== retainedCheckpoint) {
        throw goalError("CHAPTER_CHECKPOINT_CHANGED", `Accepted checkpoint ${step.id} changed or its older receipt has no retained checkpoint content. The receipt was kept without silently resuming it.`);
      }
      for (const ref of step.receipt!.artifacts) {
        const artifact = work.artifacts.find(item => item.id === ref.artifactId);
        const current = artifact?.revisions.find(item => item.id === artifact.currentRevisionId);
        const saved = current?.snapshotPath ? await readFile(safeChildPath(join(root, "works", workId), current.snapshotPath)) : undefined;
        if (current?.id !== ref.revisionId || !saved
          || !saved.equals(await readFile(safeChildPath(join(root, "works", workId), ref.path)))) {
          throw goalError("CHAPTER_BASELINE_CHANGED", `Accepted chapter ${step.id} changed. Reconcile the goal baseline before continuing.`);
        }
      }
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
}

async function missingChapterBaseline(state: ChapterState, chapterNumber: number): Promise<GoalReconciliation> {
  const { latest, numbers, lookup, bookDir, work, index, runtime } = state;
  if (chapterNumber !== latest + 1) return unknown("CHAPTER_RANGE_GAP", `Requested chapter ${chapterNumber} is not the next unwritten chapter ${latest + 1}.`);
  const sources = [];
  for (const number of numbers) {
    const path = `source/chapters/${lookup.get(number)!}`;
    const bytes = await readFile(join(bookDir, "chapters", lookup.get(number)!));
    const artifact = work.artifacts.find(item => item.revisions.some(revision => revision.path === path));
    const revision = artifact?.revisions.find(item => item.id === artifact.currentRevisionId);
    const saved = revision?.snapshotPath ? await readFile(join(bookDir, "..", revision.snapshotPath)) : undefined;
    if (!revision || revision.path !== path || !saved?.equals(bytes)) {
      return unknown("CHAPTER_DEPENDENCY_UNCONFIRMED", `Earlier chapter ${number} differs from its current Work revision. Reconcile before continuing.`);
    }
    sources.push({ number, revisionId: revision.id, content: bytes.toString("utf8") });
  }
  return { status: "absent", baselineState: goalInputValue({ index, runtime, sources }) };
}

async function inspectChapter(root: string, manager: StateManager, context: GoalStepContext): Promise<GoalReconciliation> {
  const { chapterNumber } = ChapterInput.parse(context.step.input), workId = context.goal.workId;
  const state = await readChapterState(root, manager, workId);
  await checkAcceptedInputs(root, state, context);
  const { lookup, bookDir, runtime, work } = state, file = lookup.get(chapterNumber);
  if (!file) return missingChapterBaseline(state, chapterNumber);
  const snapshot = await loadRuntimeStateSnapshotAtChapter({ bookDir, chapterNumber, language: runtime.manifest.language });
  if (snapshot.manifest.lastAppliedChapter !== chapterNumber) {
    return unknown("CHAPTER_CHECKPOINT_BEHIND", `Chapter ${chapterNumber} has prose but its checkpoint is not settled. Preserve the prose and repair its state.`);
  }
  const path = `source/chapters/${file}`, bytes = await readFile(join(bookDir, "chapters", file));
  const artifact = work.artifacts.find(item => item.revisions.some(revision => revision.path === path));
  const revision = artifact?.revisions.find(item => item.id === artifact.currentRevisionId);
  if (!artifact || !revision || revision.path !== path || !revision.snapshotPath) {
    return unknown("CHAPTER_REGISTRY_UNCONFIRMED", `Chapter ${chapterNumber} is retained, but its current Work revision does not match. Reconcile the registry without rewriting prose.`);
  }
  if (!(await readFile(safeChildPath(join(root, "works", workId), revision.snapshotPath))).equals(bytes)) {
    return unknown("CHAPTER_REVISION_SNAPSHOT_CHANGED", `Saved revision for chapter ${chapterNumber} differs from the retained chapter text.`);
  }
  if (context.step.receipt) return { status: "completed", receipt: context.step.receipt };
  return { status: "completed", receipt: { operationKey: context.step.operationKey,
    artifacts: [{ artifactId: artifact.id, revisionId: revision.id, path }],
    evidence: { chapterNumber, checkpointState: goalInputValue(snapshot) },
  } };
}
