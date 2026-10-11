import { AsyncLocalStorage } from 'node:async_hooks';
import type { ImageContent } from '@mariozechner/pi-ai';
import type { CodexAgentOptions } from '../../../codex/agent.js';
import type { AgentEvent, AgentMessage } from '../../../codex/contracts.js';
import { beginAgentModelCall } from '../../../llm/agent-trajectory.js';
import { RuntimeAuthenticationError } from '../../auth/codex-owner.js';
import { guardRuntimeExecution, RuntimeHistoryWriteError } from '../../execution.js';
import { currentRuntimeRun, type PiRunContext } from '../../run-context.js';
import { appendRunDispatch, appendRunObservation } from '../../run-history.js';
import type { RuntimeAgent } from '../../provider.js';
import { createPiAdapter } from './adapter.js';
import { createOfficialPiSdkPort, type PiOfficialSessionObservation } from './official-sdk.js';
import type { PiHostTool, PiRunHandle, PiThinkingLevel, PiToolFailure } from './contracts.js';

export class PiCleanupError extends Error {
  readonly code = 'PI_CLEANUP_FAILED';
  readonly cleanupFailure!: unknown;
  constructor(readonly primaryFailure: unknown, cleanupFailure: unknown) {
    super('Pi session cleanup could not be confirmed');
    Object.defineProperty(this, 'cleanupFailure', { value: cleanupFailure });
  }
}

/** Each call reconstructs a real SDK session from committed host state, including corrections. */
export class PiAgent implements RuntimeAgent {
  readonly state: RuntimeAgent['state'];
  finalOutput: string | undefined;
  modelError: (Error & { code: string }) | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private handle?: PiRunHandle;
  private controller?: AbortController;
  private terminal: unknown;
  constructor(private readonly options: CodexAgentOptions) {
    this.state = { ...options.initialState, messages: [...options.initialState.messages] };
  }
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  abort(): void { this.controller?.abort(new DOMException('Pi agent cancelled', 'AbortError')); void this.handle?.abort().catch(() => {}); }
  clearAllQueues(): void {}
  private async emit(event: AgentEvent): Promise<void> { for (const listener of this.listeners) await listener(event); }
  private async guard(signal?: AbortSignal): Promise<void> {
    try { await guardRuntimeExecution(signal); }
    catch (error) { if (error instanceof RuntimeAuthenticationError || error instanceof RuntimeHistoryWriteError) this.terminal ??= error; throw error; }
    if (this.terminal) throw this.terminal;
  }
  async prompt(input: string | AgentMessage[], images: ImageContent[] = []): Promise<void> {
    const messages: AgentMessage[] = typeof input === 'string'
      ? [{ role: 'user', content: images.length ? [{ type: 'text', text: input }, ...images] : input, timestamp: Date.now() }] : input;
    await this.run('prompt', messages);
  }
  async continue(): Promise<void> { await this.run('continue', []); }
  private persist(runtime: PiRunContext, write: () => unknown): void {
    try { write(); } catch (error) {
      const failure = new RuntimeHistoryWriteError(error); runtime.onHistoryFailure?.(failure); this.terminal = failure; throw failure;
    }
  }
  private failure(error: unknown, phase: 'prepare' | 'execute'): PiToolFailure {
    if (this.terminal || error instanceof RuntimeAuthenticationError || error instanceof RuntimeHistoryWriteError) return { kind: 'fatal', category: 'guard' };
    const code = (error as { code?: string })?.code;
    if (phase === 'prepare' || ['WORKER_RESULT_INVALID', 'WORKER_DOMAIN_INVALID', 'TOOL_SCHEMA_INVALID'].includes(code ?? '')) {
      return { kind: 'recoverable', category: 'validation', ...(error instanceof Error ? { feedback: error.message } : {}) };
    }
    return { kind: 'fatal', category: 'uncertain' };
  }
  private async run(mode: 'prompt' | 'continue', newMessages: AgentMessage[]): Promise<void> {
    if (this.controller) throw new Error('Pi agent is already running');
    const runtime = currentRuntimeRun();
    if (runtime?.harnessId !== 'pi') throw new RuntimeAuthenticationError('Pi requires its admitted runtime context');
    const inInvocation = AsyncLocalStorage.snapshot();
    const controller = new AbortController(); this.controller = controller;
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, controller.signal]) : controller.signal;
    let failure: unknown, cleanup: unknown, observe: (() => PiOfficialSessionObservation) | undefined;
    this.finalOutput = undefined; this.modelError = undefined;
    try {
      await this.guard(signal);
      for (const message of newMessages) {
        await this.emit({ type: 'message_start', message }); this.state.messages.push(message); await this.emit({ type: 'message_end', message });
      }
      const committed = [...this.state.messages];
      const context = this.options.transformContext ? await this.options.transformContext(committed, signal) : committed;
      await this.guard(signal);
      const tools: PiHostTool[] = this.state.tools.map(tool => ({ ...tool,
        prepareArguments: async args => inInvocation(async () => {
          await this.guard(signal); const prepared = tool.prepareArguments ? await tool.prepareArguments(args) : args;
          await this.guard(signal); return prepared;
        }),
        execute: async (id, args, toolSignal, onUpdate) => inInvocation(async () => {
          await this.guard(toolSignal);
          const result = await tool.execute(id, args, toolSignal, onUpdate);
          try { await this.guard(toolSignal); }
          catch { return { ...result, isError: true, failure: { kind: 'fatal' as const, category: 'guard' as const } }; }
          return result;
        }),
        classifyFailure: (error, phase) => this.failure(error, phase),
        completesRun: result => !result.isError && !!this.options.shouldStop?.(),
      }));
      const sdk = createOfficialPiSdkPort({ projectMessage: runtime.runtime.projectMessage, cwd: runtime.projectRoot,
        onSessionCreated: async observed => { observe = observed; await this.guard(signal); } });
      const sessionInMemory = sdk.sessionInMemory.bind(sdk);
      const systemPrompt = this.options.outputSchema ? `${this.state.systemPrompt}\n\nReturn a complete final result matching this host JSON Schema, or use an offered completion tool: ${JSON.stringify(this.options.outputSchema)}` : this.state.systemPrompt;
      sdk.sessionInMemory = () => {
        const manager = sessionInMemory();
        // Direct native continuation bypasses AgentSession.prompt's prompt assembly.
        // Commit the real system message to the actual session tree before reconstruction.
        manager.appendMessage({ role: 'system', content: systemPrompt, timestamp: Date.now() });
        return manager;
      };
      const createSession = sdk.createAgentSession.bind(sdk);
      sdk.createAgentSession = options => {
        // Native continuation needs a real control entry after the restored assistant.
        if (mode === 'continue' && options.sessionManager.buildSessionContext().messages.at(-1)?.role === 'assistant') {
          options.sessionManager.appendMessage({ role: 'system', content: systemPrompt, timestamp: Date.now() });
        }
        return createSession(options);
      };
      this.handle = await createPiAdapter({ provider: 'openai', modelId: runtime.selection.modelId,
        thinkingLevel: runtime.selection.effort as PiThinkingLevel, systemPrompt,
        initialMessages: context, tools, signal, maxOutputTokens: this.options.maxOutputTokens }, {
        sdk, modelRuntime: runtime.runtime.modelRuntime,
        beforeToolCall: (toolContext, toolSignal) => inInvocation(async () => {
          await this.guard(toolSignal);
          await this.options.beforeToolCall?.({ ...toolContext, signal: toolSignal,
            context: { messages: toolContext.context.messages as AgentMessage[], tools: this.state.tools, systemPrompt: this.state.systemPrompt } });
          await this.guard(toolSignal);
        }),
      });
      await this.guard(signal);
      this.handle.subscribe(event => inInvocation(async () => {
        if (event.type === 'turn_start') {
          await this.guard(signal); this.options.onModelTurn?.();
          const trace = beginAgentModelCall(), observed = observe?.();
          if (runtime.history) {
            if (!trace || !observed || trace.runId !== runtime.history.coreRequestId) {
              const failure = new RuntimeHistoryWriteError('Pi history requires the current trajectory and real session');
              runtime.onHistoryFailure?.(failure); this.terminal = failure; throw failure;
            }
            const base = { schemaVersion: 1 as const, sessionId: runtime.history.sessionId, coreRequestId: trace.runId, modelCallId: trace.modelCallId };
            this.persist(runtime, () => appendRunDispatch(runtime.history!, { ...base, kind: 'dispatch', operation: 'pi-prompt',
              piSessionId: observed.sessionId, agentRole: trace.agentRole, ...(trace.parentToolCallId ? { parentToolCallId: trace.parentToolCallId } : {}),
              wire: { model: runtime.selection.modelId, effort: runtime.selection.effort, serviceTier: runtime.selection.serviceTier } }));
            for (const entry of observed.changes) this.persist(runtime, () => appendRunObservation(runtime.history!, { ...base, kind: 'observation',
              source: 'pi-session-entry', scope: 'entry', piSessionId: observed.sessionId, entryId: entry.entryId,
              effective: entry.type === 'model_change' ? (entry.modelId === undefined ? {} : { modelId: entry.modelId })
                : (entry.thinkingLevel === undefined ? {} : { effort: entry.thinkingLevel }) }));
          }
          await this.guard(signal);
        }
        await this.emit(event as AgentEvent);
      }));
      const result = await this.handle.continue();
      // The canonical host transcript survives context transformation and is never replaced with a UI-only array.
      this.state.messages = [...committed, ...result.messages.slice(context.length)] as AgentMessage[];
      // A cancelled model/auth wait settles before detached saving errors arrive in drain.
      if (signal.aborted && this.terminal === undefined) signal.throwIfAborted();
      await this.guard(signal);
      if (result.error) {
        this.modelError = Object.assign(new Error(result.error.message), { code: result.error.code }); throw this.modelError;
      }
      signal.throwIfAborted();
      const last = [...this.state.messages].reverse().find(message => message.role === 'assistant');
      if (last?.role === 'assistant' && last.stopReason === 'stop') this.finalOutput = last.content.filter(part => part.type === 'text').map(part => part.text).join('');
    } catch (error) {
      const callerCancelled = this.options.signal?.aborted && (this.options.signal.reason as { code?: string })?.code !== 'WORKER_TIMEOUT';
      failure = this.terminal ?? (callerCancelled ? this.options.signal!.reason ?? error : error);
    }
    finally {
      try { await this.handle?.dispose(); } catch (error) { cleanup = error; }
      try { await runtime.lease.drain(); } catch (error) { cleanup = cleanup === undefined ? error : new AggregateError([cleanup, error], 'Pi cleanup work failed'); }
      this.handle = undefined; this.controller = undefined;
    }
    if (cleanup !== undefined && cleanup !== failure) throw new PiCleanupError(failure, cleanup);
    if (failure !== undefined) throw failure;
  }
}
