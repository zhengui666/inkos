import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { toLlmContent } from '@earendil-works/pi-mcp';
import type { InkExtension } from '../../runtime/plugins.js';
import type { BrowserObservation } from '../../publishing/contracts.js';
import { BrowserRunDoc } from './documents.js';
import { targetBrowser } from './session.js';

const nullableText = Type.Union([Type.String(), Type.Null()]);
export const BrowserObservationSchema = Type.Object({
  state: Type.Union(['absent', 'draft', 'submitted', 'reviewing', 'rejected', 'published', 'user-action', 'unknown'].map(value => Type.Literal(value))),
  accountId: nullableText, remote: Type.Object({ workId: nullableText, artifactId: nullableText, authorUrl: nullableText, readerUrl: nullableText }),
  title: nullableText, body: nullableText, complete: Type.Boolean(), notApplied: Type.Boolean(), evidence: Type.String(),
});
export function createBrowserExtension(rootDir: string): InkExtension {
  const tools = [
    defineTool({
      name: 'inkos_browser_tools', description: 'List the actual MCP browser tools and their input schemas for this target/account.',
      parameters: Type.Object({}), replay: 'safe', executionMode: 'sequential',
      execute: async (_args, api, context) => {
        const run = await api.snapshot(BrowserRunDoc, api.conversationId, context);
        if (!run?.target) throw new Error('No distribution browser context');
        const client = await targetBrowser(rootDir, run.target);
        const tools = await client.listTools({ signal: context.abortSignal });
        return { content: [{ type: 'text', text: JSON.stringify(tools) }] };
      },
    }),
    defineTool({
      name: 'inkos_browser_call', description: 'Execute an actual MCP tool using its listed schema. Inspect the current UI; never blindly replay a mutation.',
      parameters: Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
      // Navigation, evaluation and run_code can change state. This dispatcher is never safe to replay.
      replay: 'unsafe', executionMode: 'sequential',
      execute: async (args, api, context) => {
        const run = await api.snapshot(BrowserRunDoc, api.conversationId, context);
        if (!run?.target) throw new Error('No distribution browser context');
        const client = await targetBrowser(rootDir, run.target);
        const result = await client.callTool(args.name, args.arguments, { signal: context.abortSignal });
        await api.commit(async tx => {
          const doc = await tx.doc(BrowserRunDoc, api.conversationId);
          doc.mcpCalls++;
        }, context);
        return { content: toLlmContent(result), isError: result.isError === true };
      },
    }),
    defineTool({
      name: 'inkos_browser_report', description: 'Finish with current observed account, real URL identities and exact title/body. A mutation acknowledgment is not observation. notApplied needs positive evidence, not an absent row.',
      parameters: BrowserObservationSchema, replay: 'safe', executionMode: 'sequential',
      execute: async (args, api, context) => {
        await api.commit(async tx => {
          const doc = await tx.doc(BrowserRunDoc, api.conversationId);
          if (!doc.mcpCalls) throw new Error('Use actual MCP browser tools before reporting');
          doc.report = { ...args, observedAt: Date.now() } as BrowserObservation;
        }, context);
        return { content: [{ type: 'text', text: 'Browser observation recorded.' }], control: { terminate: true } };
      },
    }),
  ];
  return defineExtension({
    name: 'inkos.browser', tools,
    sections: [section('browser-context', async (input, context) => {
      const run = await input.read.snapshot(BrowserRunDoc, input.conversationId, context);
      if (!run?.target) return undefined;
      return `Operate only this target/account: ${JSON.stringify(run.target)}\nMode: ${run.mode}; operation: ${run.operation}.\n`
        + 'First list actual MCP tools, then call them. Observe mode permits inspection/navigation only, never editor input, save, create, publish or confirm. '
        + 'Mutate mode permits the one retained intent, not repeated final actions. Read the UI dynamically; no invented selectors or IDs. '
        + 'Preserve prose exactly. Report user-action with the specific login/captcha/identity/payment/contract requirement; do not attempt those actions. Resume only after the user resolves it. Use the persistent session and never switch accounts. '
        + 'Finish using inkos_browser_report; unknown/incomplete evidence must remain unknown.\n' + run.target.config.skill;
    })],
  });
}
export { BrowserRunDoc } from './documents.js';
export * from './session.js';
export default (context: { rootDir: string }): InkExtension => createBrowserExtension(context.rootDir);
