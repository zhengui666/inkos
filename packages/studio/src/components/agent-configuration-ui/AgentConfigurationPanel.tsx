import { ChatGptConnectionCard } from "./ChatGptConnectionCard";
import { ConfigurationStatus } from "./ConfigurationStatus";
import { HarnessSelector } from "./HarnessSelector";
import { ModelOptions } from "./ModelOptions";
import { buttonClass, harnessLabel, sameTarget, sectionClass, text, type ConfigurationView, type ConnectionIntent, type HarnessId, type SaveIntent, type SelectionIntent } from "./view-model";

export interface AgentConfigurationPanelProps {
  readonly id: string;
  readonly view: ConfigurationView;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly connectDisabled?: boolean;
  readonly authManagementAvailable?: boolean;
  readonly canSave: boolean;
  readonly hasChanges: boolean;
  readonly onHarnessChange: (harness: HarnessId) => void;
  readonly onConnectionIntent: (intent: ConnectionIntent) => void;
  readonly onSelectionIntent: (intent: SelectionIntent) => void;
  readonly onSaveIntent: (intent: SaveIntent) => void;
}

export function AgentConfigurationPanel({ id, view, isZh, disabled, connectDisabled, authManagementAvailable, canSave, hasChanges, onHarnessChange, onConnectionIntent, onSelectionIntent, onSaveIntent }: AgentConfigurationPanelProps) {
  const saving = sameTarget(view.target, view.save.target) && view.save.phase === "saving";
  const saveDisabled = disabled || !canSave || !hasChanges || saving;
  return <section className={sectionClass} aria-label={text(isZh, "Agent 默认配置", "Agent defaults")}>
    <h2 className="text-base font-bold">{text(isZh, "ChatGPT Agent 配置", "ChatGPT agent configuration")}</h2>
    <HarnessSelector name={`${id}-harness`} value={view.target.harness} isZh={isZh} disabled={disabled} onChange={onHarnessChange} />
    <ChatGptConnectionCard target={view.target} connection={view.connection} isZh={isZh} disabled={disabled} connectDisabled={connectDisabled} authManagementAvailable={authManagementAvailable} onIntent={onConnectionIntent} />
    <ModelOptions id={`${id}-options`} target={view.target} catalog={view.catalog} selection={view.selection} isZh={isZh} disabled={disabled} onIntent={onSelectionIntent} />
    <ConfigurationStatus view={view} isZh={isZh} />
    <p id={`${id}-save-help`} className="text-xs text-muted-foreground">{hasChanges
      ? text(isZh, "有未保存的默认配置变更。保存后仍需确认连接和执行验证。", "Default changes have not been saved. After saving, connection and execution still need confirmation.")
      : text(isZh, "默认配置没有未保存的变更。", "There are no unsaved default changes.")}</p>
    <button type="button" className={buttonClass} disabled={saveDisabled} aria-describedby={`${id}-save-help`}
      onClick={() => { if (!saveDisabled) onSaveIntent({ action: "save-defaults", target: { ...view.target }, selection: { ...view.selection } }); }}>
      {saving ? text(isZh, "保存中…", "Saving…") : `${text(isZh, "保存默认配置", "Save defaults")} · ${harnessLabel(view.target.harness)}`}
    </button>
  </section>;
}
