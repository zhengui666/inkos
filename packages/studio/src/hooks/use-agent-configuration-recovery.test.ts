import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableHarnessState, type AgentSettings, type DeviceLoginAttemptCloseResult, type HarnessState } from "../shared/agent-configuration";
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
type Action = "reserve" | "start" | "close";
interface HttpCall {
  readonly url: string; readonly method: string; readonly body: unknown; readonly signal: AbortSignal;
  readonly keepalive: boolean | undefined; readonly action?: Action;
  aborted: boolean; reply(value: unknown): void; reject(error: unknown): void;
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

async function setup() {
  let state = observed();
  const held = new Set<Action>(), calls: HttpCall[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET", signal = init?.signal as AbortSignal;
    const action: Action | undefined = url.endsWith("/login/reserve") ? "reserve" : url.endsWith("/login/close") ? "close" : url.endsWith("/login") ? "start" : undefined;
    let resolve!: (response: Response) => void, reject!: (error: unknown) => void;
    const pending = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    const call: HttpCall = { url, method, signal, action, body: init?.body ? JSON.parse(String(init.body)) : undefined,
      keepalive: init?.keepalive, aborted: signal.aborted,
      reply: value => { signal.removeEventListener("abort", abort); resolve(Response.json(value)); },
      reject: error => { signal.removeEventListener("abort", abort); reject(error); } };
    const abort = () => { call.aborted = true; call.reject(new DOMException("The offline fetch was aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true }); calls.push(call);
    const automatic = url.endsWith("/settings") ? { settings: initial }
      : url.endsWith("/state") ? { state: url.includes("/pi/") ? unavailableHarnessState("pi") : state }
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
  return { mount, calls, held, fetchImpl, state: (next: HarnessState) => { state = next; },
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
