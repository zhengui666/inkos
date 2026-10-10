import { catalogLabels, catalogModels, selectionIssues } from "./display-state";
import { fieldClass, harnessLabel, localize, sameTarget, text, type CatalogView, type OptionView, type SelectionIntent, type SelectionView, type TargetView } from "./view-model";

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
  const select = (field: SelectionIntent["field"], label: string, value: string | null, options: readonly OptionView[], enabled: boolean) => {
    const invalid = value !== null && !options.some((item) => item.key === value);
    return <label className="space-y-1 text-sm" htmlFor={`${id}-${field}`}>
      {label}
      <select id={`${id}-${field}`} aria-label={label} value={value ?? ""} disabled={disabled || !enabled}
        aria-invalid={invalid || undefined} aria-describedby={`${id}-issues`} className={fieldClass} onChange={(event) => {
          if (!disabled && enabled && options.some((item) => item.key === event.target.value)) {
            onIntent({ action: "choose-option", target: { ...target }, field, choiceKey: event.target.value });
          }
        }}>
        <option value="" disabled>{text(isZh, "请选择", "Choose an option")}</option>
        {invalid && <option value={value} disabled>{value} ({text(isZh, "不可用", "unavailable")})</option>}
        {options.map((item) => <option key={item.key} value={item.key}>{localize(isZh, item.label)}</option>)}
      </select>
    </label>;
  };
  return <section className="space-y-3" aria-label={`${harnessLabel(target.harness)} · ${text(isZh, "模型选项", "Model options")}`}>
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{localize(isZh, catalogLabels[matches ? catalog.phase : "unverified"])}</p>
    {matches && catalog.detail && <p role={["failed", "partial", "uncertain"].includes(catalog.phase) ? "alert" : undefined} className="text-sm text-muted-foreground">{localize(isZh, catalog.detail)}</p>}
    <div className="grid gap-4 md:grid-cols-3">
      {select("model", text(isZh, "模型", "Model"), selection.modelKey, models, models.length > 0)}
      {(model?.reasoningOptions.length || selection.reasoningKey !== null) ? select("reasoning", text(isZh, "推理强度", "Reasoning effort"), selection.reasoningKey, model?.reasoningOptions ?? [], !!model?.reasoningOptions.length) : null}
      {speedVerified && model.speed.options.length ? select("speed", text(isZh, "运行速度", "Service speed"), selection.speedKey, model.speed.options, true) : null}
    </div>
    {!speedVerified && <p className="text-xs text-muted-foreground">{text(isZh, "运行速度选项尚未验证或不受支持。", "Service speed options are unverified or unsupported.")}</p>}
    <div id={`${id}-issues`} aria-live="polite" aria-atomic="true">
      {issues.map((issue) => <p key={issue.en} role="alert" className="text-sm text-destructive">{localize(isZh, issue)}</p>)}
    </div>
    <p className="text-xs text-muted-foreground">{text(isZh, "模型、推理强度和速度分别选择。更改模型不会自动重置其他选项。", "Choose model, reasoning effort and speed separately. Changing the model does not reset other options automatically.")}</p>
  </section>;
}
