import type {
  ChapterSummariesState,
  CurrentStateState,
  HooksState,
} from "../models/runtime-state.js";

export function renderHooksProjection(
  state: HooksState,
  language: "zh" | "en" = "zh",
  options?: { readonly currentChapter?: number },
): string {
  void options;
  const title = language === "en" ? "# Pending Hooks" : "# 伏笔池";
  // Keep legacy projections unchanged when no authored dependency metadata exists.
  const hasDependencyContext = state.hooks.some((hook) => hook.dependsOn !== undefined || hook.paysOffInArc !== undefined);
  const columns = language === "en"
    ? ["hook_id", "start_chapter", "type", "status", "last_advanced_chapter", "expected_payoff", "notes"]
    : ["hook_id", "起始章节", "类型", "状态", "最近推进", "预期回收", "备注"];
  if (hasDependencyContext) columns.push(...(language === "en"
    ? ["depends_on", "pays_off_in_arc"] : ["依赖伏笔", "回收篇章语境"]));
  const headers = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];

  const rows = [...state.hooks]
    .sort((left, right) => (
      left.startChapter - right.startChapter
      || left.lastAdvancedChapter - right.lastAdvancedChapter
      || left.hookId.localeCompare(right.hookId)
    ))
    .map((hook) => `| ${
        [
          hook.hookId,
          hook.startChapter,
          hook.type,
          hook.status,
          hook.lastAdvancedChapter,
          hook.expectedPayoff,
          hook.notes,
          ...(hasDependencyContext ? [[...new Set(hook.dependsOn ?? [])].join(", "), hook.paysOffInArc ?? ""] : []),
        ].map(escapeTableCell).join(" | ")
      } |`);

  return [title, "", ...headers, ...rows, ""].join("\n");
}

export function renderChapterSummariesProjection(
  state: ChapterSummariesState,
  language: "zh" | "en" = "zh",
): string {
  const title = language === "en" ? "# Chapter Summaries" : "# 章节摘要";
  const headers = language === "en"
    ? [
      "| Chapter | Title | Characters | Key Events | State Changes | Hook Activity | Mood | Chapter Type |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    : [
      "| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];

  const rows = [...state.rows]
    .sort((left, right) => left.chapter - right.chapter)
    .map((summary) => `| ${
      [
        summary.chapter,
        summary.title,
        summary.characters,
        summary.events,
        summary.stateChanges,
        summary.hookActivity,
        summary.mood,
        summary.chapterType,
      ].map(escapeTableCell).join(" | ")
    } |`);

  return [title, "", ...headers, ...rows, ""].join("\n");
}

export function renderCurrentStateProjection(
  state: CurrentStateState,
  language: "zh" | "en" = "zh",
): string {
  const title = language === "en" ? "# Current State" : "# 当前状态";
  const chapterLabel = language === "en" ? "Current chapter" : "当前章节";
  const headers = language === "en"
    ? [
        "| Subject | Predicate | Object | Valid from | Source chapter |",
        "| --- | --- | --- | --- | --- |",
      ]
    : [
        "| 主体 | 关系 / 属性 | 当前事实 | 生效章节 | 来源章节 |",
        "| --- | --- | --- | --- | --- |",
      ];
  const facts = state.facts
    .filter((fact) => fact.validUntilChapter === null || fact.validUntilChapter >= state.chapter)
    .sort((left, right) => (
      left.subject.localeCompare(right.subject)
      || left.predicate.localeCompare(right.predicate)
      || left.object.localeCompare(right.object)
    ))
    .map((fact) => `| ${[
      fact.subject,
      fact.predicate,
      fact.object,
      fact.validFromChapter,
      fact.sourceChapter,
    ].map(escapeTableCell).join(" | ")} |`);

  return [
    title,
    "",
    `> ${chapterLabel}: ${state.chapter}`,
    "",
    ...headers,
    ...facts,
    "",
  ].join("\n");
}

function escapeTableCell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}
