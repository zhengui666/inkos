import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { PublishingTarget } from '../../../publishing/contracts.js';
import { emptyMapping } from '../../../publishing/contracts.js';
import { targetBrowser, withTargetBrowser, runBrowserCode, mcpResultText } from '../../browser/session.js';

async function localBrowser<T>(run: (root: string, target: PublishingTarget, signal: AbortSignal) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-official-mcp-'));
  const target: PublishingTarget = { id: 'local-check', workId: 'local-content', platform: 'browser', label: 'Local browser check', enabled: true,
    conversationId: 0, createdAt: 1, updatedAt: 1, config: { accountId: 'local', entryUrl: 'about:blank',
      remote: emptyMapping(), skill: '', metadata: {}, browser: { headless: true,
        args: ['--browser', 'chromium', '--no-sandbox'], ...((process.env.INKOS_BROWSER_EXECUTABLE || existsSync('/usr/bin/google-chrome-stable')) ? { executablePath: process.env.INKOS_BROWSER_EXECUTABLE ?? '/usr/bin/google-chrome-stable' } : {}) } } };
  const signal = AbortSignal.timeout(30_000);
  try { return await withTargetBrowser(root, target, signal, () => run(root, target, signal)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
it('connects to the actual installed Playwright MCP and discovers its real tools through pi-mcp', async () => {
  await localBrowser(async (root, target, signal) => {
    const client = await targetBrowser(root, target);
    const tools = await client.listTools({ signal });
    expect(tools.some(tool => tool.name === 'browser_run_code')).toBe(true);
    expect(tools.some(tool => tool.name === 'browser_navigate')).toBe(true);
    expect(tools.find(tool => tool.name === 'browser_run_code')?.annotations?.readOnlyHint).toBe(false);
  });
}, 35_000);
// This check requires an installed browser. It never navigates to a platform or invokes a model.
it('executes actual MCP browser tools on about:blank and standard HTML content', async () => {
  await localBrowser(async (root, target, signal) => {
    const client = await targetBrowser(root, target);
    const navigation = await client.callTool('browser_navigate', { url: 'about:blank' }, { signal });
    expect(navigation.isError, mcpResultText(navigation)).not.toBe(true);
    const result = await runBrowserCode<{ url: string; heading: string; body: string }>(root, target,
      `async (page) => {
        await page.setContent('<main><h1>Browser check</h1><p>Standard paragraph.</p></main>');
        return {url:page.url(), heading:await page.locator('h1').innerText(), body:await page.locator('p').innerText()};
      }`, signal);
    expect(result).toEqual({ url: 'about:blank', heading: 'Browser check', body: 'Standard paragraph.' });
  });
}, 35_000);
