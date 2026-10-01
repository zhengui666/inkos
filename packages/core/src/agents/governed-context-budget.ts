import type { LLMMessage } from "../llm/provider.js";
import type { ContextPackage } from "../models/input-governance.js";
import { ProtectedContextOverflowError } from "../harness/context-compiler.js";
import { recordExecutionEvidence } from "../harness/execution-evidence.js";
import { prepareWorkerInput, type AgentContext } from "./base.js";
import { SemanticContextCompilerAgent } from "./semantic-context-compiler.js";

/** Fit lower-priority evidence to the *consumer's* prompt, never its authority. */
export async function fitGovernedContext(input: {
  readonly context: AgentContext;
  readonly worker: string;
  readonly language: "zh" | "en";
  readonly contextPackage: ContextPackage;
  readonly maxTokens?: number;
  readonly intent?: string;
  readonly render: (context: ContextPackage) => ReadonlyArray<LLMMessage>;
}): Promise<ContextPackage> {
  const prepare = (context: ContextPackage) => prepareWorkerInput(input.context, input.render(context), input.maxTokens, input.worker);
  try {
    await prepare(input.contextPackage);
    return input.contextPackage;
  } catch (error) {
    if (!(error instanceof ProtectedContextOverflowError)) throw error;
  }
  const protectedEntries = input.contextPackage.selectedContext.filter(entry => entry.protection === "protected");
  const compressible = input.contextPackage.selectedContext.filter(entry => entry.protection !== "protected");
  const fixed = { ...input.contextPackage, selectedContext: protectedEntries };
  // This must succeed before any model is called: genuine protected overflow
  // remains an error, not permission to truncate or summarize protected input.
  const prepared = await prepare(fixed);
  const available = (prepared.budgetTokens ?? 0) - prepared.inputTokens - 512;
  if (compressible.length === 0 || available < 1) {
    throw new ProtectedContextOverflowError(prepared.inputTokens + 512, prepared.budgetTokens ?? 0);
  }
  input.context.signal?.throwIfAborted();
  const compiled = await new SemanticContextCompilerAgent(input.context).compile({
    intent: `Select lower-priority background relevant to chapter ${input.contextPackage.chapter}; the consumer receives all protected instructions and state separately.\nCurrent operation: ${input.intent ?? "Continue the chapter using the supplied evidence."}`,
    language: input.language,
    maxTokens: Math.min(available, input.context.client.defaults.maxTokens),
    fragments: compressible.map((entry, index) => ({ id: `evidence-${index + 1}`, source: entry.source,
      content: entry.excerpt ?? entry.reason, pointer: entry.source, protection: "compressible", priority: 0 })),
  });
  const result: ContextPackage = { ...fixed, selectedContext: [...protectedEntries, {
    source: "runtime/consumer-compiled-context", reason: "Lower-priority evidence compiled for this worker's remaining input budget.",
    excerpt: compiled.content, protection: "compressible",
  }] };
  const final = await prepare(result);
  recordExecutionEvidence("consumer-context-compiled", { worker: input.worker, chapter: result.chapter,
    sources: compressible.map(entry => entry.source), protectedSources: protectedEntries.map(entry => entry.source),
    inputTokens: final.inputTokens, budgetTokens: final.budgetTokens });
  return result;
}
