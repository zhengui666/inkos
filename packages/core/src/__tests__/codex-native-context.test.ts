import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { describe, expect, it, vi } from "vitest";
import { prepareWorkerInput } from "../agents/base.js";
import { contextBudgetFromClient } from "../agents/composer.js";
import { fitGovernedContext } from "../agents/governed-context-budget.js";
import { resolveCodexModel } from "../codex/model.js";
import { createHarnessContextTransform } from "../harness/agent-context.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { semanticInputBudget } from "../llm/semantic-input.js";
import { estimateTextTokens, type LLMClient, type LLMMessage } from "../llm/provider.js";

const client: LLMClient = { provider: "openai", apiFormat: "responses", stream: true,
  defaults: { temperature: 0, maxTokens: 16384, thinkingBudget: 0, extra: {} },
  _codex: { projectRoot: "/fixture", settings: { model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "priority" } },
  // Stale compatibility metadata must not leak back into Codex preparation.
  _piModel: { contextWindow: 128_000 } as never };

describe("native Codex context ownership", () => {
  it("does not invent capacity from transcript metadata or stale direct-provider settings", () => {
    expect(resolveCodexModel(client._codex!.settings).contextWindow).toBe(0);
    expect(contextBudgetFromClient(client)).toBeUndefined();
    expect(semanticInputBudget(client, { reservedOutputTokens: 8192 })).toBeUndefined();
    const direct = { ...client, _codex: undefined };
    expect(contextBudgetFromClient(direct)).toEqual({ contextWindowTokens: 128_000, reservedOutputTokens: 16384 });
    expect(semanticInputBudget(direct, { reservedOutputTokens: 8192 })).toBe(115712);
  });

  it.each([119_500, 280_000])("preserves %i estimated input tokens without a host rejection or summary", async size => {
    const source = "原".repeat(size);
    const messages: LLMMessage[] = [{ role: "system", content: "Keep every source fact." }, { role: "user", content: source }];
    const prepared = await withExecutionEvidence(() => {}, () => prepareWorkerInput({ client }, messages, 8192, "state-validator", false),
      undefined, null, "Validate the submitted state; do not rewrite earlier chapters.");
    expect(prepared.budgetTokens).toBeUndefined();
    expect(prepared.inputTokens).toBeGreaterThan(117760);
    expect(prepared.messages.find(message => message.content === source)?.role).toBe("user");
    expect(prepared.messages.some(message => message.content === messages[0]!.content)).toBe(true);
    expect(prepared.messages[0]?.content).toContain("Validate the submitted state; do not rewrite earlier chapters.");
    // This is transport preparation, not a claim that the selected model accepts any size.
    expect(estimateTextTokens(source)).toBe(size);
  });

  it("keeps author authority, professional guidance and current work around large source input", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-native-guidance-"));
    try {
      const work = createWorkManifest({ id: "story", title: "The sealed letter", profileId: "longform-novel", language: "en" });
      await saveWorkManifest(root, work);
      const skillDir = join(root, ".agents", "skills", "inkos-long-writing");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "---\nname: inkos-long-writing\ndescription: Project writing method.\n---\nPROJECT_METHOD_KEEP_WITNESS_POV");
      const source = "正文。\n".repeat(65000);
      const prepared = await withExecutionEvidence(() => {}, () => prepareWorkerInput({ client, projectRoot: root, bookId: work.id },
        [{ role: "user", content: source }], 8192, "writer"), undefined, null, "Keep the letter sealed.");
      expect(prepared.budgetTokens).toBeUndefined();
      expect(prepared.messages.some(message => message.content === source)).toBe(true);
      const assembled = prepared.messages.map(message => message.content).join("\n");
      expect(assembled).toContain("Keep the letter sealed.");
      expect(assembled).toContain("PROJECT_METHOD_KEEP_WITNESS_POV");
      expect(assembled).toContain('"workId":"story"');
      const transform = createHarnessContextTransform({ projectRoot: root, work,
        profile: createBuiltInWorkProfileRegistry().require("longform-novel") });
      const messages = [{ role: "user" as const, content: source, timestamp: 1 }];
      const session = await transform(messages);
      expect(session.at(-1)).toEqual(messages[0]);
      expect(session[0]?.content).toContain('"title":"The sealed letter"');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("leaves large governed source packages intact instead of invoking an extra compiler", async () => {
    const contextPackage = { chapter: 28, selectedContext: [
      { source: "authority", reason: "Binding", protection: "protected" as const, excerpt: "权".repeat(120_000) },
      { source: "history", reason: "Evidence", protection: "compressible" as const, excerpt: "史".repeat(120_000) },
    ] };
    const result = await fitGovernedContext({ context: { client, projectRoot: "/fixture", model: "gpt-6.1-sol" },
      worker: "writer", language: "en", contextPackage,
      render: context => [{ role: "user", content: context.selectedContext.map(entry => entry.excerpt).join("\n") }] });
    expect(result).toBe(contextPackage);
  });

  it("preserves initial and restored session input rather than forcing a guessed host summary", async () => {
    const conversationCompactor = vi.fn();
    const transform = createHarnessContextTransform({ projectRoot: "/fixture", work: null,
      profile: createBuiltInWorkProfileRegistry().require("workspace-default"), conversationCompactor });
    const messages = [{ role: "user" as const, content: "史".repeat(150_000), timestamp: 1 },
      { role: "user" as const, content: "新".repeat(120_000), timestamp: 2 }];
    expect(await transform(messages)).toEqual(messages);
    expect(conversationCompactor).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(new Error("Stopped"));
    await expect(transform(messages, controller.signal)).rejects.toThrow("Stopped");
  });
});
