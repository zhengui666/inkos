import {
  VERSION, SessionManager, SettingsManager, createAgentSession, createExtensionRuntime,
  type AgentSession, type ModelRuntime, type ResourceLoader, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PiMessage, PiSdkEvent, PiSdkPort, PiSdkSession, PiSessionManager, PiToolContext } from "./contracts.js";

type CoreAgent = AgentSession["agent"];
type CoreMessage = CoreAgent["state"]["messages"][number];
type CoreEvent = Parameters<Parameters<CoreAgent["subscribe"]>[0]>[0];
type CoreBefore = Parameters<NonNullable<CoreAgent["beforeToolCall"]>>[0];

function messageFromCore(message: CoreMessage): PiMessage {
  if (!["system", "user", "assistant", "toolResult"].includes(message.role)) throw new Error("Unsupported Pi SDK message");
  // This explicit boundary preserves common transcript fields across the two Pi AI versions.
  return structuredClone(message) as PiMessage;
}
function eventFromCore(event: CoreEvent): PiSdkEvent {
  switch (event.type) {
    case "message_start": case "message_end": return { ...event, message: messageFromCore(event.message) };
    case "message_update": {
      const message = messageFromCore(event.message);
      if (message.role !== "assistant") throw new Error("Invalid Pi SDK assistant event");
      return { ...event, message, assistantMessageEvent: structuredClone(event.assistantMessageEvent) };
    }
    case "agent_end": return { ...event, messages: event.messages.map(messageFromCore) };
    case "turn_end": {
      const message = messageFromCore(event.message);
      if (message.role !== "assistant") throw new Error("Invalid Pi SDK turn event");
      return { ...event, message, toolResults: structuredClone(event.toolResults) };
    }
    default: return structuredClone(event);
  }
}
export interface PiOfficialSessionObservation {
  readonly sessionId: string;
  readonly model: Readonly<{ provider: string; modelId: string }> | null;
  readonly thinkingLevel: AgentSession["thinkingLevel"];
  readonly availableThinkingLevels: readonly AgentSession["thinkingLevel"][];
  readonly changes: readonly Readonly<{
    entryId: string; type: "model_change" | "thinking_level_change";
    provider?: string; modelId?: string; thinkingLevel?: string;
  }>[];
}

/** Actual SDK state and SessionManager entry IDs, never requested values or invented IDs. */
export function observeOfficialPiSession(session: AgentSession, manager: SessionManager): PiOfficialSessionObservation {
  return Object.freeze({
    sessionId: session.sessionId,
    model: session.model ? Object.freeze({ provider: session.model.provider, modelId: session.model.id }) : null,
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: Object.freeze([...session.getAvailableThinkingLevels()]),
    changes: Object.freeze(manager.getBranch().flatMap<PiOfficialSessionObservation["changes"][number]>(entry => {
      if (entry.type === "model_change") return [Object.freeze({ entryId: entry.id, type: entry.type, provider: entry.provider, modelId: entry.modelId })];
      if (entry.type === "thinking_level_change") return [Object.freeze({ entryId: entry.id, type: entry.type, thinkingLevel: entry.thinkingLevel })];
      return [];
    })),
  });
}

export interface PiOfficialSdkOptions {
  cwd?: string;
  agentDir?: string;
  /** Host may retain this read-only live projection; a failed hook disposes the new session. */
  onSessionCreated?: (observe: () => PiOfficialSessionObservation) => void | Promise<void>;
}

function sessionFromCore(session: AgentSession): PiSdkSession {
  const agent = session.agent;
  const coreBefore = agent.beforeToolCall;
  const contexts = new WeakMap<PiToolContext, CoreBefore>();
  let before: PiSdkSession["agent"]["beforeToolCall"] = async (context, signal) => {
    const original = contexts.get(context);
    if (!original) throw new Error("Missing Pi SDK tool context");
    return coreBefore?.(original, signal);
  };
  const agentFinish = agent.finishTurn;
  let finish: PiSdkSession["agent"]["finishTurn"] = (turn, signal) => agentFinish?.(turn as Parameters<NonNullable<CoreAgent["finishTurn"]>>[0], signal);
  return {
    agent: {
      state: {
        get messages() { return agent.state.messages.map(messageFromCore); },
        get errorMessage() { return agent.state.errorMessage; },
      },
      get toolExecution() { return agent.toolExecution; },
      set toolExecution(value) { agent.toolExecution = value; },
      get beforeToolCall() { return before; },
      set beforeToolCall(value) {
        before = value;
        agent.beforeToolCall = async (context, signal) => {
          const translated: PiToolContext = { toolCall: structuredClone(context.toolCall), args: structuredClone(context.args),
            context: { messages: context.context.messages.map(messageFromCore) } };
          contexts.set(translated, context);
          return before?.(translated, signal);
        };
      },
      get finishTurn() { return finish; },
      set finishTurn(value) {
        finish = value;
        agent.finishTurn = async (turn, signal) => { const decision = await finish?.(turn, signal); return decision || undefined; };
      },
      subscribe: listener => agent.subscribe((event, signal) => listener(eventFromCore(event), signal)),
      continue: () => agent.continue(), abort: () => agent.abort(), waitForIdle: () => agent.waitForIdle(),
    },
    prompt: (text, options) => session.prompt(text, options),
    abort: () => session.abort(), waitForIdle: () => session.waitForIdle(), dispose: () => session.dispose(),
  };
}

/** Official SDK binding only. ModelRuntime creation and ChatGPT authentication belong to the host. */
export function createOfficialPiSdkPort(host: PiOfficialSdkOptions = {}): PiSdkPort {
  if (VERSION !== "1.1.0") throw new Error("Pi SDK port requires version 1.1.0");
  const { cwd, agentDir, onSessionCreated } = host;
  const managers = new WeakMap<PiSessionManager, SessionManager>();
  return {
    version: "1.1.0",
    resolveModel(runtime, provider, id) {
      if (!("getModel" in runtime) || typeof runtime.getModel !== "function") throw new Error("Pi requires a supplied ModelRuntime");
      return runtime.getModel(provider, id);
    },
    createExtensionRuntime,
    settingsInMemory: settings => SettingsManager.inMemory({ ...settings, retry: { ...settings.retry, maxRetries: 0 } }),
    sessionInMemory() {
      const manager = SessionManager.inMemory(cwd);
      const port: PiSessionManager = {
        appendMessage: message => manager.appendMessage(structuredClone(message) as Parameters<SessionManager["appendMessage"]>[0]),
        buildSessionContext: () => ({ messages: manager.buildSessionContext().messages.map(messageFromCore) }),
      };
      managers.set(port, manager);
      return port;
    },
    async createAgentSession(options) {
      const manager = managers.get(options.sessionManager);
      if (!manager || !(options.settingsManager instanceof SettingsManager)) throw new Error("Pi requires in-memory SDK managers");
      const customTools: ToolDefinition[] = options.customTools.map(tool => ({
        name: tool.name, label: tool.label, description: tool.description, executionMode: "sequential",
        // Native 1.x TypeBox consumes JSON Schema; host preparation already performs strict 0.x validation.
        parameters: JSON.parse(JSON.stringify(tool.parameters)) as ToolDefinition["parameters"],
        prepareArguments: args => tool.prepareArguments(args),
        execute: (id, args, signal, onUpdate) => tool.execute(id, args, signal, onUpdate),
      }));
      const created = await createAgentSession({
        cwd, agentDir,
        modelRuntime: options.modelRuntime as ModelRuntime,
        model: options.model as NonNullable<Parameters<typeof createAgentSession>[0]>["model"],
        thinkingLevel: options.thinkingLevel, tools: [...options.tools], customTools,
        sessionManager: manager, settingsManager: options.settingsManager,
        resourceLoader: options.resourceLoader as ResourceLoader,
      });
      try {
        await onSessionCreated?.(() => observeOfficialPiSession(created.session, manager));
        return { session: sessionFromCore(created.session) };
      } catch (error) { created.session.dispose(); throw error; }
    },
  };
}
