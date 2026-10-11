import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  VERSION, CONFIG_DIR_NAME, ModelRuntime, SettingsManager, SessionManager, createAgentSession, createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createPiNativeStoreCompat, type PiCredentialStore } from "../../auth/pi-native-store-compat.js";
import { createHostResourceLoader } from "./adapter.js";
import { observeOfficialPiSession, type PiOfficialSessionObservation } from "./official-sdk.js";
import type { PiMessage, PiModelRuntime } from "./contracts.js";

export interface PiRuntimeContextOptions {
  cwd: string;
  agentDir: string;
  authPath: string;
  projectTrusted: boolean;
  speed?: unknown;
  /** Offline catalog GET uses raw settings snapshots and official in-memory parsing, without filesystem locks. */
  passiveObservation?: boolean;
  /** Supplied only by the trusted execution owner; passive probes use raw read-only compatibility. */
  credentials?: PiCredentialStore;
  resolveAuth?: <T>(resolve: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}
export interface PiDefaultObservation extends PiOfficialSessionObservation {
  readonly speed: null;
  readonly activeToolNames: readonly string[];
  readonly resourceCounts: Readonly<{ extensions: number; skills: number; prompts: number; themes: number; agentsFiles: number }>;
}
type OfficialModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
export interface PiRuntimeContext {
  /** Real ModelRuntime, deliberately opaque to selection/UI consumers. No registration surface. */
  readonly modelRuntime: PiModelRuntime;
  readonly authCapability: Readonly<{ providerId: "openai"; type: "oauth"; isSubscription: true }>;
  /** Host projection only; native SDK messages stay untouched. */
  projectMessage(message: PiMessage): PiMessage;
  getModels(): readonly Readonly<OfficialModel>[];
  resolveModel(modelId: string): Readonly<OfficialModel>;
  observeDefaults(onObserved?: (observation: PiDefaultObservation) => void | Promise<void>, modelId?: string): Promise<PiDefaultObservation>;
}

/** Explicit host scope around the official runtime, without implementing auth or model transport. */
export async function createPiRuntimeContext(options: PiRuntimeContextOptions): Promise<PiRuntimeContext> {
  const { cwd, agentDir, authPath, projectTrusted, speed, passiveObservation = false } = options;
  if (VERSION !== "1.1.0") throw new Error("Pi runtime context requires the official SDK 1.1.0");
  if (![cwd, agentDir, authPath].every(isAbsolute) || typeof projectTrusted !== "boolean") {
    throw new Error("Pi runtime context requires explicit absolute directories and project trust");
  }
  if (speed !== undefined && speed !== null) throw new Error("Pi does not support speed selection");
  function readSettings(path: string): string | undefined {
    try { return readFileSync(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  // Capture once per passive catalog. Parsing, migration, defaults and per-model
  // thinking remain official SDK behavior; session-local saves stay in memory.
  const settingsSnapshot = passiveObservation ? {
    global: readSettings(join(agentDir, "settings.json")),
    project: projectTrusted ? readSettings(join(cwd, CONFIG_DIR_NAME, "settings.json")) : undefined,
  } : null;
  function createObservationSettings(): SettingsManager {
    const content = { ...settingsSnapshot! };
    return SettingsManager.fromStorage({ withLock(scope, fn) {
      const next = fn(content[scope]);
      if (next !== undefined) content[scope] = next;
    } }, { projectTrusted });
  }
  const credentials = options.credentials ?? await createPiNativeStoreCompat(authPath);
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const openai = runtime.getProvider("openai");
  if (openai?.auth.oauth?.isSubscription !== true || openai.auth.oauth.name !== "OpenAI (ChatGPT subscription)") {
    throw new Error("Pi official ChatGPT OAuth capability is unavailable");
  }
  // Public mutable auth capability objects are shared by the native, unconfigured providers.
  // No models.json or provider registration is exposed, so SDK recomposition retains this policy.
  for (const provider of runtime.getProviders()) {
    if (provider.id === "openai") delete provider.auth.apiKey;
    else {
      delete provider.auth.oauth;
      provider.auth.apiKey = { name: "Disabled by Inkos host", check: async () => undefined, resolve: async () => undefined };
    }
  }
  // Native prepareRequest otherwise lets a caller's apiKey win over OAuth.toAuth().
  // Guard request input; the official OAuth output may legitimately contain an apiKey transport field.
  const nativeGetAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (providerOrModel: string | Parameters<ModelRuntime["getAuth"]>[0], overrides: NonNullable<Parameters<ModelRuntime["getAuth"]>[1]> = {}) => {
    if (overrides.apiKey !== undefined) throw new Error("Pi request API key overrides are disabled; ChatGPT OAuth is required");
    const provider = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
    if (provider !== "openai") throw new Error("Pi requests require official openai ChatGPT OAuth");
    const resolve = async () => {
      try { return typeof providerOrModel === "string" ? await nativeGetAuth(providerOrModel, overrides) : await nativeGetAuth(providerOrModel, overrides); }
    catch {
      if (overrides.signal?.aborted) throw new DOMException("Pi auth operation cancelled", "AbortError");
      throw new Error("Pi official ChatGPT OAuth resolution failed");
    }
    };
    // The owner gate sits outside SDK error sanitization so terminal host failures survive.
    if (!options.resolveAuth) throw new Error("Pi auth resolution requires an execution lease");
    try { return await options.resolveAuth(resolve, overrides.signal); }
    catch (error) {
      const code = (error as { code?: string })?.code;
      if (overrides.signal?.aborted && code !== 'RUNTIME_AUTH_REVOKED' && code !== 'RUNTIME_HISTORY_WRITE_FAILED') {
        throw new DOMException('Pi auth operation cancelled', 'AbortError');
      }
      throw error;
    }
  };
  // The official Responses parser initializes usage to zero even without a native report.
  // Associate each native message object with evidence captured by its own request closure.
  const messageEvidence = new WeakMap<object, { readonly ids: ReadonlySet<string> }>();
  const nativeStream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, request = {}) => {
    const ids = new Set<string>();
    const originalHook = request.onProviderStreamEvent;
    const stream = nativeStream(model, context, { ...request, onProviderStreamEvent: async (data, nativeModel) => {
      await originalHook?.(data, nativeModel);
      if (!data || typeof data !== 'object') return;
      const event = data as { type?: unknown; response?: { id?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown } } };
      if (event.type !== 'response.completed' && event.type !== 'response.incomplete') return;
      const { response } = event;
      if (typeof response?.id !== 'string' || !response.id) return;
      const counts = [response.usage?.input_tokens, response.usage?.output_tokens, response.usage?.total_tokens];
      if (counts.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) ids.add(response.id);
      else ids.delete(response.id);
    } });
    const iterator = stream[Symbol.asyncIterator].bind(stream), result = stream.result.bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
      for await (const event of { [Symbol.asyncIterator]: iterator }) {
        const message = 'partial' in event ? event.partial : 'message' in event ? event.message : 'error' in event ? event.error : undefined;
        if (message) messageEvidence.set(message, { ids });
        yield event;
      }
    };
    stream.result = async () => { const message = await result(); messageEvidence.set(message, { ids }); return message; };
    return stream;
  };
  function projectMessage(message: PiMessage): PiMessage {
    const copy = structuredClone(message);
    if (copy.role === 'assistant' && (!copy.responseId || !messageEvidence.get(message)?.ids.has(copy.responseId))) delete copy.usage;
    return copy;
  }
  const refreshed = await runtime.refresh({ providers: ["openai"], allowNetwork: false });
  if (refreshed.errors.size > 0) throw new Error("Pi ChatGPT OAuth storage or offline model availability failed");
  if ((await runtime.checkAuth("openai"))?.type !== "oauth") throw new Error("Pi requires a stored ChatGPT OAuth credential");
  function freezeSnapshot<T>(value: T): Readonly<T> {
    if (value && typeof value === "object") {
      for (const nested of Object.values(value)) freezeSnapshot(nested);
      Object.freeze(value);
    }
    return value;
  }
  function getModels(): readonly Readonly<OfficialModel>[] {
    return Object.freeze(runtime.getAvailableSnapshot().filter(model => model.provider === "openai" && model.type === "chat")
      .map(model => freezeSnapshot(structuredClone(model))));
  }
  function resolveModel(id: string): Readonly<OfficialModel> {
    const model = getModels().find(model => model.id === id);
    if (!model) throw new Error("Pi model must be an available official openai ChatGPT chat model");
    return model;
  }
  return Object.freeze({
    modelRuntime: runtime,
    projectMessage,
    authCapability: Object.freeze({ providerId: "openai" as const, type: "oauth" as const, isSubscription: true as const }),
    getModels, resolveModel,
    async observeDefaults(onObserved?: (observation: PiDefaultObservation) => void | Promise<void>, modelId?: string) {
      if ((await runtime.checkAuth("openai"))?.type !== "oauth") throw new Error("Pi requires a stored ChatGPT OAuth credential");
      const settingsManager = settingsSnapshot ? createObservationSettings() : SettingsManager.create(cwd, agentDir, { projectTrusted });
      if (settingsManager.drainErrors().length > 0) throw new Error("Pi settings could not be loaded");
      const defaultProvider = settingsManager.getDefaultProvider(), defaultModel = settingsManager.getDefaultModel();
      if ((defaultProvider !== undefined && defaultProvider !== "openai") ||
          (defaultModel !== undefined && (!defaultProvider || !getModels().some(model => model.id === defaultModel)))) {
        throw new Error("Pi saved default model is outside the allowed ChatGPT OAuth scope");
      }
      // Override only host controls in memory; retain real model/thinking defaults without writes.
      settingsManager.applyOverrides({ cacheWarming: "off", retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false } });
      const sessionManager = SessionManager.inMemory(cwd);
      const loader = createHostResourceLoader("", createExtensionRuntime()) as ResourceLoader;
      const { session } = await createAgentSession({ cwd, agentDir,
        ...(modelId ? { model: resolveModel(modelId) as OfficialModel } : {}),
        modelRuntime: runtime, settingsManager, sessionManager, resourceLoader: loader, tools: [], customTools: [] });
      try {
        if (!session.model || session.model.provider !== "openai" || !getModels().some(model => model.id === session.model?.id)) {
          throw new Error("Pi effective default model is outside the allowed ChatGPT OAuth scope");
        }
        if (settingsManager.drainErrors().length > 0) throw new Error("Pi settings could not be loaded");
        const observation: PiDefaultObservation = Object.freeze({ ...observeOfficialPiSession(session, sessionManager), speed: null,
          activeToolNames: Object.freeze([...session.getActiveToolNames()]),
          resourceCounts: Object.freeze({ extensions: loader.getExtensions().extensions.length, skills: loader.getSkills().skills.length,
            prompts: loader.getPrompts().prompts.length, themes: loader.getThemes().themes.length, agentsFiles: loader.getAgentsFiles().agentsFiles.length }),
        });
        try { await onObserved?.(observation); }
        catch { throw new Error("Pi host default observation failed"); }
        return observation;
      } finally { session.dispose(); }
    },
  });
}
