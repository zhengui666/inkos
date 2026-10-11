import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableHarnessState, type AgentSettings, type DeviceLoginAttemptCloseResult, type HarnessState, type StudioPiLoginAttempt, type StudioPiCloseResult } from "../shared/agent-configuration";
import type { AgentConfigurationSnapshot } from "./agent-configuration-controller";

type HookValue = ReturnType<typeof import("./use-agent-configuration")["useAgentConfiguration"]>;
interface HookSlot { dependencies?: readonly unknown[]; value?: unknown; cleanup?: () => void; subscribe?: unknown }
interface HookFrame { cursor: number; slots: HookSlot[]; effects: (() => void)[]; mounted: boolean; schedule(): void }
const hookBoundary = vi.hoisted(() => {
  let active: HookFrame | undefined;
  return {
    enter: (frame: HookFrame) => { active = frame; },
    leave: () => { active = undefined; },
    current: () => { if (!active) throw new Error("A hook was called outside the offline subscription boundary"); return active; },
  };
});

// Only the React lifecycle/subscription boundary is simulated. The hook's module
// singleton, controller, transport and signal-aware fetchJson are real code.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const sameDependencies = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return {
    ...actual,
    useMemo: <T>(create: () => T, dependencies?: readonly unknown[]): T => {
      const frame = hookBoundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (!old || !sameDependencies(old.dependencies, dependencies)) frame.slots[index] = { dependencies, value: create() };
      return frame.slots[index]!.value as T;
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const frame = hookBoundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (old && sameDependencies(old.dependencies, dependencies)) return;
      const slot: HookSlot = { dependencies }; frame.slots[index] = slot;
      frame.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); if (cleanup) slot.cleanup = cleanup; });
    },
    useSyncExternalStore: <T>(subscribe: (notify: () => void) => () => void, getSnapshot: () => T): T => {
      const frame = hookBoundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (old?.subscribe !== subscribe) {
        old?.cleanup?.(); frame.slots[index] = { subscribe, cleanup: subscribe(frame.schedule) };
      }
      return getSnapshot();
    },
  };
});

const native = { model: null, effort: null, speed: null };
const initial: AgentSettings = { schemaVersion: 1, revision: 0, selectedHarnessId: "codex", modelConnectionRef: null, harnessPreferences: { codex: native, pi: native } };
const context = "offline-service-context", handle = "offline-reserved-handle";
const login = { loginId: "offline-provider-id", status: "pending" as const, verificationUrl: "https://auth.openai.com/codex/device", userCode: "OFFLINE-CODE" };
const closed: DeviceLoginAttemptCloseResult = { attemptHandle: handle, state: "closed", cleanup: "cancel-acknowledged" };
type Action = "reserve" | "start" | "close" | "reply" | "attempt-read";
interface HttpCall {
  readonly url: string; readonly method: string; readonly body: unknown; readonly signal: AbortSignal;
  readonly keepalive: boolean | undefined; readonly action?: Action;
  aborted: boolean; rejection?: unknown; reply(value: unknown, status?: number): void; reject(error: unknown): void;
}
function observed(phase: NonNullable<HarnessState["connection"]>["phase"] = "signed-out", generation: number | null = null): HarnessState {
  return { ...unavailableHarnessState("codex"), availability: "available", installation: "installed",
    scope: { harnessId: "codex", authContextRef: context, ownerGeneration: generation, adapterVersion: "offline", catalogVersion: "offline" },
    account: phase === "signed-in" ? { type: "chatgpt", label: "Observed account" } : null,
    connection: { phase, login: phase === "signing-in" ? login : null, connectionRef: null } };
}
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve(); }
const mounts: { unmount(): void }[] = [];
const releaseFetches: (() => void)[] = [];
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(async () => {
  for (const mounted of mounts.splice(0)) mounted.unmount();
  for (const release of releaseFetches.splice(0)) release();
  await flush(); vi.unstubAllGlobals(); vi.useRealTimers();
});

const piContext = "offline-pi-service-context", piHandle = "offline-pi-reserved-handle";
function publicPiAttempt(status: StudioPiLoginAttempt["status"] = "awaiting-user", handle = piHandle): StudioPiLoginAttempt {
  return { harnessId: "pi", handle, status, expiresAt: Date.now() + 120_000, canReply: status === "awaiting-user",
    challenge: status === "awaiting-user" ? { kind: "open-url", url: "https://auth.openai.com/api/accounts/authorize?state=offline" } : null,
    prompt: status === "awaiting-user" ? { kind: "callback-url", promptId: "offline-pi-prompt" } : null, error: null };
}
function observedPi(generation: number | null = null): HarnessState {
  return { ...unavailableHarnessState("pi"), availability: "available", installation: "installed", localAuthentication: "missing",
    scope: { harnessId: "pi", authContextRef: piContext, ownerGeneration: generation, adapterVersion: "offline", catalogVersion: "offline" } };
}
async function setup(pi = false) {
  let state = pi ? observedPi() : observed();
  let piAttempt = publicPiAttempt();
  const held = new Set<Action>(), calls: HttpCall[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET", signal = init?.signal as AbortSignal;
    const action: Action | undefined = url.endsWith("/login/reserve") ? "reserve" : url.endsWith("/login/close") ? "close"
      : url.endsWith("/login/start") || url.endsWith("/login") ? "start" : url.endsWith("/login/reply") ? "reply"
        : url.includes("/login/attempts/") ? "attempt-read" : undefined;
    let resolve!: (response: Response) => void, reject!: (error: unknown) => void;
    const pending = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    const call: HttpCall = { url, method, signal, action, body: init?.body ? JSON.parse(String(init.body)) : undefined,
      keepalive: init?.keepalive, aborted: signal.aborted,
      reply: (value, status = 200) => { signal.removeEventListener("abort", abort); resolve(Response.json(value, { status })); },
      reject: error => { call.rejection = error; signal.removeEventListener("abort", abort); reject(error); } };
    const abort = () => { call.aborted = true; call.reject(new DOMException("The offline fetch was aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true }); calls.push(call);
    const piRequest = url.includes("/harnesses/pi/");
    const automatic = url.endsWith("/settings") ? { settings: pi ? { ...initial, selectedHarnessId: "pi" } : initial }
      : url.endsWith("/state") ? { state: piRequest === pi ? state : unavailableHarnessState(piRequest ? "pi" : "codex") }
        : piRequest ? action === "reserve" ? { attempt: publicPiAttempt("reserved") }
          : action === "start" || action === "attempt-read" ? { attempt: piAttempt }
            : action === "reply" ? { attempt: publicPiAttempt("exchanging") }
              : action === "close" ? { result: { outcome: "closed", attempt: publicPiAttempt("closed") } } : undefined
          : action === "reserve" ? { reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } }
            : action === "start" ? { login } : action === "close" ? { result: closed } : undefined;
    if (!automatic) throw new Error(`Unexpected offline HTTP request: ${method} ${url}`);
    releaseFetches.push(() => call.reply(automatic));
    if (signal.aborted) abort(); else if (!action || !held.has(action)) call.reply(automatic);
    return pending;
  });
  vi.stubGlobal("fetch", fetchImpl);
  // No injected transport: this import creates the production module singleton.
  const { useAgentConfiguration } = await import("./use-agent-configuration");
  const mount = () => {
    let value!: HookValue, scheduled = false;
    const snapshots: AgentConfigurationSnapshot[] = [];
    const frame: HookFrame = { cursor: 0, slots: [], effects: [], mounted: true, schedule: () => {
      if (!frame.mounted || scheduled) return;
      scheduled = true;
      void Promise.resolve().then(() => { scheduled = false; if (frame.mounted) render(); });
    } };
    const render = () => {
      frame.cursor = 0; hookBoundary.enter(frame);
      try { value = useAgentConfiguration(); snapshots.push(value.snapshot); } finally { hookBoundary.leave(); }
      for (const effect of frame.effects.splice(0)) effect();
    };
    const result = { controller: () => value.controller, snapshot: () => value.snapshot, snapshots,
      unmount: () => { if (!frame.mounted) return; frame.mounted = false; for (const slot of [...frame.slots].reverse()) slot.cleanup?.(); } };
    mounts.push(result); render(); return result;
  };
  return { mount, calls, held, fetchImpl, state: (next: HarnessState) => { state = next; }, piAttempt: (next: StudioPiLoginAttempt) => { piAttempt = next; },
    action: (action: Action) => calls.filter(call => call.action === action),
    mutations: () => calls.filter(call => call.method !== "GET"),
    stateReads: () => calls.filter(call => call.url.endsWith("/state")),
    connect: (mounted: ReturnType<typeof mount>) => mounted.controller().connectionIntent({ action: "connect", target: mounted.snapshot().target }) };
}

describe("offline default React-hook singleton recovery across cleanup/remount (no browser or Core)", () => {
  it("mount, explicit refresh and remount perform only GET observations", async () => {
    const fixture = await setup(), first = fixture.mount(); await flush();
    expect(first.snapshot().target).toEqual({ harness: "codex", contextKey: context });
    expect(first.snapshot().loading).toBe(false); await first.controller().refresh(); await flush();
    first.unmount(); const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
    expect(returned.controller()).not.toBe(first.controller()); expect(fixture.calls.length).toBeGreaterThanOrEqual(8);
    expect(fixture.calls.every(call => call.method === "GET")).toBe(true); expect(fixture.mutations()).toHaveLength(0);
    expect(returned.snapshot().state?.execution).toBeNull();
  });

  it("remount recovers a known handle after start AbortError and closes only that handle on explicit intent", async () => {
    const fixture = await setup(); fixture.held.add("start"); const first = fixture.mount(); await flush(); fixture.connect(first); await flush();
    expect(fixture.action("start")[0]!.body).toEqual({ attemptHandle: handle }); first.unmount(); await flush();
    expect(fixture.action("start")[0]!.aborted).toBe(true); fixture.state(observed("signing-in"));
    const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
    expect(returned.snapshot().state?.connection?.login?.loginId).toBe(login.loginId);
    expect(returned.snapshot().canCloseConnection).toBe(true); expect(fixture.mutations()).toHaveLength(2);
    const readsBeforePoll = fixture.stateReads().length; await vi.advanceTimersByTimeAsync(2_001); await flush();
    expect(fixture.stateReads().length).toBeGreaterThan(readsBeforePoll); expect(fixture.mutations()).toHaveLength(2);
    returned.controller().closeConnection(); await flush();
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1); expect(fixture.action("close")).toHaveLength(1);
    expect(fixture.action("close")[0]!.body).toEqual({ attemptHandle: handle }); expect(returned.snapshot().authCloseResult).toEqual(closed);
  });

  it("remount subscribes to the same in-flight Close, shows settling, then receives its receipt and readback", async () => {
    const fixture = await setup(); fixture.held.add("start"); fixture.held.add("close");
    const first = fixture.mount(); await flush(); fixture.connect(first); await flush(); first.controller().closeConnection(); await flush();
    const closing = fixture.action("close")[0]!; first.unmount(); await flush(); expect(closing.signal.aborted).toBe(false); expect(closing.keepalive).toBe(true);
    fixture.state(observed("signing-in")); const returned = fixture.mount(); await flush();
    expect(returned.snapshot().authBusy).toBe("cancel"); expect(returned.snapshot().authDetail?.en).toMatch(/settling/i);
    expect(fixture.action("close")).toHaveLength(1); expect(fixture.mutations()).toHaveLength(3);
    const readsBeforeReceipt = fixture.stateReads().length; fixture.state(observed("signed-out")); closing.reply({ result: closed }); await flush();
    expect(returned.snapshot().authCloseResult).toEqual(closed); expect(returned.snapshot().authBusy).toBeNull();
    expect(returned.snapshot().state?.connection?.phase).toBe("signed-out"); expect(fixture.stateReads().length).toBeGreaterThan(readsBeforeReceipt);
    expect(returned.snapshots.some(snapshot => snapshot.authBusy === "cancel")).toBe(true);
    expect(returned.snapshots.some(snapshot => snapshot.authCloseResult?.attemptHandle === handle)).toBe(true);
    expect(fixture.action("close")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1);
  });

  it("restores an away terminal receipt with signed-in readback without replaying Close, login or logout", async () => {
    const fixture = await setup(); fixture.held.add("start"); fixture.held.add("close");
    const first = fixture.mount(); await flush(); fixture.connect(first); await flush(); first.controller().closeConnection(); await flush(); first.unmount(); await flush();
    const result: DeviceLoginAttemptCloseResult = { attemptHandle: handle, state: "already-terminal", cleanup: "not-applicable" };
    fixture.action("close")[0]!.reply({ result }); await flush(); fixture.state(observed("signed-in"));
    const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
    expect(returned.snapshot().authCloseResult).toEqual(result); expect(returned.snapshot().authDetail?.en).toMatch(/already terminal/i);
    expect(returned.snapshot().state?.account?.type).toBe("chatgpt"); expect(returned.snapshot().canCloseConnection).toBe(false);
    expect(returned.snapshot().state?.execution).toBeNull(); expect(fixture.mutations()).toHaveLength(3);
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1); expect(fixture.action("close")).toHaveLength(1);
  });

  it("restores an away lost-response uncertainty without automatic mutation and explicitly reconciles the original handle", async () => {
    const fixture = await setup(); fixture.held.add("start"); fixture.held.add("close");
    const first = fixture.mount(); await flush(); fixture.connect(first); await flush(); first.controller().closeConnection(); await flush(); first.unmount(); await flush();
    fixture.action("close")[0]!.reject(new TypeError("offline Close response lost")); await flush(); fixture.state(observed("signed-out"));
    const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
    expect(returned.snapshot().authCloseResult).toBeUndefined(); expect(returned.snapshot().authDetail?.en).toMatch(/uncertain/i);
    expect(returned.snapshot().authDetail?.zh).toBeTruthy(); expect(returned.snapshot().canCloseConnection).toBe(true);
    expect(returned.snapshot().authBusy).toBeNull(); expect(fixture.mutations()).toHaveLength(3);
    returned.controller().closeConnection(); returned.controller().closeConnection(); await flush();
    expect(fixture.action("close")).toHaveLength(2); expect(fixture.action("close")[1]!.body).toEqual({ attemptHandle: handle });
    fixture.action("close")[1]!.reply({ result: closed }); await flush();
    expect(returned.snapshot().authCloseResult).toEqual(closed); expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1);
    expect(fixture.mutations()).toHaveLength(4);
  });
});

// An origin generation is captured by a real mount's validated GET before the
// explicit connect intent. A later numeric GET alone cannot correlate a start
// whose provider response was never observed with the current connection.
async function beginOriginThreeUnknownStartClose() {
  const fixture = await setup(); fixture.state(observed("signed-out", 3)); fixture.held.add("start"); fixture.held.add("close");
  const first = fixture.mount(); await flush();
  expect(first.snapshot().ownerGeneration).toBe(3); expect(first.snapshot().state?.scope?.ownerGeneration).toBe(3);
  expect(fixture.mutations()).toHaveLength(0); fixture.connect(first); await flush();
  expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1);
  const start = fixture.action("start")[0]!;
  expect(start.body).toEqual({ attemptHandle: handle }); expect(start.signal.aborted).toBe(false);
  first.controller().closeConnection(); await flush(); const closing = fixture.action("close")[0]!;
  expect(fixture.action("close")).toHaveLength(1); expect(closing.body).toEqual({ attemptHandle: handle });
  expect(closing.signal).not.toBe(start.signal); expect(closing.keepalive).toBe(true);
  first.unmount(); await flush();
  expect(start.signal.aborted).toBe(true); expect(start.aborted).toBe(true);
  expect(start.rejection).toBeInstanceOf(DOMException); expect((start.rejection as DOMException).name).toBe("AbortError");
  expect(closing.signal.aborted).toBe(false);
  return { fixture, closing };
}

function generationFourCurrentObservation(): HarnessState {
  // Deliberately preserve a current account and a different observed pending
  // login. The unknown start's original handle supplies no authority over it.
  return { ...observed("signing-in", 4), account: { type: "chatgpt", label: "Current generation four account" },
    connection: { phase: "signing-in", login: { ...login, loginId: "current-generation-four-provider-id" }, connectionRef: null } };
}
async function observeGenerationFourWithoutMutation(fixture: Awaited<ReturnType<typeof setup>>) {
  const current = generationFourCurrentObservation(), mutationCount = fixture.mutations().length;
  fixture.state(current); const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
  expect(returned.snapshot().ownerGeneration).toBe(4); expect(returned.snapshot().state).toEqual(current);
  expect(returned.snapshot().state?.account?.label).toBe("Current generation four account");
  expect(returned.snapshot().authCloseScope).toBe("attempt"); expect(returned.snapshot().state?.execution).toBeNull();
  expect(fixture.mutations()).toHaveLength(mutationCount);
  const readsBeforePoll = fixture.stateReads().length; await vi.advanceTimersByTimeAsync(2_001); await flush();
  expect(fixture.stateReads().length).toBeGreaterThan(readsBeforePoll); expect(fixture.mutations()).toHaveLength(mutationCount);
  expect(returned.snapshot().ownerGeneration).toBe(4); expect(returned.snapshot().state).toEqual(current);
  expect(returned.snapshot().authCloseScope).toBe("attempt");
  return { returned, current };
}

describe("offline default hook preserves numeric origin evidence without correlating unknown starts", () => {
  it("origin generation 3 survives a reserve-only Close and readback 3 without starting the provider", async () => {
    const fixture = await setup(); fixture.state(observed("signed-out", 3)); fixture.held.add("reserve"); fixture.held.add("close");
    const first = fixture.mount(); await flush(); expect(first.snapshot().ownerGeneration).toBe(3); expect(fixture.mutations()).toHaveLength(0);
    fixture.connect(first); await flush(); expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(0);
    first.controller().closeConnection(); await flush(); expect(fixture.action("close")).toHaveLength(0);
    fixture.action("reserve")[0]!.reply({ reservation: { attemptHandle: handle, expiresAt: Date.now() + 120_000 } }); await flush();
    expect(fixture.action("start")).toHaveLength(0); expect(fixture.action("close")).toHaveLength(1);
    expect(fixture.action("close")[0]!.body).toEqual({ attemptHandle: handle });
    const result: DeviceLoginAttemptCloseResult = { attemptHandle: handle, state: "closed", cleanup: "not-started" };
    fixture.action("close")[0]!.reply({ result }); await flush();
    expect(first.snapshot().authCloseResult).toEqual(result); expect(first.snapshot().authCloseScope).toBe("connection");
    expect(first.snapshot().ownerGeneration).toBe(3); expect(first.snapshot().state).toEqual(observed("signed-out", 3));
    first.unmount(); const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
    expect(returned.snapshot().authCloseResult).toEqual(result); expect(returned.snapshot().authCloseScope).toBe("connection");
    expect(returned.snapshot().ownerGeneration).toBe(3); expect(returned.snapshot().state?.execution).toBeNull();
    returned.controller().closeConnection(); returned.controller().closeConnection(); await flush();
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(0); expect(fixture.action("close")).toHaveLength(1);
    expect(fixture.mutations()).toHaveLength(2);
  });

  it("unknown origin-3 start remounts into GET4 while its original Close is settling without clearing the current observation", async () => {
    const { fixture, closing } = await beginOriginThreeUnknownStartClose();
    const current = generationFourCurrentObservation(); fixture.state(current);
    const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
    expect(returned.snapshot().authBusy).toBe("cancel"); expect(returned.snapshot().authDetail?.en).toMatch(/settling.*original attempt/i);
    expect(returned.snapshot().authCloseScope).toBe("attempt"); expect(returned.snapshot().authCloseResult).toBeUndefined();
    expect(returned.snapshot().ownerGeneration).toBe(4); expect(returned.snapshot().state).toEqual(current);
    returned.controller().closeConnection(); returned.controller().closeConnection(); await flush();
    expect(fixture.action("close")).toHaveLength(1); expect(closing.signal.aborted).toBe(false); expect(fixture.mutations()).toHaveLength(3);
    const readsBeforeReceipt = fixture.stateReads().length; closing.reply({ result: closed }); await flush();
    expect(returned.snapshot().authCloseResult).toEqual(closed); expect(returned.snapshot().authCloseScope).toBe("attempt");
    expect(returned.snapshot().authBusy).toBeNull(); expect(returned.snapshot().ownerGeneration).toBe(4);
    expect(returned.snapshot().state).toEqual(current); expect(fixture.stateReads().length).toBeGreaterThan(readsBeforeReceipt);
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1); expect(fixture.action("close")).toHaveLength(1);
    expect(fixture.mutations()).toHaveLength(3);
  });

  it.each([
    { state: "closed" as const, cleanup: "cancel-acknowledged" as const },
    { state: "already-terminal" as const, cleanup: "not-applicable" as const },
    { state: "closed" as const, cleanup: "unconfirmed" as const },
    { state: "unknown-or-expired" as const, cleanup: "not-applicable" as const },
  ])("unknown origin-3 start restores cached $state/$cleanup as attempt-only beside GET generation 4", async receipt => {
    const { fixture, closing } = await beginOriginThreeUnknownStartClose();
    const result: DeviceLoginAttemptCloseResult = { attemptHandle: handle, ...receipt };
    closing.reply({ result }); await flush();
    const { returned, current } = await observeGenerationFourWithoutMutation(fixture);
    expect(returned.snapshot().authCloseResult).toEqual(result); expect(returned.snapshot().authDetail?.en).toMatch(/original attempt|not correlated/i);
    expect(returned.snapshot().authDetail?.zh).toBeTruthy(); expect(fixture.mutations()).toHaveLength(3);
    returned.controller().closeConnection(); returned.controller().closeConnection(); await flush();
    expect(returned.snapshot().ownerGeneration).toBe(4); expect(returned.snapshot().state).toEqual(current);
    expect(returned.snapshot().authCloseScope).toBe("attempt");
    if (receipt.cleanup === "unconfirmed") {
      expect(fixture.action("close")).toHaveLength(2); expect(fixture.action("close")[1]!.body).toEqual({ attemptHandle: handle });
      fixture.action("close")[1]!.reply({ result: closed }); await flush();
      expect(returned.snapshot().authCloseResult).toEqual(closed); expect(fixture.mutations()).toHaveLength(4);
    } else {
      // Terminal receipt clicks are read-only and do not check a newer login.
      expect(fixture.action("close")).toHaveLength(1); expect(returned.snapshot().authCloseResult).toEqual(result);
      expect(returned.snapshot().canCloseConnection).toBe(false); expect(fixture.mutations()).toHaveLength(3);
    }
    expect(returned.snapshot().authCloseScope).toBe("attempt"); expect(returned.snapshot().ownerGeneration).toBe(4);
    expect(returned.snapshot().state).toEqual(current); expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1);
  });

  it.each(["reject", "timeout"] as const)("unknown origin-3 start restores away Close %s at GET4 and only explicitly checks the original handle", async failure => {
    const { fixture, closing } = await beginOriginThreeUnknownStartClose();
    if (failure === "reject") closing.reject(new TypeError("offline original Close response lost"));
    else { await vi.advanceTimersByTimeAsync(15_001); expect(closing.signal.aborted).toBe(true); expect((closing.rejection as DOMException).name).toBe("AbortError"); }
    await flush(); const { returned, current } = await observeGenerationFourWithoutMutation(fixture);
    expect(returned.snapshot().authCloseResult).toBeUndefined(); expect(returned.snapshot().authDetail?.en).toMatch(/uncertain/i);
    expect(returned.snapshot().authDetail?.zh).toBeTruthy(); expect(returned.snapshot().authBusy).toBeNull();
    expect(returned.snapshot().canCloseConnection).toBe(true); expect(fixture.mutations()).toHaveLength(3);
    returned.controller().closeConnection(); returned.controller().closeConnection(); await flush();
    expect(fixture.action("close")).toHaveLength(2); expect(fixture.action("close")[1]!.body).toEqual({ attemptHandle: handle });
    expect(returned.snapshot().authCloseScope).toBe("attempt"); expect(returned.snapshot().state).toEqual(current);
    fixture.action("close")[1]!.reply({ result: closed }); await flush();
    expect(returned.snapshot().authCloseResult).toEqual(closed); expect(returned.snapshot().authCloseScope).toBe("attempt");
    expect(returned.snapshot().ownerGeneration).toBe(4); expect(returned.snapshot().state).toEqual(current);
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1); expect(fixture.mutations()).toHaveLength(4);
  });
});


describe("offline Pi default hook uses public attempts and detach-only HTTP recovery", () => {
  it("S2: default-transport remount and periodic reserved GET preserve the finite start refusal without mutation", async () => {
    const f = await setup(true); f.piAttempt(publicPiAttempt("reserved")); f.held.add("start");
    const first = f.mount(); await flush(); f.connect(first); await flush();
    f.action("start")[0]!.reply({ error: { code: "PI_SCOPE_BUSY", message: "PRIVATE-HTTP-REFUSAL" } }, 409); await flush();
    expect(first.snapshot().piAuthDetail?.en).toMatch(/scope.*busy/i); first.unmount();
    f.held.add("attempt-read"); const returned = f.mount(); await flush();
    expect(returned.snapshot().piLoginAttempt).toMatchObject({ handle: piHandle, status: "reserved", challenge: null, prompt: null });
    expect(returned.snapshot().piAuthDetail?.en).toMatch(/scope.*busy/i);
    f.action("attempt-read").at(-1)!.reply({ attempt: publicPiAttempt("reserved") }); f.held.delete("attempt-read"); await flush();
    await returned.controller().refresh(); await vi.advanceTimersByTimeAsync(2_001); await flush();
    expect(returned.snapshot().piAuthDetail?.en).toMatch(/scope.*busy/i); expect(returned.snapshot().piAuthBusy).toBeNull();
    expect(JSON.stringify(returned.snapshot())).not.toContain("PRIVATE-HTTP-REFUSAL"); expect(f.mutations()).toHaveLength(2);
    expect(f.action("reserve")).toHaveLength(1); expect(f.action("start")).toHaveLength(1); expect(f.action("reply")).toHaveLength(0); expect(f.action("close")).toHaveLength(0);
    returned.controller().closePiLogin(returned.snapshot().target, piHandle); await flush();
    expect(returned.snapshot().piCloseResult?.outcome).toBe("closed"); expect(returned.snapshot().piAuthDetail?.en).not.toMatch(/scope.*busy/i);
  });

  it("mount/refresh/remount without a known Pi handle performs only public GET observations", async () => {
    const fixture = await setup(true), first = fixture.mount(); await flush();
    expect(first.snapshot().target).toEqual({ harness: "pi", contextKey: piContext });
    expect(first.snapshot().piCapabilities).toEqual({ canStartLogin: true, canCloseAttempt: false, canReply: false, canLogout: false });
    await first.controller().refresh(); first.unmount(); const returned = fixture.mount(); await flush();
    expect(fixture.calls.every(call => call.method === "GET")).toBe(true); expect(fixture.action("attempt-read")).toHaveLength(0);
    expect(returned.snapshot().state?.account).toBeNull(); expect(returned.snapshot().state?.execution).toBeNull();
  });

  it("AbortError start cleanup recovers the same handle through GET and a captured reply is never replayed on remount", async () => {
    const fixture = await setup(true); fixture.held.add("start"); const first = fixture.mount(); await flush(); fixture.connect(first); await flush();
    const start = fixture.action("start")[0]!; expect(start.body).toEqual({ attemptHandle: piHandle }); first.unmount(); await flush();
    expect(start.signal.aborted).toBe(true); expect(start.rejection).toBeInstanceOf(DOMException); expect((start.rejection as DOMException).name).toBe("AbortError");
    const returned = fixture.mount(); await flush(); expect(returned.snapshot().piLoginAttempt?.handle).toBe(piHandle);
    expect(returned.snapshot().piLoginAttempt?.prompt?.promptId).toBe("offline-pi-prompt"); expect(fixture.action("attempt-read")).toHaveLength(1);
    const mutations = fixture.mutations().length; await vi.advanceTimersByTimeAsync(2_001); await flush();
    expect(fixture.action("attempt-read").length).toBeGreaterThan(1); expect(fixture.mutations()).toHaveLength(mutations);
    const intent = { target: returned.snapshot().target, attemptHandle: piHandle, promptId: "offline-pi-prompt" };
    await returned.controller().replyPiLogin(intent, "synthetic-local-callback"); await flush();
    expect(fixture.action("reply")[0]!.body).toEqual({ attemptHandle: piHandle, promptId: "offline-pi-prompt", callbackUrl: "synthetic-local-callback" });
    expect(JSON.stringify(returned.snapshot())).not.toContain("synthetic-local-callback"); fixture.piAttempt(publicPiAttempt("exchanging")); returned.unmount();
    const third = fixture.mount(); await flush(); expect(third.snapshot().piLoginAttempt?.status).toBe("exchanging");
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1); expect(fixture.action("reply")).toHaveLength(1); expect(fixture.action("close")).toHaveLength(0);
    expect(fixture.calls.some(call => /codex\/(login|bind|logout)/.test(call.url))).toBe(false);
  });

  it("Close stays alive across AbortError cleanup/remount and restores its receipt without changing current generation or dirty draft", async () => {
    const fixture = await setup(true); fixture.held.add("start"); fixture.held.add("close"); const first = fixture.mount(); await flush(); fixture.connect(first); await flush();
    first.controller().closePiLogin(first.snapshot().target, piHandle); first.controller().closePiLogin(first.snapshot().target, piHandle); await flush();
    const close = fixture.action("close")[0]!, start = fixture.action("start")[0]!; expect(close.keepalive).toBe(true); expect(close.signal).not.toBe(start.signal);
    first.unmount(); await flush(); expect(start.signal.aborted).toBe(true); expect(close.signal.aborted).toBe(false);
    fixture.state({ ...observedPi(4), localAuthentication: "oauth-present" }); const returned = fixture.mount(); await flush();
    returned.controller().edit({ action: "choose-option", target: returned.snapshot().target, field: "model", choiceKey: "retained-pi-model" }); await flush();
    expect(returned.snapshot().piAuthBusy).toBe("close"); expect(returned.snapshot().ownerGeneration).toBe(4); const draft = returned.snapshot().draft;
    const result: StudioPiCloseResult = { outcome: "already-committed", attempt: publicPiAttempt("saved") }; close.reply({ result }); await flush();
    expect(returned.snapshot().piCloseResult).toEqual(result); expect(returned.snapshot().piAuthBusy).toBeNull();
    expect(returned.snapshot().ownerGeneration).toBe(4); expect(returned.snapshot().draft).toEqual(draft); expect(returned.snapshot().revision).toBe(0);
    expect(returned.snapshot().state?.localAuthentication).toBe("oauth-present"); expect(returned.snapshot().state?.execution).toBeNull();
    returned.controller().closePiLogin(returned.snapshot().target, piHandle); await flush(); expect(fixture.action("close")).toHaveLength(1);
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1); expect(fixture.action("reply")).toHaveLength(0);
  });

  it.each(["lost", "timeout"] as const)("%s Close is uncertain after remount, never automatically replayed, and an explicit exact-handle check is deduplicated", async outcome => {
    const fixture = await setup(true); fixture.held.add("close"); const first = fixture.mount(); await flush(); fixture.connect(first); await flush();
    first.controller().closePiLogin(first.snapshot().target, piHandle); await flush(); const close = fixture.action("close")[0]!; first.unmount(); await flush();
    if (outcome === "lost") close.reject(new TypeError("offline response lost")); else await vi.advanceTimersByTimeAsync(15_001); await flush();
    if (outcome === "timeout") { expect(close.signal.aborted).toBe(true); expect((close.rejection as DOMException).name).toBe("AbortError"); }
    const returned = fixture.mount(); await flush(); await returned.controller().refresh(); await flush();
    expect(returned.snapshot().piAuthDetail?.en).toMatch(/uncertain/i); expect(returned.snapshot().piCanClose).toBe(true); expect(fixture.action("close")).toHaveLength(1);
    returned.controller().closePiLogin(returned.snapshot().target, "other-pi-handle"); await flush(); expect(fixture.action("close")).toHaveLength(1);
    returned.controller().closePiLogin(returned.snapshot().target, piHandle); returned.controller().closePiLogin(returned.snapshot().target, piHandle); await flush();
    expect(fixture.action("close")).toHaveLength(2); expect(fixture.action("close")[1]!.body).toEqual({ attemptHandle: piHandle });
    fixture.action("close")[1]!.reply({ result: { outcome: "closed", attempt: publicPiAttempt("closed") } }); await flush();
    expect(returned.snapshot().piCloseResult?.outcome).toBe("closed"); expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1);
  });

  it("a detached held attempt read gets AbortError and cannot expose an old prompt after a different context is selected", async () => {
    const fixture = await setup(true), first = fixture.mount(); await flush(); fixture.connect(first); await flush(); fixture.held.add("attempt-read");
    const reading = first.controller().refreshPiLogin(); await flush(); const read = fixture.action("attempt-read")[0]!;
    first.controller().selectTarget({ harness: "pi", contextKey: "different-pi-context" }); await reading; await flush();
    expect(read.signal.aborted).toBe(true); expect((read.rejection as DOMException).name).toBe("AbortError");
    expect(first.snapshot().piLoginAttempt).toBeNull(); expect(first.snapshot().piCloseResult).toBeUndefined(); expect(fixture.action("close")).toHaveLength(0);
    expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1);
  });
});
