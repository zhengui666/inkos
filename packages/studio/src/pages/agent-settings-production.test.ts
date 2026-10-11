import { Children, cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAuthenticationOwner, createCodexAccountService, readAgentSettings, type CodexClient } from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "../api/server";
import { createAgentConfigurationController, createAgentConfigurationTransport } from "../hooks/agent-configuration-controller";
import { AgentSettings } from "./AgentSettings";
import { ProjectSettings } from "./ProjectSettings";
import type { TFunction } from "../hooks/use-i18n";

// Replace the React subscription boundary and schedule component-local hooks offline.
// Every intent uses the real controller,
// HTTP transport, mounted production routes, real Core attempts/SQLite owner and filesystem CAS.
// The synthetic protocol peer proves no OAuth, native process or model execution.
const holder = vi.hoisted(() => ({ controller: null as ReturnType<typeof createAgentConfigurationController> | null }));
vi.mock("../hooks/use-agent-configuration", () => ({ useAgentConfiguration: () => {
  const controller = holder.controller!;
  return { controller, snapshot: controller.getSnapshot() };
} }));

interface LocalSlot { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }
interface LocalFrame { cursor: number; slots: LocalSlot[]; effects: (() => void)[]; mounted: boolean; schedule(): void }
const localBoundary = vi.hoisted(() => {
  let active: LocalFrame | undefined;
  return { enter: (frame: LocalFrame) => { active = frame; }, leave: () => { active = undefined; }, current: () => active };
});
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => !!a && !!b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  return { ...actual,
    useState: <T>(initial: T | (() => T)) => {
      const frame = localBoundary.current(); if (!frame) return actual.useState(initial);
      const index = frame.cursor++, slot = frame.slots[index] ??= { value: typeof initial === "function" ? (initial as () => T)() : initial };
      return [slot.value as T, (value: T | ((old: T) => T)) => {
        const next = typeof value === "function" ? (value as (old: T) => T)(slot.value as T) : value;
        if (!frame.mounted || Object.is(next, slot.value)) return;
        slot.value = next; frame.schedule();
      }] as const;
    },
    useRef: <T>(initial: T) => {
      const frame = localBoundary.current(); if (!frame) return actual.useRef(initial);
      return (frame.slots[frame.cursor++] ??= { value: { current: initial } }).value as { current: T };
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const frame = localBoundary.current(); if (!frame) return actual.useEffect(effect, dependencies);
      const index = frame.cursor++, old = frame.slots[index]; if (old && same(old.dependencies, dependencies)) return;
      const slot: LocalSlot = { dependencies }; frame.slots[index] = slot;
      frame.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); if (cleanup) slot.cleanup = cleanup; });
    },
  };
});

// Offline protocol peer: no process, credentials, OAuth or model execution.
class UiPeer implements CodexClient {
  readonly codexHome: string;
  closed = false;
  closeCount = 0;
  authenticated = false;
  cancelResponse: unknown = { status: "canceled" };
  readonly calls: string[] = [];
  readonly rpc: Array<{ method: string; params: unknown }> = [];
  private lastLoginId = "";
  private nextLogin = 0;
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly closes = new Set<() => void>();
  constructor(readonly cwd: string) { this.codexHome = join(cwd, ".inkos", "codex", "home"); }
  async request<T>(method: string, params: unknown = {}, options?: { signal?: AbortSignal }): Promise<T> {
    options?.signal?.throwIfAborted(); this.calls.push(method); this.rpc.push({ method, params });
    if (this.closed) throw new Error("synthetic-private-RPC-error");
    let result: unknown;
    switch (method) {
      case "account/read": result = { account: this.authenticated ? { type: "chatgpt", email: "hidden@example.test", planType: "fixture" } : null, requiresOpenaiAuth: true }; break;
      case "model/list": result = { data: ["fixture-default", "fixture-other"].map((model, index) => ({ id: model, model, isDefault: index === 0,
        defaultReasoningEffort: "high", defaultServiceTier: "default", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "fast" }] })), nextCursor: null }; break;
      case "config/read": result = { config: {} }; break;
      case "account/login/start":
        this.lastLoginId = ++this.nextLogin === 1 ? "ui-attempt" : `ui-attempt-${this.nextLogin}`;
        result = { type: "chatgptDeviceCode", loginId: this.lastLoginId, verificationUrl: "https://auth.openai.com/codex/device", userCode: "UI-CODE" }; break;
      case "account/login/cancel": result = this.cancelResponse; break;
      case "account/logout": this.authenticated = false; result = {}; break;
      default: throw new Error(`Unexpected fixture method ${method}`);
    }
    return result as T;
  }
  onNotification(listener: (method: string, params: unknown) => void) { this.notifications.add(listener); return () => { this.notifications.delete(listener); }; }
  onRequest() { return () => {}; }
  onClose(listener: () => void) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
  disconnect() { if (!this.closed) { this.closed = true; for (const listener of this.closes) listener(); } }
  async close() { this.closeCount++; this.disconnect(); }
  complete(success = true) {
    if (success) this.authenticated = true;
    for (const listener of this.notifications) listener("account/login/completed", { loginId: this.lastLoginId, success });
  }
}

type Element = ReactElement<Record<string, unknown>>;
function native(node: ReactNode, tag: string): Element[] {
  const found: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (child.type === tag) found.push(child);
    found.push(...native(child.props.children as ReactNode, tag));
  });
  return found;
}
function contents(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? contents(child.props.children) : String(child)).join("");
}
// Persistent per-component frames preserve local input and cleanup across queries.
// Capture also supplies React's actual SSR dispatcher for unmocked hooks/context.
// Product components, intent handlers, controller, transport and Core are unchanged.
function createPageView(isZh: boolean) {
  const controller = holder.controller!, frames = new Map<string, LocalFrame>();
  let output: ReactNode, mounted = true, queued = false;
  const schedule = () => {
    if (!mounted || queued) return; queued = true;
    void Promise.resolve().then(() => { queued = false; if (mounted) render(); });
  };
  const render = () => {
    const used = new Set<string>();
    const expand = (node: ReactNode, path: string): ReactNode => Children.map(node, (child, index) => {
      if (!isValidElement<Record<string, unknown>>(child)) return child;
      const nextPath = `${path}/${index}`;
      if (typeof child.type !== "function") return cloneElement(child, {}, expand(child.props.children as ReactNode, nextPath));
      const Component = child.type as (props: Record<string, unknown>) => ReactNode;
      const props = child.props;
      const key = `${nextPath}:${Component.name}:${child.key ?? ""}`; used.add(key);
      const frame = frames.get(key) ?? { cursor: 0, slots: [], effects: [], mounted: true, schedule };
      frames.set(key, frame); frame.cursor = 0;
      let result: ReactNode = null;
      function Capture() {
        localBoundary.enter(frame);
        try { result = Component(props); } finally { localBoundary.leave(); }
        return null;
      }
      renderToStaticMarkup(createElement(Capture));
      return expand(result, key);
    });
    output = expand(createElement(AgentSettings, { isZh }), "root");
    for (const [key, frame] of frames) {
      if (!used.has(key)) { frame.mounted = false; frame.slots.forEach(slot => slot.cleanup?.()); frames.delete(key); }
      else for (const effect of frame.effects.splice(0)) effect();
    }
  };
  const unsubscribe = controller.subscribe(schedule); render();
  return { tree: () => { render(); return output; }, dispose: () => {
    mounted = false; unsubscribe();
    for (const frame of frames.values()) { frame.mounted = false; frame.slots.forEach(slot => slot.cleanup?.()); }
    frames.clear();
  } };
}
const pageViews = new Map<boolean, ReturnType<typeof createPageView>>();
const tree = (isZh = false) => {
  let page = pageViews.get(isZh); if (!page) { page = createPageView(isZh); pageViews.set(isZh, page); }
  return page.tree();
};
const disposePageViews = () => { for (const page of pageViews.values()) page.dispose(); pageViews.clear(); };
function button(label: string, isZh = false) {
  const result = native(tree(isZh), "button").find(item => contents(item.props.children as ReactNode) === label);
  expect(result, `missing ${label}`).toBeDefined(); return result!;
}
function click(label: string) {
  const control = button(label); expect(control.props.disabled).toBeFalsy(); (control.props.onClick as () => void)();
}
function choose(label: string, value: string) {
  const control = native(tree(), "select").find(item => item.props["aria-label"] === label);
  expect(control, `missing native select ${label}`).toBeDefined();
  (control!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

describe("native UI → production API → real Core attempts/SQLite owner/CAS with offline protocol peer", () => {
  let root: string;
  let peer: UiPeer;
  let app: ReturnType<typeof createStudioServer>;
  let factory: ReturnType<typeof vi.fn<() => Promise<CodexClient>>>;
  let controller: ReturnType<typeof createAgentConfigurationController>;
  const http: Array<{ method: string; path: string }> = [];
  beforeEach(async () => {
    vi.stubEnv("INKOS_CODEX_HOME", ""); delete process.env.INKOS_CODEX_HOME;
    vi.stubEnv("INKOS_CODEX_STATE_ROOT", ""); delete process.env.INKOS_CODEX_STATE_ROOT;
    root = await mkdtemp(join(tmpdir(), "inkos-native-ui-")); await mkdir(join(root, ".inkos", "codex", "home"), { recursive: true, mode: 0o700 });
    peer = new UiPeer(root); factory = vi.fn(async (): Promise<CodexClient> => { if (peer.closed) peer = new UiPeer(root); return peer; });
    const service = createCodexAccountService({ projectDir: root, clientFactory: factory });
    app = createStudioServer({} as never, root, { codexAccountService: service });
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(new URL(String(input), "http://localhost"), init);
      http.push({ method: request.method, path: new URL(request.url).pathname }); return app.request(request);
    };
    controller = createAgentConfigurationController(createAgentConfigurationTransport(fetchImpl)); holder.controller = controller; http.length = 0;
    await controller.refresh();
  });
  afterEach(async () => { disposePageViews(); controller.dispose(); holder.controller = null; await shutdownStudioServer(app); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  const settled = () => vi.waitFor(() => expect(controller.getSnapshot().authBusy).toBeNull());
  const owner = () => new CodexAuthenticationOwner(peer);
  async function signIn() {
    click("Sign in with ChatGPT"); await settled();
    expect(renderToStaticMarkup(tree())).toContain("UI-CODE");
    peer.complete();
    await vi.waitFor(async () => {
      await controller.refreshState();
      expect(controller.getSnapshot().state?.account?.type).toBe("chatgpt");
      expect(controller.getSnapshot().state?.catalog).not.toBeNull();
      expect(controller.getSnapshot().state?.connection?.phase).toBe("signed-in");
    });
  }

  it("mounts this panel in ProjectSettings and dispatches real native model/effort/speed/save/bind controls", async () => {
    const html = renderToStaticMarkup(createElement(ProjectSettings, { nav: { toDashboard() {}, toServices() {} }, theme: "dark", t: ((key: string) => key) as TFunction }));
    expect(html).toContain('aria-label="Agent defaults"'); expect(html).toContain('name="agent-settings-harness"');
    expect(http.every(call => call.method === "GET")).toBe(true); expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    await signIn();
    choose("Model", "fixture-default"); choose("Reasoning effort", "high"); choose("Service speed", "fast"); choose("Model", "fixture-other");
    expect(controller.getSnapshot().draft).toEqual({ model: "fixture-other", effort: "high", speed: "fast" });
    click("Save defaults · Codex"); await vi.waitFor(() => expect(controller.getSnapshot().savePhase).toBe("saved"));
    expect((await readAgentSettings(root)).harnessPreferences.codex).toEqual(controller.getSnapshot().draft);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull();
    click("Bind current ChatGPT model connection"); await settled();
    const bound = await readAgentSettings(root); expect(bound.revision).toBe(2); expect(bound.modelConnectionRef).toBeTruthy();
    expect(controller.getSnapshot().state?.connection?.connectionRef).toBe(bound.modelConnectionRef);
    const rendered = renderToStaticMarkup(tree()); expect(rendered).toContain("execution remains unverified"); expect(rendered).not.toContain("hidden@example.test");
    expect(controller.getSnapshot().state?.execution).toBeNull(); expect(factory).toHaveBeenCalledTimes(1);
    expect(http.some(call => call.method === "POST" && call.path.endsWith("/bind"))).toBe(true);
    expect(http.some(call => call.method === "PUT" && call.path.endsWith("/settings"))).toBe(true);
  });

  it("saves Pi pending connection through its native radio without inheriting Codex identity, speed or binding", async () => {
    await signIn(); const callsBeforePi = peer.calls.length;
    const radio = native(tree(), "input").find(item => item.props.value === "pi")!;
    (radio.props.onChange as () => void)();
    await vi.waitFor(() => expect(controller.getSnapshot().state?.harnessId).toBe("pi"));
    expect(native(tree(), "select").map(item => item.props["aria-label"])).toEqual(["Model"]);
    // Pi2 permits an explicit request, but this scenario only observes and saves preferences.
    // Do not begin OAuth to test isolation; read-only mount/refresh must never start it.
    expect(controller.getSnapshot().piCapabilities).toMatchObject({ canStartLogin: true, canReply: false, canCloseAttempt: false, canLogout: false });
    expect(button("Sign in with ChatGPT").props.disabled).toBe(false);
    expect(button("Sign out of ChatGPT").props.disabled).toBe(true);
    expect(button("Sign out of ChatGPT").props.onClick).toBeUndefined();
    expect(renderToStaticMarkup(tree())).toContain("Pi sign-out is unavailable on this page.");
    expect(http.some(call => call.method === "POST" && call.path.includes("/pi/login/"))).toBe(false);
    expect(peer.calls.length).toBe(callsBeforePi);
    expect(button("Check status").props.disabled).toBeFalsy();
    expect(native(tree(), "button").some(item => contents(item.props.children as ReactNode) === "Bind current ChatGPT model connection")).toBe(false);
    click("Save defaults · Pi"); await vi.waitFor(() => expect(controller.getSnapshot().savePhase).toBe("saved"));
    const saved = await readAgentSettings(root); expect(saved.selectedHarnessId).toBe("pi"); expect(saved.modelConnectionRef).toBeNull();
    expect(saved.harnessPreferences.pi).toEqual({ model: null, effort: null, speed: null });
    expect(peer.calls.length).toBe(callsBeforePi); expect(controller.getSnapshot().state?.account).toBeNull();
    expect(renderToStaticMarkup(tree(true))).toContain("已保存，待连接");
    expect(renderToStaticMarkup(tree())).toContain("Current run configuration remains frozen");
    expect(renderToStaticMarkup(tree())).toContain("A sign-in request entry point does not verify deployment or execution.");
    expect(http.some(call => call.method === "POST" && call.path.includes("/pi/login/"))).toBe(false);
    expect(renderToStaticMarkup(tree())).not.toContain("Pi production execution is unavailable");
  });

  it("dispatches explicit Close and logout through native buttons, preserving unverified execution", async () => {
    click("Sign in with ChatGPT"); await settled(); const pending = owner().snapshot()!;
    click("Close and cancel sign-in"); await settled();
    expect(peer.calls.filter(method => method === "account/login/cancel")).toHaveLength(1);
    expect(peer.rpc.filter(call => call.method === "account/login/cancel")).toEqual([{ method: "account/login/cancel", params: { loginId: "ui-attempt" } }]);
    expect(controller.getSnapshot().state?.connection?.login?.status).toBe("cancelled");
    expect(controller.getSnapshot().authCloseResult).toMatchObject({ state: "closed", cleanup: "cancel-acknowledged" });
    expect(owner().snapshot()).toMatchObject({ localState: "unknown", operationId: null, authGeneration: pending.authGeneration });
    await signIn(); click("Sign out of ChatGPT"); await settled();
    expect(peer.calls.filter(method => method === "account/logout")).toHaveLength(1);
    expect(peer.calls.filter(method => method === "account/login/start")).toHaveLength(2); expect(peer.closeCount).toBe(0); expect(factory).toHaveBeenCalledTimes(1);
    expect(owner().snapshot()?.localState).toBe("disconnected");
    expect(controller.getSnapshot().state?.account).toBeNull(); expect(controller.getSnapshot().state?.execution).toBeNull();
    expect(renderToStaticMarkup(tree())).toContain('role="status"'); expect(renderToStaticMarkup(tree())).toContain('aria-live="polite"');
  });

  it("renders native completion failure without readiness and starts a fresh attempt through the actual Connect button", async () => {
    click("Sign in with ChatGPT"); await settled(); const pending = owner().snapshot()!;
    peer.complete(false);
    await vi.waitFor(async () => {
      await controller.refreshState(); expect(controller.getSnapshot().state?.connection?.login?.status).toBe("failed");
    });
    const failed = owner().snapshot()!;
    expect(failed).toMatchObject({ localState: "unknown", operationId: null, authGeneration: pending.authGeneration });
    expect(controller.getSnapshot().state).toMatchObject({ account: null, catalog: null, execution: null });
    expect(renderToStaticMarkup(tree())).toContain('role="alert"'); expect(button("Sign in with ChatGPT").props.disabled).toBeFalsy();
    click("Sign in with ChatGPT"); await settled();
    expect(controller.getSnapshot().state?.connection?.login).toMatchObject({ loginId: "ui-attempt-2", status: "pending" });
    expect(owner().snapshot()).toMatchObject({ localState: "transitioning", authGeneration: failed.authGeneration + 1 });
    expect(peer.calls.filter(method => method === "account/login/start")).toHaveLength(2);
    expect(peer.calls).not.toContain("account/login/cancel"); expect(peer.calls).not.toContain("account/logout"); expect(peer.closeCount).toBe(0);
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull(); expect(factory).toHaveBeenCalledTimes(1);
  });

  it("renders unconfirmed Close, reuses its cached receipt and unlocks native Connect only after original-peer retirement", async () => {
    peer.cancelResponse = {}; const oldPeer = peer;
    click("Sign in with ChatGPT"); await settled(); click("Close and cancel sign-in"); await settled();
    const receipt = controller.getSnapshot().authCloseResult, fenced = owner().snapshot()!;
    expect(receipt).toMatchObject({ state: "closed", cleanup: "unconfirmed" });
    expect(fenced.localState).toBe("unknown"); expect(renderToStaticMarkup(tree())).toContain("provider cleanup is unconfirmed");
    click("Check this Close again"); await settled();
    expect(controller.getSnapshot().authCloseResult).toEqual(receipt); expect(owner().snapshot()).toEqual(fenced);
    expect(peer.rpc.filter(call => call.method === "account/login/cancel")).toEqual([{ method: "account/login/cancel", params: { loginId: "ui-attempt" } }]);
    click("Sign in with ChatGPT"); await settled();
    expect(peer.calls.filter(method => method === "account/login/start")).toHaveLength(1); expect(owner().snapshot()).toEqual(fenced);
    expect(renderToStaticMarkup(tree())).toContain("Authentication outcome is uncertain");
    oldPeer.disconnect(); await vi.waitFor(() => expect(oldPeer.closeCount).toBe(1));
    click("Refresh settings and observations"); await vi.waitFor(() => expect(controller.getSnapshot().loading).toBe(false));
    expect(peer).not.toBe(oldPeer); expect(owner().snapshot()).toEqual(fenced); expect(factory).toHaveBeenCalledTimes(2);
    const oldCalls = [...oldPeer.rpc];
    click("Sign in with ChatGPT"); await settled();
    expect(controller.getSnapshot().state?.connection?.login?.status).toBe("pending");
    expect(peer.calls.filter(method => method === "account/login/start")).toHaveLength(1);
    const current = owner().snapshot()!; oldPeer.complete();
    expect(owner().snapshot()).toEqual(current); expect(oldPeer.rpc).toEqual(oldCalls); expect(oldPeer.closeCount).toBe(1);
    expect(peer.calls).not.toContain("account/login/cancel"); expect(peer.calls).not.toContain("account/logout");
    expect((await readAgentSettings(root)).modelConnectionRef).toBeNull(); expect(controller.getSnapshot().state?.execution).toBeNull();
  });
});
