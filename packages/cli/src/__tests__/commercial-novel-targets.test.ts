import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  config: {
    llm: {},
    modelOverrides: { "short-reviser": "project-editor", "short-writer": "project-writer" },
  },
  reviseTool: vi.fn((..._args: unknown[]) => ({ name: "fixture-short-revise" })),
  execute: vi.fn(async (..._args: unknown[]) => ({ summary: "Fixture revision completed" })),
  buildPipelineConfig: vi.fn((config: unknown, ..._args: unknown[]) => ({ config })),
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@actalk/inkos-core", () => ({
  SHORT_FICTION_DEFAULT_CHAPTERS: 5,
  SHORT_FICTION_DEFAULT_CHARS_PER_CHAPTER: 2400,
  SHORT_FICTION_EN_DEFAULT_WORDS_PER_CHAPTER: 650,
  activatedSkillIds: () => [],
  createBuiltInWorkProfileRegistry: () => ({ require: () => ({}) }),
  createShortFictionRunTool: vi.fn(),
  createShortFictionReviseTool: fixture.reviseTool,
  executeExplicitCapabilityTool: fixture.execute,
  loadAvailableAgentSkills: async () => ({ skills: [] }),
  resolveProfileSkillActivations: () => [],
  PipelineRunner: class {},
  extractResponsesImageBase64: vi.fn(),
  resolveCoverApiKey: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  buildPipelineConfig: fixture.buildPipelineConfig,
  findProjectRoot: () => "/offline-fixture",
  loadConfig: async () => fixture.config,
  log: fixture.log,
  logError: fixture.logError,
  resolveCliProfileSkills: async () => [],
}));

let originalExitCode: typeof process.exitCode;
beforeEach(() => {
  originalExitCode = process.exitCode;
  vi.resetModules();
  vi.clearAllMocks();
  fixture.config = {
    llm: {},
    modelOverrides: { "short-reviser": "project-editor", "short-writer": "project-writer" },
  };
});
afterEach(() => { process.exitCode = originalExitCode; });

describe("short revise respects the saved target and configured models", () => {
  it.each([
    { label: "omitted length and model", flags: [], charsPerChapter: undefined, model: "project-editor" },
    { label: "only an explicit length", flags: ["--chars", "2600"], charsPerChapter: 2600, model: "project-editor" },
    { label: "only an explicit model", flags: ["--model", "chosen-editor"], charsPerChapter: undefined, model: "chosen-editor" },
    { label: "explicit length and model", flags: ["--chars", "850", "--model", "chosen-editor"], charsPerChapter: 850, model: "chosen-editor" },
  ])("handles $label without silently changing the other setting", async ({ flags, charsPerChapter, model }) => {
    const { shortCommand } = await import("../commands/short-fiction.js");
    await shortCommand.parseAsync([
      "revise", "saved-story", "--instruction", "Clarify the evidence in the final confrontation", ...flags, "--json",
    ], { from: "user" });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.execute.mock.calls[0]?.[0]).toMatchObject({
      workId: "saved-story",
      parameters: { instruction: "Clarify the evidence in the final confrontation", charsPerChapter },
    });
    expect(fixture.buildPipelineConfig).toHaveBeenCalledOnce();
    expect(fixture.buildPipelineConfig.mock.calls[0]?.[0]).toMatchObject({
      modelOverrides: { "short-reviser": model, "short-writer": "project-writer" },
    });
    expect(fixture.reviseTool).toHaveBeenCalledOnce();
    expect(fixture.logError).not.toHaveBeenCalled();
  });
});
