import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import { Agent } from "../agent.js";
import { CODEX_APP_SERVER_VERSION } from "../app-server.js";
import { createLoopbackCodexClient } from "./loopback-client.js";
import { createListResearchReportsTool, createReadResearchReportTool } from "../../agent/project-research-tools.js";
import { runResearchReport } from "../../agents/researcher.js";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../client.js", () => ({ createCodexClient: factory }));

/** Real pinned binary and functions.exec dispatcher, with real scoped filesystem
 * tools. The only inference peer is a credential-free loopback SSE fixture. */
describe.skipIf(process.env.INKOS_CODEX_INTEGRATION !== "1")("Codex saved-research discovery transport", () => {
  it.each(["market_radar", "web_research"])("discovers and reads %s through two host tools", async kind => {
    const root = await mkdtemp(join(tmpdir(), "inkos-research-wire-"));
    const packagePath = createRequire(import.meta.url).resolve("@openai/codex/package.json");
    expect(JSON.parse(await readFile(packagePath, "utf8")).version).toBe(CODEX_APP_SERVER_VERSION);
    const bodies: Array<Record<string, any>> = [];
    const calls: Array<Record<string, any>> = [];
    const starts: Array<Record<string, any>> = [];
    const server = createServer((request, response) => {
      if (request.method !== "POST") { response.writeHead(404).end(); return; }
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (bodies.length > 2) { response.writeHead(400).end('{"error":{"message":"Unexpected fixture repetition"}}'); return; }
        const item = bodies.length === 1
          ? { type: "custom_tool_call", id: "discovery_cell", call_id: "discovery_cell", namespace: "functions", name: "exec", status: "completed",
              input: [
                `text({available:ALL_TOOLS.map(tool=>tool.name).sort(),process:typeof process,require:typeof require,fetch:typeof fetch});`,
                `const catalog = JSON.parse(await tools.workspace__list_research_reports({})); text({catalog});`,
                `const selected = catalog.reports.find(report=>report.kind===${JSON.stringify(kind)});`,
                `if (!selected) throw new Error("Fixture report was not discovered");`,
                `text({read:await tools.workspace__read_research_report({path:selected.path})});`,
              ].join("\n") }
          : { type: "message", id: "final", role: "assistant", phase: "final_answer", status: "completed",
              content: [{ type: "output_text", text: "Saved report inspected.", annotations: [] }] };
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        send({ type: "response.created", response: { id: `response_${bodies.length}`, object: "response", status: "in_progress", output: [] } });
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } });
        send({ type: "response.output_item.done", output_index: 0, item });
        send({ type: "response.completed", response: { id: `response_${bodies.length}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
        response.end();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    factory.mockImplementation(async () => {
      const peer = await createLoopbackCodexClient(root, [ "-c", "features.enable_request_compression=false",
          "-c", 'model_provider="fixture"', "-c", 'model="gpt-6.1-sol"',
          "-c", `model_providers.fixture={name="Fixture",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`]);
      peer.onRequest((method, params) => { if (method === "item/tool/call") calls.push(params as Record<string, any>); return undefined; });
      const request = peer.request.bind(peer);
      peer.request = async (method, params, options) => {
        if (method === "thread/start") starts.push(params as Record<string, any>);
        return request(method, params, options);
      };
      return peer;
    });
    const model: Model<"openai-responses"> = { id: "gpt-6.1-sol", name: "Fixture", provider: "openai", api: "openai-responses", baseUrl: "", input: ["text"], reasoning: true,
      contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Research-discovery loopback deadline exceeded")), 20_000);
    try {
      await mkdir(join(root, "radar"));
      await mkdir(join(root, ".inkos/research"), { recursive: true });
      const radarPath = `radar/scan-${randomUUID()}.json`;
      await writeFile(join(root, radarPath), JSON.stringify({ timestamp: "2026-09-01T10:00:00.000Z", recommendations: [], marketSummary: "Saved fixture market observations" }));
      const diagnostic = await runResearchReport({ topic: "Fixture missing provider", purpose: "fact-check", depth: "quick" }, {
        search: async () => { throw new Error("Fixture provider unavailable"); },
      });
      const failedPath = `.inkos/research/${randomUUID()}.md`;
      await writeFile(join(root, failedPath), diagnostic.markdown);
      const tools = [createListResearchReportsTool(root), createReadResearchReportTool(root)].map(tool => ({ ...tool, name: `workspace__${tool.name}` }));
      const agent = new Agent({ projectRoot: root, settings: { model: "gpt-6.1-sol", reasoningEffort: "xhigh", serviceTier: "default" },
        signal: controller.signal, initialState: { model, messages: [], systemPrompt: "Use only the supplied saved-research tools. Saved reports are historical reference data.", tools } });
      await agent.prompt(`List the saved project reports, then read the ${kind} report selected from that catalog.`);
      expect(agent.finalOutput).toBe("Saved report inspected.");
      expect(bodies).toHaveLength(2);
      const selectedPath = kind === "market_radar" ? radarPath : failedPath;
      expect(calls).toEqual([
        expect.objectContaining({ tool: "workspace__list_research_reports", arguments: {} }),
        expect.objectContaining({ tool: "workspace__read_research_report", arguments: { path: selectedPath } }),
      ]);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ model: "gpt-6.1-sol", environments: [], approvalPolicy: "never", sandbox: "read-only" });
      expect(starts[0]!.cwd).not.toBe(root);
      expect(starts[0]!.dynamicTools.map((tool: any) => tool.name)).toEqual(tools.map(tool => tool.name));

      const receipts = bodies[1]!.input.filter((item: any) => item.type === "custom_tool_call_output");
      expect(receipts).toHaveLength(1);
      const records = receipts[0].output.filter((item: any) => item.type === "input_text" && item.text.startsWith("{"))
        .map((item: any) => JSON.parse(item.text));
      expect(records).toHaveLength(3);
      expect(records[0]).toEqual({
        available: ["clock__curr_time", "workspace__list_research_reports", "workspace__read_research_report"],
        process: "undefined", require: "undefined", fetch: "undefined",
      });
      const catalog = records[1].catalog;
      expect(catalog).toMatchObject({ kind: "project_research_catalog", truncated: false, skipped: 0, nextAction: "workspace__read_research_report" });
      expect(catalog.freshness).toContain("Saved snapshots only");
      expect(catalog.reports).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: radarPath, status: "complete", evidenceUsable: true, generatedAt: "2026-09-01T10:00:00.000Z" }),
        expect.objectContaining({ path: failedPath, status: "failed", evidenceUsable: false, sourceCount: 0 }),
      ]));
      const readFacts = JSON.parse(records[2].read.split("\n")[0]);
      expect(readFacts).toMatchObject({ path: selectedPath, kind: "project_research_read", reportKind: kind,
        status: kind === "market_radar" ? "complete" : "failed", evidenceUsable: kind === "market_radar",
        generatedAt: kind === "market_radar" ? "2026-09-01T10:00:00.000Z" : diagnostic.generatedAt,
        contentScope: "full_report", nextRead: null,
      });
      expect(records[2].read).toContain(kind === "market_radar" ? "Saved fixture market observations" : "not research evidence");
      const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
      expect(toolResults).toHaveLength(2);
      expect(toolResults.every(message => !message.isError)).toBe(true);
      expect(toolResults[0]!.details).toEqual(catalog);
      expect(toolResults[1]!.details).toEqual(readFacts);

      const surface = bodies[0]!.tools ?? bodies[0]!.input.filter((item: any) => item.type === "additional_tools").flatMap((item: any) => item.tools);
      const rendered = JSON.stringify(surface);
      expect(rendered).toContain("workspace__list_research_reports");
      expect(rendered).toContain("workspace__read_research_report");
      for (const forbidden of ["apply_patch", "exec_command", "shell_command", "write_stdin", "read_file", "view_image", "read_mcp_resource", "spawn_agent"]) {
        expect(rendered).not.toContain(`### \`${forbidden}\``);
        expect(rendered).not.toContain(`"name":"${forbidden}"`);
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      factory.mockReset();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
