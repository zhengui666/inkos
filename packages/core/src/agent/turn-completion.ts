import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentTool } from "../codex/contracts.js";
import type { ActionResult } from "../harness/contracts.js";
import { loadWorkManifest } from "../harness/work-store.js";

export const TURN_COMPLETION_TOOL = "finish_turn";
export const TurnCompletionSchema = Type.Object({
  status: Type.Union([
    Type.Literal("answered", { description: "An informational or discussion request was answered. Not an execution request with actions still outstanding." }),
    Type.Literal("delivered", { description: "The requested actions actually completed, grounded in successful host action and artifact receipts." }),
    Type.Literal("needs_input", { description: "A necessary user decision or genuinely missing input prevents further work; ask a concrete question." }),
    Type.Literal("blocked", { description: "A concrete current blocker prevents the requested work; explain it and distinguish saved work from unfinished work." }),
  ]),
  message: Type.String({ minLength: 1, description: "User-facing result, necessary question, or concrete blocker. A plan or promised future action is not a delivery." }),
}, { additionalProperties: false });
export type TurnCompletion = Static<typeof TurnCompletionSchema>;

export const TURN_COMPLETION_GUIDANCE = `## Turn completion
Return the terminal response through the declared native outputSchema (status and message), or call finish_turn for immediate host validation, after answering the request, delivering its requested actions, or identifying a concrete blocker or necessary user decision. Both channels use the same host completion checks.
Announcing planned work is not completion. When work remains possible, call the relevant execution tool and continue from saved results.
Use answered only for information or discussion; delivered for completed action results; needs_input for a necessary user decision; blocked when the request cannot currently proceed.
The final output must be the complete status/message object without prose outside it or Markdown fences. Submit only after other operations finish; a successful finish_turn already completes the response. Ground delivery claims in actual tool results. A recoverable tool error does not complete the original request.`;

/** Decode only the explicitly requested whole final response, never extract JSON
 * from prose or infer a delivery from an ordinary assistant message. */
export function parseTurnCompletion(text: string): TurnCompletion {
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* Report a bounded contract error. */ }
  if (!Value.Check(TurnCompletionSchema, value)) throw Object.assign(new Error(
    "The final response did not match the required status/message completion contract."
  ), { code: "TURN_COMPLETION_INVALID" });
  return value;
}

/** Current-version reviews and exports become stale when their source changes.
 * Historical reviews are intentional snapshots and create no refresh obligation.
 */
export class TurnArtifactDeliveries {
  private readonly receipts = new Map<string, {workId: string; artifactId: string; revisionId: string; operation: string; scopeIssues?: ActionResult["observations"]}>();

  observe(result: ActionResult, parameters: unknown = {}) {
    const data = result.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object" || typeof data.workId !== "string") return;
    const historical = parameters && typeof parameters === "object" && "revisionId" in parameters;
    const chapterReview=data.kind==='chapter_review'&&data.reviewedArtifact&&typeof data.reviewedArtifact==='object'
      ? data.reviewedArtifact as {artifactId?:unknown;revisionId?:unknown}:undefined;
    const operations = data.kind === "artifact_delivered" ? ["review", "export"]
      : data.kind === "work_exported" ? ["export"]
      : chapterReview || data.kind === "artifact_reviewed" && !historical ? ["review"] : [];
    const artifactId = chapterReview?.artifactId ?? (data.kind === "work_exported" ? data.sourceArtifactId : data.artifactId);
    const revisionId = chapterReview?.revisionId ?? (data.kind === "work_exported" ? data.sourceRevisionId : data.revisionId);
    if (typeof artifactId !== "string" || typeof revisionId !== "string") return;
    const observations=Array.isArray(data.observations)?data.observations as ActionResult["observations"]:result.observations;
    const scopeIssues=observations.filter(item=>item.category==='scope'&&item.assessment==='issue');
    for (const operation of operations) this.receipts.set(JSON.stringify([data.workId, artifactId, operation]), {
      workId: data.workId, artifactId, revisionId, operation,
      ...(operation==='review'?{scopeIssues}:{}),
    });
  }

  async validate(projectRoot: string) {
    const works = new Map<string, Awaited<ReturnType<typeof loadWorkManifest>>>();
    const stale: Array<{workId: string; artifactId: string; revisionId: string; operation: string; currentRevisionId: string | null | undefined}> = [];
    for (const receipt of this.receipts.values()) {
      if (!works.has(receipt.workId)) works.set(receipt.workId, await loadWorkManifest(projectRoot, receipt.workId));
      const work = works.get(receipt.workId)!;
      const currentRevisionId = work.artifacts.find(artifact => artifact.id === receipt.artifactId)?.currentRevisionId;
      if (currentRevisionId !== receipt.revisionId) stale.push({...receipt, currentRevisionId});
    }
    if (stale.length) throw Object.assign(new Error(JSON.stringify({
      code: "TURN_DELIVERY_STALE", stale,
      instruction: "The source changed after these operations. Refresh their current-version results before claiming delivery, or report the concrete blocker.",
    })), {code: "TURN_DELIVERY_STALE"});
    const scopeViolations=[...this.receipts.values()].filter(receipt=>receipt.scopeIssues?.length);
    if(scopeViolations.length)throw Object.assign(new Error(JSON.stringify({
      code:'TURN_REVISION_SCOPE_UNRESOLVED',scopeViolations,
      instruction:'The current review identifies changes outside the author-authorized region. Restore the protected material and re-review the current revision before claiming delivery. If the finding is disputed, verify the before/current sources and obtain a corrected review; do not broaden permission to satisfy a content suggestion.',
    })),{code:'TURN_REVISION_SCOPE_UNRESOLVED'});
  }
}

export function createTurnCompletionTool(options: {
  readonly state: () => { readonly activeActions: number; readonly hasDelivery: boolean; readonly deliveryFailed: boolean };
  readonly complete: (result: TurnCompletion) => void;
  readonly validateDelivery?: () => Promise<void>;
}): AgentTool<typeof TurnCompletionSchema> {
  return {
    name: TURN_COMPLETION_TOOL,
    label: "Finish response",
    description: "Return the terminal response after fulfilling the author request or identifying a concrete blocker. Never use this merely to announce planned work.",
    parameters: TurnCompletionSchema,
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      if (!input.message.trim()) throw Object.assign(new Error("A terminal response must have meaningful text."), { code: "TURN_RESPONSE_EMPTY" });
      const state = options.state();
      if (state.activeActions > 0) throw Object.assign(new Error("Operations are still running. Wait for their results before finishing."), { code: "TURN_ACTIONS_RUNNING" });
      if (input.status === "delivered" && (!state.hasDelivery || state.deliveryFailed)) {
        throw Object.assign(new Error("Delivery requires successful production or artifact results. Continue unfinished work or report the concrete blocker."), { code: "TURN_DELIVERY_UNPROVEN" });
      }
      if (input.status === "delivered") await options.validateDelivery?.();
      signal?.throwIfAborted();
      options.complete(input);
      return { content: [{ type: "text", text: input.message }], details: { kind: "turn_completion", ...input } };
    },
  };
}
