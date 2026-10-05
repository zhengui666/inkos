import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { Agent } from "../agent.js";
import { createLoopbackCodexClient } from "./loopback-client.js";
import { resolveCodexModel } from "../model.js";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../client.js", () => ({ createCodexClient: factory }));

/** The pinned binary uses a temporary Codex home and credential-free loopback
 * responses. This verifies runtime mechanics, not model compaction quality. */
describe.skipIf(process.env.INKOS_CODEX_INTEGRATION !== "1")("Codex native compaction bridge", () => {
  it.each(["local", "remote"])("continues an ephemeral turn after native %s tool-loop compaction", async mode => {
    const root = await mkdtemp(join(tmpdir(), "inkos-native-compaction-"));
    const bodies: Array<Record<string, any>> = [];
    const compactionEvents: string[] = [];
    const server = createServer((request, response) => {
      if (request.method !== "POST") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (bodies.length > 3) {
          response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Unexpected extra fixture request" } }));
          return;
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        const item = bodies.length === 1
          ? { type: "function_call", id: "fc_read", call_id: "read-1", name: "inspect", arguments: "{}", status: "completed" }
          : bodies.length === 2 && mode === "remote"
            ? { type: "compaction", id: "compact-1", encrypted_content: "fixture-native-compaction" }
          : { type: "message", id: `text-${bodies.length}`, role: "assistant", phase: "final_answer", status: "completed",
            content: [{ type: "output_text", text: bodies.length === 2 ? "Native summary: the witness remains outside." : "Validated after compaction.", annotations: [] }] };
        send({ type: "response.created", response: { id: `resp_${bodies.length}`, object: "response", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } });
        send({ type: "response.output_item.done", output_index: 0, item });
        const inputTokens = bodies.length === 1 ? 6000 : 100;
        send({ type: "response.completed", response: { id: `resp_${bodies.length}`, object: "response", status: "completed", output: [item],
          usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 } } });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    factory.mockImplementation(async () => {
      const peer = await createLoopbackCodexClient(root, [ "-c", "features.enable_request_compression=false",
          "-c", 'model_provider="fixture"', "-c", 'model="gpt-5.3-codex"',
          "-c", "model_context_window=10000", "-c", "model_auto_compact_token_limit=5000",
          "-c", `model_providers.fixture={name="${mode === "remote" ? "OpenAI" : "Fixture"}",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`]);
      peer.onNotification((method, params) => {
        const item = (params as { item?: { type?: string } }).item;
        if (item?.type === "contextCompaction") compactionEvents.push(method);
      });
      return peer;
    });
    const inspect = vi.fn(async () => ({ content: [{ type: "text" as const, text: "The witness remains outside." }], details: {} }));
    const agent = new Agent({ projectRoot: root, signal: AbortSignal.timeout(20_000),
      settings: { reasoningEffort: "medium", serviceTier: "default" },
      initialState: { model: resolveCodexModel(), systemPrompt: "Use the supplied observation to validate continuity.", messages: [],
        tools: [{ name: "inspect", label: "Inspect", description: "Read the current story state", parameters: Type.Object({}), execute: inspect }] } });
    try {
      await agent.prompt("Inspect the state and report the result.");
      expect(bodies).toHaveLength(3);
      expect(inspect).toHaveBeenCalledOnce();
      expect(compactionEvents).toEqual(["item/started", "item/completed"]);
      expect(JSON.stringify(bodies[1]!.input)).toContain("The witness remains outside.");
      expect(JSON.stringify(bodies[2]!.input)).toContain(mode === "remote" ? "fixture-native-compaction" : "Native summary: the witness remains outside.");
      if (mode === "remote") expect(bodies[1]!.input.at(-1)).toMatchObject({ type: "compaction_trigger" });
      expect(agent.finalOutput).toBe("Validated after compaction.");
      expect(agent.state.messages.filter(message => message.role === "toolResult")).toHaveLength(1);
    } finally {
      factory.mockReset();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
