import { isAbsolute } from "node:path";
import {
  VERSION, ModelRuntime, SettingsManager, SessionManager, createAgentSession, createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { createPiNativeStoreCompat } from "../../auth/pi-native-store-compat.js";
import { createHostResourceLoader } from "./adapter.js";
import { observeOfficialPiSession, type PiOfficialSessionObservation } from "./official-sdk.js";
import type { PiModelRuntime } from "./contracts.js";

export interface PiRuntimeContextOptions {
  cwd: string;
  agentDir: string;
  authPath: string;
  projectTrusted: boolean;
  speed?: unknown;
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
  getModels(): readonly Readonly<OfficialModel>[];
  resolveModel(modelId: string): Readonly<OfficialModel>;
  observeDefaults(onObserved?: (observation: PiDefaultObservation) => void | Promise<void>): Promise<PiDefaultObservation>;
}

/** Explicit host scope around the official runtime, without implementing auth or model transport. */
export async function createPiRuntimeContext(options: PiRuntimeContextOptions): Promise<PiRuntimeContext> {
  const { cwd, agentDir, authPath, projectTrusted, speed } = options;
  if (VERSION !== "1.1.0") throw new Error("Pi runtime context requires the official SDK 1.1.0");
  if (![cwd, agentDir, authPath].every(isAbsolute) || typeof projectTrusted !== "boolean") {
    throw new Error("Pi runtime context requires explicit absolute directories and project trust");
  }
  if (speed !== undefined && speed !== null) throw new Error("Pi does not support speed selection");
  const credentials = await createPiNativeStoreCompat(authPath);
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
    return typeof providerOrModel === "string" ? nativeGetAuth(providerOrModel, overrides) : nativeGetAuth(providerOrModel, overrides);
  };
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
    authCapability: Object.freeze({ providerId: "openai" as const, type: "oauth" as const, isSubscription: true as const }),
    getModels, resolveModel,
    async observeDefaults(onObserved?: (observation: PiDefaultObservation) => void | Promise<void>) {
      if ((await runtime.checkAuth("openai"))?.type !== "oauth") throw new Error("Pi requires a stored ChatGPT OAuth credential");
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
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
        await onObserved?.(observation);
        return observation;
      } finally { session.dispose(); }
    },
  });
}
