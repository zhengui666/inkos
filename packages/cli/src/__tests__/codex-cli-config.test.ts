import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import type { ProjectConfig } from "@actalk/inkos-core";

const fixture = vi.hoisted(() => ({
  root: "",
  loaded: [] as ProjectConfig[],
  loadConfig: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
  stop: new Error("Config accepted; runtime boundary reached"),
  exit: new Error("Test process exit"),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return {
    ...actual,
    // Keep the real config resolver while excluding machine/global credentials.
    loadLLMEnvLayers: vi.fn(async () => ({ global: {}, project: {}, process: {} })),
    StateManager: class {
      async loadBookConfig() { return { id: "book", title: "Book", language: "en" }; }
      async getNextChapterNumber() { return 1; }
      async loadChapterIndex() { return []; }
      async saveChapterIndex() {}
      async restoreState() { return true; }
      bookDir() { return join(fixture.root, "book"); }
    },
  };
});

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    findProjectRoot: () => fixture.root,
    resolveBookId: async () => "book",
    resolveContext: async () => undefined,
    loadConfig: fixture.loadConfig,
    log: fixture.log,
    logError: fixture.logError,
  };
});

interface EntryPoint {
  name: string;
  load: () => Promise<Command>;
  args: string[];
}

const entryPoints: EntryPoint[] = [
  { name: "agent", load: async () => (await import("../commands/agent.js")).agentCommand, args: ["Help me plan a story", "--json"] },
  { name: "interact", load: async () => (await import("../commands/interact.js")).createInteractCommand(), args: ["Help me plan a story", "--json"] },
  { name: "book create", load: async () => (await import("../commands/book.js")).bookCommand, args: ["create", "--title", "New book", "--json"] },
  { name: "write next", load: async () => (await import("../commands/write.js")).writeCommand, args: ["next", "book", "--json"] },
  { name: "write rewrite", load: async () => (await import("../commands/write.js")).writeCommand, args: ["rewrite", "book", "1", "--force", "--json"] },
  { name: "write sync", load: async () => (await import("../commands/write.js")).writeCommand, args: ["sync", "book", "1", "--json"] },
  { name: "auto", load: async () => (await import("../commands/auto.js")).autoCommand, args: ["book", "2", "--json"] },
  { name: "revise", load: async () => (await import("../commands/revise.js")).reviseCommand, args: ["book", "1", "--json"] },
  { name: "translate run", load: async () => (await import("../commands/translate.js")).translateCommand, args: ["run", "translation", "--json"] },
  { name: "forecast create", load: async () => (await import("../commands/forecast.js")).forecastCommand, args: ["create", "book", "--divergence", "Accept the deal?", "--json"] },
  { name: "short run", load: async () => (await import("../commands/short-fiction.js")).shortCommand, args: ["run", "--direction", "A mystery", "--no-cover", "--json"] },
  { name: "short revise", load: async () => (await import("../commands/short-fiction.js")).shortCommand, args: ["revise", "story", "--instruction", "Tighten the ending", "--json"] },
  { name: "import canon", load: async () => (await import("../commands/import.js")).importCommand, args: ["canon", "book", "--from", "parent", "--json"] },
  { name: "import chapters", load: async () => (await import("../commands/import.js")).importCommand, args: ["chapters", "book", "--from", "$reference", "--json"] },
  { name: "style import", load: async () => (await import("../commands/style.js")).styleCommand, args: ["import", "$reference", "book", "--json"] },
  { name: "fanfic init", load: async () => (await import("../commands/fanfic.js")).fanficCommand, args: ["init", "--title", "Fanfic", "--from", "$reference", "--json"] },
  { name: "fanfic refresh", load: async () => (await import("../commands/fanfic.js")).fanficCommand, args: ["refresh", "book", "--from", "$reference", "--json"] },
  { name: "fanfic show", load: async () => (await import("../commands/fanfic.js")).fanficCommand, args: ["show", "book", "--json"] },
  { name: "radar scan", load: async () => (await import("../commands/radar.js")).radarCommand, args: ["scan", "--json"] },
  { name: "daemon up", load: async () => (await import("../commands/daemon.js")).upCommand, args: ["--quiet"] },
  { name: "analytics", load: async () => (await import("../commands/analytics.js")).analyticsCommand, args: ["book", "--json"] },
  { name: "detect", load: async () => (await import("../commands/detect.js")).detectCommand, args: ["book", "--stats", "--json"] },
];

const configModes = [
  { name: "ChatGPT-only project without legacy LLM settings", llm: {} },
  {
    name: "project with a legacy service but no API key",
    llm: { configSource: "studio", service: "openai", services: [{ service: "openai" }], defaultModel: "gpt-4o" },
  },
];

describe.each(configModes)("CLI config: $name", ({ llm }) => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    fixture.root = await mkdtemp(join(tmpdir(), "inkos-codex-cli-config-"));
    fixture.loaded = [];
    await writeFile(join(fixture.root, "inkos.json"), JSON.stringify({ name: "chatgpt-only", version: "0.1.0", llm }));
    await writeFile(join(fixture.root, "reference.md"), "Reference prose.");
    await mkdir(join(fixture.root, "book", "chapters"), { recursive: true });
    await mkdir(join(fixture.root, "book", "story", "snapshots", "0"), { recursive: true });
    const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
    fixture.loadConfig.mockImplementation(async (options?: Parameters<typeof actual.loadConfig>[0]) => {
      const config = await actual.loadConfig({ ...options, projectRoot: fixture.root });
      fixture.loaded.push(config);
      // Stop only after real validation succeeds. No runtime, login, provider,
      // detection, or image API is called by this entrypoint regression test.
      throw fixture.stop;
    });
    vi.spyOn(process, "exit").mockImplementation(() => { throw fixture.exit; });
  });

  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    await rm(fixture.root, { recursive: true, force: true });
  });

  it.each(entryPoints)("$name accepts a configuration with no legacy API key", async ({ load, args }) => {
    const command = await load();
    const resolvedArgs = args.map((arg) => arg === "$reference" ? join(fixture.root, "reference.md") : arg);
    await command.parseAsync(resolvedArgs, { from: "user" }).catch((error: unknown) => {
      expect([fixture.stop, fixture.exit]).toContain(error);
    });
    expect(fixture.loadConfig).toHaveBeenCalledWith(expect.objectContaining({ requireApiKey: false }));
    expect(fixture.loaded).toHaveLength(1);
    expect(fixture.loaded[0]!.llm.apiKey).toBe("");
  });

  it("preserves key validation for direct provider API consumers", async () => {
    const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
    await expect(actual.loadConfig({ projectRoot: fixture.root })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
    await expect(actual.loadConfig({ projectRoot: fixture.root, requireApiKey: true })).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });
});
