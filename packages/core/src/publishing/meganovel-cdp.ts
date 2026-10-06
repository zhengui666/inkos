import { isAbsolute } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { z } from 'zod';
import { publishingError } from './contracts.js';
import { acquireMegaNovelCdpLock } from './meganovel-cdp-lock.js';
import { MegaNovelProbeSchema, MegaNovelScopeSchema, MegaNovelSnapshotRequestSchema, type MegaNovelBrowserPort,
  type MegaNovelProbe, type MegaNovelScope, type MegaNovelBrowserOptions, type MegaNovelSnapshotRequest, type MegaNovelSnapshot } from './meganovel-contracts.js';

/** DOM functions must be implemented from an authorized observation of the current official UI.
 * This type is NOT a supplied MegaNovel DOM implementation. There is deliberately no guessed profile.
 * A binding owns navigation, checks every final preview and must never retry editor/publish mutations.
 */
export interface MegaNovelDomBinding {
  readonly protocol: 'inkos-meganovel-dom-v1';
  readonly calibration: {observedAt: string; evidence: string};
  probe(page: Page, scope: MegaNovelScope, signal: AbortSignal): Promise<MegaNovelProbe>;
  /** Optional additive capability; legacy dom-v1 modules keep their original snapshot contract. */
  observeSnapshot?(page: Page, input: MegaNovelSnapshotRequest, signal: AbortSignal): Promise<MegaNovelSnapshot>;
  snapshot(page: Page, input: Parameters<MegaNovelBrowserPort['snapshot']>[0], signal: AbortSignal): ReturnType<MegaNovelBrowserPort['snapshot']>;
  createDraft(page: Page, input: Parameters<MegaNovelBrowserPort['createDraft']>[0], signal: AbortSignal): Promise<void>;
  submit(page: Page, input: Parameters<MegaNovelBrowserPort['submit']>[0], signal: AbortSignal): Promise<void>;
}

const AuthorizationEvidence = z.object({
  provenance: z.enum(['user_reported', 'platform_document']),
  reference: z.string().trim().min(1).max(8000),
}).strict();
export const MegaNovelCdpConfigurationSchema = z.object({
  endpointURL: z.string(),
  scope: MegaNovelScopeSchema,
  // One shared path for every InkOS process that may access this browser. The SQLite lifetime lock is released by the OS on a crash.
  lockDirectory: z.string().refine(isAbsolute, 'Use an absolute browser-lock directory.'),
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
  operationTimeoutMs: z.number().int().min(100).max(300000).default(30000),
  // Neither a logged-in tab nor an absent AI checkbox establishes these permissions.
  authorization: z.object({automation: AuthorizationEvidence, aiAssistedContent: AuthorizationEvidence}).strict(),
}).strict();
export type MegaNovelCdpConfiguration = z.input<typeof MegaNovelCdpConfigurationSchema>;

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
  binding?: MegaNovelDomBinding): Promise<MegaNovelBrowserPort & {observeSnapshot(input: MegaNovelSnapshotRequest, options?: MegaNovelBrowserOptions): Promise<MegaNovelSnapshot>; close(): Promise<void>}> {
  assertBinding(binding); // Fail before any browser access when deployment is incomplete.
  const config = MegaNovelCdpConfigurationSchema.parse(configuration);
  const endpointURL = validateMegaNovelCdpEndpoint(config.endpointURL);
  if (!/^[A-Za-z0-9-]+$/u.test(config.scope.sessionId)) throw publishingError('MEGANOVEL_CDP_CONFIG', 'Use the actual CDP target ID.');
  const reservation = acquireMegaNovelCdpLock(config.lockDirectory, config.scope.sessionId);
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(endpointURL, {timeout: config.timeoutMs, noDefaults: true});
    const page = await findTargetBeforeDeadline(browser, config.scope.sessionId, config.operationTimeoutMs);
    if (!page) throw publishingError('MEGANOVEL_BROWSER_TARGET_MISSING', 'The configured browser target is gone. Do not substitute another tab.');
    page.setDefaultTimeout(config.operationTimeoutMs);
    page.setDefaultNavigationTimeout(config.operationTimeoutMs);
    const port = new MegaNovelCdpPort(browser, page, binding, config.scope, reservation, config.operationTimeoutMs);
    await port.probe(config.scope);
    return port;
  } catch (error) {
    // Playwright disconnects a connectOverCDP client; it does not terminate the pre-existing Chrome.
    try {
      if (browser) await disconnectAndRelease(browser, reservation);
      else reservation.release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'CDP startup failed; browser cleanup also failed.');
    }
    throw error;
  }
}

type BrowserReservation = ReturnType<typeof acquireMegaNovelCdpLock>;
// Keep ownership strongly reachable if Playwright cannot confirm disconnection.
// Never let garbage collection turn a cleanup failure into a second live owner.
const quarantined = new Set<BrowserReservation>();
async function disconnectAndRelease(browser: Browser, reservation: BrowserReservation): Promise<void> {
  try { await browser.close(); }
  finally {
    if (!browser.isConnected()) {
      quarantined.delete(reservation);
      reservation.release();
    } else if (!quarantined.has(reservation)) {
      quarantined.add(reservation);
      browser.once('disconnected', () => {
        quarantined.delete(reservation);
        try { reservation.release(); }
        catch { // The SQLite lock was released; a leftover marker is recoverable.
          process.emitWarning('CDP disconnected but its ownership marker could not be removed.');
        }
      });
    }
  }
  if (browser.isConnected()) throw publishingError('MEGANOVEL_BROWSER_BUSY', 'CDP disconnection is unconfirmed; browser ownership is retained.');
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
  private closePromise?: Promise<void>;
  private poisoned = false;
  constructor(private readonly browser: Browser, private readonly page: Page,
    private readonly binding: MegaNovelDomBinding, private readonly scope: MegaNovelScope,
    private readonly reservation: BrowserReservation, private readonly operationTimeoutMs: number) {}

  probe(scope: MegaNovelScope, options: MegaNovelBrowserOptions = {}) { return this.serial(signal => this.check(scope, signal), options.signal); }
  snapshot(input: Parameters<MegaNovelBrowserPort['snapshot']>[0], options: MegaNovelBrowserOptions = {}) {
    return this.serial(async signal => { await this.check(input.scope, signal); return this.binding.snapshot(this.page, input, signal); }, options.signal);
  }
  observeSnapshot(input: MegaNovelSnapshotRequest, options: MegaNovelBrowserOptions = {}) {
    return this.serial(async signal => {
      const request = MegaNovelSnapshotRequestSchema.parse(input);
      if (!this.binding.observeSnapshot) throw publishingError('MEGANOVEL_OBSERVATION_UNSUPPORTED', 'This binding has no package-free observation capability.');
      await this.check(request.scope, signal);
      return this.binding.observeSnapshot(this.page, request, signal);
    }, options.signal);
  }
  createDraft(input: Parameters<MegaNovelBrowserPort['createDraft']>[0], options: MegaNovelBrowserOptions = {}) {
    return this.serial(async signal => { await this.check(input.scope, signal); await this.binding.createDraft(this.page, input, signal); }, options.signal);
  }
  submit(input: Parameters<MegaNovelBrowserPort['submit']>[0], options: MegaNovelBrowserOptions = {}) {
    return this.serial(async signal => { await this.check(input.scope, signal); await this.binding.submit(this.page, input, signal); }, options.signal);
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closePromise ??= (async () => {
      await this.queue;
      await disconnectAndRelease(this.browser, this.reservation);
    })().catch(error => { this.closePromise = undefined; throw error; });
  }
  private serial<T>(fn: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
    if (this.closing || this.poisoned) return Promise.reject(publishingError('MEGANOVEL_BROWSER_CLOSED', 'This browser transport is closed or requires reconnection.'));
    const operation = this.queue.then(async () => {
      parentSignal?.throwIfAborted();
      if (this.poisoned) throw publishingError('MEGANOVEL_BROWSER_CLOSED', 'An earlier operation was interrupted. Reconnect for readback only.');
      const controller = new AbortController();
      let disconnecting: Promise<void> | undefined;
      const stop = (reason: unknown) => {
        this.poisoned = true;
        controller.abort(reason);
        return disconnecting ??= this.browser.close().then(() => {
          if (this.browser.isConnected()) throw publishingError('MEGANOVEL_BROWSER_BUSY', 'CDP disconnection is unconfirmed; browser ownership is retained.');
        });
      };
      let timer: ReturnType<typeof setTimeout>;
      let onAbort: (() => void) | undefined;
      const interruption = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = publishingError('MEGANOVEL_BROWSER_TIMEOUT',
            'The CDP client disconnected after a timeout. Outcome remains unknown; reconnect for readback only.');
          void stop(error).then(() => reject(error), reject);
        }, this.operationTimeoutMs);
        if (parentSignal) {
          onAbort = () => { void stop(parentSignal.reason).then(() => reject(parentSignal.reason), reject); };
          parentSignal.addEventListener('abort', onAbort, {once: true});
        }
      });
      try { return await Promise.race([fn(controller.signal), interruption]); }
      finally {
        clearTimeout(timer!);
        if (onAbort) parentSignal!.removeEventListener('abort', onAbort);
        // A cooperative binding may reject before close completes. Do not return
        // cancellation/timeout while its old Page could still issue commands.
        if (disconnecting) await disconnecting;
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
