import type { StudioCodexModel, StudioCodexSettings } from "../shared/codex";

export function selectedCodexModel(models: readonly StudioCodexModel[], settings: StudioCodexSettings) {
  return settings.model
    ? models.find((model) => model.model === settings.model || model.id === settings.model)
    : models.find((model) => model.isDefault) ?? models[0];
}

export function changeCodexModel(models: readonly StudioCodexModel[], current: StudioCodexSettings, modelId: string): StudioCodexSettings {
  const next = { ...current, model: modelId || undefined };
  const model = selectedCodexModel(models, next);
  if (!model) return next;
  return {
    ...next,
    reasoningEffort: model.supportedReasoningEfforts.some((option) => option.reasoningEffort === current.reasoningEffort)
      ? current.reasoningEffort : model.defaultReasoningEffort,
    serviceTier: current.serviceTier === "default" || model.serviceTiers.some((tier) => tier.id === current.serviceTier)
      ? current.serviceTier : "default",
  };
}

export function validCodexSettings(models: readonly StudioCodexModel[], settings: StudioCodexSettings): boolean {
  const model = selectedCodexModel(models, settings);
  return Boolean(model && model.supportedReasoningEfforts.some((option) => option.reasoningEffort === settings.reasoningEffort)
    && (settings.serviceTier === "default" || model.serviceTiers.some((tier) => tier.id === settings.serviceTier)));
}
