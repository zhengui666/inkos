import type { ConfigurationView, FrozenRunView, TargetView, TextView } from "./view-model";

// Every value below is simulated. None is evidence of a real account or run.
export const codexFixtureTarget: TargetView = { harness: "codex", contextKey: "offline-codex" };
export const piFixtureTarget: TargetView = { harness: "pi", contextKey: "offline-pi" };
const selection = { modelKey: "example-a", reasoningKey: "example-medium", speedKey: null } as const;
const model = {
  key: "example-a", label: { zh: "示例模型 A", en: "Example model A" },
  reasoningOptions: [{ key: "example-medium", label: { zh: "示例中等强度", en: "Example medium effort" } }],
  speed: { evidence: "unverified", options: [] },
} as const;

export const offlineCodexSignedIn: ConfigurationView = {
  target: codexFixtureTarget, selection,
  installation: { target: codexFixtureTarget, phase: "installed" },
  connection: { target: codexFixtureTarget, phase: "signed-in", accountLabel: "codex-fixture@example.invalid" },
  catalog: { target: codexFixtureTarget, phase: "available", models: [model] },
  execution: { target: codexFixtureTarget, phase: "unverified", evidence: "unverified", selection },
  save: { target: codexFixtureTarget, phase: "saved", selection },
};
export const offlinePiSaved: ConfigurationView = {
  target: piFixtureTarget, selection,
  installation: { target: piFixtureTarget, phase: "installed" },
  connection: { target: piFixtureTarget, phase: "signed-out" },
  catalog: { target: piFixtureTarget, phase: "unverified", models: [] },
  execution: { target: piFixtureTarget, phase: "unverified", evidence: "unverified", selection },
  save: { target: piFixtureTarget, phase: "saved", selection },
};
export const offlineRun: FrozenRunView = Object.freeze({
  runLabel: { zh: "当前运行（离线示例）", en: "Current run (offline example)" },
  harness: "codex", modelLabel: "Example model A", reasoningLabel: model.reasoningOptions[0].label, speedLabel: null,
});

export const offlineCases: readonly { readonly key: string; readonly title: TextView; readonly view: ConfigurationView }[] = [
  { key: "codex-signed-in", title: { zh: "Codex 已登录，执行未验证", en: "Codex signed in, execution unverified" }, view: offlineCodexSignedIn },
  { key: "pi-saved", title: { zh: "新默认 Pi 已保存，待连接", en: "New Pi defaults saved, awaiting connection" }, view: offlinePiSaved },
  { key: "pi-not-installed", title: { zh: "Pi 未安装，配置尚未验证", en: "Pi not installed, configuration unverified" }, view: {
    ...offlinePiSaved, installation: { target: piFixtureTarget, phase: "missing" },
  } },
  { key: "pi-login-pending", title: { zh: "Pi 登录等待中", en: "Pi sign-in pending" }, view: {
    ...offlinePiSaved, connection: { target: piFixtureTarget, phase: "signing-in", attemptKey: "offline-pi-attempt" },
    save: { target: piFixtureTarget, phase: "unsaved", selection },
  } },
  { key: "expired-partial", title: { zh: "登录过期，目录部分失败", en: "Expired sign-in, partial catalog failure" }, view: {
    ...offlineCodexSignedIn,
    connection: { target: codexFixtureTarget, phase: "expired", detail: { zh: "示例：登录已过期，请重新连接。", en: "Example: sign-in expired. Reconnect." } },
    catalog: { target: codexFixtureTarget, phase: "partial", models: [model], detail: { zh: "示例：仅部分目录条目已读到。", en: "Example: only part of the catalog was received." } },
    execution: { target: codexFixtureTarget, phase: "failed", evidence: "unverified", selection },
  } },
  { key: "uncertain-conflict", title: { zh: "登录结果不确定，保存冲突", en: "Uncertain sign-in, save conflict" }, view: {
    ...offlinePiSaved,
    connection: { target: piFixtureTarget, phase: "uncertain", detail: { zh: "示例：取消请求与登录结果先后到达，需核对状态。", en: "Example: cancellation and sign-in results arrived out of order. Check status." } },
    save: { target: piFixtureTarget, phase: "conflict", selection },
  } },
  { key: "partial-save", title: { zh: "安装检查不确定，保存部分失败", en: "Uncertain installation, partial save failure" }, view: {
    ...offlinePiSaved, installation: { target: piFixtureTarget, phase: "uncertain" },
    save: { target: piFixtureTarget, phase: "partial-failure", selection, detail: { zh: "示例：部分内容已保存，请核对后重试。", en: "Example: some changes were saved. Review before retrying." } },
  } },
  { key: "uncertain-save", title: { zh: "保存结果不确定", en: "Uncertain save result" }, view: {
    ...offlinePiSaved, save: { target: piFixtureTarget, phase: "uncertain", selection },
  } },
];
