import { BaseAgent, prepareWorkerInput } from "./base.js";
import type { ContextFragment, SemanticContextCompileResult } from "../harness/context-compiler.js";
import { estimateTextTokens } from "../llm/provider.js";
import { splitTextByEstimatedTokens } from "../llm/semantic-input.js";

export interface SemanticContextCompilerInput {
  readonly intent: string;
  readonly maxTokens: number;
  readonly fragments: ReadonlyArray<ContextFragment>;
  readonly language: "zh" | "en";
}

/** Infrastructure worker shared by story and Play context assembly. */
export class SemanticContextCompilerAgent extends BaseAgent {
  get name(): string {
    return "semantic-context-compiler";
  }

  async compile(input: SemanticContextCompilerInput): Promise<SemanticContextCompileResult> {
    return this.compileBounded(input, 4);
  }

  private async compileBounded(input: SemanticContextCompilerInput, passesRemaining: number): Promise<SemanticContextCompileResult> {
    if (input.fragments.some((fragment) => fragment.protection !== "compressible")) {
      throw new Error("Semantic context compiler accepts compressible fragments only.");
    }
    const sourceIds = input.fragments.map((fragment) => fragment.id);
    const source = input.fragments.map(renderFragment).join("\n\n");
    if (!source.trim()) return { content: "", sourceIds };

    const systemPrompt = input.language === "en"
      ? "Compile only the supplied lower-priority context for the current task. Preserve exact entity ids, names, unresolved state, causal facts, constraints, and source pointers that remain relevant. Omit unrelated history. Return Markdown only."
      : "只编译本次提供的低优先级上下文。围绕当前任务保留仍相关的精确实体 id、名称、未解状态、因果事实、约束和来源指针，省略无关历史。只返回 Markdown。";
    const render = (chunk: string, label: string) => [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: `Current intent:\n${input.intent}\n\nSource chunk ${label}:\n${chunk}` },
    ];
    const reservedOutput = Math.min(this.ctx.client.defaults.maxTokens, Math.max(512, input.maxTokens));
    const fixed = await prepareWorkerInput(this.ctx, render("", "1/1"), reservedOutput, this.name, false);
    const inputBudget = fixed.budgetTokens === undefined ? undefined : fixed.budgetTokens - fixed.inputTokens - 256;
    if (inputBudget !== undefined && inputBudget < 1) throw new Error("Semantic compiler authority leaves no room for source chunks");
    const chunks = inputBudget === undefined ? [source] : splitTextByEstimatedTokens(source, inputBudget);
    const perChunkOutput = Math.max(512, Math.ceil(input.maxTokens / chunks.length));
    const compiled: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      this.ctx.signal?.throwIfAborted();
      const response = await this.chat(render(chunks[index]!, `${index + 1}/${chunks.length}`), {
        temperature: 0.1, professionalGuidance: false,
        maxTokens: Math.min(this.ctx.client.defaults.maxTokens, perChunkOutput),
      });
      const content = response.content.trim();
      if (!content) throw new Error(`Semantic context compiler returned empty output for chunk ${index + 1}/${chunks.length}.`);
      compiled.push(content);
    }
    let content = compiled.join("\n\n");
    if (estimateTextTokens(content) > input.maxTokens) {
      if (inputBudget !== undefined && estimateTextTokens(content) > inputBudget) {
        // Compare the unwrapped content, not renderFragment's freshly added
        // metadata: otherwise a fixed-point summary can appear to shrink forever.
        const previousContentTokens = estimateTextTokens(input.fragments.map(fragment => fragment.content).join("\n\n"));
        if (estimateTextTokens(content) >= previousContentTokens) {
          throw new Error("Semantic compilation made no progress toward the bounded input window");
        }
        if (passesRemaining <= 1) throw new Error("Semantic compilation did not converge within four bounded passes");
        return this.compileBounded({ ...input, fragments: [{ id: "compiled-batches", source: "compiled source batches",
          pointer: sourceIds.join(", "), content, protection: "compressible", priority: 0 }] }, passesRemaining - 1)
          .then(result => ({ content: result.content, sourceIds }));
      }
      const response = await this.chat([
        {
          role: "system",
          content: input.language === "en"
            ? "Recompile the supplied Markdown to fit the stated token budget. Preserve exact ids, names, constraints, unresolved state, causal facts, and source pointers. Remove only lower-value repetition and unrelated history. Return Markdown only."
            : "把输入 Markdown 重新编译到指定 token 预算内。保留精确 id、名称、约束、未解状态、因果事实和来源指针；只删除低价值重复与无关历史。只返回 Markdown。",
        },
        {
          role: "user",
          content: `${input.language === "en" ? "Token budget" : "Token 预算"}: ${input.maxTokens}\n\n${content}`,
        },
      ], {
        temperature: 0.1, professionalGuidance: false,
        maxTokens: Math.min(this.ctx.client.defaults.maxTokens, Math.max(256, input.maxTokens)),
      });
      content = response.content.trim();
      if (!content) throw new Error("Semantic context recompilation returned empty output.");
    }
    if (estimateTextTokens(content) > input.maxTokens) {
      throw new Error(`Semantically recompiled context still exceeds its budget: ${estimateTextTokens(content)}/${input.maxTokens} tokens.`);
    }
    return { content, sourceIds };
  }
}

function renderFragment(fragment: ContextFragment): string {
  return [
    `## ${fragment.source}`,
    `Source id: ${fragment.id}`,
    fragment.pointer ? `Source pointer: ${fragment.pointer}` : "",
    fragment.content,
  ].filter(Boolean).join("\n");
}
