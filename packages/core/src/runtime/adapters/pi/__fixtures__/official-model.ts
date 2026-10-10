import assert from "node:assert/strict";
import type { PiAssistantMessage } from "../contracts.js";

/** Only the opaque model boundary is fake; the port, AgentSession, Agent and loop are real SDK code. */
export function officialModelFixture(responses: PiAssistantMessage[], textChunks?: string[]) {
  const model = { id: "fixture-model", name: "Accountless deterministic model", type: "chat", api: "openai-responses", provider: "openai",
    baseUrl: "http://localhost:0", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const observed: unknown[] = [];
  let emittedChunks = 0;
  const runtime = Object.freeze({
    getModel: (provider: string, id: string) => provider === "openai" && id === model.id ? model : undefined,
    getPhysicalModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model],
    getError: () => undefined, hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key", source: "accountless fixture" }),
    getAuth: async () => ({ auth: {}, source: "accountless fixture" }), isUsingOAuth: () => false,
    streamSimple(_model: unknown, context: unknown, options?: { apiKey?: string; signal?: AbortSignal }) {
      assert.equal(options?.apiKey, undefined);
      observed.push(structuredClone(context));
      const response = responses.shift();
      assert.ok(response, "Unexpected additional model request");
      let final = structuredClone(response);
      return {
        result: async () => final,
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: { ...final, content: [], stopReason: "pending", usage: undefined } };
          for (const text of textChunks ?? []) {
            if (options?.signal?.aborted) break;
            emittedChunks++;
            final = { ...final, content: [{ type: "text", text }] };
            yield { type: "text_delta", contentIndex: 0, delta: text, partial: { ...final, stopReason: "pending" } };
          }
          if (options?.signal?.aborted) final = { ...final, stopReason: "aborted" };
          yield { type: "done", reason: final.stopReason, message: final };
        },
      };
    },
  });
  return { runtime, observed, get emittedChunks() { return emittedChunks; } };
}
