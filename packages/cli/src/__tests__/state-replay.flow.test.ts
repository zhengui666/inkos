import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  StateManager, createInitialRuntimeState, loadRuntimeStateSnapshot,
  prepareStateReplay, stateReplayPlanId, type WriteChapterOutput,
} from "@actalk/inkos-core";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("the built CLI commits a fixture-generated dry-run plan without project model settings or authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-replay-cli-flow-")); roots.push(root);
  await writeFile(join(root, "inkos.json"), "{}");
  const state = new StateManager(root), bookId = "fixture", bookDir = state.bookDir(bookId), now = new Date().toISOString();
  await state.saveBookConfig(bookId, { id: bookId, title: "Fixture", platform: "local", genre: "mystery", status: "active", targetChapters: 2,
    chapterWordCount: 100, language: "en", createdAt: now, updatedAt: now });
  const initial = await createInitialRuntimeState({ bookDir, language: "en" }); await state.snapshotState(bookId, 0);
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  await writeFile(join(bookDir, "story/outline/story_frame.md"), "Lin visits the archive.");
  await writeFile(join(bookDir, "story/book_rules.md"), "Keep the chapter unchanged.");
  await mkdir(join(bookDir, "chapters"));
  const path = join(bookDir, "chapters/0001_archive.md"), prose = "# Archive\r\n\r\nLin enters the archive.  \r\n";
  await writeFile(path, prose);
  await state.saveChapterIndex(bookId, [{ number: 1, title: "Archive", wordCount: 5, createdAt: now, updatedAt: now, observations: [], provenance: "generated" }]);
  const plan = await prepareStateReplay({ projectRoot: root, bookId, baselineChapter: 0, createWorkers: () => ({
    writer: { settleChapterState: async input => ({ chapterNumber: 1, title: input.title, content: input.content, wordCount: 5, postSettlement: "",
      runtimeStateDelta: { chapter: 1, factOps: { upsert: [{ subject: "Lin", predicate: "location", object: "archive" }], expire: [] },
        hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [], chapterSummary: { chapter: 1, title: "Archive", characters: "Lin", events: "Enters", stateChanges: "location", hookActivity: "", mood: "quiet", chapterType: "scene" } },
      runtimeStateSnapshot: initial, updatedState: "", updatedHooks: "", updatedChapterSummaries: "", runtimeStateApplied: true,
    } satisfies WriteChapterOutput) },
    validator: { validate: async () => ({ consistent: true, reconciliationRequired: false, observations: [] }) },
  }) });
  const planPath = join(root, "reviewed-plan.json"); await writeFile(planPath, JSON.stringify(plan));
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
  const result = JSON.parse(execFileSync(process.execPath, [cli, "chapter", "replay-state", bookId, "--commit", "--plan", planPath, "--expect-plan", stateReplayPlanId(plan), "--json"], {
    cwd: root, encoding: "utf8", timeout: 15000, env: { ...process.env, HOME: root },
  }));
  expect(result).toMatchObject({ committed: true, baselineChapter: 0, targetChapter: 1 });
  expect((await loadRuntimeStateSnapshot(bookDir)).manifest.lastAppliedChapter).toBe(1);
  expect(await readFile(path, "utf8")).toBe(prose);
}, 20000);
