import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unavailableHarnessState, type AgentSettings, type HarnessState } from "../shared/agent-configuration";
import { AgentDefaultsStatus } from "./AgentDefaultsStatus";

// Controlled read snapshots test presentation only; default reader/real HTTP is tested separately.
const reads = vi.hoisted(() => ({ snapshots: [] as { data: unknown; loading: boolean; error: string | null }[] }));
vi.mock("react", async () => ({ ...await vi.importActual<typeof import("react")>("react"), useEffect: () => {},
  useState: () => [reads.snapshots.shift(), vi.fn()], useRef: (value: unknown) => ({ current: value }), useCallback: (callback: unknown) => callback }));
const native = { model: null, effort: null, speed: null };
const saved: AgentSettings = { schemaVersion: 1, revision: 4, selectedHarnessId: "pi", modelConnectionRef: null,
  harnessPreferences: { codex: { model: "old-codex-model", effort: "high", speed: "fast" }, pi: { model: "saved-pi-model", effort: "medium", speed: null } } };
function expanded(node: ReactNode): ReactNode {
  if (!isValidElement<Record<string, unknown>>(node)) return node;
  if (typeof node.type === "function") return expanded((node.type as (props: unknown) => ReactNode)(node.props));
  return { ...node, props: { ...node.props, children: Children.map(node.props.children as ReactNode, expanded) } } as ReactElement;
}
function render(settings = saved, state: HarnessState = unavailableHarnessState(settings.selectedHarnessId), isZh = false) {
  reads.snapshots.push({ data: { settings }, loading: false, error: null }, { data: { state }, loading: false, error: null });
  return renderToStaticMarkup(expanded(AgentDefaultsStatus({ isZh, onSettings: vi.fn() })));
}
beforeEach(() => { reads.snapshots.length = 0; });
describe("saved next-run defaults", () => {
  it.each([false, true])("reads only saved Pi and its state, with next-run wording (%s)", isZh => {
    const markup = render(saved, undefined, isZh);
    expect(markup).toContain("saved-pi-model"); expect(markup).not.toContain("old-codex-model");
    expect(markup).not.toContain("Sign in to Codex"); expect(markup).not.toContain("登录 Codex");
    expect(markup).toContain(isZh ? "下次运行默认配置" : "Next run defaults");
    expect(markup).toContain(isZh ? "当前运行保持启动时的配置" : "current run keeps its configuration from startup");
    expect(markup).toContain(isZh ? "在线账号与执行尚未验证" : "Online account and execution unverified");
    expect(markup).toContain('aria-live="polite"');
  });
  it("follows the saved harness after a new revision and never substitutes the previous preferences", () => {
    render();
    const markup = render({ ...saved, revision: 5, selectedHarnessId: "codex" });
    expect(markup).toContain("old-codex-model"); expect(markup).not.toContain("saved-pi-model");
    expect(markup).toContain("Next run defaults");
  });
  it("retains explicit preferences through a state mismatch without claiming execution", () => {
    const markup = render(saved, { ...unavailableHarnessState("codex"), account: { type: "chatgpt", label: "hidden-codex-identity" } });
    expect(markup).toContain("saved-pi-model"); expect(markup).not.toContain("hidden-codex-identity");
    expect(markup).toContain("execution unverified");
  });
  it("retains native defaults and unsupported speed overrides in the saved summary", () => {
    const markup = render({ ...saved, harnessPreferences: { ...saved.harnessPreferences, pi: { ...native, speed: "retained-unsupported-speed" } } });
    expect(markup).toContain("Native default model"); expect(markup).toContain("retained-unsupported-speed");
  });
  it("does not read a harness before saved settings are available", () => {
    reads.snapshots.push({ data: null, loading: true, error: null });
    const markup = renderToStaticMarkup(expanded(AgentDefaultsStatus({ isZh: false, onSettings: vi.fn() })));
    expect(reads.snapshots).toEqual([]); expect(markup).toContain("Loading saved settings");
  });
});
