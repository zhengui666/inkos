import { sameSelection, sameTarget, type CatalogView, type ConfigurationView, type SelectionView, type TargetView, type TextView } from "./view-model";

export function catalogModels(target: TargetView, catalog: CatalogView) {
  return sameTarget(target, catalog.target) && ["available", "partial"].includes(catalog.phase) ? catalog.models : [];
}

export function selectionIssues(target: TargetView, catalog: CatalogView, selection: SelectionView): readonly TextView[] {
  const model = catalogModels(target, catalog).find((item) => item.key === selection.modelKey);
  if (!model) return [{ zh: "所选模型尚未验证或不可用，请核对模型目录。", en: "The selected model is unverified or unavailable. Check the catalog." }];
  const issues: TextView[] = [];
  if (model.reasoningOptions.length ? !model.reasoningOptions.some((item) => item.key === selection.reasoningKey) : selection.reasoningKey !== null) {
    issues.push({ zh: "当前推理强度不可用，请明确选择受支持的选项。", en: "The current reasoning effort is unavailable. Choose a supported option explicitly." });
  }
  if (model.speed.evidence === "backend" && model.speed.options.length
    ? !model.speed.options.some((item) => item.key === selection.speedKey)
    : selection.speedKey !== null) {
    issues.push({ zh: "当前速度选项尚未核实或不可用，请核对配置。", en: "The current speed option is unverified or unavailable. Review the configuration." });
  }
  return issues;
}

export function isExecutionReady(view: ConfigurationView) {
  const { target, selection, installation, connection, catalog, execution } = view;
  return [installation, connection, catalog, execution].every((item) => sameTarget(target, item.target))
    && installation.phase === "installed" && connection.phase === "signed-in"
    && execution.phase === "ready" && execution.evidence === "backend"
    && sameSelection(selection, execution.selection) && selectionIssues(target, catalog, selection).length === 0;
}

export const installationLabels: Record<ConfigurationView["installation"]["phase"], TextView> = {
  unverified: { zh: "尚未验证", en: "Not yet verified" }, checking: { zh: "正在检查安装", en: "Checking installation" },
  installed: { zh: "已安装", en: "Installed" }, missing: { zh: "未安装", en: "Not installed" },
  failed: { zh: "安装检查失败", en: "Installation check failed" }, uncertain: { zh: "安装结果不确定", en: "Installation result uncertain" },
};
export const connectionLabels: Record<ConfigurationView["connection"]["phase"], TextView> = {
  unverified: { zh: "尚未验证", en: "Not yet verified" }, "signed-out": { zh: "尚未登录 ChatGPT", en: "Not signed in to ChatGPT" },
  "signing-in": { zh: "等待 ChatGPT 登录", en: "Waiting for ChatGPT sign-in" }, "signed-in": { zh: "已登录 ChatGPT", en: "Signed in to ChatGPT" },
  expired: { zh: "ChatGPT 登录已过期", en: "ChatGPT sign-in expired" }, failed: { zh: "ChatGPT 登录失败", en: "ChatGPT sign-in failed" },
  uncertain: { zh: "登录结果不确定", en: "Sign-in result uncertain" },
};
export const catalogLabels: Record<ConfigurationView["catalog"]["phase"], TextView> = {
  unverified: { zh: "尚未验证", en: "Not yet verified" }, loading: { zh: "正在读取模型目录", en: "Loading model catalog" },
  available: { zh: "模型目录可用", en: "Model catalog available" }, unavailable: { zh: "模型目录不可用", en: "Model catalog unavailable" },
  failed: { zh: "模型目录读取失败", en: "Model catalog failed" }, partial: { zh: "模型目录部分可用", en: "Model catalog partially available" },
  uncertain: { zh: "模型目录结果不确定", en: "Model catalog result uncertain" },
};
const executionLabels: Record<ConfigurationView["execution"]["phase"], TextView> = {
  unverified: { zh: "尚未验证", en: "Not yet verified" }, checking: { zh: "正在验证执行", en: "Verifying execution" },
  ready: { zh: "执行验证通过", en: "Execution verified" }, blocked: { zh: "执行条件未满足", en: "Execution requirements unmet" },
  failed: { zh: "执行验证失败", en: "Execution verification failed" }, uncertain: { zh: "执行结果不确定", en: "Execution result uncertain" },
};
const saveLabels: Record<ConfigurationView["save"]["phase"], TextView> = {
  unverified: { zh: "尚未验证", en: "Not yet verified" }, unsaved: { zh: "尚未保存", en: "Not saved" },
  saving: { zh: "正在保存", en: "Saving" }, saved: { zh: "已保存，下次运行生效", en: "Saved for the next run" },
  conflict: { zh: "保存冲突，请核对最新配置", en: "Save conflict. Review the latest configuration" },
  "partial-failure": { zh: "保存部分失败，请核对已保存内容", en: "Save partially failed. Review what was saved" },
  failed: { zh: "保存失败", en: "Save failed" }, uncertain: { zh: "保存结果不确定，请核对后重试", en: "Save result uncertain. Check before retrying" },
};

export function executionLabel(view: ConfigurationView): TextView {
  if (!sameTarget(view.target, view.execution.target) || !sameSelection(view.selection, view.execution.selection)
    || (view.execution.phase === "ready" && !isExecutionReady(view))) return executionLabels.unverified;
  return executionLabels[view.execution.phase];
}

export function saveLabel(view: ConfigurationView): TextView {
  if (!sameTarget(view.target, view.save.target)) return saveLabels.unverified;
  if (!sameSelection(view.selection, view.save.selection)) return { zh: "当前变更尚未保存", en: "Current changes are not saved" };
  if (view.save.phase === "saved" && !isExecutionReady(view)) return { zh: "已保存，待连接", en: "Saved, awaiting connection" };
  return saveLabels[view.save.phase];
}
