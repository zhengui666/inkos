import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';

export type McpConfig = { command?: string; args?: string[]; url?: string; env?: Record<string, string>; cwd?: string };
export async function connectMcp(name: string, config: McpConfig): Promise<McpClient> {
  const client = new McpClient({ name: `inkos-${name}`, version: '2.0.0' });
  const transport = config.url ? new StreamableHttpTransport({ url: config.url }) : new StdioTransport({
    command: config.command ?? process.execPath, args: config.args ?? [], env: config.env, cwd: config.cwd,
  });
  await client.connect(transport); return client;
}
export async function mcpExtension(name: string, client: McpClient): Promise<Extension> {
  const tools = (await client.listTools()).map(tool => defineTool({
    name: `${name}_${tool.name}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
    description: tool.description ?? tool.name,
    parameters: Type.Unsafe({ ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} }),
    replay: tool.annotations?.readOnlyHint === true ? 'safe' as const : undefined,
    execute: async (args, _api, context) => {
      const result = await client.callTool(tool.name, args as Record<string, unknown>, { signal: context.abortSignal });
      return { content: toLlmContent(result), isError: result.isError === true };
    },
  }));
  return defineExtension({ name, tools });
}
