import type { Observation } from "../models/observation.js";

/** Stable coverage identifiers. Only the reviewer judges the supplied prose. */
export const COMMERCIAL_REVIEW_CODES = [
  "reader-promise", "opening-readability", "opposition-stakes",
  "protagonist-agency", "earned-payoff", "serial-prose",
] as const;

export function commercialReviewProtocol(language: "zh" | "en", chapter: number): string {
  return language === "en"
    ? `This Work has a commercial-underdog reader contract. Independently assess the actual prose for each code: ${COMMERCIAL_REVIEW_CODES.join(", ")}. Submit one coverage observation per code, plus other defects when needed. Use observation for a supported satisfactory finding, issue for a defect, unavailable only when required evidence is missing. Cite current chapter lines for every available finding; plans and self-reports are not delivery evidence. For an issue set repairScope to local, structural, or foundation and explain the smallest repair. Read the opening as a reader, roughly the first ten sentences in chapter 1 (current chapter ${chapter}); sentence count is an inspection window, never a score or a rule requiring a villain, power reveal or win by sentence ten. Compare payoff with the actual arc role: setup and aftermath can succeed without a new victory. Do not claim popularity or income. Follow the activated review Skill for the qualitative criteria.`
    : `本作品有商业底层翻身读者契约。独立阅读正文，逐项提交 ${COMMERCIAL_REVIEW_CODES.join("、")} 的覆盖观察，必要时另加具体问题。有证据的满意表现用 observation，缺陷用 issue，缺少所需证据才用 unavailable。每项可判断观察必须引用本章原文；规划和作者自评不算已经兑现。issue 须给 repairScope：local、structural 或 foundation，并说明最小修复方向。第一章重点阅读大约前十句（当前第${chapter}章）；这是阅读窗口，不是分数，更不要求第十句前反派、能力或胜利全部出现。兑现判断结合本章 setup/advance/payoff/aftermath，铺垫和余韵不必强加新胜利。不承诺热度或收入；定性标准见已激活审稿 Skill。`;
}

/** Validate evidence coverage, never infer literary merit from strings or counts. */
export function validateCommercialReview(observations: ReadonlyArray<Observation>, primarySourceId: string): void {
  validateCoverage(observations, primarySourceId, COMMERCIAL_REVIEW_CODES);
}

function validateCoverage(observations: ReadonlyArray<Observation>, primarySourceId: string, codes: readonly string[]): void {
  for (const code of codes) {
    const entries = observations.filter(item => item.code === code);
    if (!entries.length) throw Object.assign(new Error(`Commercial review is incomplete: ${code}`), { code: "REVIEW_COVERAGE_REQUIRED" });
    for (const item of entries) {
      if (!item.assessment || item.category !== "quality") {
        throw Object.assign(new Error(`A commercial reading assessment requires quality category and an explicit assessment: ${code}`), { code: "REVIEW_COVERAGE_REQUIRED" });
      }
      if (item.assessment !== "unavailable" && !item.sourceRefs?.some(ref => ref.sourceId === primarySourceId)) {
        throw Object.assign(new Error(`Cite actual chapter evidence for ${code}; a plan cannot prove delivery.`), { code: "REVIEW_PROSE_EVIDENCE_REQUIRED" });
      }

    }
  }
  for (const item of observations.filter(item => item.category === "quality" && item.assessment === "issue")) {
    if (!["local", "structural", "foundation"].includes(item.repairScope ?? "")) {
      throw Object.assign(new Error(`Identify the smallest repair layer for ${item.code}.`), { code: "REVIEW_REPAIR_SCOPE_REQUIRED" });
    }
  }
}

export const STORY_CLOSURE_SOURCE = "runtime/required_story_closure";

export function storyClosureReviewProtocol(language: "zh" | "en"): string {
  return language === "en"
    ? "This authorized task requests a complete story at this chapter. Also submit a quality observation with code story-closure and actual chapter source lines. Assess whether the central promised outcome is causally settled and its consequence lands, using supplied prior evidence; reaching a chapter count or saying The End proves nothing. Respect an explicitly chosen open ending, but distinguish deliberate closure from an interrupted setup or missing climax. Optional future possibilities need not all be resolved. Use issue with repairScope for a supported missing ending, observation for supported closure, or unavailable when necessary prior evidence is missing. Do not fabricate resolution or certify publication."
    : "本任务明确要求在此章完成故事。另交代码 story-closure 的 quality 观察并引用本章原文：结合已提供的前文证据，检查核心承诺是否有因果成立的结果及余韵，达到章数或写‘完’不算证据。尊重明确选择的开放式结局，但区分有意收束与中途断稿、缺高潮；无需清除所有可选后续可能。有证据的缺失用 issue 并给 repairScope，实际闭合用 observation，所需前文不足用 unavailable。不编造结局，也不认证发布。";
}

export function validateStoryClosureReview(observations: ReadonlyArray<Observation>, primarySourceId: string): void {
  validateCoverage(observations, primarySourceId, ["story-closure"]);
}
