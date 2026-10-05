import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mock = vi.hoisted(() => ({ root: "", prepare: vi.fn(), commit: vi.fn(), output: vi.fn(), load: vi.fn(), workers: [] as unknown[] }));
vi.mock("../utils.js", () => ({
  findProjectRoot: () => mock.root, resolveBookId: async (id?: string) => id ?? "novel",
  loadConfig: mock.load, resolveCliProfileSkills: async () => [], buildPipelineConfig: () => ({}), log: mock.output, logError: mock.output,
}));
vi.mock("@actalk/inkos-core", () => ({
  prepareStateReplay: mock.prepare, commitStateReplay: mock.commit, stateReplayPlanId: () => "reviewed-plan-id",
  PipelineRunner: class { createAgentContext() { return {}; } },
  WriterAgent: class { constructor(context: unknown) { mock.workers.push({ kind: "writer", context }); } },
  StateValidatorAgent: class { constructor(context: unknown) { mock.workers.push({ kind: "validator", context }); } },
}));
let exitCode: typeof process.exitCode;
beforeEach(async () => {
  vi.resetModules(); mock.prepare.mockReset(); mock.commit.mockReset(); mock.output.mockReset(); mock.load.mockReset().mockResolvedValue({}); mock.workers = [];
  mock.root = await mkdtemp(join(tmpdir(), "inkos-replay-cli-"));
  await mkdir(join(mock.root, "works")); exitCode = process.exitCode; process.exitCode = undefined;
});
afterEach(async () => { process.exitCode = exitCode; await rm(mock.root, { recursive: true, force: true }); });
async function run(args: string[]) { const { stateReplayCommand } = await import("../commands/state-replay.js"); await stateReplayCommand.parseAsync(args, { from: "user" }); }
const plan = { version: 2, id: "reviewed-plan-id", bookId: "novel", baselineChapter: 27, targetChapter: 30, chapters: [] };
describe("chapter replay-state CLI", () => {
  it("creates a private dry-run plan and reports its ordinary selected plan ID", async () => {
    mock.prepare.mockImplementation(async input => { input.createWorkers("/isolated-fixture"); return plan; });
    const path = join(mock.root, "plan.json");
    await run(["novel", "--dry-run", "--baseline", "27", "--plan", path, "--json"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(plan);
    expect(mock.prepare).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: mock.root, bookId: "novel", baselineChapter: 27 }));
    expect(mock.workers).toEqual(["writer", "validator"].map(kind => ({ kind, context: { projectRoot: "/isolated-fixture", runtimeProjectRoot: mock.root, activatedSkills: [] } })));
    expect(JSON.parse(mock.output.mock.calls.at(-1)![0])).toMatchObject({ committed: false, planId: "reviewed-plan-id" });
  });
  it.each([false, true])("commit uses the retained plan with an optional selected ID and never loads models (selected ID: %s)", async selectedId => {
    const path = join(mock.root, "plan.json"); await writeFile(path, JSON.stringify(plan));
    mock.commit.mockResolvedValue({ committed: true, baselineChapter: 27, targetChapter: 30 });
    await run(["--commit", "--plan", path, ...(selectedId ? ["--expect-plan", "reviewed-plan-id"] : []), "--json"]);
    expect(mock.commit).toHaveBeenCalledWith({ projectRoot: mock.root, plan, expectedPlanId: selectedId ? "reviewed-plan-id" : undefined });
    expect(mock.load).not.toHaveBeenCalled(); expect(mock.prepare).not.toHaveBeenCalled();
  });
  it.each([
    ["--commit"], ["--dry-run"], ["--dry-run", "--commit", "--baseline", "27"], [],
  ])("rejects incomplete/ambiguous operation %j", async (...flags) => {
    await run([...flags as string[], "--plan", join(mock.root, "plan.json"), "--json"]);
    expect(process.exitCode).toBe(1); expect(mock.prepare).not.toHaveBeenCalled(); expect(mock.commit).not.toHaveBeenCalled();
  });
  it("allows an operator-selected plan path inside Work storage without adding a content gate", async () => {
    const path = join(mock.root, "works/plan.json");
    mock.prepare.mockResolvedValue(plan);
    await run(["--dry-run", "--baseline", "27", "--plan", path, "--json"]);
    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(plan);
    expect(mock.prepare).toHaveBeenCalledOnce(); expect(mock.commit).not.toHaveBeenCalled();
  });
  it("never overwrites an existing operator plan", async () => {
    const path = join(mock.root, "plan.json"); await writeFile(path, "existing evidence");
    await run(["--dry-run", "--baseline", "27", "--plan", path, "--json"]);
    expect(await readFile(path, "utf8")).toBe("existing evidence"); expect(mock.prepare).not.toHaveBeenCalled();
  });
  it("removes an incomplete plan when model-assisted dry run fails", async () => {
    mock.prepare.mockRejectedValue(Object.assign(new Error("validator unavailable"), { code: "STATE_REPLAY_VALIDATION_UNAVAILABLE" }));
    await run(["--dry-run", "--baseline", "27", "--plan", join(mock.root, "plan.json"), "--json"]);
    expect(await readdir(mock.root)).toEqual(["works"]);
    expect(JSON.parse(mock.output.mock.calls.at(-1)![0])).toMatchObject({ code: "STATE_REPLAY_VALIDATION_UNAVAILABLE" });
  });
  it("rejects a plan for another book before committing", async () => {
    const path = join(mock.root, "plan.json"); await writeFile(path, JSON.stringify({ ...plan, bookId: "other" }));
    await run(["novel", "--commit", "--plan", path, "--expect-plan", "reviewed-plan-id", "--json"]);
    expect(mock.commit).not.toHaveBeenCalled(); expect(process.exitCode).toBe(1);
  });
});
