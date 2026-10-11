import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAccountService, ProjectConfigSchema, updateAgentSettings, type AgentSettings } from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "../api/server";
import { invalidateApiPaths } from "../hooks/use-api";
import { AgentDefaultsStatus } from "./AgentDefaultsStatus";

interface Slot { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }
interface Frame { cursor: number; slots: Slot[]; effects: (() => void)[]; mounted: boolean; schedule(): void }
const boundary = vi.hoisted(() => {
  let frame: Frame | undefined;
  return { lateUpdates: 0, enter: (value: Frame) => { frame = value; }, leave: () => { frame = undefined; },
    current: () => { if (!frame) throw new Error("Hook outside offline React boundary"); return frame; } };
});
// Only React scheduling is simulated. The private default reader, fetchJson, real TCP/Hono routes,
// public Core settings CAS and account service remain real. No ready service fixture.
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...actual,
    useState: <T>(initial: T | (() => T)) => {
      const frame = boundary.current(), index = frame.cursor++;
      const slot = frame.slots[index] ??= { value: typeof initial === "function" ? (initial as () => T)() : initial };
      return [slot.value, (value: T | ((old: T) => T)) => {
        if (!frame.mounted) boundary.lateUpdates++;
        slot.value = typeof value === "function" ? (value as (old: T) => T)(slot.value as T) : value;
        if (frame.mounted) frame.schedule();
      }];
    },
    useRef: <T>(initial: T) => {
      const frame = boundary.current(), index = frame.cursor++;
      const slot = frame.slots[index] ??= { value: { current: initial } };
      return slot.value;
    },
    useCallback: <T>(value: T, dependencies?: readonly unknown[]) => {
      const frame = boundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (!old || !same(old.dependencies, dependencies)) frame.slots[index] = { value, dependencies };
      return frame.slots[index]!.value;
    },
    useEffect: (effect: () => void | (() => void), dependencies?: readonly unknown[]) => {
      const frame = boundary.current(), index = frame.cursor++, old = frame.slots[index];
      if (old && same(old.dependencies, dependencies)) return;
      const slot: Slot = { dependencies }; frame.slots[index] = slot;
      frame.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); if (cleanup) slot.cleanup = cleanup; });
    },
  };
});

function mount() {
  const frames = new Map<string, Frame>();
  let markup = "", queued = false, mounted = true, saved: AgentSettings | undefined;
  const schedule = () => {
    if (!mounted || queued) return; queued = true;
    void Promise.resolve().then(() => { queued = false; if (mounted) render(); });
  };
  const render = () => {
    const used = new Set<string>();
    function expand(node: ReactNode, path: string): ReactNode {
      if (!isValidElement<Record<string, unknown>>(node)) return node;
      if (typeof node.type === "function") {
        const key = `${path}:${node.type.name}:${node.key ?? ""}`; used.add(key);
        const frame = frames.get(key) ?? { cursor: 0, slots: [], effects: [], mounted: true, schedule };
        frames.set(key, frame); frame.cursor = 0; boundary.enter(frame);
        if (node.type.name === "SavedHarnessDefaults") saved = node.props.saved as AgentSettings;
        let result: ReactNode;
        try { result = (node.type as (props: unknown) => ReactNode)(node.props); } finally { boundary.leave(); }
        return expand(result, key);
      }
      return { ...node, props: { ...node.props, children: Children.map(node.props.children as ReactNode, (child, index) => expand(child, `${path}/${index}`)) } } as ReactElement;
    }
    markup = renderToStaticMarkup(expand(createElement(AgentDefaultsStatus, { isZh: false, onSettings: vi.fn() }), "root"));
    for (const [key, frame] of frames) {
      if (!used.has(key)) { frame.mounted = false; frame.slots.forEach(slot => slot.cleanup?.()); frames.delete(key); }
      else for (const effect of frame.effects.splice(0)) effect();
    }
  };
  render();
  return { markup: () => markup, saved: () => saved, unmount: () => { mounted = false; for (const frame of frames.values()) {
    frame.mounted = false; frame.slots.forEach(slot => slot.cleanup?.());
  } } };
}
beforeEach(() => { boundary.lateUpdates = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

const settingsPath = "/api/v1/agent-configuration/settings";
interface Read { readonly path: string; readonly signal: AbortSignal | undefined; readonly response: Response }
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(deliver?: (read: Read) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "inkos-pi-summary-"));
  let factories = 0;
  const service = createCodexAccountService({ projectDir: root, clientFactory: async () => {
    factories++; throw new Error("Pi summary must not borrow a Codex peer");
  } });
  const app = createStudioServer(ProjectConfigSchema.parse({ name: "Offline defaults summary", version: "0.1.0",
    llm: { provider: "custom", baseUrl: "https://offline.invalid/v1", model: "offline-only" } }), root, { codexAccountService: service });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local TCP listener");
  const base = `http://127.0.0.1:${address.port}`, nativeFetch = fetch;
  const calls: string[] = [];
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); calls.push(path);
    const actual = await nativeFetch(new URL(path, base), init);
    // Buffer the actual HTTP body so delayed delivery can deliberately ignore Abort.
    // The request sequence must fence both late success and late failure anyway.
    const response = new Response(await actual.arrayBuffer(), { status: actual.status, headers: actual.headers });
    await deliver?.({ path, signal: init?.signal ?? undefined, response }); return response;
  });
  return { root, calls, factories: () => factories,
    savePi: async (expectedRevision: number) => {
      const response = await nativeFetch(new URL(settingsPath, base), { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision, patch: { selectedHarnessId: "pi" } }) });
      expect(response.status).toBe(200); return (await response.json() as { settings: AgentSettings }).settings;
    },
    close: async () => {
      await shutdownStudioServer(app);
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    } };
}
async function settle() { for (let index = 0; index < 100; index++) await Promise.resolve(); }
function expectNoCodex(value: Awaited<ReturnType<typeof fixture>>) {
  expect(value.calls.some(path => path.includes("/codex/"))).toBe(false);
  expect(value.factories()).toBe(0);
}

describe("real default summary reader → TCP HTTP → saved public Core settings", () => {
  it("reads saved Pi without touching Codex, then reads a new saved revision after invalidation", async () => {
    const value = await fixture(), { root, calls } = value;
    let page: ReturnType<typeof mount> | undefined;
    try {
      const initial = await updateAgentSettings(root, { selectedHarnessId: "pi" }, { expectedRevision: 0 });
      page = mount();
      const mounted = page;
      await vi.waitFor(() => expect(mounted.markup()).toContain("Online account and execution unverified"));
      expect(mounted.markup()).toContain("Next run defaults · Pi · Native default model");
      expect(mounted.markup()).not.toContain("Sign in to Codex");
      expect(calls).toEqual(["/api/v1/agent-configuration/settings", "/api/v1/agent-configuration/harnesses/pi/state"]);
      expect(value.factories()).toBe(0);
      await updateAgentSettings(root, { selectedHarnessId: "codex", harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: initial.revision });
      invalidateApiPaths(["/api/v1/agent-configuration/settings"]);
      await vi.waitFor(() => expect(mounted.markup()).toContain("Next run defaults · Codex"));
      expect(mounted.markup()).toContain("current run keeps its configuration from startup");
      await vi.waitFor(() => expect(calls).toContain("/api/v1/agent-configuration/harnesses/codex/state"));
      expect(calls).not.toContain("/api/v1/codex/account"); expect(calls).not.toContain("/api/v1/codex/settings");
    } finally { page?.unmount(); await value.close(); }
  });

  it.each(["invalidate-success", "invalidate-failure", "focus-success", "focus-failure"])("keeps saved rev2 Pi after delayed rev1 Codex (%s)", async scenario => {
    const held = deferred(); let old: Read | undefined;
    const value = await fixture(async read => {
      if (read.path === settingsPath && !old) { old = read; await held.promise; }
    });
    let page: ReturnType<typeof mount> | undefined;
    try {
      const first = await updateAgentSettings(value.root, { harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: 0 });
      page = mount(); const mounted = page;
      await vi.waitFor(() => expect(old).toBeDefined());
      expect((await old!.response.clone().json()).settings).toMatchObject({ revision: 1, selectedHarnessId: "codex" });
      const pi = await value.savePi(first.revision); expect(pi.revision).toBe(2);
      if (scenario.startsWith("focus")) window.dispatchEvent(new Event("focus")); else invalidateApiPaths([settingsPath]);
      await vi.waitFor(() => expect(mounted.markup()).toContain("Next run defaults · Pi"));
      expect(mounted.saved()).toEqual(pi); expect(old!.signal?.aborted).toBe(true); expectNoCodex(value);
      if (scenario.endsWith("failure")) held.reject(new Error("Delayed old settings delivery failed")); else held.resolve();
      await settle();
      expect(mounted.saved()).toEqual(pi); expect(mounted.markup()).toContain("Next run defaults · Pi");
      expect(mounted.markup()).not.toContain("Next run defaults · Codex"); expectNoCodex(value);
      expect(boundary.lateUpdates).toBe(0);
    } finally { held.resolve(); page?.unmount(); await value.close(); }
  });

  it("keeps the latest real HTTP failure visible after an old successful settings response arrives", async () => {
    const held = deferred(); let old: Read | undefined;
    const value = await fixture(async read => {
      if (read.path === settingsPath && !old) { old = read; await held.promise; }
    });
    let page: ReturnType<typeof mount> | undefined;
    try {
      const first = await updateAgentSettings(value.root, { harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: 0 });
      page = mount(); const mounted = page;
      await vi.waitFor(() => expect(old).toBeDefined());
      await value.savePi(first.revision);
      await writeFile(join(value.root, ".inkos", "agent-config.json"), "invalid-test-settings");
      invalidateApiPaths([settingsPath]);
      await vi.waitFor(() => expect(mounted.markup()).toContain("Settings read failed; check settings"));
      expect(old!.signal?.aborted).toBe(true); held.resolve(); await settle();
      expect(mounted.markup()).toContain("Settings read failed; check settings"); expectNoCodex(value);
      expect(boundary.lateUpdates).toBe(0);
    } finally { held.resolve(); page?.unmount(); await value.close(); }
  });

  it("aborts and fences an unmounted read and removes focus/invalidation listeners", async () => {
    const held = deferred(); let old: Read | undefined;
    const value = await fixture(async read => { old = read; await held.promise; });
    let page: ReturnType<typeof mount> | undefined;
    try {
      page = mount(); await vi.waitFor(() => expect(old).toBeDefined());
      page.unmount(); expect(old!.signal?.aborted).toBe(true);
      held.resolve(); await settle();
      window.dispatchEvent(new Event("focus")); invalidateApiPaths([settingsPath]); await settle();
      expect(value.calls).toEqual([settingsPath]); expect(boundary.lateUpdates).toBe(0); expectNoCodex(value);
    } finally { held.resolve(); page?.unmount(); await value.close(); }
  });
});
