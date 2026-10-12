import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import type { McpClient, CallToolResult } from '@earendil-works/pi-mcp';
import { connectMcp, type McpConfig } from '../../runtime/mcp.js';
import type { PublishingTarget } from '../../publishing/contracts.js';

const require = createRequire(import.meta.url);
export function browserProfileDir(rootDir: string, target: PublishingTarget): string {
  const base = resolve(rootDir, target.config.browser.userDataDir ?? '.inkos/browser');
  const component = (id: string) => Buffer.from(id).toString('base64url');
  return join(base, component(target.id), component(target.config.accountId));
}
export function playwrightMcpConfig(rootDir: string, target: PublishingTarget): McpConfig {
  const browser = target.config.browser;
  if (browser.mcp) return browser.mcp;
  const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
  const args = [cli, '--user-data-dir', browserProfileDir(rootDir, target)];
  if (browser.headless) args.push('--headless');
  if (browser.executablePath) args.push('--executable-path', browser.executablePath);
  args.push(...(browser.args ?? []));
  return { command: process.execPath, args, cwd: rootDir };
}
const clients = new Map<string, Promise<McpClient>>();
const queues = new Map<string, Promise<void>>();
const key = (root: string, target: PublishingTarget) => JSON.stringify([resolve(root), target.id, target.config.accountId]);
export async function targetBrowser(root: string, target: PublishingTarget): Promise<McpClient> {
  const id = key(root, target);
  let client = clients.get(id);
  if (!client) {
    client = (async () => {
      if (!target.config.browser.mcp) await mkdir(browserProfileDir(root, target), { recursive: true });
      return connectMcp(`browser-${target.id}`, playwrightMcpConfig(root, target));
    })();
    clients.set(id, client);
    client.catch(() => { if (clients.get(id) === client) clients.delete(id); });
  }
  return client;
}
export async function closeTargetBrowser(root: string, target: PublishingTarget): Promise<void> {
  const id = key(root, target), pending = clients.get(id);
  clients.delete(id);
  if (pending) await (await pending).close();
}
/** Serialize whole workflows, not just individual MCP calls. Other accounts/targets can progress independently. */
export async function withTargetBrowser<T>(root: string, target: PublishingTarget, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  const id = key(root, target), previous = queues.get(id) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  const pending = previous.then(() => tail);
  queues.set(id, pending);
  await previous;
  try { signal.throwIfAborted(); return await run(); }
  finally {
    try { await closeTargetBrowser(root, target); }
    finally { release(); if (queues.get(id) === pending) queues.delete(id); }
  }
}
export function mcpResultText(result: CallToolResult): string {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}
/** Decode the official Playwright MCP result section, without implementing any MCP wire protocol. */
export function playwrightResult<T>(result: CallToolResult): T {
  const text = mcpResultText(result);
  if (result.isError) throw new Error(text);
  const section = /### Result\s*\n([\s\S]*?)(?=\n### |$)/u.exec(text)?.[1]?.trim() ?? text.trim();
  return JSON.parse(section) as T;
}
export async function runBrowserCode<T>(root: string, target: PublishingTarget, code: string, signal: AbortSignal): Promise<T> {
  const client = await targetBrowser(root, target);
  return playwrightResult<T>(await client.callTool('browser_run_code', { code }, { signal }));
}
