import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CONFIG_FILE, AgentSettingsSchema, ProjectConfigSchema, createCodexAccountService,
  currentRuntimeRun, observePiRuntime, readAgentSettings, updateAgentSettings, withRuntimeExecution,
  type HarnessPreferences, type PiRuntimeObservation,
} from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "../api/server";
import type { AgentConfigurationSnapshot } from "../hooks/agent-configuration-controller";
import type { ConfigurationView } from "../components/agent-configuration-ui/view-model";
import type { HarnessState } from "../shared/agent-configuration";
import { useChatStore } from "../store/chat";
import { AgentSettings } from "./AgentSettings";
import { ChatPage, type ChatPageProps } from "./ChatPage";

interface Slot {
  value?: unknown;
  dependencies?: readonly unknown[];
  cleanup?: () => void;
  subscribe?: unknown;
  setState?: (value: unknown) => void;
}
interface Frame {
  cursor: number;
  slots: Slot[];
  effects: (() => void)[];
  mounted: boolean;
  schedule(): void;
  snapshot?: () => unknown;
}
const boundary = vi.hoisted(() => {
  let current: Frame | undefined;
  return {
    enter: (frame: Frame) => { current = frame; }, leave: () => { current = undefined; },
    frame: () => { if (!current) throw new Error("Hook outside the offline React scheduler"); return current; },
  };
});

// Only React scheduling is simulated, plus the unchanged native loader forwarding below.
// AgentSettings, Panel/Card, the default hook/controller/
// transport, fetchJson, ChatPage/Zustand, TCP/Hono, public observePiRuntime and settings CAS
// are real. Synthetic native OAuth bytes prove local shape/continuity, never OAuth, inference
// or deployment. No AccountService/observation response or owner field is fabricated.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const memo = <T>(create: () => T, dependencies?: readonly unknown[]): T => {
    const frame = boundary.frame(), index = frame.cursor++, old = frame.slots[index];
    if (!old || !same(old.dependencies, dependencies)) frame.slots[index] = { dependencies, value: create() };
    return frame.slots[index]!.value as T;
  };
  return { ...actual,
    useMemo: memo,
    useCallback: <T>(value: T, dependencies?: readonly unknown[]) => memo(() => value, dependencies),
    useDebugValue: () => {},
    useState: <T>(initial: T | (() => T)) => {
      const frame = boundary.frame(), index = frame.cursor++;
      const slot = frame.slots[index] ??= { value: typeof initial === "function" ? (initial as () => T)() : initial };
      slot.setState ??= value => {
        const next = typeof value === "function" ? (value as (old: unknown) => unknown)(slot.value) : value;
        if (!frame.mounted || Object.is(next, slot.value)) return;
        slot.value = next; frame.schedule();
      };
      return [slot.value as T, slot.setState];
    },
    useRef: <T>(initial: T) => {
      const frame = boundary.frame(), index = frame.cursor++;
      return (frame.slots[index] ??= { value: { current: initial } }).value;
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const frame = boundary.frame(), index = frame.cursor++, old = frame.slots[index];
      if (old && same(old.dependencies, dependencies)) return;
      const slot: Slot = { dependencies }; frame.slots[index] = slot;
      frame.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); if (cleanup) slot.cleanup = cleanup; });
    },
    useSyncExternalStore: <T>(subscribe: (notify: () => void) => () => void, getSnapshot: () => T) => {
      const frame = boundary.frame(), index = frame.cursor++, old = frame.slots[index];
      if (old?.subscribe !== subscribe) {
        old?.cleanup?.(); frame.slots[index] = { subscribe, cleanup: subscribe(frame.schedule) };
      }
      frame.snapshot = getSnapshot;
      return getSnapshot();
    },
  };
});

// Vitest 3 does not provide import.meta.resolve. Load the unchanged real source in
// Node's native module context, as the Core/production Pi tests do. This forwards
// compatibility checks and native storage; it does not replace the service or probe.
vi.mock("../../../core/src/runtime/auth/pi-native-store-compat.js", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)("../../../core/src/runtime/auth/pi-native-store-compat.ts");
});

type Element = ReactElement<Record<string, unknown>>;
function renderable(type: unknown): { name: string; render(props: Record<string, unknown>): ReactNode } | undefined {
  if (typeof type === "function") return { name: type.name, render: type as (props: Record<string, unknown>) => ReactNode };
  if (!type || typeof type !== "object") return undefined;
  const wrapped = type as { $$typeof?: symbol; displayName?: string; type?: unknown;
    render?: (props: Record<string, unknown>, ref: unknown) => ReactNode };
  // memo skips are a rendering optimization; execute its unchanged component body.
  if (wrapped.$$typeof === Symbol.for("react.memo")) return renderable(wrapped.type);
  if (wrapped.$$typeof === Symbol.for("react.forward_ref") && wrapped.render) {
    return { name: wrapped.displayName ?? wrapped.render.name, render: props => wrapped.render!(props, props.ref ?? null) };
  }
  return undefined;
}
function contents(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? contents(child.props.children) : String(child)).join("");
}
function natives(node: ReactNode, tag: string): Element[] {
  const result: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (child.type === tag) result.push(child);
    result.push(...natives(child.props.children as ReactNode, tag));
  });
  return result;
}
function mount<P extends object>(Component: (props: P) => ReactNode, props: P) {
  const frames = new Map<string, Frame>(), components = new Map<string, Element>();
  let tree: ReactNode, markup = "", queued = false, mounted = true, rootFrame: Frame | undefined;
  const schedule = () => {
    if (!mounted || queued) return; queued = true;
    void Promise.resolve().then(() => { queued = false; if (mounted) render(); });
  };
  const render = () => {
    const used = new Set<string>(); components.clear();
    const expand = (node: ReactNode, path: string): ReactNode => {
      if (Array.isArray(node)) return node.map((child, index) => expand(child, `${path}/${index}`));
      if (!isValidElement<Record<string, unknown>>(node)) return node;
      const component = renderable(node.type);
      if (component) {
        const key = `${path}:${component.name}:${node.key ?? ""}`; used.add(key);
        const frame = frames.get(key) ?? { cursor: 0, slots: [], effects: [], mounted: true, schedule };
        frames.set(key, frame); frame.cursor = 0; components.set(component.name, node);
        if (path === "root") rootFrame = frame;
        let result: ReactNode = null;
        // Evaluate every real function/forwardRef/memo body inside SSR's actual
        // dispatcher and its own persistent scheduling frame. In particular, icons'
        // real useContext remains native and object children cannot run mocked hooks
        // after boundary.leave. Capture returns no DOM and adds no product wrapper.
        function Capture() {
          boundary.enter(frame);
          try { result = component!.render(node.props); } finally { boundary.leave(); }
          return null;
        }
        renderToStaticMarkup(createElement(Capture));
        return expand(result, key);
      }
      return { ...node, props: { ...node.props,
        children: Children.map(node.props.children as ReactNode, (child, index) => expand(child, `${path}/${index}`)),
      } } as ReactElement;
    };
    tree = expand(createElement(Component, props), "root"); markup = renderToStaticMarkup(tree);
    for (const [key, frame] of frames) {
      if (!used.has(key)) {
        frame.mounted = false; frame.slots.forEach(slot => slot.cleanup?.()); frames.delete(key);
      } else for (const effect of frame.effects.splice(0)) effect();
    }
  };
  const button = (label: string) => {
    const found = natives(tree, "button").find(node => contents(node.props.children as ReactNode) === label);
    if (!found) throw new Error(`Button absent: ${label}`); return found;
  };
  render();
  return {
    markup: () => markup,
    snapshot: () => rootFrame!.snapshot!() as AgentConfigurationSnapshot,
    component: (name: string) => { const found = components.get(name); if (!found) throw new Error(`Component absent: ${name}`); return found; },
    view: () => components.get("AgentConfigurationPanel")!.props.view as ConfigurationView,
    native: (tag: string) => natives(tree, tag),
    row: (name: string) => {
      const found = natives(tree, "div").find(node => node.props["data-configuration-status"] === name);
      if (!found) throw new Error(`Status row absent: ${name}`); return contents(found.props.children as ReactNode);
    },
    button,
    click: (label: string) => { const node = button(label); expect(node.props.disabled).not.toBe(true); (node.props.onClick as () => void)(); },
    choose: (label: string, value: string | null) => {
      const node = natives(tree, "select").find(item => item.props["aria-label"] === label);
      if (!node) throw new Error(`Select absent: ${label}`);
      expect(node.props.disabled).not.toBe(true);
      (node.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: value ?? "" } });
    },
    unmount: () => {
      mounted = false; for (const frame of frames.values()) { frame.mounted = false; frame.slots.forEach(slot => slot.cleanup?.()); }
    },
  };
}

const settingsPath = "/api/v1/agent-configuration/settings";
const piPath = "/api/v1/agent-configuration/harnesses/pi/state";
const nativePreferences: HarnessPreferences = { model: null, effort: null, speed: null };
const labels = (isZh = false) => ({
  connect: isZh ? "使用 ChatGPT 登录" : "Sign in with ChatGPT",
  check: isZh ? "核对状态" : "Check status",
  refresh: isZh ? "刷新配置与观察状态" : "Refresh settings and observations",
  model: isZh ? "模型" : "Model", effort: isZh ? "推理强度" : "Reasoning effort",
  save: isZh ? "保存默认配置 · Pi" : "Save defaults · Pi",
  review: isZh ? "已核对当前配置，允许再次保存" : "Reviewed current settings; allow another save",
});
interface HttpCall { path: string; method: string; body?: string; status?: number; state?: HarnessState }
type Fixture = Awaited<ReturnType<typeof fixture>>;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

async function fixture(options: { oauth?: boolean; unsupportedSpeed?: boolean } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "inkos-pi-page-combination-"));
  cleanup.push(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, "project"), agentDir = join(temporary, "agent");
  await mkdir(project); await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const credentials = (suffix: string) => writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: {
    type: "oauth", access: `synthetic-access-${suffix}`, refresh: `synthetic-refresh-${suffix}`, expires: Date.now() + 3_600_000,
  } }));
  if (options.oauth !== false) await credentials("first");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.4", defaultThinkingLevel: "low" }));
  const initial = await updateAgentSettings(project, { selectedHarnessId: "pi" }, { expectedRevision: 0 });
  if (options.unsupportedSpeed) {
    // A trusted persisted legacy fixture, validated by the real schema. It is not an API
    // catalog or a browser-supplied capability: the real Pi catalog still rejects this speed.
    const legacy = AgentSettingsSchema.parse({ ...initial, harnessPreferences: {
      ...initial.harnessPreferences, pi: { model: "gpt-5.4", effort: "low", speed: "fast" },
    } });
    await writeFile(join(project, ".inkos", AGENT_CONFIG_FILE), `${JSON.stringify(legacy)}\n`);
  }
  let factories = 0;
  const accountService = createCodexAccountService({ projectDir: project, clientFactory: async () => {
    factories++; throw new Error("Pi settings and summary must not borrow a Codex peer");
  } });
  const app = createStudioServer(ProjectConfigSchema.parse({ name: "Offline Pi page", version: "0.1.0",
    llm: { provider: "custom", baseUrl: "https://offline.invalid/v1", model: "codex-model-canary" },
  }), project, { codexAccountService: accountService });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await shutdownStudioServer(app);
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local TCP listener");
  const base = `http://127.0.0.1:${address.port}`, nativeFetch = fetch, calls: HttpCall[] = [];
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input), url = new URL(path, base);
    if (url.origin !== base || !url.pathname.startsWith("/api/v1/")) throw new Error(`External/model network forbidden: ${url.origin}`);
    const call: HttpCall = { path: url.pathname, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) };
    calls.push(call);
    const response = await nativeFetch(url, init); call.status = response.status;
    if (url.pathname === piPath && response.ok) call.state = (await response.clone().json() as { state: HarnessState }).state;
    return response;
  });
  const disk = async () => {
    const files: Record<string, string> = {};
    const walk = async (directory: string, prefix = "") => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}${entry.name}/`);
        else files[`${prefix}${entry.name}`] = (await readFile(join(directory, entry.name))).toString("base64");
      }
    };
    await walk(agentDir);
    files["public-agent-settings"] = (await readFile(join(project, ".inkos", AGENT_CONFIG_FILE))).toString("base64");
    return files;
  };
  return { project, agentDir, calls, initial, credentials, disk, factories: () => factories,
    observed: () => observePiRuntime(project),
    saved: () => readAgentSettings(project),
    mounts: <P extends object>(Component: (props: P) => ReactNode, props: P) => {
      const page = mount(Component, props); cleanup.push(page.unmount); return page;
    },
  };
}
const mutations = (value: Fixture) => value.calls.filter(call => !["GET", "HEAD"].includes(call.method));
function noCodexOrAuthMutation(value: Fixture) {
  expect(value.factories()).toBe(0);
  expect(value.calls.some(call => call.path.includes("/codex/") || call.path.endsWith("/bind"))).toBe(false);
  expect(mutations(value).every(call => call.path === settingsPath && call.method === "PUT")).toBe(true);
}
async function loaded(page: ReturnType<typeof mount>, generation?: number | null) {
  await vi.waitFor(() => {
    expect(page.snapshot().loading).toBe(false); expect(page.snapshot().target.harness).toBe("pi");
    expect(page.snapshot().state?.localAuthentication).toBe("oauth-present");
    expect(page.view().catalog.phase).toBe("available");
    if (generation !== undefined) expect(page.snapshot().ownerGeneration).toBe(generation);
  });
}
async function refreshObserved(page: ReturnType<typeof mount>, label: string) {
  const before = page.snapshot().state?.scope?.catalogVersion;
  page.click(label);
  await vi.waitFor(() => {
    expect(page.snapshot().loading).toBe(false);
    expect(page.snapshot().state?.scope?.catalogVersion).toBeDefined();
    expect(page.snapshot().state?.scope?.catalogVersion).not.toBe(before);
  });
}
function catalog(observation: PiRuntimeObservation) {
  expect(observation.ready).toBe(true);
  const value = observation.descriptor?.capabilities;
  if (!value) throw new Error("Real installed Pi capability catalog unavailable"); return value;
}

describe("real Pi settings page and ChatPage → default fetchJson → TCP/Hono → public Core", () => {
  it.each([false, true])("shows local OAuth and scoped real catalog without claiming online authentication or execution (isZh=%s)", async isZh => {
    const value = await fixture(), observed = await value.observed(), capabilities = catalog(observed), before = await value.disk();
    expect(observed.authentication).toBe("oauth-present"); expect(observed.owner).toBeNull();
    const page = value.mounts(AgentSettings, { isZh }), copy = labels(isZh); await loaded(page, null);
    const state = page.snapshot().state!;
    expect(state).toMatchObject({ harnessId: "pi", availability: "available", localAuthentication: "oauth-present", installation: "installed",
      account: null, execution: null, scope: { authContextRef: observed.authContextRef, ownerGeneration: null } });
    expect(state.connection).toBeUndefined(); expect(state.catalog?.value).toEqual(capabilities);
    expect(state.catalog?.scope).toEqual(state.scope);
    expect(state.catalog?.speedSupport).toEqual(Object.fromEntries(capabilities.models.map(model => [model.modelId, "unsupported"])));
    expect(page.component("ChatGptConnectionCard").props.connection).toMatchObject({ phase: "oauth-present" });
    expect(page.component("ChatGptConnectionCard").props.authManagementAvailable).toBe(false);
    expect(page.row("authentication")).toContain(isZh ? "已检测到本地 OAuth，在线账号尚未验证" : "Local OAuth detected; online account unverified");
    expect(page.row("catalog")).toContain(isZh ? "模型目录可用" : "Model catalog available");
    expect(page.view().execution).toMatchObject({ phase: "unverified", evidence: "unverified" });
    expect(page.row("execution")).toContain(isZh ? "尚未验证" : "Not yet verified");
    expect(page.button(copy.connect).props.disabled).toBe(true);
    // Invoke the disabled Card handler too: its controlled intent guard must not emit auth.
    (page.button(copy.connect).props.onClick as () => void)();
    expect(page.native("button").some(button => /Bind current|绑定当前|Sign out|退出 ChatGPT|Close and cancel/.test(contents(button.props.children as ReactNode)))).toBe(false);
    await refreshObserved(page, copy.check); await refreshObserved(page, copy.refresh); await loaded(page, null);
    expect(await value.disk()).toEqual(before); expect(mutations(value)).toHaveLength(0); noCodexOrAuthMutation(value);
    expect(page.markup()).toContain(isZh ? "当前运行配置保持冻结" : "Current run configuration remains frozen");
    expect(page.markup()).not.toContain("synthetic-access"); expect(page.markup()).not.toContain("synthetic-refresh");
  });

  it("refreshes native auth disappearance and explicitly saves native preferences as pending connection without fallback", async () => {
    const value = await fixture(), page = value.mounts(AgentSettings, { isZh: false }); await loaded(page);
    const capabilities = catalog(await value.observed());
    page.choose("Model", capabilities.nativeDefaults.modelId);
    await vi.waitFor(() => expect(page.snapshot().hasChanges).toBe(true));
    await rm(join(value.agentDir, "auth.json"));
    const before = await value.disk(); await refreshObserved(page, labels().check);
    await vi.waitFor(() => expect(page.snapshot().state?.localAuthentication).toBe("missing"));
    expect(page.view().connection.phase).toBe("signed-out"); expect(page.snapshot().draft.model).toBe(capabilities.nativeDefaults.modelId);
    expect(page.button(labels().connect).props.disabled).toBe(true); expect(await value.disk()).toEqual(before);
    // The user explicitly removes the now-unverified model override; nothing auto-resets it.
    page.choose("Model", null);
    await vi.waitFor(() => expect(page.snapshot().draft).toEqual(nativePreferences));
    // Make a reversible real remote edit so saving native preferences is a meaningful CAS change.
    await writeFile(join(value.agentDir, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "synthetic-access-returned", refresh: "synthetic-refresh-returned", expires: Date.now() + 3_600_000 } }));
    const current = await value.saved();
    await updateAgentSettings(value.project, { harnessPreferences: { pi: { model: capabilities.nativeDefaults.modelId } } },
      { expectedRevision: current.revision, catalogs: { pi: capabilities } });
    await rm(join(value.agentDir, "auth.json"));
    await refreshObserved(page, labels().refresh);
    await vi.waitFor(() => expect(page.snapshot().baseline?.harnessPreferences.pi.model).toBe(capabilities.nativeDefaults.modelId));
    // Refresh adopts clean defaults; choose native explicitly again before saving.
    page.choose("Model", null); await vi.waitFor(() => expect(page.snapshot().hasChanges).toBe(true));
    page.click(labels().save);
    await vi.waitFor(() => expect(page.snapshot().savePhase).toBe("saved"));
    expect((await value.saved()).selectedHarnessId).toBe("pi"); expect((await value.saved()).harnessPreferences.pi).toEqual(nativePreferences);
    expect(page.row("save")).toContain("Saved, awaiting connection"); expect(page.view().execution.phase).toBe("unverified"); noCodexOrAuthMutation(value);
  });

  it("edits independent real model/effort choices and saves one narrow Pi CAS without upgrading readiness", async () => {
    const value = await fixture(), capabilities = catalog(await value.observed()), page = value.mounts(AgentSettings, { isZh: false }); await loaded(page);
    const first = capabilities.models.find(model => model.efforts.length > 0)!;
    const second = capabilities.models.find(model => model.modelId !== first.modelId && model.efforts.includes(first.efforts[0]!))!;
    expect(second).toBeDefined(); page.choose("Model", first.modelId);
    await vi.waitFor(() => expect(page.view().selection.modelKey).toBe(first.modelId));
    page.choose("Reasoning effort", first.efforts[0]!);
    page.choose("Model", second.modelId);
    const desired = { model: second.modelId, effort: first.efforts[0]!, speed: null };
    await vi.waitFor(() => expect(page.snapshot().draft).toEqual(desired));
    expect(page.native("select").some(node => node.props["aria-label"] === "Service speed")).toBe(false);
    page.click(labels().save);
    await vi.waitFor(() => expect(page.snapshot().savePhase).toBe("saved"));
    const writes = mutations(value); expect(writes).toHaveLength(1); expect(writes[0]!.status).toBe(200);
    expect(JSON.parse(writes[0]!.body!)).toEqual({ expectedRevision: value.initial.revision,
      patch: { selectedHarnessId: "pi", harnessPreferences: { pi: desired } } });
    const saved = await value.saved(); expect(saved.revision).toBe(value.initial.revision + 1);
    expect(saved.harnessPreferences.pi).toEqual(desired); expect(saved.harnessPreferences.codex).toEqual(value.initial.harnessPreferences.codex);
    expect(saved.modelConnectionRef).toBeNull(); expect(page.view().connection.phase).toBe("oauth-present");
    expect(page.view().execution.phase).toBe("unverified"); expect(page.row("save")).toContain("Saved, awaiting connection"); noCodexOrAuthMutation(value);
  });

  it("keeps a dirty Pi draft after a real HTTP CAS conflict until explicit review and a second save", async () => {
    const value = await fixture(), capabilities = catalog(await value.observed()), page = value.mounts(AgentSettings, { isZh: false }); await loaded(page);
    page.choose("Model", capabilities.nativeDefaults.modelId);
    await vi.waitFor(() => expect(page.snapshot().hasChanges).toBe(true));
    const dirty = { ...page.snapshot().draft }, oldRevision = page.snapshot().revision;
    const remote = await updateAgentSettings(value.project, { harnessPreferences: { pi: { effort: "low" } } },
      { expectedRevision: value.initial.revision, catalogs: { pi: capabilities } });
    page.click(labels().save);
    await vi.waitFor(() => { expect(page.snapshot().savePhase).toBe("conflict"); expect(page.snapshot().loading).toBe(false); });
    expect(mutations(value)).toHaveLength(1); expect(mutations(value)[0]!.status).toBe(409);
    expect(page.snapshot().draft).toEqual(dirty); expect(page.snapshot().revision).toBe(oldRevision);
    expect(page.snapshot().baseline?.revision).toBe(remote.revision); expect(page.snapshot().hasChanges).toBe(true);
    expect(page.row("save")).toContain("Current changes are not saved"); expect(page.native("p").some(node => node.props.role === "alert")).toBe(true);
    await refreshObserved(page, labels().check);
    expect(page.snapshot().draft).toEqual(dirty); expect(mutations(value)).toHaveLength(1);
    page.click(labels().review);
    await vi.waitFor(() => expect(page.view().save.phase).toBe("unsaved"));
    page.click(labels().save);
    await vi.waitFor(() => expect(page.snapshot().savePhase).toBe("saved"));
    expect(mutations(value)).toHaveLength(2); expect(JSON.parse(mutations(value)[1]!.body!).expectedRevision).toBe(remote.revision);
    expect((await value.saved()).harnessPreferences.pi).toEqual(dirty); noCodexOrAuthMutation(value);
  });

  it("preserves dirty preferences and their base revision through a real public Pi owner generation change", async () => {
    const value = await fixture();
    // Empty public admission establishes real continuity and freezes selection. It does
    // not call a model, refresh OAuth, run tools or verify execution. No private owner API.
    await withRuntimeExecution(value.project, async () => { expect(currentRuntimeRun()?.harnessId).toBe("pi"); });
    const first = await value.observed(); expect(first.owner).not.toBeNull();
    const page = value.mounts(AgentSettings, { isZh: false }); await loaded(page, first.owner!.authGeneration);
    page.choose("Model", catalog(first).nativeDefaults.modelId);
    await vi.waitFor(() => expect(page.snapshot().hasChanges).toBe(true));
    const draft = { ...page.snapshot().draft }, revision = page.snapshot().revision;
    await value.credentials("external-change");
    await withRuntimeExecution(value.project, async () => { expect(currentRuntimeRun()?.harnessId).toBe("pi"); });
    const next = await value.observed(); expect(next.owner!.authGeneration).toBeGreaterThan(first.owner!.authGeneration);
    const beforeGet = await value.disk(); page.click(labels().check); await loaded(page, next.owner!.authGeneration);
    expect(page.snapshot().draft).toEqual(draft); expect(page.snapshot().revision).toBe(revision); expect(page.snapshot().hasChanges).toBe(true);
    expect(page.snapshot().state?.scope?.authContextRef).toBe(next.authContextRef); expect(page.snapshot().state?.account).toBeNull();
    expect(page.view().execution.phase).toBe("unverified"); expect(await value.disk()).toEqual(beforeGet); expect(mutations(value)).toHaveLength(0); noCodexOrAuthMutation(value);
  });

  it("retains a trusted stored unsupported speed override until the user explicitly clears it and real Pi CAS accepts null", async () => {
    const value = await fixture({ unsupportedSpeed: true }), page = value.mounts(AgentSettings, { isZh: false }); await loaded(page);
    expect(page.snapshot().draft.speed).toBe("fast");
    expect(page.native("output").find(node => node.props["aria-label"] === "Current speed preference")?.props.children).toBe("fast");
    expect(page.native("select").some(node => node.props["aria-label"] === "Service speed")).toBe(false);
    expect(page.markup()).toContain("This model does not support speed overrides.");
    const original = { ...page.snapshot().draft }, before = await value.disk();
    await refreshObserved(page, labels().refresh); await loaded(page);
    expect(page.snapshot().draft).toEqual(original); expect(await value.disk()).toEqual(before); expect(mutations(value)).toHaveLength(0);
    page.click("Remove speed override; use native default");
    await vi.waitFor(() => expect(page.snapshot().draft).toEqual({ ...original, speed: null }));
    page.click(labels().save); await vi.waitFor(() => expect(page.snapshot().savePhase).toBe("saved"));
    expect((await value.saved()).harnessPreferences.pi).toEqual({ ...original, speed: null });
    expect(mutations(value)).toHaveLength(1); expect(JSON.parse(mutations(value)[0]!.body!).patch.harnessPreferences.pi.speed).toBeNull();
    expect(page.view().execution.phase).toBe("unverified"); noCodexOrAuthMutation(value);
  });

  it.each([false, true])("actual ChatPage shows saved Pi defaults separately from an unsaved editor and keeps the current-run title (isZh=%s)", async isZh => {
    const value = await fixture(), capabilities = catalog(await value.observed());
    const saved = await updateAgentSettings(value.project, { harnessPreferences: { pi: { model: capabilities.nativeDefaults.modelId, effort: "low" } } },
      { expectedRevision: value.initial.revision, catalogs: { pi: capabilities } });
    const editor = value.mounts(AgentSettings, { isZh }); await loaded(editor);
    const other = capabilities.models.find(model => model.modelId !== capabilities.nativeDefaults.modelId && !capabilities.nativeDefaults.modelId.includes(model.modelId))!;
    expect(other).toBeDefined(); editor.choose(labels(isZh).model, other.modelId);
    await vi.waitFor(() => expect(editor.snapshot().hasChanges).toBe(true));
    // The real store creates only a local empty draft. Never send a chat or execute inference.
    useChatStore.getState().createDraftSession(null, "chat");
    const nav = { toDashboard: vi.fn(), toBook: vi.fn(), toServices: vi.fn(), toProjectSettings: vi.fn(), toFilm: vi.fn(), toFilmStudio: vi.fn() };
    const props: ChatPageProps = { mode: "project-chat", nav, theme: "light", t: key => isZh && key === "nav.connected" ? "已连接" : key,
      sse: { messages: [], connected: false } };
    const chat = value.mounts(ChatPage, props);
    await vi.waitFor(() => expect(chat.markup()).toContain(isZh ? "本地 OAuth 已检测，在线账号与执行尚未验证" : "Local OAuth detected; online account and execution unverified"));
    const summary = chat.native("button").find(node => node.props["data-testid"] === "agent-defaults-status")!;
    expect(summary).toBeDefined(); const label = contents(summary.props.children as ReactNode);
    expect(label).toContain(`${isZh ? "下次运行默认配置" : "Next run defaults"} · Pi · ${saved.harnessPreferences.pi.model}`);
    expect(label).not.toContain(other.modelId); expect(label).not.toContain(saved.harnessPreferences.codex.model!); expect(label).not.toContain("codex-model-canary");
    expect(label).not.toContain("Codex"); expect(label).not.toContain("Sign in to Codex");
    expect(summary.props.title).toBe(isZh ? "下次运行默认配置；当前运行保持启动时的配置。" : "Next run defaults; the current run keeps its configuration from startup.");
    expect(editor.snapshot().draft.model).toBe(other.modelId); expect((await value.saved()).harnessPreferences.pi).toEqual(saved.harnessPreferences.pi);
    (summary.props.onClick as () => void)(); expect(nav.toProjectSettings).toHaveBeenCalledOnce();
    expect(mutations(value)).toHaveLength(0); noCodexOrAuthMutation(value);
  });
});
