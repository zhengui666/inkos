import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createLoopbackCodexClient } from "./loopback-client.js";
import { runWorkerAgentTool } from "../../agent/worker-agent.js";
import { prepareWorkerInput } from "../../agents/base.js";
import { RadarResultToolSchema } from "../../agents/radar-tool.js";
import type { LLMClient } from "../../llm/provider.js";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../client.js", () => ({ createCodexClient: factory }));

/** The actual pinned binary connects only to a credential-free loopback peer.
 * Unlike transport mocks, this verifies outputSchema reaches Responses text.format,
 * and real App Server final-item notifications reach the host's domain validator. */
describe.skipIf(process.env.INKOS_CODEX_INTEGRATION !== "1")("Codex native structured worker transport", () => {
  it.each(["radar", "open-schema", "dynamic", "large-input"])("validates %s through the production worker", async mode => {
    const root = await mkdtemp(join(tmpdir(), "inkos-worker-wire-"));
    const bodies: Array<Record<string, any>> = [];
    const dynamicCalls: unknown[] = [];
    const value = mode === "radar"
      ? { recommendations: [{ platform: "qidian", genre: "fantasy", concept: "A clockmaker", reasoning: "Based on Fixture ranking", benchmarkTitles: ["Fixture ranking"] }], marketSummary: "Evidence from Fixture ranking" }
      : { value: { flag: true, count: 1, text: "1", absent: null }, optional: "present" };
    const tool = mode === "radar" ? "submit_market_radar" : "submit_open_result";
    const server = createServer((request, response) => {
      if (request.method !== "POST") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        const dynamic = mode === "dynamic" && bodies.length === 1;
        const final = { type: "message", id: "result", role: "assistant", phase: "final_answer", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify({ resultJson: JSON.stringify(value) }), annotations: [] }] };
        const item = dynamic ? { type: "function_call", id: "fc_result", call_id: "call_result", name: tool, arguments: JSON.stringify(value), status: "completed" } : final;
        send({ type: "response.created", response: { id: `resp_${bodies.length}`, object: "response", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } });
        send({ type: "response.output_item.done", output_index: 0, item });
        send({ type: "response.completed", response: { id: `resp_${bodies.length}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    factory.mockImplementation(async () => {
      const peer = await createLoopbackCodexClient(root, [ "-c", "features.enable_request_compression=false",
        "-c", 'model_provider="fixture"', "-c", 'model="gpt-5.3-codex"',
        "-c", `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`]);
      peer.onRequest((method, params) => { if (method === "item/tool/call") dynamicCalls.push(params); return undefined; });
      return peer;
    });
    const client: LLMClient = { provider: "openai", apiFormat: "chat", stream: false,
      defaults: { temperature: 0.7, maxTokens: 4096, thinkingBudget: 0, extra: {} },
      _codex: { projectRoot: root, settings: { reasoningEffort: "medium", serviceTier: "default" } } };
    const validate = vi.fn((parameters: unknown) => parameters);
    try {
      const source = mode === "large-input" ? "原".repeat(119500) : "Analyze Fixture ranking and return the requested result.";
      const prepared = await prepareWorkerInput({ client }, [{ role: "user", content: source }], 4096, "fixture", false);
      const result = await runWorkerAgentTool(client, "ignored", prepared.messages, {
        name: tool, label: "Result", description: "Submit result", validate: validate as never,
        parameters: mode === "radar" ? RadarResultToolSchema : Type.Object({ value: Type.Record(Type.String(), Type.Unknown()), optional: Type.Optional(Type.String()) }),
      }, { timeoutMs: 20_000 });
      expect(result).toEqual(value);
      expect(JSON.stringify(bodies[0]!.input)).toContain(source);
      if (mode === "large-input") {
        expect(prepared.inputTokens).toBeGreaterThan(117760);
        expect(prepared.budgetTokens).toBeUndefined();
      }
      expect(validate).toHaveBeenCalledExactlyOnceWith(value);
      expect(bodies[0]!.text.format).toMatchObject({ type: "json_schema", strict: true,
        schema: { required: ["resultJson"], additionalProperties: false } });
      // Catalog models can use top-level tools or the additional_tools surface.
      const surface = bodies[0]!.tools ?? bodies[0]!.input.filter((item: any) => item.type === "additional_tools");
      expect(JSON.stringify(surface)).toContain(tool);
      if (mode === "dynamic") expect(dynamicCalls).toEqual([expect.objectContaining({ tool, arguments: value })]);
      else { expect(bodies).toHaveLength(1); expect(dynamicCalls).toHaveLength(0); }
    } finally {
      factory.mockReset();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
