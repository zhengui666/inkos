import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentConfigurationPanel } from "./AgentConfigurationPanel";
import { ChatGptConnectionCard } from "./ChatGptConnectionCard";
import { ConfigurationStatus } from "./ConfigurationStatus";
import { HarnessSelector } from "./HarnessSelector";
import { ModelOptions } from "./ModelOptions";
import { OfflineConfigurationFixtures } from "./OfflineConfigurationFixtures";
import { RunConfigurationStamp } from "./RunConfigurationStamp";
import { catalogModels, isExecutionReady, saveLabel, selectionIssues } from "./display-state";
import { codexFixtureTarget, offlineCases, offlineCodexSignedIn, offlinePiSaved, offlineRun, piFixtureTarget } from "./fixtures";
import type { ConfigurationView, SelectionView, TargetView } from "./view-model";

// Node-only component tests: inspect native controls and invoke their intent handlers.
// Browser focus/keyboard behavior and actual operations remain integration checks.
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode, tag: string): Element[] {
  const result: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    if (child.type === tag) result.push(child);
    result.push(...elements(child.props.children as ReactNode, tag));
  });
  return result;
}
function contents(node: ReactNode): string {
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? contents(child.props.children) : String(child)).join("");
}
function button(node: ReactNode, label: string) {
  const result = elements(node, "button").find((item) => contents(item.props.children as ReactNode) === label);
  expect(result, `missing button ${label}`).toBeDefined();
  return result!;
}
function click(element: Element) { (element.props.onClick as () => void)(); }
function choose(element: Element, value: string) { (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); }
function modelOptions(view: ConfigurationView, onIntent = vi.fn()) {
  return ModelOptions({ id: "test-options", target: view.target, catalog: view.catalog, selection: view.selection, isZh: false, onIntent });
}
function panel(view: ConfigurationView, onSaveIntent = vi.fn(), options: { canSave?: boolean; hasChanges?: boolean; disabled?: boolean } = {}) {
  return AgentConfigurationPanel({ id: "test-panel", view, isZh: false, canSave: true, hasChanges: true, onSaveIntent,
    onHarnessChange: vi.fn(), onConnectionIntent: vi.fn(), onSelectionIntent: vi.fn(), ...options });
}
// Fabricated display evidence tests the rendering rule; this is never real backend evidence.
function simulatedReady(): ConfigurationView {
  return { ...offlineCodexSignedIn, execution: { ...offlineCodexSignedIn.execution, phase: "ready", evidence: "backend" } };
}

describe("HarnessSelector native accessibility", () => {
  it("uses one labelled native radio group with a controlled selection", () => {
    const onChange = vi.fn();
    const tree = HarnessSelector({ name: "harness-one", value: "pi", isZh: false, onChange });
    const radios = elements(tree, "input");
    expect(radios.map((item) => [item.props.type, item.props.name, item.props.value, item.props.checked])).toEqual([
      ["radio", "harness-one", "codex", false], ["radio", "harness-one", "pi", true],
    ]);
    expect(renderToStaticMarkup(tree)).toContain("<legend");
    expect(renderToStaticMarkup(tree)).toContain('aria-describedby="harness-one-help"');
    expect(radios.every((item) => String(item.props.className).includes("focus-visible:"))).toBe(true);
    choose(radios[0]!, "codex");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("codex");
    expect(radios[1]!.props.checked).toBe(true);
  });
  it("keeps group names separate and suppresses disabled selection intents", () => {
    const onChange = vi.fn();
    const first = HarnessSelector({ name: "first", value: "codex", isZh: true, disabled: true, onChange });
    const second = HarnessSelector({ name: "second", value: "pi", isZh: true, onChange });
    expect(renderToStaticMarkup(first)).toMatch(/<fieldset[^>]*disabled/);
    expect(elements(first, "input")[0]!.props.name).not.toBe(elements(second, "input")[0]!.props.name);
    choose(elements(first, "input")[1]!, "pi");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ChatGPT connections and target-bound intents", () => {
  it.each([piFixtureTarget, { ...codexFixtureTarget, contextKey: "another-codex-context" }])("hides an account from a different target %o", (target) => {
    const html = renderToStaticMarkup(ChatGptConnectionCard({ target, connection: offlineCodexSignedIn.connection, isZh: true, onIntent: vi.fn() }));
    expect(html).not.toContain("codex-fixture@example.invalid");
    expect(html).toContain("尚未验证");
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>使用 ChatGPT 登录/);
  });
  it("only shows the same target's account when signed in", () => {
    const signedIn = renderToStaticMarkup(ChatGptConnectionCard({ target: codexFixtureTarget, connection: offlineCodexSignedIn.connection, isZh: false, onIntent: vi.fn() }));
    const signedOut = renderToStaticMarkup(ChatGptConnectionCard({ target: codexFixtureTarget, connection: { ...offlineCodexSignedIn.connection, phase: "signed-out" }, isZh: false, onIntent: vi.fn() }));
    expect(signedIn).toContain("codex-fixture@example.invalid");
    expect(signedIn).toContain("execution still need verification");
    expect(signedOut).not.toContain("codex-fixture@example.invalid");
    expect(signedOut).not.toContain("API key");
  });
  it("binds an old cancel handler to its original attempt when a new target is rendered", () => {
    const onIntent = vi.fn();
    const old = ChatGptConnectionCard({ target: piFixtureTarget, connection: { target: piFixtureTarget, phase: "signing-in", attemptKey: "attempt-old" }, isZh: false, onIntent });
    ChatGptConnectionCard({ target: codexFixtureTarget, connection: { target: codexFixtureTarget, phase: "signing-in", attemptKey: "attempt-new" }, isZh: false, onIntent });
    click(button(old, "Cancel sign-in"));
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ action: "cancel-sign-in", target: piFixtureTarget, attemptKey: "attempt-old" });
    expect(renderToStaticMarkup(old)).not.toContain("Signed in to ChatGPT");
  });
  it("never cancels an unbound attempt or one from another harness", () => {
    const onIntent = vi.fn();
    const noAttempt = ChatGptConnectionCard({ target: piFixtureTarget, connection: { target: piFixtureTarget, phase: "signing-in" }, isZh: false, onIntent });
    const wrong = ChatGptConnectionCard({ target: piFixtureTarget, connection: { target: codexFixtureTarget, phase: "signing-in", attemptKey: "codex-attempt" }, isZh: false, onIntent });
    expect(button(noAttempt, "Cancel sign-in").props.disabled).toBe(true);
    click(button(noAttempt, "Cancel sign-in"));
    expect(elements(wrong, "button").some((item) => contents(item.props.children as ReactNode) === "Cancel sign-in")).toBe(false);
    expect(onIntent).not.toHaveBeenCalled();
  });
  it("requires a status check before retrying unknown or uncertain sign-in results", () => {
    const onIntent = vi.fn();
    for (const phase of ["unverified", "uncertain"] as const) {
      const tree = ChatGptConnectionCard({ target: piFixtureTarget, connection: { target: piFixtureTarget, phase }, isZh: false, onIntent });
      click(button(tree, "Sign in with ChatGPT"));
      expect(button(tree, "Sign in with ChatGPT").props.disabled).toBe(true);
    }
    expect(onIntent).not.toHaveBeenCalled();
  });
  it("emits login, logout and refresh intents for exactly the displayed target", () => {
    const onIntent = vi.fn();
    const signedOut = ChatGptConnectionCard({ target: piFixtureTarget, connection: offlinePiSaved.connection, isZh: false, onIntent });
    click(button(signedOut, "Sign in with ChatGPT"));
    click(button(signedOut, "Check status"));
    const signedIn = ChatGptConnectionCard({ target: codexFixtureTarget, connection: offlineCodexSignedIn.connection, isZh: false, onIntent });
    click(button(signedIn, "Sign out of ChatGPT"));
    expect(onIntent.mock.calls.map(([intent]) => intent)).toEqual([
      { action: "connect", target: piFixtureTarget }, { action: "refresh-connection", target: piFixtureTarget }, { action: "sign-out", target: codexFixtureTarget },
    ]);
    expect(elements(signedOut, "button").every((item) => item.props.type === "button")).toBe(true);
  });
  it("blocks disabled intents and reports expired, failed and uncertain results in text", () => {
    const onIntent = vi.fn();
    const disabled = ChatGptConnectionCard({ target: piFixtureTarget, connection: offlinePiSaved.connection, isZh: false, disabled: true, onIntent });
    click(button(disabled, "Sign in with ChatGPT"));
    expect(onIntent).not.toHaveBeenCalled();
    for (const phase of ["expired", "failed", "uncertain"] as const) {
      const html = renderToStaticMarkup(ChatGptConnectionCard({ target: piFixtureTarget, connection: { target: piFixtureTarget, phase }, isZh: true, onIntent }));
      expect(html).toContain('role="alert"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('aria-atomic="true"');
    }
  });
});

describe("ModelOptions controlled catalog choices", () => {
  it("emits only the chosen model, keeping other choices until the owner changes them", () => {
    const onIntent = vi.fn();
    const selection: SelectionView = Object.freeze({ modelKey: "example-a", reasoningKey: "old-effort", speedKey: "old-speed" });
    const view = { ...offlineCodexSignedIn, selection, catalog: { ...offlineCodexSignedIn.catalog, models: [
      ...offlineCodexSignedIn.catalog.models, { ...offlineCodexSignedIn.catalog.models[0]!, key: "example-b" },
    ] } };
    const tree = modelOptions(view, onIntent);
    choose(elements(tree, "select").find((item) => item.props["aria-label"] === "Model")!, "example-b");
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ action: "choose-option", target: codexFixtureTarget, field: "model", choiceKey: "example-b" });
    expect(selection).toEqual({ modelKey: "example-a", reasoningKey: "old-effort", speedKey: "old-speed" });
    expect(renderToStaticMarkup(tree)).toContain("old-effort (unavailable)");
    expect(selectionIssues(view.target, view.catalog, selection)).toHaveLength(2);
  });
  it("preserves an unavailable selected model and never chooses the first model as fallback", () => {
    const view = { ...offlineCodexSignedIn, selection: { ...offlineCodexSignedIn.selection, modelKey: "removed-model" } };
    const tree = modelOptions(view);
    const select = elements(tree, "select")[0]!;
    expect(select.props.value).toBe("removed-model");
    expect(select.props["aria-invalid"]).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain("removed-model (unavailable)");
    expect(isExecutionReady({ ...simulatedReady(), selection: view.selection })).toBe(false);
  });
  it("provides only verified speed choices and keeps speed independent of reasoning", () => {
    const onIntent = vi.fn();
    const view: ConfigurationView = { ...offlineCodexSignedIn, selection: { ...offlineCodexSignedIn.selection, speedKey: "example-standard" },
      catalog: { ...offlineCodexSignedIn.catalog, models: [{ ...offlineCodexSignedIn.catalog.models[0]!, speed: {
        evidence: "backend", options: [{ key: "example-standard", label: { zh: "示例标准速度", en: "Example standard speed" } }],
      } }] } };
    const tree = modelOptions(view, onIntent);
    const selects = elements(tree, "select");
    expect(selects.map((item) => item.props["aria-label"])).toEqual(["Model", "Reasoning effort", "Service speed"]);
    choose(selects[2]!, "example-standard");
    expect(onIntent).toHaveBeenCalledExactlyOnceWith({ action: "choose-option", target: codexFixtureTarget, field: "speed", choiceKey: "example-standard" });
    expect(selectionIssues(view.target, view.catalog, view.selection)).toHaveLength(0);
    expect(selects.every((item) => String(item.props.className).includes("focus-visible:") && item.props["aria-describedby"] === "test-options-issues")).toBe(true);
  });
  it.each(["unverified", "unsupported"] as const)("hides Pi speed controls when capability is %s, even if options are present", (evidence) => {
    const view: ConfigurationView = { ...offlinePiSaved, catalog: { target: piFixtureTarget, phase: "available", models: [{ ...offlineCodexSignedIn.catalog.models[0]!, speed: {
      evidence, options: [{ key: "fabricated-fast", label: { zh: "虚构快档", en: "Fabricated fast tier" } }],
    } }] } };
    const tree = modelOptions(view);
    expect(elements(tree, "select").some((item) => item.props["aria-label"] === "Service speed")).toBe(false);
    expect(renderToStaticMarkup(tree)).not.toContain("Fabricated fast tier");
    expect(renderToStaticMarkup(tree)).toContain("unverified or unsupported");
  });
  it("does not read catalog options from another harness or context", () => {
    for (const target of [piFixtureTarget, { ...codexFixtureTarget, contextKey: "other" }] satisfies TargetView[]) {
      const view = { ...offlineCodexSignedIn, target };
      expect(catalogModels(target, view.catalog)).toHaveLength(0);
      expect(renderToStaticMarkup(modelOptions(view))).not.toContain("Example model A");
      expect(elements(modelOptions(view), "select")[0]!.props.disabled).toBe(true);
    }
  });
  it("rejects invalid selection events and preserves target binding across renders", () => {
    const onIntent = vi.fn();
    const old = modelOptions(offlineCodexSignedIn, onIntent);
    modelOptions(offlinePiSaved, onIntent);
    choose(elements(old, "select")[0]!, "not-in-catalog");
    expect(onIntent).not.toHaveBeenCalled();
    choose(elements(old, "select")[0]!, "example-a");
    expect(onIntent.mock.calls[0]![0].target).toEqual(codexFixtureTarget);
  });
  it("marks partial catalog errors inline while showing received options", () => {
    const view = offlineCases.find((item) => item.key === "expired-partial")!.view;
    const html = renderToStaticMarkup(modelOptions(view));
    expect(html).toContain("Model catalog partially available");
    expect(html).toContain("only part of the catalog was received");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Example model A");
  });
});

describe("five independent configuration statuses", () => {
  it("does not equate signed-in, available catalog or saved settings with execution readiness", () => {
    const html = renderToStaticMarkup(ConfigurationStatus({ view: offlineCodexSignedIn, isZh: false }));
    expect((html.match(/data-configuration-status=/g) ?? [])).toHaveLength(5);
    expect(html).toContain("Installed");
    expect(html).toContain("Signed in to ChatGPT");
    expect(html).toContain("Model catalog available");
    expect(html).toContain("Not yet verified");
    expect(html).toContain("Saved, awaiting connection");
    expect(html).not.toContain("ready to run");
  });
  it("requires exact-target, exact-selection backend execution evidence", () => {
    const ready = simulatedReady();
    expect(isExecutionReady(ready)).toBe(true);
    const staleSelection = { ...ready.selection, modelKey: "different" };
    const variants: ConfigurationView[] = [
      { ...ready, execution: { ...ready.execution, evidence: "unverified" } },
      { ...ready, execution: { ...ready.execution, target: piFixtureTarget } },
      { ...ready, execution: { ...ready.execution, selection: staleSelection } },
      { ...ready, installation: { ...ready.installation, phase: "missing" } },
      { ...ready, connection: { ...ready.connection, phase: "signed-out" } },
      { ...ready, catalog: { ...ready.catalog, phase: "failed" } },
      { ...ready, selection: { ...ready.selection, reasoningKey: "unsupported" } },
    ];
    for (const view of variants) {
      expect(isExecutionReady(view)).toBe(false);
      const html = renderToStaticMarkup(ConfigurationStatus({ view, isZh: true }));
      expect(html).toContain("当前配置尚未验证");
      expect(html).not.toContain("执行验证通过");
    }
  });
  it("renders saved Pi as awaiting connection in both languages without fallback", () => {
    expect(saveLabel(offlinePiSaved)).toEqual({ zh: "已保存，待连接", en: "Saved, awaiting connection" });
    const zh = renderToStaticMarkup(ConfigurationStatus({ view: offlinePiSaved, isZh: true }));
    const en = renderToStaticMarkup(ConfigurationStatus({ view: offlinePiSaved, isZh: false }));
    expect(zh).toContain("已保存，待连接");
    expect(en).toContain("Saved, awaiting connection");
    expect(zh).not.toContain("Codex");
  });
  it("does not claim a previous save applies to another target or new draft", () => {
    expect(saveLabel({ ...offlinePiSaved, save: offlineCodexSignedIn.save }).zh).toBe("尚未验证");
    expect(saveLabel({ ...offlinePiSaved, selection: { ...offlinePiSaved.selection, reasoningKey: "new-effort" } }).en).toBe("Current changes are not saved");
  });
  it("does not display stale save or execution details as evidence for a new selection", () => {
    const stale = { ...offlineCodexSignedIn.selection, modelKey: "previous-model" };
    const view: ConfigurationView = { ...offlineCodexSignedIn,
      execution: { ...offlineCodexSignedIn.execution, phase: "ready", evidence: "backend", selection: stale, detail: { zh: "旧执行通过", en: "Old execution passed" } },
      save: { ...offlineCodexSignedIn.save, selection: stale, detail: { zh: "旧配置保存成功", en: "Old configuration saved" } },
    };
    const html = renderToStaticMarkup(ConfigurationStatus({ view, isZh: false }));
    expect(html).not.toContain("Old execution passed");
    expect(html).not.toContain("Old configuration saved");
    expect(html).toContain("Current changes are not saved");
  });
  it.each(["conflict", "partial-failure", "uncertain", "failed"] as const)("reports %s save results inline", (phase) => {
    const html = renderToStaticMarkup(ConfigurationStatus({ view: { ...offlinePiSaved, save: { ...offlinePiSaved.save, phase } }, isZh: false }));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Saved, awaiting connection");
  });
});

describe("explicit controlled save and frozen current-run display", () => {
  it("emits an explicit Pi save while disconnected, taking a copy of the selection", () => {
    const onSaveIntent = vi.fn();
    const tree = panel(offlinePiSaved, onSaveIntent);
    expect(button(tree, "Save defaults · Pi").props.disabled).toBe(false);
    click(button(tree, "Save defaults · Pi"));
    expect(onSaveIntent).toHaveBeenCalledExactlyOnceWith({ action: "save-defaults", target: piFixtureTarget, selection: offlinePiSaved.selection });
    expect(onSaveIntent.mock.calls[0]![0].selection).not.toBe(offlinePiSaved.selection);
    expect(offlinePiSaved.connection.phase).toBe("signed-out");
  });
  it.each([{ canSave: false }, { hasChanges: false }, { disabled: true }])("uses the parent's save controls %o", (options) => {
    const onSaveIntent = vi.fn();
    const tree = panel(offlinePiSaved, onSaveIntent, options);
    click(button(tree, "Save defaults · Pi"));
    expect(button(tree, "Save defaults · Pi").props.disabled).toBe(true);
    expect(onSaveIntent).not.toHaveBeenCalled();
  });
  it("does not re-emit save while the controlled save state is busy", () => {
    const onSaveIntent = vi.fn();
    const tree = panel({ ...offlinePiSaved, save: { ...offlinePiSaved.save, phase: "saving" } }, onSaveIntent);
    click(button(tree, "Saving…"));
    expect(onSaveIntent).not.toHaveBeenCalled();
  });
  it("does not treat another harness's save as this target's busy operation", () => {
    const onSaveIntent = vi.fn();
    const tree = panel({ ...offlinePiSaved, save: { ...offlineCodexSignedIn.save, phase: "saving" } }, onSaveIntent);
    click(button(tree, "Save defaults · Pi"));
    expect(onSaveIntent.mock.calls[0]![0].target).toEqual(piFixtureTarget);
  });
  it("continues displaying the startup Codex snapshot after defaults switch to Pi", () => {
    const before = renderToStaticMarkup(RunConfigurationStamp({ run: offlineRun, isZh: true }));
    const defaults = renderToStaticMarkup(panel(offlinePiSaved));
    const after = renderToStaticMarkup(RunConfigurationStamp({ run: offlineRun, isZh: true }));
    expect(defaults).toContain("Save defaults · Pi");
    expect(after).toBe(before);
    expect(after).toContain("Codex");
    expect(after).toContain("Example model A");
    expect(after).not.toContain("<select");
    expect(after).not.toContain("<button");
  });
  it("renders all offline mixed-state fixtures in both languages without network work", () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network work is forbidden in this UI package"); });
    vi.useFakeTimers();
    try {
      const zh = renderToStaticMarkup(OfflineConfigurationFixtures({ isZh: true }));
      const en = renderToStaticMarkup(OfflineConfigurationFixtures({ isZh: false }));
      expect(zh).toContain("真实登录、推理和部署均尚未验证");
      expect(en).toContain("Real sign-in, inference and deployment are not yet verified");
      expect(zh).toContain("登录结果不确定");
      expect(zh).toContain("保存冲突");
      expect(zh).toContain("保存部分失败");
      expect(zh).toContain("保存结果不确定");
      expect(offlineCases.every(({ view }) => !isExecutionReady(view))).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { fetch.mockRestore(); vi.useRealTimers(); }
  });
});
