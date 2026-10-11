import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAccountService, ProjectConfigSchema, updateAgentSettings } from "@actalk/inkos-core";
import { createStudioServer, shutdownStudioServer } from "../api/server";
import { invalidateApiPaths } from "../hooks/use-api";
import { AgentDefaultsStatus } from "./AgentDefaultsStatus";

interface Slot { value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void }
interface Frame { cursor: number; slots: Slot[]; effects: (() => void)[]; mounted: boolean; schedule(): void }
const boundary = vi.hoisted(() => {
  let frame: Frame | undefined;
  return { enter: (value: Frame) => { frame = value; }, leave: () => { frame = undefined; },
    current: () => { if (!frame) throw new Error("Hook outside offline React boundary"); return frame; } };
});
// Only React scheduling is simulated. useApi, fetchJson, production Hono routes,
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
        slot.value = typeof value === "function" ? (value as (old: T) => T)(slot.value as T) : value;
        if (frame.mounted) frame.schedule();
      }];
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
  let markup = "", queued = false, mounted = true;
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
  return { markup: () => markup, unmount: () => { mounted = false; for (const frame of frames.values()) {
    frame.mounted = false; frame.slots.forEach(slot => slot.cleanup?.());
  } } };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("real default summary hook → HTTP → saved public Core settings", () => {
  it("reads saved Pi without touching Codex, then reads a new saved revision after invalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-pi-summary-"));
    let factories = 0;
    const service = createCodexAccountService({ projectDir: root, clientFactory: async () => {
      factories++; throw new Error("Pi summary must not borrow a Codex peer");
    } });
    const app = createStudioServer(ProjectConfigSchema.parse({ name: "Offline defaults summary", version: "0.1.0",
      llm: { provider: "custom", baseUrl: "https://offline.invalid/v1", model: "offline-only" } }), root, { codexAccountService: service });
    const calls: string[] = [];
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input)); return app.request(String(input), init);
    });
    let page: ReturnType<typeof mount> | undefined;
    try {
      const initial = await updateAgentSettings(root, { selectedHarnessId: "pi" }, { expectedRevision: 0 });
      page = mount();
      const mounted = page;
      await vi.waitFor(() => expect(mounted.markup()).toContain("Online account and execution unverified"));
      expect(mounted.markup()).toContain("Next run defaults · Pi · Native default model");
      expect(mounted.markup()).not.toContain("Sign in to Codex");
      expect(calls).toEqual(["/api/v1/agent-configuration/settings", "/api/v1/agent-configuration/harnesses/pi/state"]);
      expect(factories).toBe(0);
      await updateAgentSettings(root, { selectedHarnessId: "codex", harnessPreferences: { codex: { model: null, effort: null, speed: null } } }, { expectedRevision: initial.revision });
      invalidateApiPaths(["/api/v1/agent-configuration/settings"]);
      await vi.waitFor(() => expect(mounted.markup()).toContain("Next run defaults · Codex"));
      expect(mounted.markup()).toContain("current run keeps its configuration from startup");
      await vi.waitFor(() => expect(calls).toContain("/api/v1/agent-configuration/harnesses/codex/state"));
      expect(calls).not.toContain("/api/v1/codex/account"); expect(calls).not.toContain("/api/v1/codex/settings");
    } finally { page?.unmount(); await shutdownStudioServer(app); await rm(root, { recursive: true, force: true }); }
  });
});
