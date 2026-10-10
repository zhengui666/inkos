import { catalogLabels, connectionLabels, executionLabel, installationLabels, isExecutionReady, saveLabel } from "./display-state";
import { harnessLabel, localize, sameSelection, sameTarget, text, type ConfigurationView, type TextView } from "./view-model";

export interface ConfigurationStatusProps { readonly view: ConfigurationView; readonly isZh: boolean }

export function ConfigurationStatus({ view, isZh }: ConfigurationStatusProps) {
  const unknown: TextView = { zh: "尚未验证", en: "Not yet verified" };
  const rows = [
    { key: "installation", label: text(isZh, "安装", "Installation"), status: sameTarget(view.target, view.installation.target) ? installationLabels[view.installation.phase] : unknown, source: view.installation },
    { key: "authentication", label: text(isZh, "ChatGPT 认证", "ChatGPT authentication"), status: sameTarget(view.target, view.connection.target) ? connectionLabels[view.connection.phase] : unknown, source: view.connection },
    { key: "catalog", label: text(isZh, "模型目录", "Model catalog"), status: sameTarget(view.target, view.catalog.target) ? catalogLabels[view.catalog.phase] : unknown, source: view.catalog },
    { key: "execution", label: text(isZh, "执行验证", "Execution verification"), status: executionLabel(view), source: view.execution },
    { key: "save", label: text(isZh, "保存", "Save"), status: saveLabel(view), source: view.save },
  ];
  return <section className="space-y-3" aria-label={`${harnessLabel(view.target.harness)} · ${text(isZh, "配置状态", "Configuration status")}`}>
    <p role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium">{isExecutionReady(view)
      ? text(isZh, "当前配置可运行", "This configuration is ready to run")
      : text(isZh, "当前配置尚未验证", "This configuration is not yet verified")}</p>
    <dl className="grid gap-3 sm:grid-cols-2" aria-live="polite" aria-atomic="true">
      {rows.map(({ key, label, status, source }) => {
        const current = sameTarget(view.target, source.target)
          && (key !== "save" || sameSelection(view.selection, view.save.selection))
          && (key !== "execution" || (sameSelection(view.selection, view.execution.selection) && (view.execution.phase !== "ready" || isExecutionReady(view))));
        return <div key={key} data-configuration-status={key} className="rounded-lg border border-border p-3 text-sm">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="mt-1" role={current && ["failed", "expired", "uncertain", "conflict", "partial-failure", "partial"].includes(source.phase) ? "alert" : undefined}>
            {localize(isZh, status)}
            {current && source.detail && <p className="mt-1 text-xs text-muted-foreground">{localize(isZh, source.detail)}</p>}
          </dd>
        </div>;
      })}
    </dl>
    <p className="text-xs text-muted-foreground">{text(isZh, "保存成功与可运行状态分别确认。当前运行继续使用启动时的配置。", "Saving and readiness are confirmed separately. The current run keeps its configuration from startup.")}</p>
  </section>;
}
