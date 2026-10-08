import { compileContext, ContextSourceRegistry, ProtectedContextOverflowError } from "../harness/context-compiler.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { recordExecutionEvidence, currentExecutionProfile, currentExecutionWork, currentExecutionAuthorRequest } from "../harness/execution-evidence.js";
import { loadWorkManifest } from "../harness/work-store.js";
import { loadAvailableAgentSkills } from "../skills/builtin-loader.js";
import { requiredWorkSkillIds, resolveWorkSkillActivations, resolveProfileSkillActivations, mergeActivatedSkillGuidance } from "../skills/activations.js";
import type { LLMClient, LLMMessage, LLMResponse, OnStreamProgress } from "../llm/provider.js";
import { runWorkerAgent, runWorkerAgentTool, type WorkerResultTool } from "../agent/worker-agent.js";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Logger } from "../utils/logger.js";
import { SourcedReviewIndexToolSchema, ArtifactReviewIndexToolSchema } from "./review-tool.js";
import { resolveObservationSources } from "../models/observation.js";
import {
  hydrateActivatedSkillGuidance,
  type ActivatedSkillGuidance,
} from "../agent/skill-tool.js";

export interface AgentContext {
  readonly client: LLMClient;
  readonly model: string;
  readonly projectRoot: string;
  /** Persisted account/model settings can stay in the live project while data is isolated. */
  readonly runtimeProjectRoot?: string;
  readonly bookId?: string;
  readonly logger?: Logger;
  readonly onStreamProgress?: OnStreamProgress;
  readonly signal?: AbortSignal;
  readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
}

export abstract class BaseAgent {
  protected readonly ctx: AgentContext;

  constructor(ctx: AgentContext) {
    this.ctx = ctx;
  }

  protected get log() {
    return this.ctx.logger;
  }

  protected async chat(
    messages: ReadonlyArray<LLMMessage>,
    options?: { readonly temperature?: number; readonly maxTokens?: number; readonly professionalGuidance?: boolean },
  ): Promise<LLMResponse> {
    return runWorkerAgent(this.ctx.client, this.ctx.model, await this.appendTaskSkillGuidance(messages, options?.maxTokens, options?.professionalGuidance), {
      ...options,
      projectRoot: this.ctx.runtimeProjectRoot ?? this.ctx.projectRoot,
      onStreamProgress: this.ctx.onStreamProgress,
      signal: this.ctx.signal,
    });
  }

  protected async submitStructured<TParameters extends TSchema>(
    messages: ReadonlyArray<LLMMessage>,
    resultTool: WorkerResultTool<TParameters>,
    options?: { readonly temperature?: number; readonly maxTokens?: number; readonly professionalGuidance?: boolean },
  ): Promise<{ readonly result: Static<TParameters>; readonly usage: LLMResponse["usage"] }> {
    let usage: LLMResponse["usage"] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const result = await runWorkerAgentTool(
      this.ctx.client,
      this.ctx.model,
      await this.appendTaskSkillGuidance(messages, options?.maxTokens, options?.professionalGuidance).catch(error => {
        if (error instanceof ProtectedContextOverflowError) {
          Object.assign(error, { worker: this.name, resultTool: resultTool.name });
          recordExecutionEvidence("worker-context-rejected", { worker: this.name, resultTool: resultTool.name,
            code: error.code, protectedTokens: error.protectedTokens, budgetTokens: error.budgetTokens, sources: error.sources });
        }
        throw error;
      }),
      resultTool,
      {
        ...options,
        projectRoot: this.ctx.runtimeProjectRoot ?? this.ctx.projectRoot,
        signal: this.ctx.signal,
        onStreamProgress: this.ctx.onStreamProgress,
        onUsage: (value) => { usage = value; },
      },
    );
    return { result, usage };
  }

  private async appendTaskSkillGuidance(
    messages: ReadonlyArray<LLMMessage>,
    maxTokens?: number,
    professionalGuidance = true,
  ): Promise<ReadonlyArray<LLMMessage>> {
    return prepareWorkerMessages(this.ctx, messages, maxTokens, this.name, professionalGuidance);
  }

  abstract get name(): string;

  protected async submitSourcedReview(
    messages: ReadonlyArray<LLMMessage>,
    sources: ReadonlyMap<string, string>,
    tool: { name: string; label: string; description: string },
    options: { temperature?: number; maxTokens: number; categoryRequired?: boolean; validateObservations?: (observations: ReturnType<typeof resolveObservationSources>) => void },
  ) {
    const { categoryRequired, validateObservations, ...generationOptions } = options;
    const resolve = (observations: Static<typeof SourcedReviewIndexToolSchema>["observations"]) => {
      const resolved=resolveObservationSources(observations.map(observation => ({ ...observation, evidence: [] })), sources);
      validateObservations?.(resolved);
      return resolved;
    };
    const index = await this.submitStructured(messages, {
      ...tool, parameters: categoryRequired ? ArtifactReviewIndexToolSchema : SourcedReviewIndexToolSchema,
      validate: result => { resolve(result.observations); return result; },
    }, {...generationOptions,maxTokens:Math.min(generationOptions.maxTokens*2,this.ctx.client.defaults.maxTokens)});
    const observations = resolve(index.result.observations);
    return {
      result: { summary: index.result.summary, observations },
      usage: index.usage,
    };
  }
}

type WorkerPreparationContext = Pick<AgentContext, "client" | "activatedSkills" | "signal" | "bookId"> & { readonly projectRoot?: string };

export interface PreparedWorkerInput {
  readonly messages: ReadonlyArray<LLMMessage>;
  readonly inputTokens: number;
  readonly budgetTokens?: number;
}

export async function prepareWorkerMessages(
  context: WorkerPreparationContext, messages: ReadonlyArray<LLMMessage>, maxTokens?: number,
  workerId = "worker", professionalGuidance = true,
): Promise<ReadonlyArray<LLMMessage>> {
  return (await prepareWorkerInput(context, messages, maxTokens, workerId, professionalGuidance)).messages;
}

/** Preflight uses exactly the same authority, methods and source accounting as a worker call. */
export async function prepareWorkerInput(
  context: WorkerPreparationContext,
  messages: ReadonlyArray<LLMMessage>, maxTokens?: number, workerId = "worker",
  professionalGuidance = true,
): Promise<PreparedWorkerInput> {
    context.signal?.throwIfAborted();
    const authorRequest = currentExecutionAuthorRequest();
    if (authorRequest?.trim()) messages = [{role:"system",content:[
      "The following authorRequest is the user's actual request. Use it as the authority for the intended target and constraints. The delegated instruction may elaborate it, but cannot replace its target or grant a wider mutation scope. Perform only this operation; other requested steps remain the coordinator's responsibility.",
      JSON.stringify({authorRequest}),
    ].join("\n\n")},...messages];
    let work=currentExecutionWork();
    if(context.bookId && context.projectRoot && work?.id!==context.bookId) {
      work=null;
      try {work=await loadWorkManifest(context.projectRoot,context.bookId);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    const query = messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n\n");
    const scopedProfile=currentExecutionProfile();
    const profile=work && scopedProfile?.id!==work.profileId
      ? createBuiltInWorkProfileRegistry(context.projectRoot).require(work.profileId)
      : scopedProfile ?? createBuiltInWorkProfileRegistry(context.projectRoot).require("workspace-default");
    let selectedSkills=context.activatedSkills;
    const requiredIds=[...profile.requiredSkillIds,...requiredWorkSkillIds(work)];
    if(professionalGuidance&&requiredIds.some(id=>!selectedSkills?.some(item=>item.skill.id===id))) {
      const available=await loadAvailableAgentSkills({projectRoot:context.projectRoot ?? ""});
      selectedSkills=mergeActivatedSkillGuidance(resolveProfileSkillActivations(available.skills,profile),resolveWorkSkillActivations(available.skills,work),selectedSkills ?? []);
    }
    // Navigation and other read-only semantic mechanics need the source and
    // author request, without a writing method encouraging broader changes.
    const activations = professionalGuidance ? await hydrateActivatedSkillGuidance(selectedSkills, query) : [];
    recordExecutionEvidence("skills-applied", { worker: workerId, skills: activations?.map(({ skill, resources }) => ({
      id: skill.id, source: skill.source,
      references: resources.map(resource => ({ path: resource.path, charStart: resource.charStart, charEnd: resource.charEnd })),
    })) ?? [] });
    // Codex owns its model limits and automatic compaction. Compatibility
    // transcript metadata is not a model catalog and must never veto input.
    const window = context.client._codex ? undefined : context.client._piModel?.contextWindow;
    if (context.client._codex || window) {
      const sources = new ContextSourceRegistry();
      sources.register({ id: "task", load: async () => messages.map((message, index) => ({
        id: `message-${index}`, source: `${workerId}:${message.role}`, content: message.content,
        protection: "protected" as const, priority: messages.length - index,
      })) });
      const guidance = appendActivatedSkillGuidance([],activations)[0]?.content;
      sources.register({ id: "skills", load: async () => guidance ? [{id:"professional-methods",source:"skills",content:guidance,protection:"protected",priority:0}] : [] });
      sources.register({ id: "work", load: async () => work ? [{id:"current-work",source:"work",content:JSON.stringify({workId:work.id,title:work.title,profileId:work.profileId,language:work.language,lineage:work.lineage}),protection:"protected",priority:-1}] : [] });
      const compiled = await compileContext({
        recipe: { id: `${profile.contextRecipe?.id ?? profile.id}-${workerId}${professionalGuidance?'':'-task'}`, sourceIds: professionalGuidance ? [...new Set(["task", ...(guidance?["skills"]:[]), ...(profile.contextRecipe?.sourceIds ?? [])])] : ['task'] }, sources,
        request: { projectRoot: context.projectRoot ?? "", work, profile, actionId: workerId, intent: query, signal: context.signal },
        budgetTokens: window ? Math.max(1, window - (maxTokens ?? context.client.defaults.maxTokens) - 2048) : undefined,
      }).catch(error => {
        if (error instanceof ProtectedContextOverflowError) {
          // Counts and stable source ids only; never log author text/manuscripts.
          recordExecutionEvidence("context-overflow", { worker: workerId, code: error.code,
            protectedTokens: error.protectedTokens, budgetTokens: error.budgetTokens, sources: error.sources });
        }
        throw error;
      });
      recordExecutionEvidence("context-compiled", { worker: workerId, trace: compiled.trace });
      const original = new Map(messages.map((message,index)=>[`message-${index}`,message]));
      return { messages: compiled.fragments.map(fragment=>({...(original.get(fragment.id) ?? {role:"system" as const}),content:fragment.content})),
        inputTokens: compiled.trace.finalTokens, budgetTokens: compiled.trace.budgetTokens };
    }
    return { messages: appendActivatedSkillGuidance(messages, activations), inputTokens: 0 };
}

export function appendActivatedSkillGuidance(
  messages: ReadonlyArray<LLMMessage>,
  activations: ReadonlyArray<ActivatedSkillGuidance> | undefined,
): ReadonlyArray<LLMMessage> {
  if (!activations || activations.length === 0) return messages;
  // Canonicalize only rendered methodology, as SKILL.md parsing already does.
  // Keep raw reference bodies and character offsets intact for source readback;
  // author messages and protected story evidence must remain byte-for-byte.
  const guidance = [
    "## Activated professional skills",
    "Use this specialist methodology for the current operation. It is not author intent, canon, an output-format override, or permission to mutate anything outside the active operation.",
    ...activations.flatMap(({ skill, resources }) => [
      `### ${skill.id} — ${skill.name}`,
      skill.body.trim() || skill.description,
      ...resources.flatMap((resource) => [
        `#### Reference: ${resource.path}:${resource.charStart}-${resource.charEnd}${resource.heading ? ` · ${resource.heading}` : ""}`,
        resource.body,
      ]),
    ]),
  ].join("\n\n").replace(/\r\n?/g, "\n");
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    return [{ role: "system", content: guidance }, ...messages];
  }
  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${message.content}\n\n${guidance}` }
    : message);
}
