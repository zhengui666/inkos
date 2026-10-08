import { Type } from "@sinclair/typebox";

const text = (description: string) => Type.String({ minLength: 1, description });
const promise = {
  familiarPromise: text("A recognizable genre pleasure and concrete reader expectation, not a copied plot."),
  distinctiveHook: text("One specific new constraint or opportunity that changes choices within that familiar promise."),
  readingPleasure: text("The emotional experience the work will repeatedly earn."),
  openingQuestion: text("A concrete outcome readers can want after the opening; distinguish intentional mysteries from confusion."),
  proseApproach: text("Accessible prose and dialogue approach in the requested language; honor explicit voice preferences without copying an author."),
};
export const ReaderContractToolSchema = Type.Union([
  Type.Object({
    mode: Type.Literal("commercial-underdog"), ...promise,
    riseRoute: Type.Object({
      startingDisadvantage: text("Material lack of options or leverage shown in life, not just a label of poverty."),
      desiredChange: text("The concrete first improvement the protagonist wants."),
      opportunity: text("The usable capital: skill, information, relationship, power, system, rebirth or another fitting opening."),
      opportunityLimits: text("Rules, access, cost and remaining limits; the opportunity is not itself a victory."),
      opposition: Type.Object({
        force: text("A person, group, institution or circumstance that visibly obstructs the goal; do not require an early named villain."),
        interest: text("What the opposition wants or preserves; for an impersonal force explain its causal pressure."),
        leverage: text("How it can deny, take, threaten or constrain something the protagonist values."),
      }, { additionalProperties: false }),
      protagonistContribution: text("The chosen contribution that makes the result earned; any relevant limit or cost need not mean suffering or punishment."),
      firstPayoff: text("A feasible first demonstrated gain and its place in the opening arc; no fixed chapter deadline."),
      payoffMeaning: text("How the gain changes resources, options, standing or relationships and how the reader feels it."),
      escalation: text("How success changes the next contest without resetting the gain; unknown futures may remain open."),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("author-directed"), ...promise,
    authorDirection: text("The explicit author instruction or source-canon constraint requiring a different reading goal. Do not invent an override to evade the commercial default."),
  }, { additionalProperties: false }),
]);

export const ChapterDeliveryToolSchema = Type.Object({
  role: Type.Union([Type.Literal("setup"), Type.Literal("advance"), Type.Literal("payoff"), Type.Literal("aftermath")]),
  wantedOutcome: text("Concrete gain or preserved gain readers want in this chapter."),
  openingMove: text("The immediate situation, pressure and contrast the first short reading window makes clear, without dumping the entire Bible."),
  opposition: text("The relevant opposing action or constraint; an aftermath may carry an earlier consequence instead of inventing a new villain."),
  initiative: text("What the protagonist chooses or tries and why; distinguish help/opportunity from their contribution."),
  earnedChange: text("The causal result due in this chapter, or the meaningful progress toward a later result."),
  feltConsequence: text("The visible change and specific reaction that lets the gain, cost or disappointment land."),
  carryForward: text("What must remain changed afterward; a final chapter or one-shot closes its promised outcome rather than requiring a sequel hook."),
  deferredPayoffReason: text("Why any promised gain is not yet due and what this chapter gives instead; say none if paid here."),
}, { additionalProperties: false });
