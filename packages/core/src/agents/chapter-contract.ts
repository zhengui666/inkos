import type { Observation } from "../models/observation.js";
import { sourceLineBodies } from "../utils/source-text.js";

export const CHAPTER_CONTRACT_SOURCE = "chapter-contract-source";
export const CHAPTER_CONTRACT_INVENTORY = "chapter-contract-inventory";
const activeKinds = ["required-event", "prohibition", "time-constraint"];
const kinds = [...activeKinds, "background", "future-plan", "superseded", "unknown"];

/** Classification is semantic and source-bound; the host never guesses from words. */
export function chapterContractPlanningProtocol(language: "zh" | "en"): string {
  return language === "en"
    ? `Classify the supplied current chapter memo without rewriting it or inventing obligations. Use the existing sourced observation format: code is one of ${kinds.join(", ")}, summary describes one atomic item, assessment is observation or unavailable. Cite its exact original source lines. Account for every nonempty memo line, including headings as background; split separate obligations even when they share a line. required-event means an event, choice or consequence explicitly due in this chapter; prohibition means something that must not occur; time-constraint means an explicit current time/order boundary. Background facts constrain consistency but need not be recited. Future possibilities, readerDelivery promises deferred by a setup/aftermath role, and later payments are future-plan, not current required wins or received funds. The latest explicit author instruction overrides generated plans: classify replaced requirements as superseded and cite that instruction; retain newly requested obligations with their source. Do not change accepted facts yourself. Use unknown/unavailable if authority or meaning cannot be established; explain what is missing. This is a read-only inventory, never proof that prose fulfilled anything.`
    : `只给当前章节 memo 分类，不改写原文、不发明要求。复用带原文定位的 observation：code 只能为 ${kinds.join("、")}，summary 描述一个独立事项，assessment 为 observation 或 unavailable。引用原文确切行。覆盖 memo 每个非空行，标题可归 background；同一行有多项要求须分开。required-event 是明确本章应发生的事件、选择或后果；prohibition 是不得发生的事；time-constraint 是本章明确时间或先后边界。background 约束一致性，不必复述。后续可能、setup/aftermath 明确推迟的 readerDelivery 兑现、以后付款属于 future-plan，不是本章必胜或已经到账。最新明确作者指令优先于生成计划：被替代要求归 superseded 并引用新指令，新增本章要求保留来源。不要自行更改已接受事实。权威或含义无法确定时用 unknown/unavailable 并说明缺什么。这只是只读清单，不是正文已经兑现的证据。`;
}

export function validateChapterContractInventory(items: ReadonlyArray<Observation>, memo: string): void {
  for (const item of items) {
    if (!kinds.includes(item.code) || !["observation", "unavailable"].includes(item.assessment ?? "")
      || (item.code === "unknown" && item.assessment !== "unavailable")) {
      throw Object.assign(new Error("Classify each memo item with a supported kind and observation/unavailable assessment."), { code: "CHAPTER_CONTRACT_CLASSIFICATION_REQUIRED" });
    }
  }
  if (items.some(item => item.assessment === "unavailable")) return;
  const covered = new Set(items.flatMap(item => (item.sourceRefs ?? [])
    .filter(ref => ref.sourceId === CHAPTER_CONTRACT_SOURCE).flatMap(ref => sourceLineBodies(ref.quote))));
  if (sourceLineBodies(memo).some(line => line.trim() && !covered.has(line))) {
    throw Object.assign(new Error("Classify every supplied memo line without dropping source requirements, or report unavailable."), { code: "CHAPTER_CONTRACT_INVENTORY_INCOMPLETE" });
  }
}

/** Ephemeral ids belong to this exact inventory, not a new persisted contract model. */
export function chapterContractRequirements(items: ReadonlyArray<Observation>) {
  return items.flatMap((item, index) => activeKinds.includes(item.code) ? [{
    code: `chapter-contract-${index + 1}`, kind: item.code, requirement: item.summary,
    unavailable: item.assessment === "unavailable", sourceRefs: item.sourceRefs ?? [],
  }] : []);
}

export function chapterContractReviewProtocol(language: "zh" | "en"): string {
  return language === "en"
    ? `Review the chapterContract inventory against its original memo, governed context and latest author instruction first. Submit exactly one quality observation with code ${CHAPTER_CONTRACT_INVENTORY}; cite the original memo and any changed authority. Use unavailable if the inventory is incomplete, misclassified, ambiguous or unavailable; do not repair prose to satisfy a mistaken plan. Then submit exactly one quality observation for EVERY listed requirement code, without unknown or duplicate chapter-contract ids. For each available item cite its named requirement source and the CURRENT chapter, never an old draft or the plan alone. Required events need actual present-text evidence, not a promise or self-report; an offer, invoice or promised payment is not received money. For prohibitions inspect the prose for violations: a satisfactory absence does not require the banned detail or background fact to be narrated; cite the inspected relevant passage and explain the non-violation. Check time/order constraints against actual prose without demanding a repeated timestamp. Background/future/superseded items do not require delivery now; setup and aftermath need not force a win. Use issue for a supported defect with local/structural/foundation repairScope, observation for supported compliance, and unavailable for missing semantic evidence. No keyword count or inventory completeness establishes literary merit or permission to settle facts.`
    : `先对照原 memo、权威上下文及最新作者指令核查 chapterContract 分类清单。必须且只能提交一条代码 ${CHAPTER_CONTRACT_INVENTORY} 的 quality 观察，引用原 memo 及有变更的权威来源。清单漏项、分类错误、歧义或不可用须用 unavailable，不得为错误计划强改正文。然后对每个 requirement code 恰好提交一条 quality 观察，不得漏项、重复或自造 chapter-contract id。可判断事项须同时引用该要求的命名来源和当前本章，旧稿或计划不能自证兑现。必需事件须有实际正文证据；出价、账单、承诺付款不等于收到款。禁令检查是否被违背：合规不要求把禁写细节或背景事实写出来，引用已检查的相关段落并解释未违背。时间/顺序须符合正文，不强迫重复时间戳。background/future-plan/superseded 不要求现在兑现，铺垫和余韵不强迫胜利。有证据的缺陷用 issue 并给 local/structural/foundation 的 repairScope，合规用 observation，语义证据不足用 unavailable。关键词数量或清单完整不证明文学质量，也不授权事实落库。`;
}

export function validateChapterContractReview(observations: ReadonlyArray<Observation>, items: ReadonlyArray<Observation>, primarySourceId: string): void {
  const requirements = chapterContractRequirements(items);
  const expected = [CHAPTER_CONTRACT_INVENTORY, ...requirements.map(item => item.code)];
  if (observations.some(item => item.code.startsWith("chapter-contract-") && !expected.includes(item.code))) {
    throw Object.assign(new Error("Review only the supplied chapter contract ids."), { code: "REVIEW_CONTRACT_UNKNOWN_ID" });
  }
  for (const code of expected) {
    const entries = observations.filter(item => item.code === code);
    if (entries.length !== 1 || entries[0]!.category !== "quality" || !entries[0]!.assessment) {
      throw Object.assign(new Error(`Exactly one quality assessment is required for ${code}.`), { code: "REVIEW_COVERAGE_REQUIRED" });
    }
    const item = entries[0]!;
    if (code === CHAPTER_CONTRACT_INVENTORY && item.assessment === "issue") {
      throw Object.assign(new Error("A disputed inventory is unavailable; do not repair prose to satisfy a mistaken plan."), { code: "REVIEW_CONTRACT_UNAVAILABLE" });
    }
    const unknown = code === CHAPTER_CONTRACT_INVENTORY ? items.some(entry => entry.assessment === "unavailable")
      : requirements.find(entry => entry.code === code)!.unavailable;
    if (unknown && item.assessment !== "unavailable") {
      throw Object.assign(new Error(`Unavailable inventory evidence remains unknown for ${code}.`), { code: "REVIEW_CONTRACT_UNAVAILABLE" });
    }
    if (item.assessment !== "unavailable") {
      const ids = new Set(item.sourceRefs?.map(ref => ref.sourceId));
      const inventory = code === CHAPTER_CONTRACT_INVENTORY;
      if (!ids.has(inventory ? CHAPTER_CONTRACT_SOURCE : code) || (!inventory && !ids.has(primarySourceId))) {
        throw Object.assign(new Error(`Cite original requirement and actual current chapter evidence for ${code}.`), { code: "REVIEW_PROSE_EVIDENCE_REQUIRED" });
      }
    }
    if (item.assessment === "issue" && !["local", "structural", "foundation"].includes(item.repairScope ?? "")) {
      throw Object.assign(new Error(`Identify the smallest repair layer for ${code}.`), { code: "REVIEW_REPAIR_SCOPE_REQUIRED" });
    }
  }
}
