import { harnessLabel, text, type HarnessId } from "./view-model";

export interface HarnessSelectorProps {
  readonly name: string;
  readonly value: HarnessId;
  readonly isZh: boolean;
  readonly disabled?: boolean;
  readonly onChange: (harness: HarnessId) => void;
}

export function HarnessSelector({ name, value, isZh, disabled, onChange }: HarnessSelectorProps) {
  return <fieldset disabled={disabled} className="space-y-3" aria-describedby={`${name}-help`}>
    <legend className="text-sm font-medium">{text(isZh, "Agent 执行器", "Agent harness")}</legend>
    <div className="flex flex-wrap gap-3">
      {(["codex", "pi"] as const).map((harness) => <label key={harness} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
        <input type="radio" name={name} value={harness} checked={value === harness}
          className="accent-primary focus-visible:outline-2 focus-visible:outline-primary"
          onChange={() => { if (!disabled) onChange(harness); }} />
        {harnessLabel(harness)}
      </label>)}
    </div>
    <p id={`${name}-help`} className="text-xs text-muted-foreground">{text(isZh,
      "Codex 和 Pi 分别连接自己的 ChatGPT 登录。新默认配置用于下次运行。",
      "Codex and Pi use their own ChatGPT connections. New defaults apply to the next run.")}</p>
  </fieldset>;
}
