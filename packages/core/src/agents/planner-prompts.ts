import type { ContextPackage } from "../models/input-governance.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";

export function getPlannerMemoSystemPrompt(language: "zh" | "en" = "zh"): string {
  return language === "en"
    ? "Compile the supplied governed context into one chapter memo. Do not write prose. Professional planning methodology comes only from the activated Skill. Preserve user direction and established facts, use only supplied hook ids, and submit one concrete goal plus a readable Markdown plan through the result tool. Distinguish explicitly required current events/choices/consequences, prohibitions, time/order constraints, background facts and future plans in that existing Markdown body. Retain the originating instruction or context reference for each obligation. Background need not be recited, future payments are not received money, and setup/aftermath need not force a win. The latest explicit author instruction supersedes a conflicting generated plan; do not invent extra requirements or treat a plan as an accepted fact."
    : "把输入的 governed context 编译为一份章节 memo，不写正文。专业规划方法只来自已激活 Skill。保留用户方向和既成事实，只使用输入中存在的 hook id，并通过结果工具提交一个具体目标和完整可读的 Markdown 计划。在原有 Markdown body 中区分本章明确必需的事件/选择/后果、禁令、时间/先后约束、背景事实和未来计划，保留各项要求的原始指令或上下文来源。背景不必复述，未来付款不等于到账，铺垫/余韵章不强迫胜利。最新明确作者指令优先于冲突的生成计划，不新增作者未要求的义务，也不把计划当成已接受事实。";
}

export function buildPlannerUserMessage(input: {
  readonly chapterNumber: number;
  readonly contextPackage: ContextPackage;
  readonly currentInstruction?: string;
  readonly previousChapter?: string;
  readonly lengthBudget: {
    readonly target: number;
    readonly unit: string;
  };
  readonly language?: "zh" | "en";
}): string {
  const language = input.language ?? "zh";
  const context = renderNarrativeSelectedContext(input.contextPackage.selectedContext, language);
  const instruction = input.currentInstruction?.trim();
  const previous = input.previousChapter?.trim();
  if (language === "en") {
    return [
      `# Chapter ${input.chapterNumber} memo request`,
      instruction ? `## Current user instruction\n${instruction}` : "",
      `## Governed context\n${context}`,
      previous ? `## Previous chapter\n${previous}` : "",
      "## Host length telemetry",
      `User target: ${input.lengthBudget.target} ${input.lengthBudget.unit}. Treat it as a creative constraint, not a host quality verdict.`,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `# 第${input.chapterNumber}章 memo 请求`,
    instruction ? `## 当前用户指令\n${instruction}` : "",
    `## 权威上下文\n${context}`,
    previous ? `## 上一章正文\n${previous}` : "",
    "## 宿主字数遥测",
    `用户目标：${input.lengthBudget.target} ${input.lengthBudget.unit}。这是创作约束，不是宿主质量判决。`,
  ].filter(Boolean).join("\n\n");
}
