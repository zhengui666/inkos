import type { Api, Model } from "@mariozechner/pi-ai";
import type { CodexSettings } from "./settings.js";

/** Compatibility metadata for the durable InkOS transcript, never provider routing. */
export function resolveCodexModel(settings: Partial<CodexSettings> = {}): Model<Api> {
  return {
    id: settings.model || "codex-default", name: settings.model || "Codex",
    api: "openai-responses", provider: "openai", baseUrl: "",
    reasoning: true, input: ["text", "image"], contextWindow: 128_000,
    maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
