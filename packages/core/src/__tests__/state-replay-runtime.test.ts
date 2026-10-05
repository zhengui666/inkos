import { afterEach, expect, it, vi } from "vitest";
const codex = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../codex/client.js", () => ({ createCodexClient: codex.create }));
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexFixture } from "./codex-fixture.js";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState, loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { prepareStateReplay } from "../state/state-replay.js";
import { WriterAgent } from "../agents/writer.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { createLLMClient } from "../llm/provider.js";
const roots: string[] = [];
afterEach(async () => { codex.create.mockReset(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(["valid", "unsupported", "blank-authority"])("real replay workers review candidate summaries with the existing authority contract (%s)", async mode => {
  const unsupported = mode === "unsupported";
  const marker = "UNSUPPORTED_SUMMARY_Lin_burns_archive";
  const root = await mkdtemp(join(tmpdir(), "inkos-replay-runtime-")); roots.push(root);
  const state = new StateManager(root), bookId = "fixture", bookDir = state.bookDir(bookId), now = new Date().toISOString();
  await state.saveBookConfig(bookId, { id: bookId, title: "Fixture", platform: "local", genre: "mystery", status: "active", targetChapters: 2,
    chapterWordCount: 100, language: "en", createdAt: now, updatedAt: now });
  await createInitialRuntimeState({ bookDir, language: "en" }); await state.snapshotState(bookId, 0);
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  await writeFile(join(bookDir, "story/outline/story_frame.md"), mode === "blank-authority" ? " \n" : "Lin is an archivist.");
  await writeFile(join(bookDir, "story/book_rules.md"), mode === "blank-authority" ? " \n" : "Never invent events.");
  await writeFile(join(bookDir, "story/book_rules.json"), JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }));
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  const prosePath = join(bookDir, "chapters/0001_archive.md"); await writeFile(prosePath, "# Archive\r\n\r\nLin entered the archive and found a sealed letter.\r\n");
  await state.saveChapterIndex(bookId, [{ number: 1, title: "Archive", wordCount: 11, createdAt: now, updatedAt: now, observations: [], provenance: "generated" }]);
  await mkdir(join(root, ".inkos"));
  const settings = JSON.stringify({ model: "fixture", reasoningEffort: "medium", serviceTier: "default" });
  await writeFile(join(root, ".inkos/codex-config.json"), settings);
  const peer = new CodexFixture(view => {
    const name = view.tools[0].function.name;
    if (name === "submit_runtime_state_delta") return { calls: [{ name, args: {
      postSettlement: "Entered archive", factOps: { upsert: [{ subject: "Lin", predicate: "location", object: "archive" }], expire: [] },
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [{ type: "mystery", expectedPayoff: "Open the sealed letter", notes: "Letter found in chapter one" }],
      chapterSummary: { title: "Archive", characters: "Lin", events: unsupported ? marker : "Entered archive", stateChanges: "location", hookActivity: "letter", mood: "quiet", chapterType: "scene" },
    } }] };
    expect(name).toBe("submit_state_validation");
    const prompt = view.messages.filter(message => message.role === "user").map(message => message.content).join("\n");
    const [beforeCandidate, candidate] = prompt.split("## Candidate Projection (unverified; not authority)");
    expect(candidate).toContain('"chapter": 1');
    expect(candidate).toContain(unsupported ? marker : "Entered archive");
    expect(beforeCandidate).not.toContain(marker);
    return { calls: [{ name, args: { reconciliationRequired: unsupported,
      reportMarkdown: unsupported ? "Candidate summary claims Lin burns the archive, but the prose only enters it and finds a letter." : "" } }] };
  });
  codex.create.mockImplementation(async runtimeRoot => { expect(runtimeRoot).toBe(root); return peer.createClient(runtimeRoot); });
  const client = createLLMClient({ service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture",
    baseUrl: "https://fixture.invalid/v1", apiFormat: "chat", stream: true, temperature: 0, thinkingBudget: 0 }, root);
  const originalProse = await readFile(prosePath);
  const pending = prepareStateReplay({ projectRoot: root, bookId, baselineChapter: 0, createWorkers: isolatedRoot => {
    expect(isolatedRoot).not.toBe(root);
    mkdirSync(join(isolatedRoot, ".inkos"));
    writeFileSync(join(isolatedRoot, ".inkos/codex-config.json"), "invalid settings must not be used");
    const context = { client, model: "fixture", bookId, projectRoot: isolatedRoot, runtimeProjectRoot: root };
    return { writer: new WriterAgent(context), validator: new StateValidatorAgent(context) };
  } });
  if (unsupported) await expect(pending).rejects.toMatchObject({ code: "STATE_REPLAY_VALIDATION_FAILED" });
  else expect((await pending).chapters[0].delta.hookOps.upsert).toHaveLength(1);
  expect(codex.create).toHaveBeenCalledTimes(2);
  expect(peer.requests.filter(r => r.method === "thread/start").map(r => r.params.model)).toEqual(["fixture", "fixture"]);
  expect((await loadRuntimeStateSnapshot(bookDir)).manifest.lastAppliedChapter).toBe(0);
  expect(await readFile(prosePath)).toEqual(originalProse);
  expect(await readFile(join(root, ".inkos/codex-config.json"), "utf8")).toBe(settings);
}, 15000);
