import { harnessLabel, localize, text, type FrozenRunView } from "./view-model";

export interface RunConfigurationStampProps { readonly run: FrozenRunView; readonly isZh: boolean }

export function RunConfigurationStamp({ run, isZh }: RunConfigurationStampProps) {
  const unspecified = text(isZh, "未指定", "Not specified");
  return <section className="rounded-lg border border-border p-4 space-y-2" aria-label={text(isZh, "本次运行配置", "Configuration for this run")}>
    <h3 className="text-sm font-medium">{localize(isZh, run.runLabel)}</h3>
    <dl className="grid gap-2 sm:grid-cols-2 text-sm">
      <div><dt className="text-muted-foreground">{text(isZh, "执行器", "Harness")}</dt><dd>{harnessLabel(run.harness)}</dd></div>
      <div><dt className="text-muted-foreground">{text(isZh, "模型", "Model")}</dt><dd>{run.modelLabel}</dd></div>
      <div><dt className="text-muted-foreground">{text(isZh, "推理强度", "Reasoning effort")}</dt><dd>{run.reasoningLabel ? localize(isZh, run.reasoningLabel) : unspecified}</dd></div>
      <div><dt className="text-muted-foreground">{text(isZh, "运行速度", "Service speed")}</dt><dd>{run.speedLabel ? localize(isZh, run.speedLabel) : unspecified}</dd></div>
    </dl>
    <p className="text-xs text-muted-foreground">{text(isZh, "配置已在启动时固定；新默认设置用于下次运行。", "Configuration was fixed at startup; new defaults apply to the next run.")}</p>
  </section>;
}
