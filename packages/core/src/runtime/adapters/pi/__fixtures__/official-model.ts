import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(getPackageDir(), "../pi-ai/dist/utils/event-stream.js")).href);
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
    streamSimple(_model: Parameters<ModelRuntime["streamSimple"]>[0], context: Parameters<ModelRuntime["streamSimple"]>[1], options?: Parameters<ModelRuntime["streamSimple"]>[2]) {
      assert.equal(options?.apiKey, undefined);
      observed.push(structuredClone(context));
      const response = responses.shift();
      assert.ok(response, "Unexpected additional model request");
      let final = { ...structuredClone(response), responseId: response.responseId ?? `fixture-response-${observed.length}` };
      const stream = createAssistantMessageEventStream();
      // Backpressure is observable in cancellation tests. Use the official stream,
      // and advance the fixture producer only after the SDK consumes each event.
      const iterator = stream[Symbol.asyncIterator].bind(stream), acknowledged = new Map<object, () => void>();
      stream[Symbol.asyncIterator] = async function* () {
        for await (const event of { [Symbol.asyncIterator]: iterator }) {
          yield event; acknowledged.get(event)?.(); acknowledged.delete(event);
        }
      };
      const emit = (event: object) => new Promise<void>(resolve => { acknowledged.set(event, resolve); stream.push(event); });
      void (async () => {
        await emit({ type: "start", partial: { ...final, content: [], stopReason: "pending", usage: undefined } });
        for (const text of textChunks ?? []) {
          if (options?.signal?.aborted) break;
          emittedChunks++;
          final = { ...final, content: [{ type: "text", text }] };
          await emit({ type: "text_delta", contentIndex: 0, delta: text, partial: { ...final, stopReason: "pending" } });
        }
        await options?.onProviderStreamEvent?.({ type: 'response.completed', response: { id: final.responseId,
          ...(final.usage ? { usage: { input_tokens: final.usage.input, output_tokens: final.usage.output, total_tokens: final.usage.totalTokens } } : {}) } }, _model);
        if (options?.signal?.aborted) final = { ...final, stopReason: "aborted" };
        stream.push({ type: "done", reason: final.stopReason, message: final });
      })().catch(error => stream.push({ type: 'error', reason: 'error', error: { ...final, stopReason: 'error', errorMessage: String(error) } }));
      return stream;
    },
  });
  return { runtime, observed, get emittedChunks() { return emittedChunks; } };
}
