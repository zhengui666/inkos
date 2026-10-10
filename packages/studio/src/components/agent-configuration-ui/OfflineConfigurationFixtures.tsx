import { AgentConfigurationPanel } from "./AgentConfigurationPanel";
import { offlineCases, offlineRun } from "./fixtures";
import { RunConfigurationStamp } from "./RunConfigurationStamp";
import { localize, text, type ConnectionIntent, type HarnessId, type SaveIntent, type SelectionIntent } from "./view-model";

type FixtureIntent = ConnectionIntent | SelectionIntent | SaveIntent | { readonly action: "choose-harness"; readonly harness: HarnessId };
export interface OfflineConfigurationFixturesProps {
  readonly isZh: boolean;
  readonly onIntent?: (intent: FixtureIntent) => void;
}

// An isolated fixture surface; no production route imports this component.
export function OfflineConfigurationFixtures({ isZh, onIntent }: OfflineConfigurationFixturesProps) {
  const emit = (intent: FixtureIntent) => onIntent?.(intent);
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <h1 className="text-xl font-bold">{text(isZh, "Agent 配置 · 离线示例", "Agent configuration · offline examples")}</h1>
    <p role="note" className="text-sm text-muted-foreground">{text(isZh,
      "以下安装、账户、目录与保存状态均为固定示例；控件仅输出意图。真实登录、推理和部署均尚未验证。",
      "Installation, account, catalog and save states below are fixed examples; controls only emit intents. Real sign-in, inference and deployment are not yet verified.")}</p>
    <RunConfigurationStamp run={offlineRun} isZh={isZh} />
    {offlineCases.map(({ key, title, view }) => <section key={key} className="space-y-2">
      <h2 className="text-base font-medium">{localize(isZh, title)}</h2>
      <AgentConfigurationPanel id={`offline-${key}`} view={view} isZh={isZh} canSave hasChanges
        onHarnessChange={(harness) => emit({ action: "choose-harness", harness })}
        onConnectionIntent={emit} onSelectionIntent={emit} onSaveIntent={emit} />
    </section>)}
  </main>;
}
