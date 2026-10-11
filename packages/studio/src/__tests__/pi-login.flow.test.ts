import { once } from "node:events";
import { createServer, request as nodeHttpRequest, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeEpisodeStore, PiAccountService, createCodexAccountService, projectRunHistory, readAgentSettings, readTranscriptEvents, updateAgentSettings } from "@actalk/inkos-core";
import { CodexFixture } from "../../../core/src/__tests__/codex-fixture.js";
import type { StudioPiLoginAttempt as Attempt, StudioPiCloseResult as CloseResult } from "../shared/agent-configuration";
import type { AgentConfigurationSnapshot } from "../hooks/agent-configuration-controller";
import { startStudioServer } from "../api/server.js";
import { loadPiNativeAuthStorage } from "../../../core/src/runtime/auth/pi-native-store-compat.js";

// Vitest 3 lacks import.meta.resolve. Forward the unmodified compatibility
// module through Node; this is not a deployment proof or service contract shim.
vi.mock("../../../core/src/runtime/auth/pi-native-store-compat.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("../../../core/src/runtime/auth/pi-native-store-compat.ts");
});
interface Slot { dependencies?: readonly unknown[]; value?: unknown; cleanup?: () => void; subscribe?: unknown }
interface Frame { cursor: number; slots: Slot[]; effects: (() => void)[]; mounted: boolean; schedule(): void; snapshot?: () => AgentConfigurationSnapshot }
const reactBoundary = vi.hoisted(() => {
  let active: Frame | undefined;
  return { enter: (frame: Frame) => { active = frame; }, leave: () => { active = undefined; },
    current: () => { if (!active) throw new Error("React scheduling boundary is inactive"); return active; } };
});
// Only React scheduling is simulated. Real Page/Panel/Card event handlers,
// the no-argument hook singleton, controller and transport are unchanged.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...actual,
    useState: <T>(initial: T | (() => T)) => {
      const frame = reactBoundary.current(), index = frame.cursor++;
      const slot = frame.slots[index] ?? (frame.slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial });
      return [slot.value as T, (value: T | ((previous: T) => T)) => {
        if (!frame.mounted) return; slot.value = typeof value === "function" ? (value as (previous: T) => T)(slot.value as T) : value; frame.schedule();
      }] as const;
    },
    useRef: <T>(value: T) => { const frame = reactBoundary.current(), index = frame.cursor++; return (frame.slots[index] ?? (frame.slots[index] = { value: { current: value } })).value as { current: T }; },
    useMemo: <T>(create: () => T, dependencies?: readonly unknown[]) => {
      const frame = reactBoundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (!old || !same(old.dependencies, dependencies)) frame.slots[index] = { dependencies, value: create() };
      return frame.slots[index]!.value as T;
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const frame = reactBoundary.current(), index = frame.cursor++, old = frame.slots[index]; if (old && same(old.dependencies, dependencies)) return;
      const slot: Slot = { dependencies }; frame.slots[index] = slot;
      frame.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); if (cleanup) slot.cleanup = cleanup; });
    },
    useSyncExternalStore: <T>(subscribe: (notify: () => void) => () => void, getSnapshot: () => T): T => {
      const frame = reactBoundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (old?.subscribe !== subscribe) { old?.cleanup?.(); frame.slots[index] = { subscribe, cleanup: subscribe(frame.schedule) }; }
      frame.snapshot = getSnapshot as unknown as () => AgentConfigurationSnapshot; return getSnapshot();
    },
  };
});
const nativeFetch = globalThis.fetch.bind(globalThis);
const path = "/api/v1/agent-configuration/harnesses/pi";
const tokenEndpoint = "https://auth.openai.com/api/accounts/oauth/token";
const secrets = ["synthetic-login-code", "synthetic-new-access", "synthetic-new-refresh", "synthetic-old-access", "synthetic-old-refresh", "sdk-error-private-sentinel"];
const token = () => Response.json({ access_token: secrets[1], refresh_token: secrets[2], expires_in: 3600,
  scope: "openid chatgpt.tokens.use.direct", id_token: "synthetic-presence-only" });
const oldOAuth = () => ({ type: "oauth", access: secrets[3], refresh: secrets[4], expires: Date.now() + 3_600_000 });
const post = (body: unknown = {}): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
function hold() {
  let release!: () => void, enter!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  const entered = new Promise<void>(done => { enter = done; });
  releases.push(release); return { wait, release, entered, enter };
}
type Action = "reserve" | "start" | "reply" | "close" | "read" | "save";
interface Call { action?: Action; method: string; handle?: string; keys: string[]; aborted: boolean }
interface Fixture {
  root: string; agentDir: string; base: string; service: PiAccountService;
  runner: Awaited<ReturnType<typeof startStudioServer>>;
  calls: Call[]; drops: Set<Action>; delays: Map<Action, ReturnType<typeof hold>>;
  counts: { token: number; codex: number; tokenContract: number }; tokenSignals: AbortSignal[];
  tokenReply: () => Promise<Response>;
  browserFetch: typeof fetch;
  request(url: string, init?: RequestInit): Promise<Response>;
}
const fixtures: Fixture[] = [], releases: (() => void)[] = [], pending: Promise<unknown>[] = [], mounts: { unmount(): void }[] = [];
let consoleMessages: string[];
function safe(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(secrets.some(secret => serialized.includes(secret))).toBe(false);
  expect(/code=|state=|code_verifier|"access"|"refresh"|"clientId"/.test(serialized)).toBe(false);
}
async function fixture(deferCreation?: ReturnType<typeof hold>, codexPeer?: CodexFixture): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-pi-login-")), agentDir = join(root, "isolated-pi-home");
  await mkdir(agentDir); vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  // Only native credential/config inputs are fixtures. All owner metadata,
  // login tickets and receipts are written by the real public service.
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: oldOAuth(), other: { type: "api_key", key: "synthetic-preserve-other" } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.4" }));
  await writeFile(join(root, "inkos.json"), JSON.stringify({ name: "Offline login proof", version: "0.1.0", language: "en" }));
  await updateAgentSettings(root, { selectedHarnessId: "pi" }, { expectedRevision: 0 });
  const service = await PiAccountService.create(root);
  const counts = { token: 0, codex: 0, tokenContract: 0 };
  const codexAccountService = createCodexAccountService({ projectDir: root, clientFactory: async () => {
    counts.codex++; if (codexPeer) return codexPeer.createClient(root); throw new Error("Codex fallback forbidden");
  } });
  const runner = await startStudioServer(root, 0, { hostname: "127.0.0.1", codexAccountService,
    ...(deferCreation ? { piAccountServiceFactory: async () => { deferCreation.enter(); await deferCreation.wait; return service; } } : { piAccountService: service }) });
  if (!runner.server.listening) await once(runner.server, "listening");
  const address = runner.server.address(); if (!address || typeof address === "string") throw new Error("Missing Studio TCP address");
  const f: Fixture = { root, agentDir, service, runner, counts, base: `http://127.0.0.1:${address.port}`,
    calls: [], drops: new Set(), delays: new Map(), tokenSignals: [], tokenReply: async () => token(),
    browserFetch: nativeFetch,
    request: (url, init) => globalThis.fetch(`${f.base}${url}`, init) };
  fixtures.push(f);
  // Drop real TCP response headers after the actual Hono mutation completed.
  // The browser sees native fetch rejection, not a fabricated response error.
  runner.server.on("request", (request, response) => {
    const action = actionOf(request.url ?? "", request.method ?? "GET");
    if (!action || !f.drops.delete(action)) return;
    const original = response.writeHead;
    response.writeHead = function(this: ServerResponse, ...args: Parameters<ServerResponse["writeHead"]>) {
      this.destroy(); return original.apply(this, args);
    } as ServerResponse["writeHead"];
  });
  f.browserFetch = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === tokenEndpoint) {
      counts.token++; const signal = init?.signal; if (signal) f.tokenSignals.push(signal);
      const body = init?.body;
      counts.tokenContract += Number(init?.method === "POST" && body instanceof URLSearchParams
        && body.get("grant_type") === "authorization_code" && body.get("code") === secrets[0]
        && body.has("code_verifier") && body.get("redirect_uri") === "http://127.0.0.1:1455/auth/callback" && signal instanceof AbortSignal);
      return f.tokenReply();
    }
    const absolute = url.startsWith("/") ? `${f.base}${url}` : url;
    const target = new URL(absolute);
    if (target.origin !== f.base && !(target.origin === "http://127.0.0.1:1455" && target.pathname === "/auth/callback"))
      throw new Error("External network forbidden");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET"), action = actionOf(target.pathname, method);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    const call: Call = { action, method, keys: Object.keys(body), handle: typeof body.attemptHandle === "string" ? body.attemptHandle : undefined, aborted: !!init?.signal?.aborted };
    if (target.origin === f.base) f.calls.push(call);
    init?.signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });
    const response = await nativeFetch(absolute, init);
    const delay = action && f.delays.get(action);
    if (delay) { f.delays.delete(action!); delay.enter(); await delay.wait; }
    return response;
  });
  vi.stubGlobal("fetch", f.browserFetch);
  return f;
}
function actionOf(url: string, method: string): Action | undefined {
  if (method === "PUT" && url.endsWith("/settings")) return "save";
  if (method === "GET" && url.includes("/login/attempts/")) return "read";
  return ["reserve", "start", "reply", "close"].find(action => url.endsWith(`/login/${action}`)) as Action | undefined;
}
async function reserve(f: Fixture): Promise<Attempt> {
  const response = await f.request(`${path}/login/reserve`, post()); expect(response.status).toBe(200); return (await response.json()).attempt;
}
async function start(f: Fixture, handle: string): Promise<Attempt> {
  const response = await f.request(`${path}/login/start`, post({ attemptHandle: handle })); expect(response.status).toBe(200); return (await response.json()).attempt;
}
async function read(f: Fixture, handle: string): Promise<Attempt> {
  const response = await f.request(`${path}/login/attempts/${handle}`); expect(response.status).toBe(200); return (await response.json()).attempt;
}
async function state(f: Fixture, handle: string, status: Attempt["status"]): Promise<Attempt> {
  let value!: Attempt; await vi.waitFor(async () => { value = await read(f, handle); expect(value.status).toBe(status); }); return value;
}
async function awaiting(f: Fixture, handle: string): Promise<Attempt> {
  let value!: Attempt; await vi.waitFor(async () => { value = await read(f, handle); expect(value.status).toBe("awaiting-user"); expect(value.canReply).toBe(true); }); return value;
}
function callback(attempt: Attempt, wrongState = false): string {
  const authorization = new URL(attempt.challenge!.url), result = new URL("http://127.0.0.1:1455/auth/callback");
  result.search = new URLSearchParams({ state: wrongState ? "synthetic-wrong-state" : authorization.searchParams.get("state")!, code: secrets[0], client_id: "synthetic-issued-client" }).toString();
  return result.href;
}
async function reply(f: Fixture, attempt: Attempt, callbackUrl = callback(attempt)): Promise<Response> {
  return f.request(`${path}/login/reply`, post({ attemptHandle: attempt.handle, promptId: attempt.prompt!.promptId, callbackUrl }));
}
async function close(f: Fixture, handle: string): Promise<CloseResult> {
  const response = await f.request(`${path}/login/close`, post({ attemptHandle: handle })); expect(response.status).toBe(200); return (await response.json()).result;
}
async function bytes(f: Fixture) { return readFile(join(f.agentDir, "auth.json"), "utf8"); }
async function owner(f: Fixture) { return JSON.parse(await readFile(join(f.agentDir, "inkos-connection.json"), "utf8")); }
async function releasedPort() {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(1455, "127.0.0.1", resolve); });
  await new Promise<void>(resolve => server.close(() => resolve()));
}
function observeSubscriptions(service: PiAccountService) {
  const original = service.subscribeLoginAttempt.bind(service), count = { registered: 0, detached: 0, active: 0 };
  // Forward the real registration, events and detach function. No account
  // state, owner writes, OAuth decisions or fake notifications are supplied.
  vi.spyOn(service, "subscribeLoginAttempt").mockImplementation((handle, listener) => {
    const detach = original(handle, listener); count.registered++; count.active++;
    let active = true;
    return () => { detach(); if (active) { active = false; count.detached++; count.active--; } };
  });
  return count;
}
function consoleValue(value: unknown): string {
  if (typeof value === "string") return value;
  const seen = new WeakSet<object>();
  try { return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[circular]"; seen.add(item);
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack, cause: item.cause };
    }
    return item;
  }) ?? String(value); } catch { return String(value); }
}
beforeEach(() => {
  vi.stubEnv("INKOS_CODEX_HOME", ""); delete process.env.INKOS_CODEX_HOME;
  vi.stubEnv("INKOS_CODEX_STATE_ROOT", ""); delete process.env.INKOS_CODEX_STATE_ROOT;
  vi.stubEnv("PI_OAUTH_CALLBACK_HOST", "127.0.0.1");
  consoleMessages = [];
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...values) => { consoleMessages.push(values.map(consoleValue).join(" ")); });
});
afterEach(async () => {
  for (const mount of mounts.splice(0)) mount.unmount();
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(pending.splice(0));
  for (const f of fixtures.splice(0)) { await f.runner.shutdown(); await rm(f.root, { recursive: true, force: true }); }
  expect(consoleMessages.some(message => secrets.some(secret => message.includes(secret)) || /state=|code_verifier|accounts\/authorize/.test(message))).toBe(false);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe("Pi2 actual Studio TCP routes with official 1.1.0 OAuth parser and native writer (synthetic token endpoint)", () => {
  // These exact two probes first failed against the old mounted Studio API.
  it("Pi2 RED: the actual Studio reserve route exposes the separate Pi attempt DTO", async () => {
    const f = await fixture(), before = await bytes(f), attempt = await reserve(f);
    expect(attempt.status).toBe("reserved"); expect(attempt.harnessId).toBe("pi"); expect(attempt.canReply).toBe(false);
    expect(attempt.challenge === null && attempt.prompt === null && attempt.error === null).toBe(true);
    expect(typeof attempt.handle).toBe("string"); expect(typeof attempt.expiresAt).toBe("number"); safe(attempt);
    expect(await bytes(f) === before).toBe(true);
    expect(await readFile(join(f.agentDir, "inkos-connection.json")).then(() => true, () => false)).toBe(false);
    expect(f.counts).toEqual({ token: 0, codex: 0, tokenContract: 0 });
  });
  it("Pi2 RED: the actual Studio start route rejects an unknown exact Pi handle rather than being unmounted", async () => {
    const f = await fixture(), response = await f.request(`${path}/login/start`, post({ attemptHandle: "pi-login-offline-unknown" }));
    expect(response.status).toBe(404); const body = await response.json(); expect(body.error?.code).toBe("PI_UNKNOWN_HANDLE"); safe(body);
    expect(f.counts.token + f.counts.codex).toBe(0);
  });
  it.each(["manual", "loopback"] as const)("saves through the actual %s callback parser, native writer and independent owner readback", async mode => {
    const f = await fixture(), beforeSettings = await readAgentSettings(f.root), { AuthStorage } = await loadPiNativeAuthStorage();
    const original = AuthStorage.prototype.modify; let writes = 0, writeSignal: AbortSignal | undefined;
    vi.spyOn(AuthStorage.prototype, "modify").mockImplementation(function(this: typeof AuthStorage.prototype, provider, fn, options) {
      writes++; writeSignal = options?.signal; return original.call(this, provider, fn, options);
    });
    const attempt = await reserve(f); await start(f, attempt.handle); const waiting = await awaiting(f, attempt.handle);
    const settings = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"));
    expect(typeof settings.deviceId === "string").toBe(true);
    expect(new URL(waiting.challenge!.url).searchParams.get("ext_agent_host_id") === `urn:uuid:${settings.deviceId}`).toBe(true);
    expect(waiting.prompt?.kind).toBe("callback-url");
    const response = mode === "manual" ? await reply(f, waiting) : await globalThis.fetch(callback(waiting));
    expect(response.status).toBe(200); const saved = await state(f, attempt.handle, "saved"); safe(saved);
    expect(f.counts).toEqual({ token: 1, codex: 0, tokenContract: 1 }); expect(writes).toBe(1);
    expect(writeSignal === f.tokenSignals[0]).toBe(true); expect(writeSignal?.aborted).toBe(false);
    const auth = JSON.parse(await bytes(f));
    expect(auth.openai.access === secrets[1] && auth.openai.refresh === secrets[2]).toBe(true);
    expect(auth.other.key === "synthetic-preserve-other").toBe(true);
    expect((await owner(f)).pendingLogin === undefined).toBe(true);
    expect((await readAgentSettings(f.root)).revision).toBe(beforeSettings.revision);
    const authBeforeClose = await bytes(f), result = await close(f, attempt.handle);
    expect(result.outcome).toBe("already-committed"); safe(result); expect(await bytes(f) === authBeforeClose).toBe(true);
    expect((await close(f, attempt.handle)).outcome).toBe("already-committed"); expect(writes).toBe(1);
    const next = await reserve(f); await start(f, next.handle); const again = await awaiting(f, next.handle);
    expect(new URL(again.challenge!.url).searchParams.get("ext_agent_host_id") === `urn:uuid:${settings.deviceId}`).toBe(true);
    expect((await close(f, next.handle)).outcome).toBe("closed"); await releasedPort();
  });
  it("wrong loopback state waits, whereas a wrong manual callback terminates safely before exchange", async () => {
    const f = await fixture(), before = await bytes(f), reserved = await reserve(f); await start(f, reserved.handle);
    const waiting = await awaiting(f, reserved.handle), response = await globalThis.fetch(callback(waiting, true));
    expect(response.status).toBe(400); expect((await read(f, reserved.handle)).status).toBe("awaiting-user"); expect(f.counts.token).toBe(0);
    expect((await reply(f, waiting, callback(waiting, true))).status).toBe(200);
    const failed = await state(f, reserved.handle, "failed"); expect(failed.error).toBe("login-failed"); safe(failed);
    expect(await bytes(f) === before).toBe(true); expect(f.counts.token + f.counts.codex).toBe(0); await releasedPort();
  });
  it("rejects cross-prompt and cross-service handles before token exchange without replacing the official parser", async () => {
    const f = await fixture(), reserved = await reserve(f); await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle);
    const stale = await f.request(`${path}/login/reply`, post({ attemptHandle: reserved.handle, promptId: "pi-prompt-not-current", callbackUrl: callback(waiting) }));
    expect(stale.status).toBe(409); const body = await stale.json(); expect(body.error.code).toBe("PI_PROMPT_NOT_CURRENT"); safe(body);
    const other = await PiAccountService.create(f.root);
    try { expect(() => other.readLoginAttempt(reserved.handle)).toThrow("unknown-handle"); }
    finally { await other.dispose(); }
    expect((await read(f, reserved.handle)).status).toBe("awaiting-user"); expect(f.counts.token).toBe(0);
    expect((await close(f, reserved.handle)).outcome).toBe("closed");
  });
  it("blocks actual TCP Origin, fetch-site, non-JSON and browser authority fields before OAuth", async () => {
    const f = await fixture();
    const blockedHeaders: Record<string, string>[] = [{ Origin: "https://evil.invalid" }, { "Sec-Fetch-Site": "cross-site" }];
    for (const headers of blockedHeaders) {
      const response = await f.request(`${path}/login/reserve`, { ...post(), headers: { "Content-Type": "application/json", ...headers } }); expect(response.status).toBe(403);
    }
    expect((await f.request(`${path}/login/reserve`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(415);
    for (const [action, body] of [["reserve", { authGeneration: 1 }], ["start", { handle: "browser-authority" }],
      ["close", { attemptHandle: "pi-known", loginId: "foreign-id" }], ["reply", { attemptHandle: "pi-known", promptId: "pi-prompt-known", callbackUrl: "x".repeat(16385) }]] as const) {
      const response = await f.request(`${path}/login/${action}`, post(body)); expect(response.status).toBe(400); safe(await response.json());
    }
    // No Content-Length: actual UTF-8 bytes exceed 24 KiB before JSON parsing.
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ callbackUrl: "界".repeat(9000) }))); controller.close(); } });
    const oversized = await f.request(`${path}/login/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    expect(oversized.status).toBe(400); safe(await oversized.json()); expect(f.counts.token + f.counts.codex).toBe(0);
  });
  it("keeps expired attempts distinct and unsupported logout preserves every native credential", async () => {
    const f = await fixture(), before = await bytes(f), reserved = await reserve(f), now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 300001);
    const expired = await f.request(`${path}/login/attempts/${reserved.handle}`); clock.mockRestore();
    expect(expired.status).toBe(410); expect((await expired.json()).error.code).toBe("PI_ATTEMPT_EXPIRED");
    const logout = await f.request(`${path}/logout`, post()); expect(logout.status).toBe(501); expect((await logout.json()).error.code).toBe("PI_LOGOUT_UNSUPPORTED");
    expect(await bytes(f) === before).toBe(true); expect(f.counts.token + f.counts.codex).toBe(0);
  });
  it("reports official callback-port collision safely without exchanging or writing credentials", async () => {
    const blocker = createServer(); await new Promise<void>((resolve, reject) => { blocker.once("error", reject); blocker.listen(1455, "127.0.0.1", resolve); });
    try {
      const f = await fixture(), before = await bytes(f), reserved = await reserve(f); await start(f, reserved.handle);
      const failed = await state(f, reserved.handle, "failed"); expect(failed.error).toBe("login-failed"); safe(failed);
      expect(await bytes(f) === before).toBe(true); expect(f.counts.token + f.counts.codex).toBe(0);
    } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
  });
  it("fresh host drift fails before OAuth instead of inferring deployment from a URL", async () => {
    const f = await fixture(), before = await bytes(f), reserved = await reserve(f), other = join(f.root, "changed-pi-home");
    await mkdir(other); vi.stubEnv("PI_CODING_AGENT_DIR", other);
    const result = await start(f, reserved.handle); expect(result.status).toBe("failed"); expect(result.error).toBe("context-changed"); safe(result);
    expect(await bytes(f) === before).toBe(true); expect(f.counts.token + f.counts.codex).toBe(0);
  });
  it("rejects hostile Host on the real TCP listener before reserving or borrowing any account peer", async () => {
    const f = await fixture(), before = await bytes(f);
    const receivedHosts: boolean[] = [], mutations = [vi.spyOn(f.service, "reserveLoginAttempt"), vi.spyOn(f.service, "startLoginAttempt"), vi.spyOn(f.service, "closeLoginAttempt")];
    // These spies forward the original methods; only call counts are read.
    f.runner.server.on("request", request => { receivedHosts.push(request.headers.host === "hostile.invalid"); });
    for (const suffix of ["login/reserve", "login/start", "login/close"]) {
      // Undici may rewrite Host. node:http sends this explicit header while
      // connecting exclusively to the fixture's real loopback TCP listener.
      const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = nodeHttpRequest(`${f.base}${path}/${suffix}`, { method: "POST",
          headers: { "Content-Type": "application/json", Host: "hostile.invalid" } }, incoming => {
          const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
          incoming.on("error", reject); incoming.on("end", () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
        });
        request.on("error", reject); request.end(JSON.stringify(suffix.endsWith("reserve") ? {} : { attemptHandle: "pi-host-boundary" }));
      });
      expect(response.status).toBe(403); safe(JSON.parse(response.body));
    }
    expect(receivedHosts).toHaveLength(3); expect(receivedHosts.every(value => value)).toBe(true);
    for (const mutation of mutations) expect(mutation.mock.calls.length).toBe(0);
    expect(await bytes(f) === before).toBe(true); expect(f.service.readLoginExpectation()).toBeNull();
    expect(f.counts.token + f.counts.codex).toBe(0);
  });
  it("a handle from another real service is unknown over its actual HTTP routes and cannot close the original login", async () => {
    const f = await fixture(), reserved = await reserve(f); await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle);
    const otherService = await PiAccountService.create(f.root), otherRunner = await startStudioServer(f.root, 0, {
      hostname: "127.0.0.1", piAccountService: otherService,
      codexAccountService: createCodexAccountService({ projectDir: f.root, clientFactory: async () => { throw new Error("Codex fallback forbidden"); } }),
    });
    try {
      if (!otherRunner.server.listening) await once(otherRunner.server, "listening");
      const address = otherRunner.server.address(); if (!address || typeof address === "string") throw new Error("Missing isolated TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      // Captured native fetch is restricted here to this second local Studio.
      for (const [suffix, init] of [[`login/attempts/${reserved.handle}`, undefined],
        ["login/start", post({ attemptHandle: reserved.handle })], ["login/close", post({ attemptHandle: reserved.handle })],
        ["login/reply", post({ attemptHandle: reserved.handle, promptId: waiting.prompt!.promptId, callbackUrl: callback(waiting) })]] as const) {
        const response = await nativeFetch(`${base}${path}/${suffix}`, init); expect(response.status).toBe(404);
        const body = await response.json(); expect(body.error.code).toBe("PI_UNKNOWN_HANDLE"); safe(body);
      }
      expect((await read(f, reserved.handle)).status).toBe("awaiting-user"); expect((await owner(f)).pendingLogin.closed).toBe(false);
      expect(f.counts.token + f.counts.codex).toBe(0);
    } finally { await otherRunner.shutdown(); }
    expect((await read(f, reserved.handle)).status).toBe("awaiting-user"); await close(f, reserved.handle);
  });
  it("real login and Close never append callback, state, challenge or credentials to the durable session/history stores", async () => {
    const f = await fixture(), created = await f.request("/api/v1/sessions", post({ sessionKind: "chat" })); expect(created.status).toBe(200);
    const sessionId = (await created.json()).session.sessionId as string;
    const baselineSession = (await (await f.request(`/api/v1/sessions/${sessionId}`)).json()).session;
    const readHistory = async () => {
      const transcript = await readTranscriptEvents(f.root, sessionId), store = new CreativeEpisodeStore(join(f.root, ".inkos", "harness.sqlite"));
      let episodes: ReturnType<typeof store.listEpisodes>, events: ReturnType<typeof store.listEvents>;
      try { episodes = store.listEpisodes(); events = episodes.flatMap(episode => store.listEvents(episode.id)); }
      finally { store.close(); }
      return { transcript, episodes, events, history: projectRunHistory({ sessionId, transcript, episodes, events }) };
    };
    const baseline = await readHistory(); expect(baseline.transcript.length > 0).toBe(true); expect(baseline.history.requests).toHaveLength(0);
    const reserved = await reserve(f); await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle);
    const callbackUrl = callback(waiting), stateValue = new URL(waiting.challenge!.url).searchParams.get("state")!;
    expect((await reply(f, waiting, callbackUrl)).status).toBe(200); await state(f, reserved.handle, "saved");
    expect((await close(f, reserved.handle)).outcome).toBe("already-committed");
    const restored = (await (await f.request(`/api/v1/sessions/${sessionId}`)).json()).session;
    const after = await readHistory();
    // Preserve the real session-created event and actual SQLite/history
    // baseline. No model or fixture-written history row is involved.
    const persisted = JSON.stringify({ restored, ...after, settings: await readAgentSettings(f.root),
      project: JSON.parse(await readFile(join(f.root, "inkos.json"), "utf8")), nativeSettings: JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")) });
    expect([...secrets, callbackUrl, stateValue, waiting.challenge!.url].some(secret => persisted.includes(secret))).toBe(false);
    expect(after.transcript).toEqual(baseline.transcript); expect(after.episodes).toEqual(baseline.episodes);
    expect(after.events).toEqual(baseline.events); expect(after.history).toEqual(baseline.history);
    expect(JSON.stringify(restored.messages) === JSON.stringify(baselineSession.messages)).toBe(true);
    expect(JSON.parse(await bytes(f)).openai.access === secrets[1]).toBe(true); expect(f.counts.codex).toBe(0);
  });
});

describe("host-owned Close and actual TCP response loss", () => {
  it("Close before start is terminal, idempotent and never opens the official listener", async () => {
    const f = await fixture(), before = await bytes(f), reserved = await reserve(f);
    expect((await close(f, reserved.handle)).outcome).toBe("closed");
    expect((await start(f, reserved.handle)).status).toBe("closed");
    expect((await close(f, reserved.handle)).outcome).toBe("closed");
    expect(await bytes(f) === before).toBe(true); expect(f.counts.token + f.counts.codex).toBe(0); await releasedPort();
  });
  it("Close rejects the actual manual wait, releases 1455, and leaves unrelated providers intact", async () => {
    const f = await fixture(), before = await bytes(f), reserved = await reserve(f); await start(f, reserved.handle); await awaiting(f, reserved.handle);
    const result = await close(f, reserved.handle); expect(result.outcome).toBe("closed"); safe(result);
    expect(result.attempt.status).toBe("closed"); expect((await owner(f)).pendingLogin === undefined).toBe(true);
    expect(await bytes(f) === before).toBe(true); expect(f.counts.token + f.counts.codex).toBe(0); await releasedPort();
  });
  it("Close during token exchange aborts the exact official signal before awaiting actual settlement", async () => {
    const f = await fixture(), gate = hold(), before = await bytes(f), reserved = await reserve(f);
    f.tokenReply = async () => { gate.enter(); await gate.wait; return token(); };
    await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle); expect((await reply(f, waiting)).status).toBe(200); await gate.entered;
    let settled = false; const closing = close(f, reserved.handle).then(value => { settled = true; return value; }); pending.push(closing);
    await state(f, reserved.handle, "closing"); expect(f.tokenSignals[0].aborted).toBe(true); expect(settled).toBe(false);
    expect((await owner(f)).pendingLogin.closed).toBe(true); expect((await start(f, reserved.handle)).status).toBe("closing");
    expect(f.counts.token).toBe(1); expect(await bytes(f) === before).toBe(true);
    gate.release(); const result = await closing; expect(result.outcome).toBe("closed"); safe(result);
    expect(await bytes(f) === before).toBe(true); expect((await owner(f)).pendingLogin === undefined).toBe(true);
    expect((await close(f, reserved.handle)).outcome).toBe("closed"); await releasedPort();
  });
  it.each(["before-native-callback", "after-callback-before-write", "after-native-write"] as const)("Close at %s forwards the real writer and drains without compensating logout", async boundaryName => {
    const f = await fixture(), before = await bytes(f), gate = hold(), { AuthStorage } = await loadPiNativeAuthStorage(), original = AuthStorage.prototype.modify;
    let writeSignal: AbortSignal | undefined;
    vi.spyOn(AuthStorage.prototype, "modify").mockImplementation(async function(this: typeof AuthStorage.prototype, provider, fn, options) {
      writeSignal = options?.signal;
      if (boundaryName === "before-native-callback") return original.call(this, provider, async current => { gate.enter(); await gate.wait; return fn(current); }, options);
      if (boundaryName === "after-callback-before-write") {
        type Backend = { withLockAsync(action: (content: string | undefined) => Promise<{ result: unknown; next?: string }>, options?: { signal?: AbortSignal }): Promise<unknown> };
        const backend = (this as unknown as { storage: Backend }).storage, lock = backend.withLockAsync;
        vi.spyOn(backend, "withLockAsync").mockImplementation((action, nativeOptions) => lock.call(backend, async content => {
          const candidate = await action(content);
          expect(candidate.next?.includes(secrets[1])).toBe(true); gate.enter(); await gate.wait; return candidate;
        }, nativeOptions));
        return original.call(this, provider, fn, options);
      }
      const actual = await original.call(this, provider, fn, options); gate.enter(); await gate.wait; return actual;
    });
    const reserved = await reserve(f); await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle);
    expect((await reply(f, waiting)).status).toBe(200); await gate.entered;
    expect(await bytes(f) === before).toBe(boundaryName !== "after-native-write");
    let settled = false; const closing = close(f, reserved.handle).then(value => { settled = true; return value; }); pending.push(closing);
    await state(f, reserved.handle, "closing"); expect(writeSignal === f.tokenSignals[0]).toBe(true); expect(writeSignal?.aborted).toBe(true); expect(settled).toBe(false);
    expect((await owner(f)).pendingLogin.closed).toBe(true); gate.release();
    const result = await closing; expect(result.outcome).toBe(boundaryName === "after-native-write" ? "already-committed" : "closed"); safe(result);
    const auth = JSON.parse(await bytes(f)); expect(auth.other.key === "synthetic-preserve-other").toBe(true);
    expect(auth.openai.access === secrets[boundaryName === "after-native-write" ? 1 : 3]).toBe(true);
    expect((await owner(f)).pendingLogin === undefined).toBe(true); await releasedPort();
  });
  it("a native rejection after a real commit remains unknown and never deletes committed credentials", async () => {
    const f = await fixture(), { AuthStorage } = await loadPiNativeAuthStorage(), original = AuthStorage.prototype.modify;
    vi.spyOn(AuthStorage.prototype, "modify").mockImplementation(async function(this: typeof AuthStorage.prototype, ...args) {
      await original.call(this, ...args); throw new Error(secrets[5]);
    });
    const reserved = await reserve(f); await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle); await reply(f, waiting);
    const unknown = await state(f, reserved.handle, "unknown"); expect(unknown.error).toBe("storage-failed"); safe(unknown);
    const savedBytes = await bytes(f), result = await close(f, reserved.handle); expect(result.outcome).toBe("unknown"); safe(result);
    expect(await bytes(f) === savedBytes).toBe(true); expect(JSON.parse(savedBytes).openai.access === secrets[1]).toBe(true);
  });
  it.each(["reserve", "start", "reply", "close"] as const)("actual TCP loss of %s returns no response and never automatically replays a mutation", async action => {
    const f = await fixture(), before = await bytes(f);
    if (action === "reserve") {
      f.drops.add(action); await expect(f.request(`${path}/login/reserve`, post())).rejects.toThrow();
      expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1);
      expect(await bytes(f) === before).toBe(true); expect(f.counts.token).toBe(0); return;
    }
    const reserved = await reserve(f); if (action !== "start") await start(f, reserved.handle);
    const waiting = action !== "start" ? await awaiting(f, reserved.handle) : undefined;
    f.drops.add(action);
    const init = action === "reply" ? post({ attemptHandle: reserved.handle, promptId: waiting!.prompt!.promptId, callbackUrl: callback(waiting!) }) : post({ attemptHandle: reserved.handle });
    await expect(f.request(`${path}/login/${action}`, init)).rejects.toThrow();
    const after = action === "start" ? await awaiting(f, reserved.handle) : await state(f, reserved.handle, action === "reply" ? "saved" : "closed");
    expect(after.handle === reserved.handle).toBe(true);
    const mutationCount = f.calls.filter(call => call.method === "POST").length;
    await read(f, reserved.handle); await read(f, reserved.handle);
    expect(f.calls.filter(call => call.method === "POST")).toHaveLength(mutationCount);
    expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1);
    expect(f.calls.filter(call => call.action === action)).toHaveLength(1);
    expect(f.counts.token).toBe(action === "reply" ? 1 : 0);
    expect(f.counts.codex).toBe(0); if (action === "start") await close(f, reserved.handle);
    if (action === "close") expect(await bytes(f) === before).toBe(true);
  });
  it("aborting an actual TCP long-poll detaches its subscription without cancelling the server-owned attempt", async () => {
    const f = await fixture(), reserved = await reserve(f); await start(f, reserved.handle); await awaiting(f, reserved.handle);
    const subscriptions = observeSubscriptions(f.service);
    const abort = new AbortController(), polling = f.request(`${path}/login/attempts/${reserved.handle}?wait=1`, { signal: abort.signal });
    const rejected = polling.catch(error => (error as Error).name); pending.push(rejected);
    await vi.waitFor(() => expect(subscriptions.active).toBe(1));
    abort.abort(); expect(await rejected).toBe("AbortError");
    await vi.waitFor(() => expect(subscriptions.active).toBe(0)); expect(subscriptions.registered).toBe(1); expect(subscriptions.detached).toBe(1);
    expect((await read(f, reserved.handle)).status).toBe("awaiting-user"); expect((await owner(f)).pendingLogin.closed).toBe(false);
    expect(f.calls.filter(call => call.action === "close")).toHaveLength(0); expect(f.counts.token).toBe(0);
    await close(f, reserved.handle);
  });
});

describe("real Studio runner shutdown and independent settings/auth CAS", () => {
  it("shutdown owns injected services even without any Pi route, caches its promise and leaves another service alone", async () => {
    const f = await fixture(), own = f.service.reserveLoginAttempt(), other = await PiAccountService.create(f.root), theirs = other.reserveLoginAttempt();
    try {
      const shutting = f.runner.shutdown(); expect(f.runner.shutdown() === shutting).toBe(true);
      expect(() => f.service.reserveLoginAttempt()).toThrow("service-stopped"); await shutting;
      expect(f.service.readLoginAttempt(own.handle).status).toBe("closed"); expect(other.readLoginAttempt(theirs.handle).status).toBe("reserved");
      expect(f.runner.server.listening).toBe(false); expect(f.calls).toHaveLength(0);
    } finally { await other.dispose(); }
  });
  it("shutdown refuses pending factory creation and disposes the actual late-created service before admitting its route", async () => {
    const gate = hold(), f = await fixture(gate), request = f.request(`${path}/login/reserve`, post()).then(response => response.status);
    pending.push(request); await gate.entered; const shutting = f.runner.shutdown(); expect(f.runner.shutdown() === shutting).toBe(true);
    let done = false; void shutting.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    gate.release(); expect(await request).toBe(503); await shutting;
    expect(() => f.service.reserveLoginAttempt()).toThrow("service-stopped"); expect(f.counts.token + f.counts.codex).toBe(0);
  });
  it("a hung Close TCP response cannot prevent shutdown's synchronous OAuth abort and actual drain", async () => {
    const f = await fixture(), gate = hold(), unused = f.service.reserveLoginAttempt(), reserved = await reserve(f), before = await bytes(f);
    f.tokenReply = async () => { gate.enter(); await gate.wait; return token(); };
    await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle); await reply(f, waiting); await gate.entered;
    const closing = close(f, reserved.handle); pending.push(closing); await state(f, reserved.handle, "closing");
    const shutting = f.runner.shutdown(); expect(f.runner.shutdown() === shutting).toBe(true);
    expect(f.tokenSignals[0].aborted).toBe(true); expect(f.service.readLoginAttempt(unused.handle).status).toBe("closed");
    expect(() => f.service.reserveLoginAttempt()).toThrow("service-stopped");
    let done = false; void shutting.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    gate.release(); expect((await closing).outcome).toBe("closed"); await shutting;
    expect(await bytes(f) === before).toBe(true); expect(f.runner.server.listening).toBe(false); await releasedPort();
  });
  it.each(["save-first", "login-first"] as const)("real settings save and authentication settlement preserve separate revisions (%s)", async order => {
    const f = await fixture(), original = await readAgentSettings(f.root), reserved = await reserve(f);
    const save = async () => {
      const response = await f.request("/api/v1/agent-configuration/settings", { ...post({ expectedRevision: original.revision, patch: { harnessPreferences: { pi: { model: "gpt-5.4", effort: "low", speed: null } } } }), method: "PUT" });
      expect(response.status).toBe(200); return (await response.json()).settings;
    };
    if (order === "save-first") await save();
    await start(f, reserved.handle); const waiting = await awaiting(f, reserved.handle); await reply(f, waiting); await state(f, reserved.handle, "saved");
    if (order === "login-first") await save();
    const final = await readAgentSettings(f.root); expect(final.revision).toBe(original.revision + 1);
    expect(final.harnessPreferences.pi.model).toBe("gpt-5.4"); expect(final.modelConnectionRef).toBeNull();
    const conflict = await f.request("/api/v1/agent-configuration/settings", { ...post({ expectedRevision: original.revision, patch: { selectedHarnessId: "pi" } }), method: "PUT" });
    expect(conflict.status).toBe(409); expect(JSON.parse(await bytes(f)).openai.access === secrets[1]).toBe(true);
    expect((await owner(f)).pendingLogin === undefined).toBe(true); expect(f.counts.codex).toBe(0);
  });
});

type Element = ReactElement<Record<string, unknown>>;
function expand(node: ReactNode): ReactNode {
  return Children.map(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    if (typeof child.type === "function") return expand((child.type as (props: Record<string, unknown>) => ReactNode)(child.props));
    return cloneElement(child, {}, expand(child.props.children as ReactNode));
  });
}
function controls(node: ReactNode, tag: string): Element[] {
  const result: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (child.type === tag) result.push(child); result.push(...controls(child.props.children as ReactNode, tag));
  }); return result;
}
function contents(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? contents(child.props.children) : String(child)).join("");
}
async function mountPage(isZh = false) {
  const { AgentSettings } = await import("../pages/AgentSettings"); let tree: ReactNode, scheduled = false;
  const frame: Frame = { cursor: 0, slots: [], effects: [], mounted: true, schedule: () => {
    if (!frame.mounted || scheduled) return; scheduled = true;
    void Promise.resolve().then(() => { scheduled = false; if (frame.mounted) render(); });
  } };
  function render() {
    frame.cursor = 0; reactBoundary.enter(frame);
    try { tree = expand(AgentSettings({ isZh })); } finally { reactBoundary.leave(); }
    for (const slot of frame.slots.slice(frame.cursor)) slot.cleanup?.(); frame.slots.length = frame.cursor;
    for (const effect of frame.effects.splice(0)) effect();
  }
  const button = (label: string) => {
    const value = controls(tree, "button").find(item => contents(item.props.children as ReactNode) === label);
    expect(!!value, `Missing real Page button: ${label}`).toBe(true); return value!;
  };
  const labels = { connect: isZh ? "使用 ChatGPT 登录" : "Sign in with ChatGPT", check: isZh ? "核对状态" : "Check status",
    close: isZh ? "关闭本次 Pi 登录" : "Close this Pi sign-in", refresh: isZh ? "刷新配置与观察状态" : "Refresh settings and observations" };
  const page = { labels, snapshot: () => frame.snapshot!(), text: () => contents(tree), button, native: (tag: string) => controls(tree, tag),
    click: (label: string) => { const control = button(label); expect(!!control.props.disabled, `${label} must be enabled`).toBe(false); (control.props.onClick as () => void)(); },
    chooseModel: (value: string) => {
      const control = controls(tree, "select").find(item => item.props["aria-label"] === (isZh ? "模型" : "Model"))!;
      expect(!!control).toBe(true); expect(!!control.props.disabled).toBe(false);
      expect(controls(control.props.children as ReactNode, "option").some(option => option.props.value === value)).toBe(true);
      (control.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    },
    chooseHarness: (harness: "pi" | "codex") => {
      const control = controls(tree, "input").find(item => item.props.type === "radio" && item.props.value === harness)!;
      expect(!!control).toBe(true); (control.props.onChange as () => void)();
    },
    submit: (value: string) => {
      const input = controls(tree, "input").find(item => item.props["aria-label"] === (isZh ? "Pi · 登录回调网址" : "Pi · Sign-in callback URL"))!;
      expect(!!input).toBe(true); expect(!!input.props.disabled).toBe(false);
      (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
      const form = controls(tree, "form")[0]!; expect(!!form).toBe(true);
      (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
    },
    unmount: () => { if (!frame.mounted) return; frame.mounted = false; for (const slot of [...frame.slots].reverse()) slot.cleanup?.(); } };
  mounts.push(page); render();
  await vi.waitFor(() => {
    const snapshot = page.snapshot(); expect(snapshot.target.harness).toBe("pi"); expect(snapshot.loading).toBe(false);
    // The ordinary action cases begin after the real initial context read.
    // Loading also clears between settings and state, which is not this fence.
    expect(!!snapshot.state?.scope && snapshot.target.contextKey === snapshot.state.scope.authContextRef).toBe(true);
  }, { timeout: 5000 });
  return page;
}
async function pageStatus(page: Awaited<ReturnType<typeof mountPage>>, status: Attempt["status"]) {
  await vi.waitFor(() => expect(page.snapshot().piLoginAttempt?.status).toBe(status), { timeout: 8000 });
}
async function pageTarget(page: Awaited<ReturnType<typeof mountPage>>, harness: "pi" | "codex") {
  await vi.waitFor(() => {
    const snapshot = page.snapshot(); expect(snapshot.target.harness).toBe(harness);
    expect(!!snapshot.state?.scope && snapshot.state.scope.harnessId === harness && snapshot.target.contextKey === snapshot.state.scope.authContextRef).toBe(true);
  }, { timeout: 5000 });
}
async function browserTurn() { for (let index = 0; index < 10; index++) await new Promise<void>(done => setImmediate(done)); }
describe("real Page → Panel → Card → default singleton transport over actual TCP", () => {
  it.each([false, true])("manual callback reaches the real public service while no private callback enters snapshots or storage (isZh=%s)", async isZh => {
    const f = await fixture(), storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", storage); vi.stubGlobal("sessionStorage", storage);
    const page = await mountPage(isZh); expect(f.calls.filter(call => call.method !== "GET")).toHaveLength(0);
    page.click(page.labels.connect); await pageStatus(page, "awaiting-user");
    await vi.waitFor(() => expect(page.snapshot().piLoginAttempt?.canReply).toBe(true), { timeout: 8000 });
    const attempt = page.snapshot().piLoginAttempt!, href = page.native("a").find(item => item.props["aria-label"] === (isZh ? "Pi · 打开官方 ChatGPT 登录页面" : "Pi · Open official ChatGPT sign-in page"));
    expect(href?.props.href === attempt.challenge!.url).toBe(true); expect(href?.props.rel).toBe("noopener noreferrer");
    page.submit(callback(attempt)); await pageStatus(page, "saved");
    expect(JSON.stringify(page.snapshot()).includes(secrets[0])).toBe(false);
    expect(page.native("input").some(input => String(input.props.value ?? "").includes(secrets[0]))).toBe(false);
    expect(page.text().includes(isZh ? "尚未验证" : "unverified")).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.removeItem).not.toHaveBeenCalled();
    expect(f.counts).toEqual({ token: 1, codex: 0, tokenContract: 1 });
    expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1); expect(f.calls.filter(call => call.action === "reply")).toHaveLength(1);
  });
  it("Close before a late reserve response only closes its returned handle and never starts OAuth", async () => {
    const f = await fixture(), gate = hold(); f.delays.set("reserve", gate);
    const page = await mountPage(); page.click(page.labels.connect); await gate.entered;
    expect(page.snapshot().piAuthBusy).toBe("reserve"); page.click(page.labels.close); gate.release();
    await vi.waitFor(() => expect(page.snapshot().piCloseResult?.outcome).toBe("closed"), { timeout: 5000 });
    expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1); expect(f.calls.filter(call => call.action === "close")).toHaveLength(1);
    expect(f.calls.filter(call => call.action === "start")).toHaveLength(0); expect(f.counts.token + f.counts.codex).toBe(0); await releasedPort();
  });
  it("a lost actual reserve response remains uncertain without automatically reserving or starting after Page remount", async () => {
    const f = await fixture(), before = await bytes(f), first = await mountPage(); f.drops.add("reserve"); first.click(first.labels.connect);
    await vi.waitFor(() => {
      expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1);
      expect(first.snapshot().piAuthBusy).toBeNull(); expect(first.text().toLowerCase().includes("uncertain")).toBe(true);
    }, { timeout: 5000 });
    expect(first.snapshot().piLoginAttempt).toBeNull(); first.unmount();
    const page = await mountPage(); page.click(page.labels.check); page.click(page.labels.refresh); await browserTurn();
    expect(page.snapshot().piLoginAttempt).toBeNull(); expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1);
    expect(f.calls.filter(call => ["start", "reply", "close"].includes(call.action ?? ""))).toHaveLength(0);
    expect(f.counts.token + f.counts.codex).toBe(0); expect(await bytes(f) === before).toBe(true);
    expect(await readFile(join(f.agentDir, "inkos-connection.json")).then(() => false, error => (error as NodeJS.ErrnoException).code === "ENOENT")).toBe(true);
  });
  it.each(["new-project-lifecycle", "cross-harness"] as const)("a late original Close cannot replace an edited draft or the active %s", async mode => {
    const peer = mode === "cross-harness" ? new CodexFixture(() => { throw new Error("A Codex run is not part of this login test"); }) : undefined;
    const f = await fixture(undefined, peer), page = await mountPage(); page.chooseModel("gpt-5.4");
    await vi.waitFor(() => expect(page.snapshot().draft.model).toBe("gpt-5.4"));
    page.click(page.labels.connect); await pageStatus(page, "awaiting-user");
    const oldHandle = page.snapshot().piLoginAttempt!.handle, gate = hold(); f.delays.set("close", gate); page.click(page.labels.close); await gate.entered;
    expect(f.service.readLoginAttempt(oldHandle).status).toBe("closed"); expect(page.snapshot().piAuthBusy).toBe("close");
    expect(f.counts.codex).toBe(0); // Before an explicit Codex selection there is no fallback.
    if (mode === "cross-harness") {
      page.chooseHarness("codex"); await pageTarget(page, "codex");
      const catalog = page.snapshot().state?.catalog?.value;
      const codexModel = catalog?.models.find(model => model.modelId !== catalog.nativeDefaults.modelId)?.modelId;
      expect(typeof codexModel).toBe("string"); page.chooseModel(codexModel!);
      await vi.waitFor(() => expect(page.snapshot().draft.model).toBe(codexModel)); const revision = page.snapshot().revision;
      gate.release(); await browserTurn();
      expect(page.snapshot().target.harness).toBe("codex"); expect(page.snapshot().draft.model).toBe(codexModel); expect(page.snapshot().revision).toBe(revision);
      expect(page.snapshot().piLoginAttempt).toBeNull(); expect(page.snapshot().piCloseResult).toBeUndefined(); expect(peer!.turns).toHaveLength(0);
      // These RPCs are the explicitly selected Codex observation, not a Pi dispatcher fallback.
      expect(peer!.requests.every(request => ["account/read", "model/list", "config/read"].includes(request.method))).toBe(true);
      page.chooseHarness("pi"); await pageTarget(page, "pi");
      await vi.waitFor(() => expect(page.snapshot().piCloseResult?.outcome).toBe("closed"), { timeout: 5000 });
      expect(page.snapshot().draft.model).toBe("gpt-5.4"); expect(page.snapshot().baseline?.harnessPreferences.pi.model).toBeNull();
    } else {
      page.unmount(); const next = await fixture(), active = await mountPage(); active.chooseModel("gpt-5.4");
      await vi.waitFor(() => expect(active.snapshot().draft.model).toBe("gpt-5.4")); active.click(active.labels.connect); await pageStatus(active, "awaiting-user");
      const newHandle = active.snapshot().piLoginAttempt!.handle; expect(newHandle === oldHandle).toBe(false);
      gate.release(); await browserTurn();
      expect(active.snapshot().piLoginAttempt?.handle === newHandle).toBe(true); expect(active.snapshot().piCloseResult).toBeUndefined();
      expect(active.snapshot().draft.model).toBe("gpt-5.4"); expect(next.calls.filter(call => call.action === "close")).toHaveLength(0);
      expect(next.counts.codex).toBe(0); active.click(active.labels.close);
      await vi.waitFor(() => expect(active.snapshot().piCloseResult?.outcome).toBe("closed"), { timeout: 5000 }); active.unmount();
      // Return through the real singleton's old project scope to fence that the
      // delayed receipt settled while the newer scope remained untouched.
      vi.stubEnv("PI_CODING_AGENT_DIR", f.agentDir); vi.stubGlobal("fetch", f.browserFetch);
      const restored = await mountPage(); await vi.waitFor(() => expect(restored.snapshot().piCloseResult?.outcome).toBe("closed"), { timeout: 5000 });
      expect(restored.snapshot().piLoginAttempt?.handle === oldHandle).toBe(true);
      expect(restored.snapshot().baseline?.harnessPreferences.pi.model).toBeNull();
    }
    expect(f.calls.filter(call => call.action === "close")).toHaveLength(1); expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1);
    expect(f.calls.filter(call => call.action === "start")).toHaveLength(1); expect(f.calls.filter(call => call.method === "PUT")).toHaveLength(0);
    expect((await readAgentSettings(f.root)).harnessPreferences.pi.model).toBeNull(); expect(f.counts.token).toBe(0);
  });
  it("navigation during real long-poll/start observation only detaches and restores the same known handle without a POST", async () => {
    const f = await fixture(), subscriptions = observeSubscriptions(f.service), first = await mountPage(); first.click(first.labels.connect); await pageStatus(first, "awaiting-user");
    const handle = first.snapshot().piLoginAttempt!.handle;
    await vi.waitFor(() => expect(subscriptions.active).toBe(1), { timeout: 5000 });
    const registered = subscriptions.registered, detached = subscriptions.detached;
    const before = f.calls.filter(call => call.method !== "GET").length; first.unmount();
    await vi.waitFor(() => expect(subscriptions.active).toBe(0));
    expect(subscriptions.registered).toBe(registered); expect(subscriptions.detached).toBe(detached + 1);
    expect((await read(f, handle)).status).toBe("awaiting-user"); expect((await owner(f)).pendingLogin.closed).toBe(false);
    const second = await mountPage(); second.click(second.labels.check); await pageStatus(second, "awaiting-user");
    expect(second.snapshot().piLoginAttempt?.handle === handle).toBe(true);
    expect(f.calls.filter(call => call.method !== "GET")).toHaveLength(before);
    second.click(second.labels.close); await vi.waitFor(() => expect(second.snapshot().piCloseResult?.outcome).toBe("closed"), { timeout: 5000 });
  });
  it.each(["start", "reply", "close"] as const)("real Page restores %s response uncertainty on the original handle after remount without replay", async action => {
    const f = await fixture(), first = await mountPage(); if (action === "start") f.drops.add("start");
    first.click(first.labels.connect);
    if (action === "start") {
      await vi.waitFor(() => { expect(first.snapshot().piLoginAttempt?.handle !== undefined).toBe(true); expect(first.snapshot().piAuthBusy).toBeNull(); }, { timeout: 5000 });
    } else {
      await pageStatus(first, "awaiting-user"); await vi.waitFor(() => expect(first.snapshot().piLoginAttempt?.canReply).toBe(true), { timeout: 8000 });
      f.drops.add(action); if (action === "reply") first.submit(callback(first.snapshot().piLoginAttempt!)); else first.click(first.labels.close);
      await vi.waitFor(() => expect(first.snapshot().piAuthBusy).toBeNull(), { timeout: 5000 });
    }
    const handle = first.snapshot().piLoginAttempt!.handle, before = f.calls.filter(call => call.method !== "GET").length;
    first.unmount(); const page = await mountPage(); expect(page.snapshot().piLoginAttempt?.handle === handle).toBe(true);
    expect(f.calls.filter(call => call.method !== "GET")).toHaveLength(before);
    if (action === "close") {
      expect(page.snapshot().piCloseResult).toBeUndefined(); expect(page.text().toLowerCase().includes("uncertain")).toBe(true);
      page.click(page.labels.close); await vi.waitFor(() => expect(page.snapshot().piCloseResult?.outcome).toBe("closed"), { timeout: 5000 });
      expect(f.calls.filter(call => call.action === "close")).toHaveLength(2);
      expect(f.calls.filter(call => call.action === "close").every(call => call.handle === handle)).toBe(true);
    } else {
      page.click(page.labels.check); await pageStatus(page, action === "start" ? "awaiting-user" : "saved");
      expect(f.calls.filter(call => call.method !== "GET")).toHaveLength(before); if (action === "start") page.click(page.labels.close);
    }
    expect(f.calls.filter(call => call.action === "reserve")).toHaveLength(1); expect(f.calls.filter(call => call.action === "start")).toHaveLength(1);
    expect(f.counts.token).toBe(action === "reply" ? 1 : 0); expect(f.counts.codex).toBe(0);
  });
});
