import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableHarnessState, type AgentSettings as Settings, type DeviceLoginAttemptCloseResult, type HarnessState, type StudioPiLoginAttempt } from "../shared/agent-configuration";
import type { AgentConfigurationSnapshot } from "../hooks/agent-configuration-controller";
import type { ConnectionView, PiAuthenticationView, TargetView } from "../components/agent-configuration-ui/view-model";

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
    useState: <T>(initial: T | (() => T)) => {
      const frame = boundary.current(), index = frame.cursor++;
      const slot = frame.slots[index] ?? (frame.slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial });
      return [slot.value as T, (value: T | ((previous: T) => T)) => {
        if (!frame.mounted) return;
        const next = typeof value === "function" ? (value as (previous: T) => T)(slot.value as T) : value;
        if (Object.is(slot.value, next)) return;
        slot.value = next;
        frame.schedule();
      }] as const;
    },
    useRef: <T>(initial: T) => {
      const frame = boundary.current(), index = frame.cursor++;
      return (frame.slots[index] ?? (frame.slots[index] = { value: { current: initial } })).value as { current: T };
    },
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
function expand(node: ReactNode): ReactNode {
  return Children.map(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    if (typeof child.type === "function") return expand((child.type as (props: Record<string, unknown>) => ReactNode)(child.props));
    return cloneElement(child, {}, expand(child.props.children as ReactNode));
  });
}
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

// Controlled presentation fixtures are synthetic. Only React scheduling is simulated;
// these cases do not establish real login, browser focus, inference or deployment.
async function controlledPi(isZh = false) {
  const { AgentConfigurationPanel } = await import("../components/agent-configuration-ui/AgentConfigurationPanel");
  const { offlinePiSaved } = await import("../components/agent-configuration-ui/fixtures");
  const actions = { intent: vi.fn(), reply: vi.fn(), close: vi.fn(), save: vi.fn(), select: vi.fn() };
  let target: TargetView = { harness: "pi", contextKey: "pi-controlled-context" };
  let connection: ConnectionView = { target, phase: "signing-in" };
  let disabled = false;
  let auth: PiAuthenticationView = { target, phase: "awaiting-user", capabilities: { canStartLogin: true, canCloseAttempt: true, canReply: true, canLogout: false },
    handle: "pi-controlled-handle", promptId: "pi-controlled-prompt", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?state=OFFLINE", busy: null,
    canClose: true, catalogConfirmed: false };
  let tree: ReactNode;
  const frame: PageFrame = { cursor: 0, slots: [], effects: [], mounted: true, schedule: () => { if (frame.mounted) render(); } };
  function render() {
    frame.cursor = 0; boundary.enter(frame);
    try {
      tree = expand(AgentConfigurationPanel({ id: "pi-controlled", view: { ...offlinePiSaved, target,
        connection, piAuthentication: auth }, isZh, disabled, canSave: true, hasChanges: true,
        onConnectionIntent: actions.intent, onPiReply: actions.reply, onPiClose: actions.close,
        onSaveIntent: actions.save, onSelectionIntent: actions.select, onHarnessChange: vi.fn() }));
    } finally { boundary.leave(); }
    for (const slot of frame.slots.splice(frame.cursor)) slot.cleanup?.();
    for (const effect of frame.effects.splice(0)) effect();
  }
  const controls = (tag: string) => native(tree, tag);
  const button = (label: string) => controls("button").find(element => contents(element.props.children as ReactNode) === label)!;
  const page = { actions, controls, button, text: () => contents(tree),
    set: (patch: Partial<PiAuthenticationView>) => { auth = { ...auth, ...patch }; render(); },
    connection: (value: ConnectionView) => { connection = value; render(); },
    disabled: (value: boolean) => { disabled = value; render(); },
    target: () => target,
    switchTarget: (value: TargetView) => { target = value; render(); },
    input: () => controls("input").find(element => element.props["aria-label"] === (isZh ? "Pi · 登录回调网址" : "Pi · Sign-in callback URL"))!,
    type: (value: string) => { const input = page.input(); expect(input).toBeDefined(); (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); },
    submit: () => { const form = controls("form")[0]!; expect(form).toBeDefined(); (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} }); },
    unmount: () => { frame.mounted = false; for (const slot of [...frame.slots].reverse()) slot.cleanup?.(); } };
  mounts.push(page); render(); return page;
}

describe("Pi-specific controlled callback and independent capabilities", () => {
  it.each([false, true])("renders a disabled Pi logout with a reason and a safe manual official challenge (isZh=%s)", async isZh => {
    const page = await controlledPi(isZh);
    const logout = page.button(isZh ? "退出 ChatGPT" : "Sign out of ChatGPT");
    expect(logout).toBeDefined(); expect(logout.props.disabled).toBe(true);
    expect(page.text()).toMatch(isZh ? /Pi.*暂不支持.*退出/ : /Pi.*sign-out.*unavailable/i);
    const link = page.controls("a")[0]!;
    expect(link.props.href).toBe("https://auth.openai.com/api/accounts/authorize?state=OFFLINE");
    expect(link.props.target).toBe("_blank"); expect(link.props.rel).toBe("noopener noreferrer");
    expect(page.input().props.autoComplete).toBe("off"); expect(page.input().props.spellCheck).toBe(false);
    expect(page.text()).toMatch(isZh ? /127\.0\.0\.1.*服务器/ : /127\.0\.0\.1.*server/i);
    expect(page.actions.intent).not.toHaveBeenCalled();
  });
  it("submits callback only to the target-bound dedicated reply and immediately clears component-local input", async () => {
    const page = await controlledPi(); const callback = "http://127.0.0.1:1455/auth/callback?code=OFFLINE&state=OFFLINE";
    page.type(callback); page.submit();
    expect(page.actions.reply).toHaveBeenCalledExactlyOnceWith(page.target(), "pi-controlled-handle", "pi-controlled-prompt", callback);
    expect(page.input().props.value).toBe(""); expect(page.actions.intent).not.toHaveBeenCalled(); expect(page.actions.save).not.toHaveBeenCalled();
  });
  it.each([
    "https://evil.invalid/api/accounts/authorize", "http://auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com@evil.invalid/api/accounts/authorize", "https://auth.openai.com/api/accounts/authorize#callback",
    "https://auth.openai.com/codex/device", "https://user@auth.openai.com/api/accounts/authorize",
  ])("rejects an unverified challenge without exposing an active link or reply (%s)", async authorizationUrl => {
    const page = await controlledPi(); page.set({ authorizationUrl });
    expect(page.controls("a")).toHaveLength(0); expect(page.input().props.disabled).toBe(true);
    expect(page.text()).toMatch(/sign-in URL is unverified/i);
    page.type("OFFLINE-SENSITIVE"); page.submit(); expect(page.actions.reply).not.toHaveBeenCalled();
  });
  it("clears callback on explicit Close, context/prompt/harness changes and unmount without implicit Close", async () => {
    const page = await controlledPi();
    page.type("OFFLINE-BEFORE-CLOSE"); (page.button("Close this Pi sign-in").props.onClick as () => void)();
    expect(page.actions.close).toHaveBeenCalledExactlyOnceWith(page.target(), "pi-controlled-handle");
    expect(page.input().props.value).toBe(""); page.actions.close.mockClear();
    page.type("OFFLINE-BEFORE-PROMPT"); page.set({ promptId: "pi-next-prompt" }); expect(page.input().props.value).toBe("");
    page.type("OFFLINE-BEFORE-CONTEXT"); page.switchTarget({ harness: "pi", contextKey: "pi-next-context" });
    expect(page.input()).toBeUndefined(); expect(page.actions.close).not.toHaveBeenCalled();
    page.switchTarget({ harness: "pi", contextKey: "pi-controlled-context" });
    page.type("OFFLINE-BEFORE-HARNESS"); const staleSubmit = page.controls("form")[0]!.props.onSubmit as (event: { preventDefault(): void }) => void;
    page.switchTarget({ harness: "codex", contextKey: "codex-context" });
    staleSubmit({ preventDefault() {} }); expect(page.actions.reply).not.toHaveBeenCalled(); expect(page.actions.close).not.toHaveBeenCalled();
    page.switchTarget({ harness: "pi", contextKey: "pi-controlled-context" }); expect(page.input().props.value).toBe("");
    page.type("OFFLINE-BEFORE-UNMOUNT"); const unmountedSubmit = page.controls("form")[0]!.props.onSubmit as typeof staleSubmit;
    page.unmount(); unmountedSubmit({ preventDefault() {} }); expect(page.actions.reply).not.toHaveBeenCalled(); expect(page.actions.close).not.toHaveBeenCalled();
  });
  it("honors each Pi capability independently while save and harness selection remain available", async () => {
    const page = await controlledPi();
    page.set({ capabilities: { canStartLogin: false, canReply: false, canCloseAttempt: false, canLogout: false } });
    expect(page.input().props.disabled).toBe(true); expect(page.button("Close this Pi sign-in").props.disabled).toBe(true);
    expect(page.button("Save defaults · Pi").props.disabled).toBeFalsy();
    expect(page.controls("input").filter(item => item.props.type === "radio").every(item => !item.props.disabled)).toBe(true);
    page.set({ phase: "reserved", busy: "reserve", handle: undefined, promptId: undefined, canClose: true });
    const close = page.button("Close this Pi sign-in"); expect(close.props.disabled).toBeFalsy();
    (close.props.onClick as () => void)(); expect(page.actions.close).toHaveBeenCalledExactlyOnceWith(page.target(), undefined);
    page.set({ phase: "idle", busy: null, canClose: false }); expect(page.button("Sign in with ChatGPT").props.disabled).toBe(true);
    page.set({ capabilities: { canStartLogin: true, canReply: false, canCloseAttempt: false, canLogout: false } });
    (page.button("Sign in with ChatGPT").props.onClick as () => void)();
    expect(page.actions.intent).toHaveBeenCalledExactlyOnceWith({ action: "connect", target: page.target() }); expect(page.actions.save).not.toHaveBeenCalled();
  });
  it.each([false, true])("keeps local credentials, catalog, execution, Close uncertainty and save messages separate (isZh=%s)", async isZh => {
    const page = await controlledPi(isZh); page.set({ phase: "saved", busy: null, catalogConfirmed: false, detail: { zh: "目录请求失败", en: "Catalog request failed" } });
    expect(page.controls("a")).toHaveLength(0); expect(page.controls("form")).toHaveLength(0);
    expect(page.text()).toMatch(isZh ? /本次尝试曾完成本地保存，模型目录待确认/ : /This attempt previously completed local saving; model catalog unconfirmed/);
    expect(page.text()).toMatch(isZh ? /执行尚未验证/ : /execution remain unverified/);
    expect(page.text()).toMatch(isZh ? /目录请求失败/ : /Catalog request failed/);
    page.set({ closeOutcome: "already-committed" }); expect(page.text()).toMatch(isZh ? /关闭不会退出/ : /Close does not sign out/);
    page.set({ closeOutcome: "unknown" }); expect(page.text()).toMatch(isZh ? /关闭结果不确定/ : /Close outcome is unknown/);
    expect(page.text()).not.toMatch(/cancel.acknowledged|取消已确认/i);
    expect(page.button(isZh ? "保存默认配置 · Pi" : "Save defaults · Pi").props.disabled).toBeFalsy();
  });
  it.each([
    ["awaiting-user", /Waiting for you/, /等待手动/], ["exchanging", /outcome unconfirmed/, /结果尚未确认/],
    ["closing", /Close outcome unconfirmed/, /关闭结果尚未确认/], ["closed", /sign-in is closed/, /登录已关闭/],
    ["unknown", /outcome is unknown/, /结果不确定/], ["failed", /did not complete/, /登录未完成/],
  ] as const)("announces the independent Pi %s state in both languages", async (phase, en, zh) => {
    for (const isZh of [false, true]) {
      const page = await controlledPi(isZh); page.set({ phase });
      expect(page.text()).toMatch(isZh ? zh : en);
      expect(page.controls("p").some(item => item.props.role === "status" && item.props["aria-live"] === "polite")).toBe(true);
      expect(page.actions.intent).not.toHaveBeenCalled(); expect(page.actions.save).not.toHaveBeenCalled();
    }
  });
  it("maps saved Pi credentials with failed catalog observations without claiming account, execution or deployment evidence", async () => {
    const { adaptAgentConfiguration } = await import("./agent-configuration-adapter");
    const target: TargetView = { harness: "pi", contextKey: "pi-adapter-context" };
    const savedAttempt: StudioPiLoginAttempt = { harnessId: "pi", handle: "pi-adapter-handle", status: "saved", expiresAt: 123,
      canReply: false, challenge: null, prompt: null, error: null };
    const input = { target, ownerGeneration: 3, state: null, draft: nativePreferences, saved: nativePreferences, savePhase: "saved" as const,
      piCapabilities: { canStartLogin: true, canCloseAttempt: true, canReply: true, canLogout: false as const } };
    const idle = adaptAgentConfiguration(input); expect(idle.piAuthentication?.phase).toBe("idle"); expect(idle.piAuthentication?.closeOutcome).toBeUndefined();
    const view = adaptAgentConfiguration({ ...input, piLoginAttempt: savedAttempt, piAuthDetail: { zh: "目录失败", en: "Catalog failed" },
      piCloseResult: { outcome: "already-committed", attempt: savedAttempt } });
    expect(view.connection.phase).toBe("unverified"); expect(view.connection.accountLabel).toBeUndefined();
    expect(view.catalog.phase).toBe("unavailable"); expect(view.execution).toMatchObject({ phase: "unverified", evidence: "unverified" });
    expect(view.save.phase).toBe("saved"); expect(view.piAuthentication).toMatchObject({ phase: "saved", catalogConfirmed: false, closeOutcome: "already-committed" });
    expect(view.piAuthentication).not.toHaveProperty("callbackUrl"); expect(view.piAuthentication).not.toHaveProperty("deploymentVerified");
    const staleClose = adaptAgentConfiguration({ ...input, piLoginAttempt: savedAttempt,
      piCloseResult: { outcome: "unknown", attempt: { ...savedAttempt, handle: "pi-other-attempt" } } });
    expect(staleClose.piAuthentication?.closeOutcome).toBeUndefined();
  });

  it.each(["missing", "unknown", "no-observation", "oauth-present"] as const)("S1: saved history cannot replace current %s authentication or a failed catalog", async local => {
    const { adaptAgentConfiguration, toSelection } = await import("./agent-configuration-adapter");
    for (const isZh of [false, true]) {
      const page = await controlledPi(isZh), target = page.target();
      const attempt: StudioPiLoginAttempt = { harnessId: "pi", handle: "saved-history", status: "saved", expiresAt: 123,
        canReply: false, challenge: null, prompt: null, error: null };
      const state: HarnessState | null = local === "no-observation" ? null : { ...unavailableHarnessState("pi"),
        availability: "available", installation: "installed", localAuthentication: local,
        scope: { harnessId: "pi", authContextRef: target.contextKey, ownerGeneration: 3, adapterVersion: "offline", catalogVersion: "offline" } };
      const draft = { model: "retained-model", effort: "retained-effort", speed: null };
      const view = adaptAgentConfiguration({ target, ownerGeneration: 3, state, draft, saved: nativePreferences,
        savePhase: "saved", piLoginAttempt: attempt, piCloseResult: { outcome: "already-committed", attempt } });
      expect(view.connection.phase).toBe(local === "missing" ? "signed-out" : local === "oauth-present" ? "oauth-present" : "unverified");
      expect(view.piAuthentication).toMatchObject({ phase: "saved", handle: attempt.handle, closeOutcome: "already-committed", catalogConfirmed: false });
      expect(view.selection).toEqual(toSelection(draft)); expect(view.save).toMatchObject({ phase: "saved", selection: toSelection(nativePreferences) });
      expect(view.connection.accountLabel).toBeUndefined(); expect(view.catalog.phase).toBe("unavailable");
      expect(view.execution).toMatchObject({ phase: "unverified", evidence: "unverified" });
      page.connection(view.connection); page.set(view.piAuthentication!);
      expect(page.text()).toMatch(isZh ? /本次尝试曾完成本地保存/ : /This attempt previously completed local saving/);
      expect(page.text()).toMatch(local === "missing" ? isZh ? /当前未发现本地 OAuth/ : /No local OAuth found in the current observation/
        : local === "oauth-present" ? isZh ? /当前发现本地 OAuth/ : /Local OAuth found in the current observation/
          : isZh ? /当前本地认证尚未确认/ : /Current local authentication is unconfirmed/);
      for (const action of Object.values(page.actions)) expect(action).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("direct disabled Pi Connect handler emits no authentication or save action (isZh=%s)", async isZh => {
    for (const block of ["capability", "disabled"] as const) {
      const page = await controlledPi(isZh); page.set({ phase: "idle", busy: null, handle: undefined, promptId: undefined,
        canClose: false, capabilities: { canStartLogin: block === "disabled", canReply: false, canCloseAttempt: false, canLogout: false } });
      page.disabled(block === "disabled");
      const connect = page.button(isZh ? "使用 ChatGPT 登录" : "Sign in with ChatGPT"); expect(connect.props.disabled).toBe(true);
      (connect.props.onClick as () => void)();
      const logout = page.button(isZh ? "退出 ChatGPT" : "Sign out of ChatGPT"); expect(logout.props.disabled).toBe(true); expect(logout.props.onClick).toBeUndefined();
      for (const action of Object.values(page.actions)) expect(action).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])("S2: an idle reserved attempt announces that start has not begun and retains its finite refusal (isZh=%s)", async isZh => {
    const page = await controlledPi(isZh); page.set({ phase: "reserved", busy: null,
      detail: { zh: "Pi 登录上下文忙碌（scope-busy）", en: "Pi login scope is busy (scope-busy)" } });
    expect(page.text()).toMatch(isZh ? /本次已预留，尚未开始/ : /This attempt is reserved and has not started/);
    expect(page.text()).toMatch(/scope-busy/);
    page.set({ busy: "reserve" }); expect(page.text()).toMatch(isZh ? /正在准备本次 Pi 登录/ : /Preparing this Pi sign-in/);
  });
});

async function setupPiPage(isZh = false) {
  const scope = { harnessId: "pi" as const, authContextRef: "pi-real-page-context", ownerGeneration: 3, adapterVersion: "offline", catalogVersion: "offline" };
  let catalogAvailable = true, localSaved = false;
  let stored: Settings = { ...initial, selectedHarnessId: "pi", modelConnectionRef: "existing-codex-owned-ref" };
  let attempt: StudioPiLoginAttempt = { harnessId: "pi", handle: "pi-real-page-handle", status: "reserved", expiresAt: 123_000,
    canReply: false, challenge: null, prompt: null, error: null };
  const held = new Set<string>();
  const calls: { url: string; method: string; body: Record<string, unknown> | undefined; signal: AbortSignal; reply(value: unknown): void }[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    let resolve!: (value: Response) => void; const pending = new Promise<Response>(yes => { resolve = yes; });
    const call = { url, method, body, signal: init?.signal as AbortSignal, reply: (value: unknown) => resolve(Response.json(value)) }; calls.push(call);
    let automatic: unknown; const action = method === "PUT" ? "save" : url.split("/").at(-1)!;
    if (method === "PUT") {
      const request = body as unknown as { patch: { selectedHarnessId: "pi"; harnessPreferences: { pi: Settings["harnessPreferences"]["pi"] } } };
      stored = { ...stored, revision: stored.revision + 1, selectedHarnessId: request.patch.selectedHarnessId,
        harnessPreferences: { ...stored.harnessPreferences, pi: request.patch.harnessPreferences.pi } }; automatic = { settings: stored };
    } else if (url.endsWith("/settings")) automatic = { settings: stored };
    else if (url.endsWith("/pi/state")) {
      const source = observed();
      automatic = { state: { ...source, harnessId: "pi", scope, account: null, localAuthentication: localSaved ? "oauth-present" : "missing", execution: null,
        connection: { phase: "signed-out", login: null, connectionRef: null },
        catalog: catalogAvailable ? { ...source.catalog!, scope, value: { ...source.catalog!.value, harnessId: "pi" } } : null } };
    } else if (url.endsWith("/codex/state")) automatic = { state: observed() };
    else if (url.endsWith("/pi/login/reserve")) automatic = { attempt };
    else if (url.endsWith("/pi/login/start")) {
      attempt = { ...attempt, status: "awaiting-user", canReply: true, challenge: { kind: "open-url", url: "https://auth.openai.com/api/accounts/authorize?state=OFFLINE-PAGE" },
        prompt: { kind: "callback-url", promptId: "pi-real-page-prompt" } }; automatic = { attempt };
    } else if (url.endsWith("/pi/login/reply")) {
      localSaved = true; attempt = { ...attempt, status: "saved", canReply: false, challenge: null, prompt: null }; automatic = { attempt };
    } else if (url.endsWith("/pi/login/close")) {
      attempt = { ...attempt, status: "closed", canReply: false, challenge: null, prompt: null }; automatic = { result: { outcome: "closed", attempt } };
    } else if (url.includes("/pi/login/attempts/")) automatic = { attempt };
    else throw new Error(`Unexpected offline Pi Page request ${method} ${url}`);
    releases.push(() => call.reply(automatic)); if (!held.has(action)) call.reply(automatic); return pending;
  }));
  const { AgentSettings } = await import("./AgentSettings"); let tree: ReactNode, scheduled = false;
  const frame: PageFrame = { cursor: 0, slots: [], effects: [], mounted: true, schedule: () => {
    if (!frame.mounted || scheduled) return; scheduled = true;
    void Promise.resolve().then(() => { scheduled = false; if (frame.mounted) render(); });
  } };
  function render() {
    frame.cursor = 0; boundary.enter(frame);
    try { tree = expand(AgentSettings({ isZh })); } finally { boundary.leave(); }
    for (const slot of frame.slots.splice(frame.cursor)) slot.cleanup?.();
    for (const effect of frame.effects.splice(0)) effect();
  }
  const controls = (tag: string) => native(tree, tag);
  const button = (label: string) => { const result = controls("button").find(item => contents(item.props.children as ReactNode) === label); expect(result).toBeDefined(); return result!; };
  const page = { calls, held, snapshot: () => frame.snapshot!(), controls, button, text: () => contents(tree),
    catalog: (available: boolean) => { catalogAvailable = available; },
    click: (label: string) => { const item = button(label); expect(item.props.disabled).toBeFalsy(); (item.props.onClick as () => void)(); },
    model: (value: string) => { const select = controls("select").find(item => item.props["aria-label"] === (isZh ? "模型" : "Model"))!;
      expect(select.props.disabled).toBeFalsy(); (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); },
    submit: (callback: string) => { const input = controls("input").find(item => item.props["aria-label"] === (isZh ? "Pi · 登录回调网址" : "Pi · Sign-in callback URL"))!;
      expect(input.props.disabled).toBeFalsy(); (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: callback } });
      (controls("form")[0]!.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} }); },
    action: (value: string) => calls.filter(call => call.url.endsWith(`/pi/login/${value}`)),
    unmount: () => { if (!frame.mounted) return; frame.mounted = false; for (const slot of [...frame.slots].reverse()) slot.cleanup?.(); } };
  mounts.push(page); render(); await flush(); return page;
}

describe("real Pi AgentSettings with default hook and transport (offline React boundary)", () => {
  it.each([false, true])("routes dedicated callback, preserves dirty preferences and saves independently of catalog failure (isZh=%s)", async isZh => {
    const page = await setupPiPage(isZh); page.model("other"); page.click(isZh ? "使用 ChatGPT 登录" : "Sign in with ChatGPT"); await flush();
    expect(page.snapshot().draft.model).toBe("other"); expect(page.snapshot().hasChanges).toBe(true);
    expect(page.button(isZh ? "保存默认配置 · Pi" : "Save defaults · Pi").props.disabled).toBeFalsy();
    const callback = "http://127.0.0.1:1455/auth/callback?code=OFFLINE-PAGE&state=OFFLINE-PAGE";
    page.catalog(false); page.submit(callback); await flush();
    expect(page.action("reply")[0]!.body).toEqual({ attemptHandle: "pi-real-page-handle", promptId: "pi-real-page-prompt", callbackUrl: callback });
    expect(JSON.stringify(page.snapshot())).not.toContain(callback); expect(page.snapshot().draft.model).toBe("other");
    expect(page.text()).toMatch(isZh ? /本次尝试曾完成本地保存，模型目录待确认/ : /This attempt previously completed local saving; model catalog unconfirmed/);
    page.click(isZh ? "保存默认配置 · Pi" : "Save defaults · Pi"); await flush();
    expect(page.snapshot().savePhase).toBe("saved"); expect(page.snapshot().baseline?.modelConnectionRef).toBe("existing-codex-owned-ref");
    expect(page.snapshot().baseline?.harnessPreferences.pi.model).toBe("other"); expect(page.snapshot().state?.execution).toBeNull();
    expect(page.calls.filter(call => call.method !== "GET" && call.url.includes("/codex/"))).toHaveLength(0);
    expect(page.calls.filter(call => /\/logout$|\/bind$/.test(call.url))).toHaveLength(0);
  });
  it("records target-bound Close during a pending reservation and never starts that attempt", async () => {
    const page = await setupPiPage(); page.held.add("reserve"); page.click("Sign in with ChatGPT"); await flush();
    page.model("other"); await flush(); expect(page.button("Save defaults · Pi").props.disabled).toBeFalsy();
    page.click("Close this Pi sign-in"); await flush(); expect(page.action("close")).toHaveLength(0);
    page.action("reserve")[0]!.reply({ attempt: { harnessId: "pi", handle: "pi-real-page-handle", status: "reserved", expiresAt: 123_000,
      canReply: false, challenge: null, prompt: null, error: null } }); await flush();
    expect(page.action("start")).toHaveLength(0); expect(page.action("close")[0]!.body).toEqual({ attemptHandle: "pi-real-page-handle" });
    expect(page.snapshot().draft.model).toBe("other"); expect(page.text()).toMatch(/Pi sign-in is closed/);
  });
  it("clears callback when the actual harness radio switches and detaches without closing the Pi attempt", async () => {
    const page = await setupPiPage(); page.click("Sign in with ChatGPT"); await flush();
    const input = page.controls("input").find(item => item.props["aria-label"] === "Pi · Sign-in callback URL")!;
    (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "OFFLINE-SWITCH-SECRET" } }); await flush();
    const staleSubmit = page.controls("form")[0]!.props.onSubmit as (event: { preventDefault(): void }) => void;
    const codex = page.controls("input").find(item => item.props.type === "radio" && item.props.value === "codex")!;
    expect(codex.props.disabled).toBeFalsy(); (codex.props.onChange as () => void)(); await flush();
    staleSubmit({ preventDefault() {} }); await flush();
    expect(page.snapshot().target.harness).toBe("codex"); expect(page.action("reply")).toHaveLength(0); expect(page.action("close")).toHaveLength(0);
    expect(page.controls("input").some(item => item.props["aria-label"] === "Pi · Sign-in callback URL")).toBe(false);
    expect(JSON.stringify(page.snapshot())).not.toContain("OFFLINE-SWITCH-SECRET");
  });
});
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
