import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendActivatedSkillGuidance, prepareWorkerInput } from "../agents/base.js";
import { loadLinkedSkillResources } from "../agent/skill-tool.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { withExecutionEvidence } from "../harness/execution-evidence.js";
import { estimateTextTokens, type LLMClient, type LLMMessage } from "../llm/provider.js";
import { parseAgentSkillDocument } from "../skills/external-loader.js";

describe("worker methodology representation", () => {
  it.each(["\n", "\r\n", "\r"])("normalizes emitted methods but retains raw reference offsets and author bytes (%j)", async eol => {
    const root = await mkdtemp(join(tmpdir(), "inkos-method-eol-"));
    try {
      const source = ["# Receipt evidence", "", "Keep the sealed receipt intact.", "Preserve its owner and signature.", ""].join(eol);
      await mkdir(join(root, "references"));
      const path = join(root, "references", "evidence.md");
      await writeFile(path, source);
      const skill = parseAgentSkillDocument([
        "---", "name: receipt-method", "description: Preserve receipt evidence.", "---",
        "Read `references/evidence.md`.", "Keep source pointers.",
      ].join(eol), { skillPath: join(root, "SKILL.md"), source: "builtin" });
      const resources = await loadLinkedSkillResources(skill);
      const activation = { skill, resources };
      const raw = await readFile(path, "utf8");
      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({ body: raw, charStart: 0, charEnd: raw.length });
      expect(raw.slice(resources[0]!.charStart, resources[0]!.charEnd)).toBe(resources[0]!.body);
      const messages: LLMMessage[] = [
        { role: "system", content: "Exact protocol\r\nwith source whitespace" },
        { role: "user", content: "Exact canon\r\nMara retains the receipt.\rDo not alter it." },
      ];
      const before = JSON.stringify({ messages, activation });
      const guidance = appendActivatedSkillGuidance([], [activation])[0]!.content;
      expect(guidance).not.toContain("\r");
      expect(guidance).toContain(source.replace(/\r\n?/g, "\n"));
      expect(guidance).toContain(`references/evidence.md:0-${raw.length}`);
      const appended = appendActivatedSkillGuidance(messages, [activation]);
      expect(appended[0]!.content).toBe(`${messages[0]!.content}\n\n${guidance}`);
      expect(appended[1]).toEqual(messages[1]);
      const client: LLMClient = { provider: "openai", apiFormat: "chat", stream: false,
        defaults: { temperature: 0, maxTokens: 4096, thinkingBudget: 0, extra: {} },
        _piModel: { contextWindow: 30000 } as never };
      const authorRequest = "Author request\r\nkeeps its exact lines.";
      const prepared = await withExecutionEvidence(() => {}, () => prepareWorkerInput({ client, projectRoot: root,
        activatedSkills: [activation] }, messages, undefined, "writer"),
      createBuiltInWorkProfileRegistry().require("workspace-default"), null, authorRequest);
      expect(prepared.budgetTokens).toBe(23856);
      expect(prepared.inputTokens).toBeLessThanOrEqual(prepared.budgetTokens!);
      expect(prepared.messages).toContainEqual(messages[0]);
      expect(prepared.messages).toContainEqual(messages[1]);
      expect(prepared.messages.some(message => message.content.includes(JSON.stringify({ authorRequest })))).toBe(true);
      expect(prepared.messages).toContainEqual({ role: "system", content: guidance });
      // Conservative fragment wrappers remain counted; the emitted content fits.
      expect(prepared.messages.reduce((total, message) => total + estimateTextTokens(message.content), 0)).toBeLessThanOrEqual(prepared.inputTokens);
      expect(JSON.stringify({ messages, activation })).toBe(before);
      expect(await readFile(path, "utf8")).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
