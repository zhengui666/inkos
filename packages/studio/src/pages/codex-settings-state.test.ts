import { describe, expect, it } from "vitest";
import { changeCodexModel, selectedCodexModel, validCodexSettings } from "./codex-settings-state";
import { isCodexVerificationUrl, type StudioCodexModel } from "../shared/codex";

const models: StudioCodexModel[] = [
  { id: "first", model: "first", displayName: "First", description: "", isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }, { reasoningEffort: "high", description: "" }],
    defaultReasoningEffort: "medium", serviceTiers: [{ id: "fast", name: "Fast", description: "" }], defaultServiceTier: null },
  { id: "second", model: "second", displayName: "Second", description: "", isDefault: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }], defaultReasoningEffort: "low",
    serviceTiers: [], defaultServiceTier: null },
];

describe("Codex settings model changes", () => {
  it("resets unsupported effort and speed instead of sending stale combinations", () => {
    expect(changeCodexModel(models, { model: "first", reasoningEffort: "high", serviceTier: "fast" }, "second"))
      .toEqual({ model: "second", reasoningEffort: "low", serviceTier: "default" });
  });
  it("keeps supported effort and speed and permits the runtime default model", () => {
    const settings = { model: "first", reasoningEffort: "high", serviceTier: "fast" };
    expect(changeCodexModel(models, settings, "first")).toEqual(settings);
    const defaultSettings = changeCodexModel(models, settings, "");
    expect(defaultSettings.model).toBeUndefined();
    expect(selectedCodexModel(models, defaultSettings)?.model).toBe("first");
    expect(validCodexSettings(models, defaultSettings)).toBe(true);
  });
  it("does not invent effort levels or speed tiers, including when the catalog is unavailable", () => {
    expect(validCodexSettings(models, { model: "first", reasoningEffort: "ultra", serviceTier: "default" })).toBe(false);
    expect(validCodexSettings(models, { model: "second", reasoningEffort: "low", serviceTier: "fast" })).toBe(false);
    expect(validCodexSettings(models, { model: "missing", reasoningEffort: "medium", serviceTier: "default" })).toBe(false);
    expect(validCodexSettings([], { reasoningEffort: "medium", serviceTier: "default" })).toBe(false);
  });
});

it("only opens secure official device-login URLs", () => {
  expect(isCodexVerificationUrl("https://auth.openai.com/codex/device")).toBe(true);
  expect(isCodexVerificationUrl("https://chatgpt.com/device")).toBe(true);
  for (const url of ["javascript:alert(1)", "https://auth.openai.com.evil.test/", "https://user:password@auth.openai.com/", "http://auth.openai.com/"]) {
    expect(isCodexVerificationUrl(url)).toBe(false);
  }
});
