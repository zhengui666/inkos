import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableHarnessState, type AgentSettings as Settings, type DeviceLoginAttemptCloseResult, type HarnessState } from "../shared/agent-configuration";
import type { AgentConfigurationSnapshot } from "../hooks/agent-configuration-controller";

interface Slot { dependencies?: readonly unknown[]; value?: unknown; cleanup?: () => void; subscribe?: unknown }
interface PageFrame { cursor: number; slots: Slot[]; effects: (() => void)[]; mounted: boolean; schedule(): void; snapshot?: () => AgentConfigurationSnapshot }
const boundary = vi.hoisted(() => {
  let active: PageFrame | undefined;
  return { enter: (frame: PageFrame) => { active = frame; }, leave: () => { active = undefined; },
    current: () => { if (!active) throw new Error("Page hook outside offline React boundary"); return active; } };
});

// Simulate only React's memo/effect/subscription boundary. Page, Panel, Card,
// default hook singleton, controller, transport and fetchJson remain real code.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...actual,
    useMemo: <T>(create: () => T, dependencies?: readonly unknown[]): T => {
      const frame = boundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (!old || !same(old.dependencies, dependencies)) frame.slots[index] = { dependencies, value: create() };
      return frame.slots[index]!.value as T;
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const frame = boundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (old && same(old.dependencies, dependencies)) return;
      const slot: Slot = { dependencies }; frame.slots[index] = slot;
      frame.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); if (cleanup) slot.cleanup = cleanup; });
    },
    useSyncExternalStore: <T>(subscribe: (notify: () => void) => () => void, getSnapshot: () => T): T => {
      const frame = boundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (old?.subscribe !== subscribe) { old?.cleanup?.(); frame.slots[index] = { subscribe, cleanup: subscribe(frame.schedule) }; }
      frame.snapshot = getSnapshot as unknown as () => AgentConfigurationSnapshot;
      return getSnapshot();
    },
  };
});

type Element = ReactElement<Record<string, unknown>>;
function native(node: ReactNode, tag: string): Element[] {
  const result: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (typeof child.type === "function") result.push(...native((child.type as (props: Record<string, unknown>) => ReactNode)(child.props), tag));
    else { if (child.type === tag) result.push(child); result.push(...native(child.props.children as ReactNode, tag)); }
  }); return result;
}
function component(node: ReactNode, name: string): Element | undefined {
  let found: Element | undefined;
  Children.forEach(node, child => {
    if (found || !isValidElement<Record<string, unknown>>(child)) return;
    if (typeof child.type === "function") {
      if (child.type.name === name) found = child;
      else found = component((child.type as (props: Record<string, unknown>) => ReactNode)(child.props), name);
    } else found = component(child.props.children as ReactNode, name);
  }); return found;
}
function contents(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? typeof child.type === "function" ? contents((child.type as (props: unknown) => ReactNode)(child.props)) : contents(child.props.children)
    : String(child)).join("");
}
const labels = (isZh: boolean) => ({ connect: isZh ? "使用 ChatGPT 登录" : "Sign in with ChatGPT",
  close: isZh ? "关闭并取消登录" : "Close and cancel sign-in", logout: isZh ? "退出 ChatGPT" : "Sign out of ChatGPT",
  check: isZh ? "核对状态" : "Check status", refresh: isZh ? "刷新配置与观察状态" : "Refresh settings and observations",
  bind: isZh ? "绑定当前 ChatGPT 模型连接" : "Bind current ChatGPT model connection",
  save: isZh ? "保存默认配置 · Codex" : "Save defaults · Codex" });
const nativePreferences = { model: null, effort: null, speed: null };
const initial: Settings = { schemaVersion: 1, revision: 0, selectedHarnessId: "codex", modelConnectionRef: null,
  harnessPreferences: { codex: nativePreferences, pi: nativePreferences } };
const context = "offline-page-context", originalHandle = "page-reserved-1";
const originalLogin = { loginId: "page-provider-1", status: "pending" as const, verificationUrl: "https://auth.openai.com/codex/device", userCode: "OFFLINE-PAGE-CODE" };
const closed: DeviceLoginAttemptCloseResult = { attemptHandle: originalHandle, state: "closed", cleanup: "cancel-acknowledged" };
function observed(phase: NonNullable<HarnessState["connection"]>["phase"] = "signed-out", generation: number | null = 3): HarnessState {
  const scope = { harnessId: "codex" as const, authContextRef: context, ownerGeneration: generation, adapterVersion: "offline", catalogVersion: "offline" };
  return { ...unavailableHarnessState("codex"), availability: "available", installation: "installed", scope,
    account: phase === "signed-in" ? { type: "chatgpt", label: `Observed account at generation ${generation}` } : null,
    connection: { phase, login: phase === "signing-in" ? originalLogin : null, connectionRef: null },
    catalog: { scope, speedSupport: { native: "unknown", other: "unknown" }, value: { harnessId: "codex", adapterVersion: "offline",
      supportsChatGptOauth: true, supportsTools: true, supportsStreaming: true,
      models: ["native", "other"].map(modelId => ({ modelId, efforts: [], serviceTiers: [], defaultEffort: null, defaultServiceTier: null })),
      nativeDefaults: { modelId: "native", effort: null, serviceTier: null } } } };
}
type Action = "reserve" | "start" | "close" | "logout" | "bind" | "save";
interface Call { readonly url: string; readonly method: string; readonly action?: Action; readonly body: unknown; readonly signal: AbortSignal;
  readonly keepalive?: boolean; aborted: boolean; rejection?: unknown; reply(value: unknown): void; reject(error: unknown): void }
async function flush() { for (let index = 0; index < 100; index++) await Promise.resolve(); }
const mounts: { unmount(): void }[] = [], releases: (() => void)[] = [];
beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(async () => {
  for (const page of mounts.splice(0)) page.unmount(); for (const release of releases.splice(0)) release();
  await flush(); vi.unstubAllGlobals(); vi.useRealTimers();
});

async function setup(initialState = observed()) {
  let state = initialState, stored = initial, reservationNumber = 0, startNumber = 0;
  const calls: Call[] = [], held = new Set<Action>();
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET", signal = init?.signal as AbortSignal;
    const action: Action | undefined = method === "PUT" ? "save" : url.endsWith("/login/reserve") ? "reserve" : url.endsWith("/login/close") ? "close"
      : url.endsWith("/login") ? "start" : url.endsWith("/logout") ? "logout" : url.endsWith("/bind") ? "bind" : undefined;
    let resolve!: (response: Response) => void, reject!: (error: unknown) => void;
    const pending = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    const call: Call = { url, method, action, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal, keepalive: init?.keepalive, aborted: signal.aborted,
      reply: value => { signal.removeEventListener("abort", abort); resolve(Response.json(value)); },
      reject: error => { call.rejection = error; signal.removeEventListener("abort", abort); reject(error); } };
    const abort = () => { call.aborted = true; call.reject(new DOMException("Offline page fetch aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true }); calls.push(call);
    let automatic: unknown;
    if (action === "reserve") automatic = { reservation: { attemptHandle: `page-reserved-${++reservationNumber}`, expiresAt: Date.now() + 120_000 } };
    else if (action === "start") automatic = { login: { ...originalLogin, loginId: `page-provider-${++startNumber}` } };
    else if (action === "close") automatic = { result: { ...closed, attemptHandle: (call.body as { attemptHandle: string }).attemptHandle } };
    else if (action === "logout") automatic = { ok: true };
    else if (action === "bind") automatic = { settings: { ...stored, revision: stored.revision + 1, modelConnectionRef: "offline-bound-ref" } };
    else if (action === "save") {
      const request = call.body as { patch: { harnessPreferences: { codex: Settings["harnessPreferences"]["codex"] } } };
      automatic = { settings: { ...stored, revision: stored.revision + 1, harnessPreferences: { ...stored.harnessPreferences, codex: request.patch.harnessPreferences.codex } } };
    } else if (url.endsWith("/settings")) automatic = { settings: stored };
    else if (url.endsWith("/state")) automatic = { state: url.includes("/pi/") ? unavailableHarnessState("pi") : state };
    else throw new Error(`Unexpected offline Page request ${method} ${url}`);
    releases.push(() => call.reply(automatic));
    if (signal.aborted) abort(); else if (!action || !held.has(action)) call.reply(automatic);
    return pending;
  });
  vi.stubGlobal("fetch", fetchImpl);
  const { AgentSettings } = await import("./AgentSettings");
  const mount = (isZh = false) => {
    let tree: ReactNode, scheduled = false;
    const frame: PageFrame = { cursor: 0, slots: [], effects: [], mounted: true, schedule: () => {
      if (!frame.mounted || scheduled) return; scheduled = true;
      void Promise.resolve().then(() => { scheduled = false; if (frame.mounted) render(); });
    } };
    const render = () => {
      frame.cursor = 0; boundary.enter(frame);
      try { tree = AgentSettings({ isZh }); } finally { boundary.leave(); }
      for (const effect of frame.effects.splice(0)) effect();
    };
    const button = (label: string) => {
      const result = native(tree, "button").find(control => contents(control.props.children as ReactNode) === label);
      expect(result, `Missing real Page button ${label}`).toBeDefined(); return result!;
    };
    const page = { labels: labels(isZh), snapshot: () => frame.snapshot!(), native: (tag: string) => native(tree, tag),
      component: (name: string) => { const result = component(tree, name); expect(result, `Missing real ${name}`).toBeDefined(); return result!; },
      button, click: (label: string) => { const control = button(label); expect(control.props.disabled, `${label} disabled`).toBeFalsy(); (control.props.onClick as () => void)(); },
      chooseModel: (value: string) => {
        const control = native(tree, "select").find(item => item.props["aria-label"] === (isZh ? "模型" : "Model"))!;
        expect(control).toBeDefined(); expect(control.props.disabled).toBeFalsy(); (control.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
      },
      alerts: () => native(tree, "p").filter(item => item.props.role === "alert").map(item => contents(item.props.children as ReactNode)),
      unmount: () => { if (!frame.mounted) return; frame.mounted = false; for (const slot of [...frame.slots].reverse()) slot.cleanup?.(); } };
    mounts.push(page); render(); return page;
  };
  return { mount, calls, held, state: (value: HarnessState) => { state = value; }, settings: (value: Settings) => { stored = value; },
    action: (name: Action) => calls.filter(call => call.action === name), mutations: () => calls.filter(call => call.method !== "GET"),
    stateReads: () => calls.filter(call => call.url.endsWith("/state")) };
}
async function beginAttemptOnlyClose(isZh = false) {
  const fixture = await setup(); fixture.held.add("start"); fixture.held.add("close");
  const first = fixture.mount(isZh); await flush(); expect(first.snapshot().ownerGeneration).toBe(3); expect(fixture.mutations()).toHaveLength(0);
  first.click(first.labels.connect); await flush(); first.click(first.labels.close); await flush();
  const start = fixture.action("start")[0]!, closing = fixture.action("close")[0]!;
  first.unmount(); await flush(); expect(start.signal.aborted).toBe(true); expect((start.rejection as DOMException).name).toBe("AbortError");
  expect(closing.signal.aborted).toBe(false); expect(closing.keepalive).toBe(true); expect(closing.body).toEqual({ attemptHandle: originalHandle });
  fixture.state(observed("signed-out", 4)); const page = fixture.mount(isZh); await flush();
  expect(page.snapshot().authBusy).toBe("cancel"); expect(page.snapshot().authBlocking).toBeNull(); expect(page.snapshot().authCloseScope).toBe("attempt");
  expect(page.snapshot().ownerGeneration).toBe(4); expect(page.snapshot().state?.connection?.phase).toBe("signed-out");
  return { fixture, page, closing };
}
function expectBaseProtection(page: ReturnType<Awaited<ReturnType<typeof setup>>["mount"]>) {
  expect(page.component("AgentConfigurationPanel").props.disabled).toBe(true);
  expect(page.component("ChatGptConnectionCard").props.disabled).toBe(true);
  expect(page.button(page.labels.save).props.disabled).toBe(true); expect(page.button(page.labels.bind).props.disabled).toBe(true);
  expect(page.button(page.labels.check).props.disabled).toBe(true);
  expect(page.native("fieldset")[0]!.props.disabled).toBe(true);
  expect(page.native("select").every(select => select.props.disabled === true)).toBe(true);
}

describe("real AgentSettings → Panel → Card auth controls with default hook/transport (offline React boundary)", () => {
  it("attempt-only Close permits the actual Connect button and replaces correlation before the new reserve response", async () => {
    const { fixture, page, closing } = await beginAttemptOnlyClose();
    expectBaseProtection(page); expect(page.component("AgentConfigurationPanel").props.connectDisabled).toBe(false);
    expect(page.component("ChatGptConnectionCard").props.connectDisabled).toBe(false); expect(page.button(page.labels.connect).props.disabled).toBe(false);
    expect(page.alerts().join(" ")).toMatch(/original attempt.*current connection observation is separate/i);
    page.click(page.labels.refresh); await flush(); expect(fixture.mutations()).toHaveLength(3);
    fixture.held.add("reserve"); page.click(page.labels.connect); await flush();
    expect(fixture.action("reserve")).toHaveLength(2); expect(fixture.action("start")).toHaveLength(1); expect(fixture.action("close")).toHaveLength(1);
    expect(page.snapshot().authBusy).toBe("login"); expect(page.snapshot().authBlocking).toBe("login");
    closing.reply({ result: closed }); await flush();
    expect(page.snapshot().authBusy).toBe("login"); expect(page.snapshot().authBlocking).toBe("login");
    expect(page.snapshot().authCloseResult).toBeUndefined(); expect(page.snapshot().authCloseScope).toBeUndefined();
    expect(page.alerts().join(" ")).not.toMatch(/original attempt/i);
    fixture.action("reserve")[1]!.reply({ reservation: { attemptHandle: "new-page-reservation", expiresAt: Date.now() + 120_000 } }); await flush();
    expect(fixture.action("start")).toHaveLength(2); expect(fixture.action("start")[1]!.body).toEqual({ attemptHandle: "new-page-reservation" });
    const newLogin = { ...originalLogin, loginId: "new-page-provider-id", userCode: "NEW-PUBLIC-CODE" };
    const next = observed("signing-in", 5); fixture.state({ ...next, connection: { ...next.connection!, login: newLogin } });
    fixture.action("start")[1]!.reply({ login: newLogin }); await flush();
    expect(page.snapshot().state?.connection?.login?.loginId).toBe(newLogin.loginId); expect(page.snapshot().ownerGeneration).toBe(5);
    expect(page.snapshot().authCloseResult).toBeUndefined(); expect(fixture.action("close")).toHaveLength(1);
    expect(fixture.mutations()).toHaveLength(5); expect(fixture.action("logout")).toHaveLength(0); expect(fixture.action("bind")).toHaveLength(0);
  });

  it.each([false, true])("attempt-only pending Page exposes its scoped copy and protects every control except Connect (isZh=%s)", async isZh => {
    const { fixture, page } = await beginAttemptOnlyClose(isZh); expectBaseProtection(page);
    expect(page.button(page.labels.connect).props.disabled).toBe(false);
    expect(page.alerts().join(" ")).toMatch(isZh ? /原尝试.*当前连接观察独立/ : /original attempt.*current connection observation is separate/i);
    const draft = page.snapshot().draft, readCount = fixture.stateReads().length;
    const select = page.native("select")[0]!; (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "other" } });
    const pi = page.native("input").find(input => input.props.value === "pi")!; (pi.props.onChange as () => void)();
    (page.button(page.labels.save).props.onClick as () => void)(); (page.button(page.labels.check).props.onClick as () => void)(); await flush();
    expect(page.snapshot().draft).toEqual(draft); expect(page.snapshot().target.harness).toBe("codex");
    expect(fixture.stateReads()).toHaveLength(readCount); expect(fixture.mutations()).toHaveLength(3);
    expect(fixture.action("save")).toHaveLength(0); expect(fixture.action("bind")).toHaveLength(0);
  });

  it.each(["login", "logout", "bind", "connection-close"] as const)("current %s blocks the actual Connect button and its Card emit while preserving other guards", async action => {
    const fixture = await setup(observed(action === "logout" || action === "bind" ? "signed-in" : "signed-out", null));
    const page = fixture.mount(); await flush(); page.chooseModel("other"); await flush(); expect(page.button(page.labels.save).props.disabled).toBe(false);
    if (action === "login") { fixture.held.add("reserve"); page.click(page.labels.connect); }
    else if (action === "logout") { fixture.held.add("logout"); page.click(page.labels.logout); }
    else if (action === "bind") { fixture.held.add("bind"); page.click(page.labels.bind); }
    else {
      fixture.held.add("close"); page.click(page.labels.connect); await flush();
      fixture.state(observed("signing-in", null)); page.click(page.labels.refresh); await flush();
      page.click(page.labels.close);
    }
    await flush(); fixture.state(observed("signed-out", null)); page.click(page.labels.refresh); await flush();
    const blocker = action === "connection-close" ? "cancel" : action;
    // The current scoped signed-out observation makes Card.canConnect true.
    // Equal null generation preserves the still-pending authentication owner.
    expect(page.snapshot().state?.availability).toBe("available"); expect(page.snapshot().state?.connection?.phase).toBe("signed-out");
    expect(page.snapshot().ownerGeneration).toBeNull();
    expect(page.snapshot().authBusy).toBe(blocker); expect(page.snapshot().authBlocking).toBe(blocker);
    if (action === "connection-close") expect(page.snapshot().authCloseScope).toBe("connection");
    expectBaseProtection(page); expect(page.component("AgentConfigurationPanel").props.connectDisabled).toBe(true);
    expect(page.component("ChatGptConnectionCard").props.connectDisabled).toBe(true);
    const connect = page.button(page.labels.connect); expect(connect.props.disabled).toBe(true);
    const mutationCount = fixture.mutations().length, readCount = fixture.stateReads().length;
    // Invoke the actual disabled Card handler as an additional emit-guard check.
    (connect.props.onClick as () => void)(); (page.button(page.labels.save).props.onClick as () => void)();
    (page.button(page.labels.check).props.onClick as () => void)(); await flush();
    expect(fixture.mutations()).toHaveLength(mutationCount); expect(fixture.stateReads()).toHaveLength(readCount);
    expect(fixture.action("save")).toHaveLength(0); expect(page.snapshot().draft.model).toBe("other");
  });

  it("Save remains a single protected Panel submission while newer model edits remain controlled", async () => {
    const fixture = await setup(); fixture.held.add("save"); const page = fixture.mount(); await flush(); page.chooseModel("other"); await flush();
    page.click(page.labels.save); await flush(); expect(fixture.action("save")).toHaveLength(1); expect(page.snapshot().savePhase).toBe("saving");
    const saving = page.button("Saving…"); expect(saving.props.disabled).toBe(true); (saving.props.onClick as () => void)(); await flush();
    page.chooseModel("native"); await flush(); expect(page.snapshot().draft.model).toBe("native");
    expect(page.snapshot().submitted?.preferences.model).toBe("other"); expect(fixture.action("save")).toHaveLength(1);
    const stored: Settings = { ...initial, revision: 1, harnessPreferences: { ...initial.harnessPreferences, codex: { ...nativePreferences, model: "other" } } };
    fixture.settings(stored); fixture.action("save")[0]!.reply({ settings: stored }); await flush();
    expect(page.snapshot().savePhase).toBe("saved"); expect(page.snapshot().draft.model).toBe("native"); expect(fixture.action("save")).toHaveLength(1);
  });

  it("attempt-only pending Close keeps real pending-login observation polling active despite authBusy cancel", async () => {
    const { fixture, page } = await beginAttemptOnlyClose();
    const pending = observed("signing-in", 4); fixture.state({ ...pending, connection: { ...pending.connection!, login: { ...originalLogin, loginId: "current-unrelated-pending-id" } } });
    page.click(page.labels.refresh); await flush();
    expect(page.snapshot().authBusy).toBe("cancel"); expect(page.snapshot().authBlocking).toBeNull(); expect(page.snapshot().authCloseScope).toBe("attempt");
    const readCount = fixture.stateReads().length; await vi.advanceTimersByTimeAsync(2_001); await flush();
    expect(fixture.stateReads().length).toBeGreaterThan(readCount); expect(fixture.mutations()).toHaveLength(3);
    expect(fixture.action("close")).toHaveLength(1); expect(fixture.action("reserve")).toHaveLength(1); expect(fixture.action("start")).toHaveLength(1);
  });

  it("a generation-5 cancelled historical login record neither correlates the old attempt nor schedules observation polling", async () => {
    const { fixture, page } = await beginAttemptOnlyClose();
    const history = observed("signed-out", 5); fixture.state({ ...history, connection: { ...history.connection!, login: { ...originalLogin, status: "cancelled" } } });
    page.click(page.labels.refresh); await flush(); expect(page.snapshot().ownerGeneration).toBe(5);
    expect(page.snapshot().state?.connection?.login?.status).toBe("cancelled"); expect(page.snapshot().authCloseScope).toBe("attempt");
    expect(page.snapshot().authBusy).toBe("cancel"); expect(page.snapshot().authBlocking).toBeNull(); expect(page.button(page.labels.connect).props.disabled).toBe(false);
    const readCount = fixture.stateReads().length; await vi.advanceTimersByTimeAsync(4_001); await flush();
    expect(fixture.stateReads()).toHaveLength(readCount); expect(fixture.mutations()).toHaveLength(3); expect(fixture.action("close")[0]!.signal.aborted).toBe(false);
  });
});
