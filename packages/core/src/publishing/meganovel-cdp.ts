import { mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { z } from 'zod';
import { publishingError } from './contracts.js';
import { MegaNovelProbeSchema, MegaNovelScopeSchema, type MegaNovelBrowserPort,
  type MegaNovelProbe, type MegaNovelScope, type MegaNovelBrowserOptions } from './meganovel-contracts.js';

/** DOM functions must be implemented from an authorized observation of the current official UI.
 * This type is NOT a supplied MegaNovel DOM implementation. There is deliberately no guessed profile.
 * A binding owns navigation, checks every final preview and must never retry editor/publish mutations.
 */
export interface MegaNovelDomBinding {
  readonly protocol: 'inkos-meganovel-dom-v1';
  readonly calibration: {observedAt: string; evidence: string};
  probe(page: Page, scope: MegaNovelScope, signal: AbortSignal): Promise<MegaNovelProbe>;
  snapshot(page: Page, input: Parameters<MegaNovelBrowserPort['snapshot']>[0], signal: AbortSignal): ReturnType<MegaNovelBrowserPort['snapshot']>;
  createDraft(page: Page, input: Parameters<MegaNovelBrowserPort['createDraft']>[0], signal: AbortSignal): Promise<void>;
  submit(page: Page, input: Parameters<MegaNovelBrowserPort['submit']>[0], signal: AbortSignal): Promise<void>;
}

const AuthorizationEvidence = z.object({
  provenance: z.enum(['user_reported', 'platform_document']),
  reference: z.string().trim().min(1).max(8000),
}).strict();
const ConfigurationSchema = z.object({
  endpointURL: z.string(),
  scope: MegaNovelScopeSchema,
  // One shared path for every InkOS process that may access this browser. A crash leaves it locked.
  lockDirectory: z.string().refine(isAbsolute, 'Use an absolute browser-lock directory.'),
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
  operationTimeoutMs: z.number().int().min(100).max(300000).default(30000),
  // Neither a logged-in tab nor an absent AI checkbox establishes these permissions.
  authorization: z.object({automation: AuthorizationEvidence, aiAssistedContent: AuthorizationEvidence}).strict(),
}).strict();
export type MegaNovelCdpConfiguration = z.input<typeof ConfigurationSchema>;

/** No launch flags, endpoint discovery, cookie extraction, new profile, authentication or security changes. */
export function validateMegaNovelCdpEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw publishingError('MEGANOVEL_CDP_CONFIG', 'Configure an existing authorized loopback CDP endpoint.'); }
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.port || url.username || url.password || url.search || url.hash
    || (url.protocol === 'http:' && url.pathname !== '/')
    || (url.protocol === 'ws:' && !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(url.pathname))) {
    throw publishingError('MEGANOVEL_CDP_CONFIG', 'Use an explicit numeric loopback CDP endpoint without credentials or query.');
  }
  return url.href;
}

function assertBinding(binding: MegaNovelDomBinding | undefined): asserts binding is MegaNovelDomBinding {
  if (!binding || binding.protocol !== 'inkos-meganovel-dom-v1'
    || !z.string().datetime({offset: true}).safeParse(binding.calibration?.observedAt).success
    || !binding.calibration?.evidence?.trim()
    || !['probe', 'snapshot', 'createDraft', 'submit'].every(key => typeof binding[key as keyof MegaNovelDomBinding] === 'function')) {
    throw publishingError('MEGANOVEL_BINDING_MISSING', 'No current, calibrated MegaNovel DOM implementation is installed. Automatic submission remains unavailable.');
  }
}

/** Concrete Playwright transport. Deploying this transport alone does not supply the missing DOM binding. */
export async function connectMegaNovelCdpPort(configuration: MegaNovelCdpConfiguration,
  binding?: MegaNovelDomBinding): Promise<MegaNovelBrowserPort & {close(): Promise<void>}> {
  assertBinding(binding); // Fail before any browser access when deployment is incomplete.
  const config = ConfigurationSchema.parse(configuration);
  const endpointURL = validateMegaNovelCdpEndpoint(config.endpointURL);
  if (!/^[A-Za-z0-9-]+$/u.test(config.scope.sessionId)) throw publishingError('MEGANOVEL_CDP_CONFIG', 'Use the actual CDP target ID.');
  await mkdir(config.lockDirectory, {recursive: true});
  const lockPath = join(config.lockDirectory, `${config.scope.sessionId}.lock`);
  try {
    const lock = await open(lockPath, 'wx', 0o600);
    try { await lock.writeFile(JSON.stringify({pid: process.pid, createdAt: new Date().toISOString()})); }
    finally { await lock.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw publishingError('MEGANOVEL_BROWSER_BUSY', 'This browser target is reserved. A stale lock needs explicit reconciliation; it is never stolen.');
    }
    throw error;
  }
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(endpointURL, {timeout: config.timeoutMs, noDefaults: true});
    const page = await findTargetBeforeDeadline(browser, config.scope.sessionId, config.operationTimeoutMs);
    if (!page) throw publishingError('MEGANOVEL_BROWSER_TARGET_MISSING', 'The configured browser target is gone. Do not substitute another tab.');
    page.setDefaultTimeout(config.operationTimeoutMs);
    page.setDefaultNavigationTimeout(config.operationTimeoutMs);
    const port = new MegaNovelCdpPort(browser, page, binding, config.scope, lockPath, config.operationTimeoutMs);
    await port.probe(config.scope);
    return port;
  } catch (error) {
    // Playwright disconnects a connectOverCDP client; it does not terminate the pre-existing Chrome.
    if (browser) await browser.close().catch(() => undefined);
    await unlink(lockPath);
    throw error;
  }
}

async function findTarget(browser: Browser, targetId: string): Promise<Page | undefined> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      // CDP transport identity only: no website internals, network payloads or browser credentials.
      const session = await context.newCDPSession(page);
      try {
        const info = await session.send('Target.getTargetInfo');
        if (info.targetInfo.targetId === targetId) return page;
      } finally { await session.detach(); }
    }
  }
  return undefined;
}

async function findTargetBeforeDeadline(browser: Browser, targetId: string, timeoutMs: number) {
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      void browser.close().then(() => reject(publishingError('MEGANOVEL_BROWSER_TIMEOUT',
        'Browser target discovery timed out and the CDP client disconnected.')), reject);
    }, timeoutMs);
  });
  try { return await Promise.race([findTarget(browser, targetId), deadline]); }
  finally {
    clearTimeout(timer!);
    if (expired) await browser.close();
  }
}

class MegaNovelCdpPort implements MegaNovelBrowserPort {
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private poisoned = false;
  constructor(private readonly browser: Browser, private readonly page: Page,
    private readonly binding: MegaNovelDomBinding, private readonly scope: MegaNovelScope,
    private readonly lockPath: string, private readonly operationTimeoutMs: number) {}

  probe(scope: MegaNovelScope, options: MegaNovelBrowserOptions = {}) { return this.serial(signal => this.check(scope, signal), options.signal); }
  snapshot(input: Parameters<MegaNovelBrowserPort['snapshot']>[0], options: MegaNovelBrowserOptions = {}) {
    return this.serial(async signal => { await this.check(input.scope, signal); return this.binding.snapshot(this.page, input, signal); }, options.signal);
  }
  createDraft(input: Parameters<MegaNovelBrowserPort['createDraft']>[0], options: MegaNovelBrowserOptions = {}) {
    return this.serial(async signal => { await this.check(input.scope, signal); await this.binding.createDraft(this.page, input, signal); }, options.signal);
  }
  submit(input: Parameters<MegaNovelBrowserPort['submit']>[0], options: MegaNovelBrowserOptions = {}) {
    return this.serial(async signal => { await this.check(input.scope, signal); await this.binding.submit(this.page, input, signal); }, options.signal);
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    await this.queue;
    await this.browser.close(); // Disconnects this CDP client, not the user's Chrome process.
    await unlink(this.lockPath);
  }
  private serial<T>(fn: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
    if (this.closing || this.poisoned) return Promise.reject(publishingError('MEGANOVEL_BROWSER_CLOSED', 'This browser transport is closed or requires reconnection.'));
    const operation = this.queue.then(async () => {
      parentSignal?.throwIfAborted();
      if (this.poisoned) throw publishingError('MEGANOVEL_BROWSER_CLOSED', 'An earlier operation timed out. Reconnect for readback only.');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          this.poisoned = true;
          controller.abort();
          // Do not return a timeout while the old Page can still issue browser commands.
          void this.browser.close().then(() => reject(publishingError('MEGANOVEL_BROWSER_TIMEOUT',
            'The CDP client disconnected after a timeout. Outcome remains unknown; reconnect for readback only.')), reject);
        }, this.operationTimeoutMs);
      });
      const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
      try { return await Promise.race([fn(signal), timeout]); }
      finally {
        clearTimeout(timer!);
        if (this.poisoned) await this.browser.close();
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private async check(scope: MegaNovelScope, signal: AbortSignal): Promise<MegaNovelProbe> {
    signal.throwIfAborted();
    if (JSON.stringify(scope) !== JSON.stringify(this.scope) || !this.browser.isConnected() || this.page.isClosed()) {
      throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The configured browser target/account/book is unavailable or changed.');
    }
    if (new URL(this.page.url()).origin !== 'https://www.meganovel.com') {
      throw publishingError('MEGANOVEL_BROWSER_BLOCKED', 'The tab is outside the observed official MegaNovel origin.');
    }
    const probe = MegaNovelProbeSchema.parse(await this.binding.probe(this.page, scope, signal));
    signal.throwIfAborted();
    if (JSON.stringify(probe.scope) !== JSON.stringify(scope)) throw publishingError('MEGANOVEL_SCOPE_CHANGED', 'The observed account/book changed.');
    if (probe.blocker !== 'none') throw publishingError('MEGANOVEL_BROWSER_BLOCKED', `Stop at ${probe.blocker}; do not bypass it.`);
    return probe;
  }
}
