import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WriterAgent } from "../agents/writer.js";
import { ComposerAgent } from "../agents/composer.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { createWorkManifest, loadWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { captureWorkSourceState, syncWorkSourceArtifacts } from "../harness/source-sync.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { savePersistedPlan } from "../pipeline/persisted-governed-plan.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import * as draftRecovery from "../pipeline/unsettled-draft.js";
import { loadUnsettledDraft } from "../pipeline/unsettled-draft.js";
import type { BookConfig } from "../models/book.js";
import type { LLMClient } from "../llm/provider.js";

const mock = vi.hoisted(() => ({ tool: vi.fn(), text: vi.fn() }));
vi.mock("../agent/worker-agent.js", () => ({ runWorkerAgentTool: mock.tool, runWorkerAgent: mock.text }));
const client: LLMClient = { provider: "openai", apiFormat: "responses", stream: true,
  defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} }, _codex: { projectRoot: "/fixture" } };
const roots: string[] = [];
const usage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
const prose = "Mara returns the sealed receipt to its owner. The witness closes the door.";
let settleFailures = 0, draftCount = 0;
let onDraft: (() => void | Promise<void>) | undefined;
let onSettle: (() => void | Promise<void>) | undefined;
let onValidate: (() => void | Promise<void>) | undefined;

// Shared with the fresh-process fixture below. The returned citations pass the
// actual source resolver and contract validators; no review method is stubbed.
function sourcedRecoveryReview(toolName: string, messages: ReadonlyArray<{ role: string; content: string }>) {
  const prompt = JSON.parse([...messages].reverse().find(message => message.role === "user")!.content);
  const source = (id: string) => prompt.sources.find((item: { sourceId: string }) => item.sourceId === id)?.numberedLines;
  if (source("chapter-contract-source") !== "1\tgoal=Return the receipt | Keep it sealed.") {
    throw new Error("Recovery review must classify the actual retained chapter memo.");
  }
  const ref = (sourceId: string) => ({ sourceId, startLine: 1, endLine: 1 });
  if (toolName === "submit_chapter_contract") {
    if (source("chapter-1") !== undefined) throw new Error("Contract classification must not see draft prose.");
    return { summary: "The retained memo requires return and prohibits breaking the seal.", observations: [
      { code: "required-event", assessment: "observation", summary: "Return the receipt.", sourceRefs: [ref("chapter-contract-source")] },
      { code: "prohibition", assessment: "observation", summary: "Do not break the seal.", sourceRefs: [ref("chapter-contract-source")] },
    ] };
  }
  if (!source("chapter-1")?.startsWith("1\tMara returns the sealed receipt to its owner. The witness closes the door.")) {
    throw new Error("Recovery review must inspect the actual current draft.");
  }
  if (JSON.stringify(prompt.chapterContract?.requirements.map((item: { code: string }) => item.code)) !== JSON.stringify(["chapter-contract-1", "chapter-contract-2"])) {
    throw new Error("Recovery review must cover both retained requirements.");
  }
  return { summary: "The current body returns the receipt without breaking its seal.", observations: [
    { code: "chapter-contract-inventory", category: "quality", assessment: "observation", summary: "Both original requirements are retained.", sourceRefs: [ref("chapter-contract-source")] },
    ...["chapter-contract-1", "chapter-contract-2"].map(code => ({ code, category: "quality", assessment: "observation",
      summary: "The current body returns the still-sealed receipt.", sourceRefs: [ref(code), ref("chapter-1")] })),
  ] };
}

beforeEach(() => {
  settleFailures = 0; draftCount = 0; onDraft = onSettle = onValidate = undefined;
  mock.tool.mockReset(); mock.text.mockReset();
  mock.tool.mockImplementation(async (_client, _model, _messages, tool, options) => {
    options.onUsage?.(usage);
    if (tool.name === "submit_chapter_memo") return { goal: "Return the receipt", body: "Keep it sealed.", threadRefs: [] };
    if (tool.name === "submit_chapter_draft") { draftCount++; await onDraft?.(); return { title: "Receipt", content: `${prose}${draftCount > 1 ? ` Attempt ${draftCount}.` : ""}` }; }
    if (tool.name === "submit_runtime_state_delta") {
      await onSettle?.();
      if (settleFailures-- > 0) throw new Error("Fixture interrupted settlement");
      return { postSettlement: "Receipt returned.", factOps: { upsert: [{ subject: "receipt", predicate: "owner", object: "Mara's client" }], expire: [] },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { title: "Receipt", characters: "Mara", events: "Receipt returned.", stateChanges: "", hookActivity: "", mood: "quiet", chapterType: "scene" } };
    }
    if (["submit_chapter_contract", "submit_chapter_review"].includes(tool.name)) return sourcedRecoveryReview(tool.name, _messages);
    if (tool.name === "submit_state_validation") { await onValidate?.(); return { reconciliationRequired: false, reportMarkdown: "" }; }
    throw new Error(`Unexpected offline tool ${tool.name}`);
  });
});
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-unsettled-")); roots.push(root);
  const state = new StateManager(root), bookDir = state.bookDir("novel"), now = "2026-10-08T00:00:00.000Z";
  const book: BookConfig = { id: "novel", title: "Receipt", genre: "general", platform: "other", status: "active" as const,
    targetChapters: 2, chapterWordCount: 20, language: "en" as const, createdAt: now, updatedAt: now };
  await saveWorkManifest(root, createWorkManifest({ id: book.id, title: book.title, profileId: "longform-novel", language: "en" }));
  await state.saveBookConfig(book.id, book);
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  await mkdir(join(bookDir, "story/runtime"), { recursive: true });
  for (const [file, content] of Object.entries({ "outline/story_frame.md": "Mara returns the sealed receipt.", "outline/volume_map.md": "One delivery.",
    "book_rules.md": "# Rules\nKeep the receipt sealed.", "book_rules.json": JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }) })) await writeFile(join(bookDir, "story", file), content);
  await createInitialRuntimeState({ bookDir, language: "en" }); await state.saveChapterIndex(book.id, []);
  await savePersistedPlan(bookDir, { intent: { chapter: 1, goal: "Return the receipt" }, memo: { chapter: 1, goal: "Return the receipt", body: "Keep it sealed.", threadRefs: [] },
    intentMarkdown: "Return the receipt", plannerInputs: [], runtimePath: "unused" });
  const runner = () => new PipelineRunner({ projectRoot: root, client, model: "fixture" });
  const checkpointDir = join(root, ".inkos/unsettled-drafts/novel"), checkpointPath = join(checkpointDir, "chapter-0001.json");
  const write = (instruction?: string) => runner().writeChapters(book.id, 1, { startChapterNumber: 1, externalContext: instruction });
  return { root, state, bookDir, book, runner, checkpointDir, checkpointPath, write };
}
const calls = (name: string) => mock.tool.mock.calls.filter(call => call[3].name === name);
async function noAcceptedChapter(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.state.loadChapterIndex("novel")).toEqual([]);
  expect((await loadRuntimeStateSnapshot(f.bookDir)).manifest.lastAppliedChapter).toBe(0);
  expect((await readdir(join(f.bookDir, "chapters"))).filter(file => file.endsWith(".md"))).toEqual([]);
  expect((await loadWorkManifest(f.root, "novel")).artifacts.filter(artifact => artifact.kind === "chapter" && artifact.currentRevisionId)).toEqual([]);
}

describe("generated but unsettled draft recovery", () => {
  it("retains a complete body before settlement, restarts without redrafting, and accepts once", async () => {
    const f = await fixture(); settleFailures = 1;
    onSettle = async () => { expect(JSON.parse(await readFile(f.checkpointPath, "utf8")).draft.content).toBe(prose); };
    await expect(f.write("Keep the receipt sealed.")).rejects.toThrow("interrupted settlement");
    await noAcceptedChapter(f);
    expect(draftCount).toBe(1);
    const checkpointBefore = await readFile(f.checkpointPath, "utf8");
    expect([...await captureWorkSourceState(f.root, "novel")].some(([path]) => path.includes("unsettled-drafts"))).toBe(false);
    await syncWorkSourceArtifacts({ projectRoot: f.root, workId: "novel", accept: true });
    expect(JSON.stringify(await loadWorkManifest(f.root, "novel"))).not.toContain(prose);
    const result = await f.write("Keep the receipt sealed.");
    expect(result[0].title).toBe("Receipt"); expect(draftCount).toBe(1);
    expect(calls("submit_chapter_memo")).toHaveLength(1);
    expect(calls("submit_runtime_state_delta")).toHaveLength(2);
    expect(calls("submit_chapter_contract")).toHaveLength(1);
    expect(calls("submit_chapter_review")).toHaveLength(1);
    const acceptedIndex = await f.state.loadChapterIndex("novel");
    expect(acceptedIndex).toHaveLength(1);
    expect(acceptedIndex[0].observations.map(item => item.code)).toEqual(["chapter-contract-inventory", "chapter-contract-1", "chapter-contract-2"]);
    expect(acceptedIndex[0].observations.every(item => item.assessment === "observation")).toBe(true);
    expect((await loadRuntimeStateSnapshot(f.bookDir)).currentState.facts).toHaveLength(1);
    await expect(readFile(f.checkpointPath)).rejects.toMatchObject({ code: "ENOENT" });
    // Simulate a process dying after atomic acceptance but before checkpoint cleanup.
    await writeFile(f.checkpointPath, checkpointBefore);
    await expect(f.write("Keep the receipt sealed.")).rejects.toMatchObject({ code: "CHAPTER_WRITE_RANGE_CONFLICT" });
    expect(draftCount).toBe(1); expect(calls("submit_runtime_state_delta")).toHaveLength(2);
  });

  it("resumes repeated settlement failures from the identical checkpoint", async () => {
    const f = await fixture(); settleFailures = 2;
    await expect(f.write()).rejects.toThrow("interrupted settlement");
    const before = await readFile(f.checkpointPath, "utf8");
    await expect(f.write()).rejects.toThrow("interrupted settlement");
    expect(await readFile(f.checkpointPath, "utf8")).toBe(before);
    await f.write(); expect(draftCount).toBe(1); expect(calls("submit_runtime_state_delta")).toHaveLength(3);
  });

  it.each(["outline/story_frame.md", "author_intent.md", "current_focus.md", "style_guide.md", "runtime/chapter-0001.plan.json", "runtime/chapter-0001.user-brief.md", "state/current_state.json"])("archives the old body and starts a new draft when %s changes", async file => {
    const f = await fixture(); settleFailures = 1;
    await expect(f.write()).rejects.toThrow("interrupted settlement");
    const before = await readFile(f.checkpointPath, "utf8");
    const path = join(f.bookDir, "story", file);
    if (file.endsWith("plan.json")) { const plan = JSON.parse(await readFile(path, "utf8")); plan.memo.body = "Use the updated chapter plan."; await writeFile(path, JSON.stringify(plan)); }
    else if (file.endsWith("current_state.json")) { const state = JSON.parse(await readFile(path, "utf8")); state.facts.push({ subject: "receipt", predicate: "seal", object: "intact", sourceChapter: 0, validFromChapter: 0, validUntilChapter: null }); await writeFile(path, JSON.stringify(state)); }
    else await writeFile(path, "Updated author source. Keep it sealed.");
    await f.write(); expect(draftCount).toBe(2);
    const archived = await readdir(join(f.checkpointDir, "stale")); expect(archived).toHaveLength(1);
    expect(await readFile(join(f.checkpointDir, "stale", archived[0]), "utf8")).toBe(before);
  });

  it("invalidates changed author requests even when the delegated instruction is identical", async () => {
    const f = await fixture(); settleFailures = 1;
    await expect(withExecutionEvidence(undefined, () => f.write(), undefined, undefined, "Original author request")).rejects.toThrow("interrupted settlement");
    await withExecutionEvidence(undefined, () => f.write(), undefined, undefined, "New author request");
    expect(draftCount).toBe(2);
  });

  it("retains a completed body on cancellation without settlement, then resumes only on a new call", async () => {
    const f = await fixture(), controller = new AbortController();
    onDraft = () => controller.abort(new Error("Author cancelled"));
    const runner = f.runner();
    await expect(runner.runWithAbortSignal(controller.signal, () => runner.writeChapters("novel", 1, { startChapterNumber: 1 }))).rejects.toThrow("Author cancelled");
    expect(JSON.parse(await readFile(f.checkpointPath, "utf8")).draft.content).toBe(prose);
    expect(calls("submit_runtime_state_delta")).toHaveLength(0); await noAcceptedChapter(f);
    onDraft = undefined; await f.write(); expect(draftCount).toBe(1);
  });

  it("does not accept a body when inputs change during generation", async () => {
    const f = await fixture(); onDraft = () => writeFile(join(f.bookDir, "story/current_focus.md"), "New direction");
    await expect(f.write()).rejects.toMatchObject({ code: "CHAPTER_DRAFT_INPUTS_CHANGED" });
    expect(JSON.parse(await readFile(f.checkpointPath, "utf8")).draft.content).toBe(prose);
    expect(calls("submit_runtime_state_delta")).toHaveLength(0); await noAcceptedChapter(f);
    onDraft = undefined; await f.write(); expect(draftCount).toBe(2);
  });

  it.each(["settlement", "validation"])("cancellation during %s never promotes the checkpoint", async stage => {
    const f = await fixture(), controller = new AbortController(), runner = f.runner();
    const cancel = () => controller.abort(new Error("Author cancelled"));
    if (stage === "settlement") onSettle = cancel; else onValidate = cancel;
    await expect(runner.runWithAbortSignal(controller.signal, () => runner.writeChapters("novel", 1, { startChapterNumber: 1 }))).rejects.toThrow("Author cancelled");
    await noAcceptedChapter(f);
    expect(JSON.parse(await readFile(f.checkpointPath, "utf8")).draft.content).toBe(prose);
    onSettle = onValidate = undefined; await f.write(); expect(draftCount).toBe(1);
  });

  it("pre-aborted operations do not load, archive or start a draft", async () => {
    const f = await fixture(), controller = new AbortController(), runner = f.runner(); controller.abort(new Error("Already paused"));
    await expect(runner.runWithAbortSignal(controller.signal, () => runner.writeChapters("novel", 1, { startChapterNumber: 1 }))).rejects.toThrow("Already paused");
    await expect(readFile(f.checkpointPath)).rejects.toMatchObject({ code: "ENOENT" }); expect(mock.tool).not.toHaveBeenCalled();
  });

  it("rechecks inputs after review before atomic acceptance", async () => {
    const f = await fixture(); onValidate = () => writeFile(join(f.bookDir, "story/current_focus.md"), "Changed during review");
    await expect(f.write()).rejects.toMatchObject({ code: "CHAPTER_DRAFT_INPUTS_CHANGED" });
    await noAcceptedChapter(f); expect(calls("submit_chapter_review")).toHaveLength(1);
  });

  it("does not draft from a source changed during context preparation", async () => {
    const f = await fixture(), original = ComposerAgent.prototype.composeChapter;
    vi.spyOn(ComposerAgent.prototype, "composeChapter").mockImplementationOnce(async function(this: ComposerAgent, input) {
      const result = await original.call(this, input);
      await writeFile(join(f.bookDir, "story/current_focus.md"), "New preparation inputs");
      return result;
    });
    await expect(f.write()).rejects.toMatchObject({ code: "CHAPTER_DRAFT_INPUTS_CHANGED" }); expect(draftCount).toBe(0);
  });

  it("does not bless an author plan edit as this operation's preparation output", async () => {
    const f = await fixture(), original = ComposerAgent.prototype.composeChapter;
    vi.spyOn(ComposerAgent.prototype, "composeChapter").mockImplementationOnce(async function(this: ComposerAgent, input) {
      const result = await original.call(this, input);
      const path = join(f.bookDir, "story/runtime/chapter-0001.plan.json");
      const plan = JSON.parse(await readFile(path, "utf8")); plan.memo.body = "Never return the receipt. Destroy it.";
      await writeFile(path, JSON.stringify(plan)); return result;
    });
    await expect(f.write()).rejects.toMatchObject({ code: "CHAPTER_DRAFT_INPUTS_CHANGED" });
    expect(draftCount).toBe(0); await noAcceptedChapter(f);
  });

  it("keeps the draft when final persistence fails and reruns review on retry", async () => {
    const f = await fixture(); const save = vi.spyOn(WriterAgent.prototype, "saveChapter").mockRejectedValueOnce(new Error("Disk unavailable"));
    await expect(f.write()).rejects.toThrow("Disk unavailable"); await noAcceptedChapter(f);
    expect(JSON.parse(await readFile(f.checkpointPath, "utf8")).draft.content).toBe(prose);
    save.mockRestore(); await f.write(); expect(draftCount).toBe(1); expect(calls("submit_chapter_review")).toHaveLength(2);
  });

  it("detects reference content changes behind the same binding", async () => {
    const f = await fixture(); await mkdir(join(f.root, ".inkos/materials"), { recursive: true });
    await writeFile(join(f.root, ".inkos/materials/ref.json"), JSON.stringify({ id: "ref", title: "Method", markdownPath: ".inkos/materials/ref.md", manifestPath: ".inkos/materials/ref.json" }));
    await writeFile(join(f.root, ".inkos/materials/ref.md"), "An original method note.");
    await writeFile(join(f.bookDir, "story/reference_bindings.json"), JSON.stringify({ version: 1, bookId: "novel", bindings: [{ materialId: "ref", uses: ["Method only"], createdAt: f.book.createdAt, updatedAt: f.book.updatedAt }] }));
    vi.spyOn(ComposerAgent.prototype, "selectReferenceSections").mockResolvedValue([]);
    settleFailures = 1; await expect(f.write()).rejects.toThrow("interrupted settlement");
    await writeFile(join(f.root, ".inkos/materials/ref.md"), "Updated method note.");
    await f.write(); expect(draftCount).toBe(2);
  });

  it("actually resumes settlement in a fresh OS process without a new draft call", async () => {
    const f = await fixture(); settleFailures = 1; await expect(f.write()).rejects.toThrow("interrupted settlement");
    const sourceRoot = new URL("../", import.meta.url).href;
    const workerModule = `
      ${sourcedRecoveryReview.toString()}
      export const calls = [];
      export async function runWorkerAgent() { throw new Error('No text model calls allowed'); }
      export async function runWorkerAgentTool(client, model, messages, tool, options) {
        calls.push(tool.name); options.onUsage?.({promptTokens:1,completionTokens:1,totalTokens:2});
        if(tool.name === 'submit_runtime_state_delta') return {
          postSettlement:'Receipt returned.',factOps:{upsert:[],expire:[]},hookOps:{upsert:[],mention:[],resolve:[],defer:[]},newHookCandidates:[],
          chapterSummary:{title:'Receipt',characters:'Mara',events:'Receipt returned.',stateChanges:'',hookActivity:'',mood:'quiet',chapterType:'scene'}};
        if(['submit_chapter_contract','submit_chapter_review'].includes(tool.name)) return sourcedRecoveryReview(tool.name,messages);
        if(tool.name === 'submit_state_validation') return {reconciliationRequired:false,reportMarkdown:''};
        throw new Error('Unexpected call on resume: '+tool.name);
      }
    `;
    const workerUrl = 'data:text/javascript,' + encodeURIComponent(workerModule);
    const script = `
      import {registerHooks} from 'node:module';
      const sourceRoot = ${JSON.stringify(sourceRoot)}, workerUrl = ${JSON.stringify(workerUrl)};
      registerHooks({resolve(specifier,context,next){
        if(context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('/worker-agent.js'))return {url:workerUrl,shortCircuit:true};
        return next(context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js') ? specifier.slice(0,-3)+'.ts' : specifier,context);
      }});
      const {PipelineRunner} = await import(sourceRoot+'pipeline/runner.ts');
      const {calls} = await import(workerUrl);
      const runner = new PipelineRunner({projectRoot:${JSON.stringify(f.root)},client:${JSON.stringify(client)},model:'fixture'});
      await runner.writeChapters('novel',1,{startChapterNumber:1});
      console.log('RECOVERY_CALLS='+JSON.stringify(calls));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script]);
    const recoveredCalls = JSON.parse(stdout.split("RECOVERY_CALLS=")[1].trim());
    expect(recoveredCalls).toContain("submit_runtime_state_delta"); expect(recoveredCalls).toContain("submit_chapter_review");
    expect(recoveredCalls).toContain("submit_chapter_contract");
    expect(recoveredCalls).not.toContain("submit_chapter_draft"); expect(recoveredCalls).not.toContain("submit_chapter_memo");
    const recoveredIndex = await f.state.loadChapterIndex("novel");
    expect(recoveredIndex).toHaveLength(1);
    expect(recoveredIndex[0].observations.map(item => item.code)).toEqual(["chapter-contract-inventory", "chapter-contract-1", "chapter-contract-2"]);
    expect(recoveredIndex[0].observations.every(item => item.assessment === "observation")).toBe(true);
  }, 20000);

  it("recovers a dead-owner atomic checkpoint transaction before reading it", async () => {
    const f = await fixture(); settleFailures = 1; await expect(f.write()).rejects.toThrow("interrupted settlement");
    const before = await readFile(f.checkpointPath, "utf8");
    const transaction = join(f.checkpointDir, ".inkos-file-txn-interrupted");
    await mkdir(join(transaction, "backup"), { recursive: true });
    await writeFile(join(transaction, "backup/chapter-0001.json"), before);
    await writeFile(f.checkpointPath, "{partial replacement");
    await writeFile(join(transaction, "journal.json"), JSON.stringify({ version: 1, pid: 0, phase: "prepared", entries: [{ path: "chapter-0001.json", existed: true }] }));
    await f.write(); expect(draftCount).toBe(1); expect((await f.state.loadChapterIndex("novel"))).toHaveLength(1);
    await expect(readdir(transaction)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps accepted Work progress successful when recovery cleanup cannot write", async () => {
    const f = await fixture();
    vi.spyOn(draftRecovery, "clearUnsettledDraft").mockRejectedValueOnce(Object.assign(new Error("Checkpoint directory unavailable"), { code: "EACCES" }));
    await expect(f.write()).resolves.toHaveLength(1);
    const work = await loadWorkManifest(f.root, "novel");
    expect(work.artifacts.filter(artifact => artifact.kind === "chapter" && artifact.currentRevisionId)).toHaveLength(1);
    expect((await f.state.loadChapterIndex("novel"))).toHaveLength(1);
    expect(JSON.parse(await readFile(f.checkpointPath, "utf8")).draft.content).toBe(prose);
    await expect(f.write()).rejects.toMatchObject({ code: "CHAPTER_WRITE_RANGE_CONFLICT" }); expect(draftCount).toBe(1);
  });

  it("does not silently omit a linked source directory from recovery checks", async () => {
    const f = await fixture();
    await mkdir(join(f.root, "outside-outline"));
    await writeFile(join(f.root, "outside-outline/story_frame.md"), "Linked source.");
    await writeFile(join(f.root, "outside-outline/volume_map.md"), "Linked volume map.");
    await rm(join(f.bookDir, "story/outline"), { recursive: true });
    await symlink(join(f.root, "outside-outline"), join(f.bookDir, "story/outline"), process.platform === "win32" ? "junction" : "dir");
    await expect(f.write()).rejects.toThrow("Draft input cannot be a symbolic link"); expect(draftCount).toBe(0);
  });

  it("rejects mixed checkpoint chapter identities without consuming or rewriting it", async () => {
    const f = await fixture(); settleFailures = 1; await expect(f.write()).rejects.toThrow("interrupted settlement");
    const checkpoint = JSON.parse(await readFile(f.checkpointPath, "utf8"));
    checkpoint.input.chapterMemo.chapter = checkpoint.input.chapterIntentData.chapter = checkpoint.input.contextPackage.chapter = 42;
    const corrupt = JSON.stringify(checkpoint); await writeFile(f.checkpointPath, corrupt);
    await expect(f.write()).rejects.toThrow("Draft inputs must identify the same chapter");
    expect(await readFile(f.checkpointPath, "utf8")).toBe(corrupt); expect(draftCount).toBe(1); await noAcceptedChapter(f);
  });

  it("invalidates a changed effective writing method", async () => {
    const f = await fixture(); settleFailures = 1;
    const writeWithMethod = (body: string) => {
      const runner = f.runner();
      return runner.runWithAgentContext({ activatedSkills: [{ skill: { id: "fixture-method", name: "Fixture method", description: "Offline style guidance", source: "project", body }, resources: [] }] },
        () => runner.writeChapters("novel", 1, { startChapterNumber: 1 }));
    };
    await expect(writeWithMethod("Use restrained narration.")).rejects.toThrow("interrupted settlement");
    await writeWithMethod("Use an energetic narrative voice."); expect(draftCount).toBe(2);
  });

  it("invalidates a changed method reference file", async () => {
    const f = await fixture(); settleFailures = 1;
    const baseDir = join(f.root, "fixture-method"); await mkdir(join(baseDir, "references"), { recursive: true });
    const path = join(baseDir, "references/style.md"); await writeFile(path, "Use a restrained narrative voice.");
    const writeWithMethod = () => {
      const runner = f.runner();
      return runner.runWithAgentContext({ activatedSkills: [{ skill: { id: "fixture-method", name: "Fixture method", description: "Offline style guidance", source: "project", body: "[Style](references/style.md)", baseDir }, resources: [] }] },
        () => runner.writeChapters("novel", 1, { startChapterNumber: 1 }));
    };
    await expect(writeWithMethod()).rejects.toThrow("interrupted settlement");
    await writeFile(path, "Use an energetic narrative voice.");
    await writeWithMethod(); expect(draftCount).toBe(2);
  });

  it("invalidates changed Work metadata that reaches the writer", async () => {
    const f = await fixture(); settleFailures = 1; await expect(f.write()).rejects.toThrow("interrupted settlement");
    const work = await loadWorkManifest(f.root, "novel");
    await saveWorkManifest(f.root, { ...work, title: "New author-facing Work title" });
    await f.write(); expect(draftCount).toBe(2);
  });

  it("rejects malformed recovery input without overwriting the retained file", async () => {
    const f = await fixture(); await mkdir(f.checkpointDir, { recursive: true }); await writeFile(f.checkpointPath, "{broken");
    await expect(loadUnsettledDraft(f.root, { book: f.book, bookDir: f.bookDir, chapterNumber: 1, lengthSpec: buildLengthSpec(20, "en", f.book) })).rejects.toThrow();
    expect(await readFile(f.checkpointPath, "utf8")).toBe("{broken"); expect(mock.tool).not.toHaveBeenCalled();
  });
});

describe("independent fusion recovery checks", () => {
  it("never pairs old recovered prose with a newly edited memo contract", async () => {
    const f = await fixture(); settleFailures = 1;
    await expect(f.write()).rejects.toThrow("interrupted settlement");
    const planPath = join(f.bookDir, "story/runtime/chapter-0001.plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    plan.memo.body = "Return the receipt only after the witness inspects its seal.";
    await writeFile(planPath, JSON.stringify(plan));
    const original = mock.tool.getMockImplementation()!;
    let classified = false, reviewed = false;
    mock.tool.mockImplementation(async (...args) => {
      const messages = args[2], tool = args[3];
      if (!["submit_chapter_contract", "submit_chapter_review"].includes(tool.name)) return original(...args);
      const payload = JSON.parse([...messages].reverse().find((message: { role: string; content: string }) => message.role === "user")!.content);
      const source = (id: string) => payload.sources.find((item: { sourceId: string }) => item.sourceId === id)?.numberedLines;
      expect(source("chapter-contract-source")).toContain(plan.memo.body);
      const ref = (sourceId: string) => ({sourceId, startLine:1, endLine:1});
      if (tool.name === "submit_chapter_contract") {
        classified = true; expect(source("chapter-1")).toBeUndefined();
        return {summary:"New source inventory",observations:[{code:"required-event",assessment:"observation",summary:"Inspect before returning",sourceRefs:[ref("chapter-contract-source")]}]};
      }
      reviewed = true;
      expect(source("chapter-1")).toContain("Attempt 2.");
      return {summary:"New body against new contract",observations:[
        {code:"chapter-contract-inventory",category:"quality",assessment:"observation",summary:"New requirement retained",sourceRefs:[ref("chapter-contract-source")]},
        {code:"chapter-contract-1",category:"quality",assessment:"observation",summary:"Current body inspected",sourceRefs:[ref("chapter-contract-1"),ref("chapter-1")]},
      ]};
    });
    const result = await f.write();
    expect(draftCount).toBe(2); expect(classified).toBe(true); expect(reviewed).toBe(true);
    expect(result[0].review.observations.map(item => item.code)).toEqual(["chapter-contract-inventory","chapter-contract-1"]);
    expect(await readdir(join(f.checkpointDir,"stale"))).toHaveLength(1);
  });

  it("carries protected dependency authority through durable draft recovery into contract review", async () => {
    const f = await fixture();
    await createInitialRuntimeState({bookDir:f.bookDir,language:"en",hooks:[
      {hookId:"return",startChapter:0,type:"mystery",status:"open",lastAdvancedChapter:0,expectedPayoff:"Return the receipt",notes:"Return after inspection",dependsOn:["witness"],paysOffInArc:"Owner returns"},
      {hookId:"witness",startChapter:0,type:"evidence",status:"superseded",lastAdvancedChapter:0,expectedPayoff:"Previous prohibition",notes:"AUTHOR WITHDREW THE OLD PROHIBITION"},
    ]});
    const planPath = join(f.bookDir,"story/runtime/chapter-0001.plan.json");
    const plan = JSON.parse(await readFile(planPath,"utf8"));plan.memo.threadRefs=["return"];await writeFile(planPath,JSON.stringify(plan));
    settleFailures=1;await expect(f.write()).rejects.toThrow("interrupted settlement");
    const saved = JSON.parse(await readFile(f.checkpointPath,"utf8"));
    const witness = saved.input.contextPackage.selectedContext.find((item: { source: string; protection: string; excerpt?: string })=>item.source==="runtime/referenced_hook#witness");
    expect(witness.protection).toBe("protected");expect(witness.excerpt).toContain("AUTHOR WITHDREW THE OLD PROHIBITION");
    const original=mock.tool.getMockImplementation()!;let checks=0;
    mock.tool.mockImplementation(async (...args)=>{
      if(["submit_chapter_contract","submit_chapter_review"].includes(args[3].name)){
        const payload=JSON.parse([...args[2]].reverse().find((message: { role: string; content: string })=>message.role==="user")!.content);
        const governed=payload.sources.find((item: { sourceId: string; numberedLines: string })=>item.sourceId==="governed-context").numberedLines;
        expect(governed).toContain("AUTHOR WITHDREW THE OLD PROHIBITION");
        expect(governed).toContain("dependsOn=witness");expect(governed).toContain("paysOffInArc=Owner returns");checks++;
      }
      return original(...args);
    });
    const result=await f.write();expect(draftCount).toBe(1);expect(checks).toBe(2);
    expect(result[0].review.observations.map(item=>item.code)).toEqual(["chapter-contract-inventory","chapter-contract-1","chapter-contract-2"]);
  });
});
