import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAuthenticationOwner, CreativeEpisodeStore, createCodexAccountService, readAgentSettings,
  type CodexAccountService, type CodexClient,
} from "@actalk/inkos-core";
import { createAgentConfigurationDependencies } from "./agent-configuration.js";
import type { HarnessState } from "../shared/agent-configuration.js";

// Offline protocol peer only. This does not authenticate with OAuth, open a
// provider credential, run inference, or create a native app-server process.
// AccountService, its durable owner CAS, observation, and SQLite remain real.
class ObservationPeer implements CodexClient {
  private readonly homePath: string;
  closed = false;
  authenticated = false;
  email = "private@observation.test";
  planType: string | null = "fixture";
  readonly calls: Array<{ method: string; params: unknown }> = [];
  beforeRequest?: (method: string) => Promise<void>;
  beforeHomeRead?: () => void;
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly closes = new Set<() => void>();
  constructor(readonly cwd: string) { this.homePath = join(cwd, ".inkos", "codex", "home"); }
  get codexHome() { this.beforeHomeRead?.(); return this.homePath; }
  async request<T = unknown>(method: string, params: unknown = {}, options?: { signal?: AbortSignal }): Promise<T> {
    this.calls.push({ method, params }); options?.signal?.throwIfAborted();
    if (this.closed) throw new Error("The offline observation peer is closed");
    await this.beforeRequest?.(method);
    let result: unknown;
    switch (method) {
      case "account/read":
        result = { account: this.authenticated ? { type: "chatgpt", email: this.email, planType: this.planType } : null,
          requiresOpenaiAuth: true };
        break;
      case "account/login/start":
        // Deliberate historical ID reuse: an ID alone cannot prove an owner generation.
        result = { type: "chatgptDeviceCode", loginId: "same-provider-id", verificationUrl: "https://auth.openai.com/codex/device", userCode: "OFFLINE-CODE" };
        break;
      case "account/login/cancel": result = { status: "canceled" }; break;
      case "account/logout": this.authenticated = false; result = {}; break;
      case "model/list":
        result = { data: [{ id: "offline-model", model: "offline-model", isDefault: true, defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }], serviceTiers: [], defaultServiceTier: null }], nextCursor: null };
        break;
      case "config/read": result = { config: {} }; break;
      default: throw new Error(`Unexpected offline observation RPC: ${method}`);
    }
    return result as T;
  }
  onNotification(listener: (method: string, params: unknown) => void) { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest() { return () => {}; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  complete() {
    this.authenticated = true;
    for (const listener of this.notifications) listener("account/login/completed", { loginId: "same-provider-id", success: true });
  }
  async close() { if (!this.closed) { this.closed = true; for (const listener of this.closes) listener(); } }
}

const fixtures: Array<{ root: string; service: CodexAccountService; store: CreativeEpisodeStore }> = [];
afterEach(async () => {
  for (const value of fixtures.splice(0)) {
    try { await value.service.dispose(); }
    finally { value.store.close(); await rm(value.root, { recursive: true, force: true }); }
  }
  vi.unstubAllEnvs();
});
async function fixture(rebuildClosedPeer = false) {
  vi.stubEnv("INKOS_CODEX_HOME", ""); delete process.env.INKOS_CODEX_HOME;
  vi.stubEnv("INKOS_CODEX_STATE_ROOT", ""); delete process.env.INKOS_CODEX_STATE_ROOT;
  const root = await mkdtemp(join(tmpdir(), "inkos-studio-observation-combination-"));
  await mkdir(join(root, ".inkos", "codex", "home"), { recursive: true, mode: 0o700 });
  const peer = new ObservationPeer(root);
  const peers = [peer];
  const service = createCodexAccountService({ projectDir: root, clientFactory: async () => {
    let current = peers.at(-1)!;
    if (rebuildClosedPeer && current.closed) {
      const replacement = new ObservationPeer(root); replacement.authenticated = current.authenticated;
      peers.push(replacement); current = replacement;
    }
    return current;
  } });
  const storePath = join(root, ".inkos", "harness.sqlite"), store = new CreativeEpisodeStore(storePath);
  fixtures.push({ root, service, store });
  const owner = new CodexAuthenticationOwner(peer);
  const start = async () => {
    const reservation = service.reserveDeviceLoginAttempt();
    const login = await service.startDeviceLogin({ attemptHandle: reservation.attemptHandle });
    return { reservation, login };
  };
  return { root, peer, peers, service, store, storePath, owner, start };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const mutationMethods = new Set(["account/login/start", "account/login/cancel", "account/logout", "thread/start", "turn/start"]);
const mutations = (value: Fixture) => value.peer.calls.filter(call => mutationMethods.has(call.method));

/**
 * A transparent timing scheduler, not an AccountService substitute. Every
 * method executes on the same public Core instance with its original `this`.
 * The second getRuntimeClient barrier executes a real operation after Studio's
 * readAccount has returned and before its separate real runtime observation.
 * No status, login, owner record or observeCodexRuntime result is fabricated.
 */
async function observeAcross(value: Fixture, interleave: () => Promise<void>) {
  let scheduled = false;
  let clientReads = 0;
  let ownerAfterOperation: ReturnType<CodexAuthenticationOwner["snapshot"]>;
  let mutationsAfterOperation: ReturnType<typeof mutations> = [];
  const settingsBefore = await readAgentSettings(value.root), sqliteBefore = readFileSync(value.storePath);
  const scheduledService = new Proxy(value.service, {
    get(service, property) {
      if (property === "getRuntimeClient") return async () => {
        if (++clientReads === 2 && !scheduled) {
          scheduled = true; await interleave();
          ownerAfterOperation = value.owner.snapshot(); mutationsAfterOperation = [...mutations(value)];
        }
        return service.getRuntimeClient();
      };
      const member = Reflect.get(service, property, service);
      return typeof member === "function" ? member.bind(service) : member;
    },
  });
  const dependencies = createAgentConfigurationDependencies(value.root, scheduledService);
  const state = await dependencies.observeHarness!("codex");
  expect(scheduled).toBe(true);
  // The composite GET is passive after the explicitly scheduled lifecycle work.
  expect(value.owner.snapshot()).toEqual(ownerAfterOperation!);
  expect(mutations(value)).toEqual(mutationsAfterOperation);
  expect(await readAgentSettings(value.root)).toEqual(settingsBefore);
  expect(value.store.listEpisodes()).toEqual([]);
  expect(readFileSync(value.storePath)).toEqual(sqliteBefore);
  expect(state.execution).toBeNull();
  expect(JSON.stringify(state)).not.toContain("private@observation.test");
  return state;
}
async function observeDuringConfirmation(value: Fixture, interleave: () => Promise<void>) {
  let reads = 0, scheduled = false;
  let ownerAfterOperation: ReturnType<CodexAuthenticationOwner["snapshot"]>;
  let mutationsAfterOperation: ReturnType<typeof mutations> = [];
  const settingsBefore = await readAgentSettings(value.root), sqliteBefore = readFileSync(value.storePath);
  value.peer.beforeRequest = async method => {
    if (method !== "account/read" || ++reads !== 4) return;
    // Native reads 1/2/3 are the real service status + two real Core probe reads.
    // Read 4 is the added confirmation. Its RPC result remains the peer's own
    // result; only actual service/owner lifecycle work is scheduled while held.
    scheduled = true; await interleave();
    ownerAfterOperation = value.owner.snapshot(); mutationsAfterOperation = [...mutations(value)];
  };
  const state = await createAgentConfigurationDependencies(value.root, value.service).observeHarness!("codex");
  expect(scheduled).toBe(true); expect(reads).toBe(4);
  expect(value.owner.snapshot()).toEqual(ownerAfterOperation!);
  expect(mutations(value)).toEqual(mutationsAfterOperation);
  expect(await readAgentSettings(value.root)).toEqual(settingsBefore);
  expect(value.store.listEpisodes()).toEqual([]); expect(readFileSync(value.storePath)).toEqual(sqliteBefore);
  expect(state).toEqual({ harnessId: "codex", availability: "unavailable", scope: null,
    installation: "unknown", account: null, catalog: null, execution: null });
  expect(state.connection).toBeUndefined();
  return state;
}
function expectCurrentLogin(state: HarnessState, latest: Awaited<ReturnType<CodexAccountService["readAccount"]>>) {
  // Conservatively omitting an uncorrelated historical record is safe. Publishing
  // it requires the real service's current ID AND terminal/pending status.
  if (state.connection?.login) {
    expect(latest.login).not.toBeNull();
    expect(state.connection.login).toMatchObject({ loginId: latest.login?.loginId, status: latest.login?.status });
  }
  if (latest.login?.status !== "pending") expect(state.connection?.phase).not.toBe("signing-in");
}
function expectCatalogScope(state: HarnessState) {
  if (state.catalog) {
    expect(state.account?.type).toBe("chatgpt"); expect(state.connection?.phase).toBe("signed-in");
    expect(state.catalog.scope).toEqual(state.scope);
    expect(state.catalog.value.adapterVersion).toBe(state.scope?.adapterVersion);
  }
}

describe("Studio composite observation with the real public Core account service, durable owner and SQLite", () => {
  it.each([null, " fixture "])("keeps a stable cold native plan %s without inventing a label or owner", async plan => {
    const value = await fixture(); value.peer.authenticated = true; value.peer.planType = plan;
    expect((await value.service.readAccount()).account?.planType).toBe(plan || "unknown");
    const state = await createAgentConfigurationDependencies(value.root, value.service).observeHarness!("codex");
    expect(state.availability).toBe("available");
    expect(state.account).toEqual({ type: "chatgpt", ...(plan ? { label: `ChatGPT · ${plan}` } : {}) });
    expect(state.catalog).not.toBeNull(); expect(state.execution).toBeNull();
    expect(value.owner.snapshot()).toBeUndefined(); expect(mutations(value)).toEqual([]);
  });

  it("discards a cold probe with a different visible plan even when the first and final account identity match", async () => {
    const value = await fixture(); value.peer.authenticated = true;
    const settingsBefore = await readAgentSettings(value.root), sqliteBefore = readFileSync(value.storePath);
    const ownerPath = join(value.peer.codexHome, "inkos-connection.json");
    let reads = 0;
    value.peer.beforeRequest = async method => {
      if (method !== "account/read") return;
      const read = ++reads;
      if (read === 2) { value.peer.email = "other@observation.test"; value.peer.planType = "other-plan"; }
      if (read === 4) { value.peer.email = "private@observation.test"; value.peer.planType = "fixture"; }
    };
    const dependencies = createAgentConfigurationDependencies(value.root, value.service);
    const state = await dependencies.observeHarness!("codex");
    expect(reads).toBe(4);
    expect(state).toEqual({ harnessId: "codex", availability: "unavailable", scope: null,
      installation: "unknown", account: null, catalog: null, execution: null });
    const stable = await dependencies.observeHarness!("codex");
    expect(stable.account).toEqual({ type: "chatgpt", label: "ChatGPT · fixture" });
    expect(stable.catalog).not.toBeNull(); expect(stable.execution).toBeNull();
    expect(value.owner.snapshot()).toBeUndefined(); expect(existsSync(ownerPath)).toBe(false);
    expect(mutations(value)).toEqual([]); expect(await readAgentSettings(value.root)).toEqual(settingsBefore);
    expect(value.store.listEpisodes()).toEqual([]); expect(readFileSync(value.storePath)).toEqual(sqliteBefore);
  });

  it("discards pending-login ABA across a real Close and same-ID start, then restores the new pending login on a stable read", async () => {
    const value = await fixture(), original = await value.start();
    const before = value.owner.snapshot()!, oldStatus = await value.service.readAccount();
    expect(oldStatus.login).toMatchObject({ loginId: original.login.loginId, status: "pending" });
    let newer!: Awaited<ReturnType<Fixture["start"]>>;
    const state = await observeAcross(value, async () => {
      expect(await value.service.closeDeviceLoginAttempt(original.reservation.attemptHandle)).toMatchObject({ state: "closed", cleanup: "cancel-acknowledged" });
      newer = await value.start();
      expect(newer.reservation.attemptHandle).not.toBe(original.reservation.attemptHandle);
      expect(newer.login).toEqual(original.login);
    });
    const currentOwner = value.owner.snapshot()!, currentStatus = await value.service.readAccount();
    expect(currentOwner.authGeneration).toBeGreaterThan(before.authGeneration);
    expect(currentOwner.localState).toBe("transitioning"); expect(currentOwner.operationId).not.toBe(before.operationId);
    // Public ID/status/code equality is real in this protocol fixture, but cannot
    // prove that the initial status and later probe belong to the same owner epoch.
    expect(currentStatus.login).toEqual(oldStatus.login);
    expect(state).toEqual({ harnessId: "codex", availability: "unavailable", scope: null,
      installation: "unknown", account: null, catalog: null, execution: null });
    expect(state.connection).toBeUndefined();
    const stable = await createAgentConfigurationDependencies(value.root, value.service).observeHarness!("codex");
    expect(stable.availability).toBe("available");
    expect(stable.connection).toMatchObject({ phase: "signing-in", login: { loginId: newer.login.loginId, status: "pending" } });
    expectCurrentLogin(stable, await value.service.readAccount());
    expect(stable.account).toBeNull(); expect(stable.catalog).toBeNull(); expect(stable.execution).toBeNull();
    expect(value.owner.snapshot()).toEqual(currentOwner);
    expect(mutations(value).map(call => call.method)).toEqual(["account/login/start", "account/login/cancel", "account/login/start"]);
  });

  it.each(["signed-out", "different-identity"] as const)("discards a cold ready probe when native confirmation read four reports %s without creating an owner", async change => {
    const value = await fixture(); value.peer.authenticated = true;
    const ownerPath = join(value.peer.codexHome, "inkos-connection.json");
    expect(value.owner.snapshot()).toBeUndefined(); expect(existsSync(ownerPath)).toBe(false);
    await observeDuringConfirmation(value, async () => {
      if (change === "signed-out") value.peer.authenticated = false;
      else value.peer.email = "different@observation.test";
    });
    expect(value.owner.snapshot()).toBeUndefined(); expect(existsSync(ownerPath)).toBe(false);
    const current = await value.service.readAccount();
    if (change === "signed-out") { expect(current.connected).toBe(false); expect(current.account).toBeNull(); }
    else { expect(current.connected).toBe(true); expect(current.account?.email).toBe("different@observation.test"); }
    expect(value.owner.snapshot()).toBeUndefined(); expect(existsSync(ownerPath)).toBe(false);
    expect(mutations(value)).toEqual([]);
  });

  it("discards a cold ready probe when a real owner begin creates its generation before Studio takes the first snapshot", async () => {
    const value = await fixture(); value.peer.authenticated = true;
    expect(value.owner.snapshot()).toBeUndefined();
    const settingsBefore = await readAgentSettings(value.root), sqliteBefore = readFileSync(value.storePath);
    let reads = 0, homesAfterThirdRead = 0, scheduled = false;
    let created: ReturnType<CodexAuthenticationOwner["snapshot"]>;
    value.peer.beforeRequest = async method => { if (method === "account/read") reads++; };
    value.peer.beforeHomeRead = () => {
      if (reads !== 3 || scheduled || ++homesAfterThirdRead !== 2) return;
      // After native read 3, home access 1 is Core probe's final assertContext;
      // access 2 is Studio's subsequent Owner construction. This getter always
      // returns the actual same peer path. The held real owner's public begin
      // performs its normal durable CAS synchronously; no owner/service method
      // or return value is substituted by this timing scheduler.
      scheduled = true; value.owner.begin(true); created = value.owner.snapshot();
    };
    const state = await createAgentConfigurationDependencies(value.root, value.service).observeHarness!("codex");
    expect(scheduled).toBe(true); expect(homesAfterThirdRead).toBe(2);
    expect(created).toMatchObject({ localState: "transitioning" });
    expect(created!.authGeneration).toBeGreaterThan(0); expect(created!.operationId).not.toBeNull();
    expect(value.owner.snapshot()).toEqual(created);
    expect(state).toEqual({ harnessId: "codex", availability: "unavailable", scope: null,
      installation: "unknown", account: null, catalog: null, execution: null });
    expect(state.connection).toBeUndefined(); expect(mutations(value)).toEqual([]);
    expect(await readAgentSettings(value.root)).toEqual(settingsBefore);
    expect(value.store.listEpisodes()).toEqual([]); expect(readFileSync(value.storePath)).toEqual(sqliteBefore);
  });

  it("discards a ready catalog envelope when a real start changes the owner during native confirmation read four", async () => {
    const value = await fixture(); value.peer.authenticated = true; await value.owner.admit(value.peer);
    const before = value.owner.snapshot()!; expect(before.localState).toBe("ready");
    await observeDuringConfirmation(value, async () => { await value.start(); });
    const current = value.owner.snapshot()!;
    expect(current.authGeneration).toBeGreaterThan(before.authGeneration); expect(current.localState).toBe("transitioning");
    expect((await value.service.readAccount()).login).toMatchObject({ loginId: "same-provider-id", status: "pending" });
    expect(value.owner.snapshot()).toEqual(current);
    expect(mutations(value).map(call => call.method)).toEqual(["account/login/start"]);
  });

  it("discards the complete nonready envelope when a real Close changes owner state during native confirmation read four", async () => {
    const value = await fixture(), started = await value.start(), before = value.owner.snapshot()!;
    expect(before.localState).toBe("transitioning");
    await observeDuringConfirmation(value, async () => {
      expect(await value.service.closeDeviceLoginAttempt(started.reservation.attemptHandle)).toMatchObject({ state: "closed", cleanup: "cancel-acknowledged" });
    });
    const current = value.owner.snapshot()!;
    // Close changes the operation/state stamp even though its generation stays the same.
    expect(current.authGeneration).toBe(before.authGeneration); expect(current.localState).toBe("unknown"); expect(current.operationId).toBeNull();
    expect((await value.service.readAccount()).login).toMatchObject({ loginId: started.login.loginId, status: "cancelled" });
    expect(value.owner.snapshot()).toEqual(current);
    expect(mutations(value).map(call => call.method)).toEqual(["account/login/start", "account/login/cancel"]);
  });

  it("discards a buffered confirmation from a closed peer and lets only the real service replace its borrowed peer", async () => {
    const value = await fixture(true); value.peer.authenticated = true; await value.owner.admit(value.peer);
    const before = value.owner.snapshot()!;
    // A transport may close after a request was issued while its buffered reply
    // still arrives. The peer's read result is not fabricated by the scheduler.
    await observeDuringConfirmation(value, async () => { await value.peer.close(); });
    expect(value.peer.closed).toBe(true); expect(value.owner.snapshot()).toEqual(before);
    const replacement = await value.service.getRuntimeClient();
    expect(replacement).toBe(value.peers[1]); expect(replacement).not.toBe(value.peer); expect(replacement.closed).toBe(false);
    expect(value.peers).toHaveLength(2); expect(value.peers[1]!.calls).toEqual([]);
    expect(value.owner.snapshot()).toEqual(before); expect(mutations(value)).toEqual([]);
  });

  it("keeps a stable ready login, account, catalog and owner generation coherent without side effects", async () => {
    const value = await fixture(), started = await value.start();
    value.peer.complete(); const current = await value.service.readAccount(), owner = value.owner.snapshot()!;
    expect(current.login).toMatchObject({ loginId: started.login.loginId, status: "completed" });
    expect(owner.localState).toBe("ready");
    const state = await observeAcross(value, async () => {});
    expectCurrentLogin(state, current); expectCatalogScope(state);
    expect(state.scope?.ownerGeneration).toBe(owner.authGeneration);
    expect(state.connection?.connectionRef).toBe(owner.connectionRef);
    expect(state.account?.type).toBe("chatgpt"); expect(state.catalog).not.toBeNull();
    expect(mutations(value).map(call => call.method)).toEqual(["account/login/start"]);
  });

  it("keeps a stable nonready pending login separate from an unobserved owner and catalog", async () => {
    const value = await fixture(), started = await value.start(), owner = value.owner.snapshot()!;
    expect(owner.localState).toBe("transitioning");
    const state = await observeAcross(value, async () => {});
    expectCurrentLogin(state, await value.service.readAccount());
    expect(state.connection).toMatchObject({ phase: "signing-in", login: { loginId: started.login.loginId, status: "pending" } });
    expect(state.scope?.ownerGeneration).toBeNull(); expect(state.account).toBeNull(); expect(state.catalog).toBeNull();
    expect(value.owner.snapshot()).toEqual(owner);
    expect(mutations(value).map(call => call.method)).toEqual(["account/login/start"]);
  });

  it.each(["Close", "logout", "start"] as const)("does not combine a stale login record with the runtime read after a real %s between reads", async action => {
    const value = await fixture(), original = await value.start();
    if (action === "start") { value.peer.complete(); await value.service.readAccount(); }
    const oldGeneration = value.owner.snapshot()!.authGeneration;
    const state = await observeAcross(value, async () => {
      if (action === "Close") await value.service.closeDeviceLoginAttempt(original.reservation.attemptHandle);
      else if (action === "logout") await value.service.logout();
      else await value.start();
    });
    const latest = await value.service.readAccount();
    if (action === "Close") expect(latest.login).toMatchObject({ loginId: original.login.loginId, status: "cancelled" });
    else if (action === "logout") expect(latest.login).toBeNull();
    else {
      expect(latest.login).toMatchObject({ loginId: original.login.loginId, status: "pending" });
      expect(value.owner.snapshot()!.authGeneration).toBeGreaterThan(oldGeneration);
    }
    expect(state.account).toBeNull(); expect(state.catalog).toBeNull(); expectCatalogScope(state);
    expectCurrentLogin(state, latest);
    const expected = action === "Close" ? ["account/login/start", "account/login/cancel"]
      : action === "logout" ? ["account/login/start", "account/login/cancel", "account/logout"]
        : ["account/login/start", "account/login/start"];
    expect(mutations(value).map(call => call.method)).toEqual(expected);
  });

  it.each(["ready", "nonready"] as const)("does not attach an old pending record to a reused ID in a newer %s generation", async readiness => {
    const value = await fixture(), original = await value.start(), oldGeneration = value.owner.snapshot()!.authGeneration;
    const state = await observeAcross(value, async () => {
      await value.service.closeDeviceLoginAttempt(original.reservation.attemptHandle);
      const newer = await value.start(); expect(newer.login.loginId).toBe(original.login.loginId);
      await value.service.closeDeviceLoginAttempt(newer.reservation.attemptHandle);
      // Independent protocol evidence is synthetic; readiness is still committed
      // only by the real owner admission rather than a fabricated owner record.
      value.peer.authenticated = true;
      if (readiness === "ready") await value.owner.admit(value.peer);
    });
    const latest = await value.service.readAccount(), owner = value.owner.snapshot()!;
    expect(owner.authGeneration).toBeGreaterThan(oldGeneration);
    expect(latest.login).toMatchObject({ loginId: original.login.loginId, status: "cancelled" });
    if (readiness === "ready") {
      expect(owner.localState).toBe("ready");
      // The first and confirmation account reads straddled a real change. Do
      // not publish that mixed envelope, even though the later probe was ready.
      expect(state).toEqual({ harnessId: "codex", availability: "unavailable", scope: null,
        installation: "unknown", account: null, catalog: null, execution: null });
      // A subsequent complete stable read restores the genuine latest scope,
      // catalog and terminal login; omission cannot become a permanent outage.
      const refreshed = await createAgentConfigurationDependencies(value.root, value.service).observeHarness!("codex");
      expect(refreshed.scope?.ownerGeneration).toBe(owner.authGeneration);
      expect(refreshed.connection?.connectionRef).toBe(owner.connectionRef);
      expect(refreshed.account?.type).toBe("chatgpt"); expect(refreshed.catalog).not.toBeNull();
      expectCurrentLogin(refreshed, latest); expectCatalogScope(refreshed);
      expect(value.owner.snapshot()).toEqual(owner);
    } else {
      expect(owner.localState).toBe("unknown");
      expect(state).toEqual({ harnessId: "codex", availability: "unavailable", scope: null,
        installation: "unknown", account: null, catalog: null, execution: null });
      const refreshed = await createAgentConfigurationDependencies(value.root, value.service).observeHarness!("codex");
      expect(refreshed.scope?.ownerGeneration).toBeNull();
      expect(refreshed.connection?.login).toMatchObject({ loginId: original.login.loginId, status: "cancelled" });
      expect(refreshed.catalog).toBeNull(); expect(refreshed.execution).toBeNull();
      expect(value.owner.snapshot()).toEqual(owner);
    }
    expectCatalogScope(state); expectCurrentLogin(state, latest);
    expect(mutations(value).map(call => call.method)).toEqual([
      "account/login/start", "account/login/cancel", "account/login/start", "account/login/cancel",
    ]);
  });
});
