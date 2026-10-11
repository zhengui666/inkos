import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateChapterTruthPersistence } from "../pipeline/chapter-truth-validation.js";
import { reconcileChapterStateAfterReview } from "../pipeline/chapter-state-recovery.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage } from "../models/input-governance.js";
import type { ValidationResult } from "../agents/state-validator.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const failure = (code: string) => Object.assign(new Error("Offline provider fixture"), { code });
const mismatch: ValidationResult = { consistent: false, reconciliationRequired: true,
  observations: [{ code: "state-reconciliation", summary: "Receipt ownership contradicts the body.", evidence: [] }] };
async function boundary(kind: "initial" | "retry", error: unknown) {
  const bookDir = await mkdtemp(join(tmpdir(), "inkos-validator-unit-")); roots.push(bookDir);
  await createInitialRuntimeState({ bookDir, language: "en" });
  const snapshot = await loadRuntimeStateSnapshot(bookDir);
  const output: WriteChapterOutput = { chapterNumber: 1, title: "Receipt", content: "Receipt returned.", wordCount: 2,
    postSettlement: "Returned.", runtimeStateDelta: { chapter: 1, factOps: { upsert: [], expire: [] },
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
      chapterSummary: { chapter: 1, title: "Receipt", characters: "Mara", events: "Receipt returned", stateChanges: "", hookActivity: "", mood: "quiet", chapterType: "scene" } },
    runtimeStateSnapshot: snapshot, runtimeStateApplied: true, updatedState: "Changed ownership", updatedHooks: "", updatedChapterSummaries: "" };
  const validator = { validate: vi.fn().mockRejectedValue(error) };
  const writer = { settleChapterState: vi.fn().mockResolvedValue(output) };
  const common = { book: { id: "fixture" } as BookConfig, bookDir, chapterNumber: 1, title: output.title, content: output.content,
    writer, validator, reducedControlInput: { chapterIntent: "Return receipt", contextPackage: {} as ContextPackage },
    language: "en" as const, logWarn: vi.fn() };
  const run = () => kind === "initial"
    ? validateChapterTruthPersistence({ ...common, previousTruth: { oldState: "Baseline", oldHooks: "" }, persistenceOutput: output })
    : reconcileChapterStateAfterReview({ ...common, oldState: "Baseline", oldHooks: "", originalValidation: mismatch });
  return { run, validator, writer, snapshot, output };
}

for (const kind of ["initial", "retry"] as const) describe(`${kind} validator catch`, () => {
  it.each(["MODEL_UNAVAILABLE", "WORKER_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "RATE_LIMITED"])
  ("rethrows the original immediate %s object before returning persistence output", async code => {
    const error = failure(code), f = await boundary(kind, error);
    await expect(f.run()).rejects.toBe(error);
    expect(f.validator.validate).toHaveBeenCalledOnce();
    expect(f.writer.settleChapterState).toHaveBeenCalledTimes(kind === "retry" ? 1 : 0);
  });
  const excluded: Array<[string, () => unknown]> = [
    ["cause-only wrapper", () => new Error("Retained context", { cause: failure("ECONNRESET") })],
    ...["CODEX_AUTH_REQUIRED", "PI_AUTH_REQUIRED", "PI_RUNTIME_GENERATION_CHANGED", "QUALITY_FAILED", "CHAPTER_STATE_SYNC_REQUIRED",
      "STATE_RECONCILIATION_REASON_REQUIRED", "REMOTE_WORK_OUTCOME_UNKNOWN", "EACCES", "UNKNOWN",
      "CHAPTER_REVIEW_UNAVAILABLE", "PUBLISHING_UNAVAILABLE"].map(code => [code, () => failure(code)] as [string, () => unknown]),
    ["misleading message", () => new Error("ECONNRESET MODEL_UNAVAILABLE")],
    ["missing code", () => new Error("Unavailable")],
    ["AbortError", () => Object.assign(new Error("Cancelled"), { name: "AbortError" })],
    ["aggregate with recognized outer code", () => Object.assign(new AggregateError([failure("ECONNRESET"), new Error("Cleanup uncertain")],
      "Uncertain effects", { cause: failure("ECONNRESET") }), { code: "ECONNRESET" })],
    ["explicit unknown outer code with transient cause", () => Object.assign(new Error("Unknown", { cause: failure("ECONNRESET") }), { code: "UNKNOWN" })],
  ];
  it.each(excluded)("preserves conservative fallback for %s", async (_name, makeError) => {
    const f = await boundary(kind, makeError()), result = await f.run();
    expect(result.validation).toMatchObject({ consistent: false, reconciliationRequired: true,
      observations: [{ code: "state-validation-unavailable" }] });
    if ("persistenceOutput" in result) {
      expect(result.persistenceOutput.runtimeStateApplied).toBe(false);
      expect(result.persistenceOutput.runtimeStateSnapshot).toEqual(f.snapshot);
    } else {
      expect(result.kind).toBe("unresolved"); expect(result.output).toBe(f.output);
    }
  });
});

it("leaves settlement failures outside the retry validator catch", async () => {
  const f = await boundary("retry", failure("ETIMEDOUT")), error = failure("EACCES");
  f.writer.settleChapterState.mockRejectedValue(error);
  await expect(f.run()).rejects.toBe(error);
  expect(f.validator.validate).not.toHaveBeenCalled();
});
