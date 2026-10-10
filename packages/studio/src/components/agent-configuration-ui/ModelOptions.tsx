import { catalogLabels, catalogModels, selectionIssues } from "./display-state";
import { buttonClass, fieldClass, harnessLabel, localize, sameTarget, text, type CatalogView, type OptionView, type SelectionIntent, type SelectionView, type TargetView } from "./view-model";

export interface ModelOptionsProps {
  readonly id: string;
  readonly target: TargetView;
  readonly catalog: CatalogView;
  readonly selection: SelectionView;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly onIntent: (intent: SelectionIntent) => void;
}

export function ModelOptions({ id, target, catalog, selection, isZh, disabled, onIntent }: ModelOptionsProps) {
  const matches = sameTarget(target, catalog.target);
  const models = catalogModels(target, catalog);
  const model = models.find((item) => item.key === selection.modelKey);
  const issues = selectionIssues(target, catalog, selection);
  const speedVerified = model?.speed.evidence === "backend";
  const nativeDefault = text(isZh, "使用原生默认", "Use native default");
  const speedReason = model?.speed.evidence === "unsupported"
    ? text(isZh, "当前模型不支持速度覆盖。", "This model does not support speed overrides.")
    : speedVerified
      ? text(isZh, "当前模型未提供可选速度档位。", "This model provides no selectable speed tiers.")
      : text(isZh, "运行速度能力尚未验证。", "Service speed capabilities are not yet verified.");
  const select = (field: SelectionIntent["field"], label: string, value: string | null, options: readonly OptionView[], verified: boolean) => {
    const invalid = value !== null && !options.some((item) => item.key === value);
    return <label className="space-y-1 text-sm" htmlFor={`${id}-${field}`}>
      {label}
      <select id={`${id}-${field}`} aria-label={label} value={value ?? ""} disabled={disabled}
        aria-invalid={invalid || undefined} aria-describedby={`${id}-issues`} className={fieldClass} onChange={(event) => {
          const choiceKey = event.target.value === "" ? null : event.target.value;
          if (!disabled && (choiceKey === null || options.some((item) => item.key === choiceKey))) {
            onIntent({ action: "choose-option", target: { ...target }, field, choiceKey });
          }
        }}>
        <option value="">{nativeDefault}</option>
        {invalid && <option value={value} disabled>{value} ({verified ? text(isZh, "不可用", "unavailable") : text(isZh, "尚未验证", "not yet verified")})</option>}
        {options.map((item) => <option key={item.key} value={item.key}>{localize(isZh, item.label)}</option>)}
      </select>
    </label>;
  };
  return <section className="space-y-3" aria-label={`${harnessLabel(target.harness)} · ${text(isZh, "模型选项", "Model options")}`}>
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{localize(isZh, catalogLabels[matches ? catalog.phase : "unverified"])}</p>
    {matches && catalog.detail && <p role={["failed", "partial", "uncertain"].includes(catalog.phase) ? "alert" : undefined} className="text-sm text-muted-foreground">{localize(isZh, catalog.detail)}</p>}
    <div className="grid gap-4 md:grid-cols-3">
      {select("model", text(isZh, "模型", "Model"), selection.modelKey, models, matches && ["available", "partial"].includes(catalog.phase))}
      {(model?.reasoningOptions.length || selection.reasoningKey !== null) ? select("reasoning", text(isZh, "推理强度", "Reasoning effort"), selection.reasoningKey, model?.reasoningOptions ?? [], !!model) : null}
      {speedVerified && model.speed.options.length
        ? select("speed", text(isZh, "运行速度", "Service speed"), selection.speedKey, model.speed.options, true)
        : <div className="space-y-1 text-sm">
          <p>{text(isZh, "运行速度", "Service speed")}</p>
          <output aria-label={text(isZh, "当前速度偏好", "Current speed preference")} aria-describedby={`${id}-speed-reason ${id}-issues`}>{selection.speedKey ?? nativeDefault}</output>
          <p id={`${id}-speed-reason`} className="text-xs text-muted-foreground">{speedReason}</p>
          {selection.speedKey !== null && <button type="button" className={buttonClass} disabled={disabled} aria-describedby={`${id}-speed-reason ${id}-issues`}
            onClick={() => { if (!disabled) onIntent({ action: "choose-option", target: { ...target }, field: "speed", choiceKey: null }); }}>
            {text(isZh, "移除速度覆盖，使用原生默认", "Remove speed override; use native default")}
          </button>}
        </div>}
    </div>
    {!speedVerified && <p className="text-xs text-muted-foreground">{text(isZh, "运行速度选项尚未验证或不受支持。", "Service speed options are unverified or unsupported.")}</p>}
    <div id={`${id}-issues`} aria-live="polite" aria-atomic="true">
      {issues.map((issue) => <p key={issue.en} role="alert" className="text-sm text-destructive">{localize(isZh, issue)}</p>)}
    </div>
    <p className="text-xs text-muted-foreground">{text(isZh, "模型、推理强度和速度分别选择。更改模型不会自动重置其他选项。", "Choose model, reasoning effort and speed separately. Changing the model does not reset other options automatically.")}</p>
  </section>;
}
