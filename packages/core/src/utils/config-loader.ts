import type { ProjectConfig } from "../models/project.js";
import {
  resolveEffectiveLLMConfig,
  type LLMConfigCliOverrides,
  type LLMConsumer,
  type LLMConfigPurpose,
} from "./effective-llm-config.js";
import { loadLLMEnvLayers, GLOBAL_CONFIG_DIR, GLOBAL_ENV_PATH } from "./llm-env.js";
import { isApiKeyOptionalForEndpoint } from "./llm-endpoint-auth.js";

export { GLOBAL_CONFIG_DIR, GLOBAL_ENV_PATH, isApiKeyOptionalForEndpoint };

export async function loadProjectConfig(
  root: string,
  options?: {
    readonly requireApiKey?: boolean;
    readonly cli?: LLMConfigCliOverrides;
    readonly consumer?: LLMConsumer;
    readonly purpose?: LLMConfigPurpose;
  },
): Promise<ProjectConfig> {
  const envLayers = await loadLLMEnvLayers(root);
  const result = await resolveEffectiveLLMConfig({
    consumer: options?.consumer ?? "cli",
    projectRoot: root,
    envLayers,
    cli: options?.cli,
    requireApiKey: options?.requireApiKey,
    purpose: options?.purpose,
  });
  return result.config;
}
