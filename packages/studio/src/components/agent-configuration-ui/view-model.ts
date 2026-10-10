// Presentation models only. The integration owner maps backend evidence into these views.
export type HarnessId = "codex" | "pi";
export interface TextView { readonly zh: string; readonly en: string }
export interface TargetView { readonly harness: HarnessId; readonly contextKey: string }
interface ScopedView { readonly target: TargetView; readonly detail?: TextView }

export interface InstallationView extends ScopedView {
  readonly phase: "unverified" | "checking" | "installed" | "missing" | "failed" | "uncertain";
}
export interface ConnectionView extends ScopedView {
  readonly phase: "unverified" | "signed-out" | "signing-in" | "signed-in" | "expired" | "failed" | "uncertain";
  readonly accountLabel?: string;
  readonly attemptKey?: string;
}
export interface OptionView { readonly key: string; readonly label: TextView }
export interface ModelView extends OptionView {
  readonly reasoningOptions: readonly OptionView[];
  readonly speed: {
    readonly evidence: "backend" | "unverified" | "unsupported";
    readonly options: readonly OptionView[];
  };
}
export interface NativeDefaultsView {
  readonly target: TargetView;
  readonly evidence: "backend" | "unverified";
  readonly modelKey: string;
}
export interface CatalogView extends ScopedView {
  readonly phase: "unverified" | "loading" | "available" | "unavailable" | "failed" | "partial" | "uncertain";
  readonly models: readonly ModelView[];
  // Evidence for capability checks only; never replaces a requested or saved null.
  readonly nativeDefaults?: NativeDefaultsView;
}
export interface SelectionView {
  // null means inherit the harness's native default, never a missing catalog value.
  readonly modelKey: string | null;
  readonly reasoningKey: string | null;
  readonly speedKey: string | null;
}
export interface ExecutionView extends ScopedView {
  readonly phase: "unverified" | "checking" | "ready" | "blocked" | "failed" | "uncertain";
  readonly evidence: "backend" | "unverified";
  readonly selection: SelectionView;
}
export interface SaveView extends ScopedView {
  readonly phase: "unverified" | "unsaved" | "saving" | "saved" | "conflict" | "partial-failure" | "failed" | "uncertain";
  readonly selection: SelectionView;
}
export interface ConfigurationView {
  readonly target: TargetView;
  readonly selection: SelectionView;
  readonly installation: InstallationView;
  readonly connection: ConnectionView;
  readonly catalog: CatalogView;
  readonly execution: ExecutionView;
  readonly save: SaveView;
}
export type ConnectionIntent =
  | { readonly action: "connect" | "sign-out" | "refresh-connection"; readonly target: TargetView }
  | { readonly action: "cancel-sign-in"; readonly target: TargetView; readonly attemptKey: string };
export interface SelectionIntent {
  readonly action: "choose-option";
  readonly target: TargetView;
  readonly field: "model" | "reasoning" | "speed";
  readonly choiceKey: string | null;
}
export interface SaveIntent {
  readonly action: "save-defaults";
  readonly target: TargetView;
  readonly selection: SelectionView;
}
export interface FrozenRunView {
  readonly runLabel: TextView;
  readonly harness: HarnessId;
  readonly modelLabel: string;
  readonly reasoningLabel: TextView | null;
  readonly speedLabel: TextView | null;
}

export const text = (isZh: boolean, zh: string, en: string) => isZh ? zh : en;
export const localize = (isZh: boolean, value: TextView) => text(isZh, value.zh, value.en);
export const harnessLabel = (harness: HarnessId) => harness === "codex" ? "Codex" : "Pi";
export const sameTarget = (a: TargetView, b: TargetView) => a.harness === b.harness && a.contextKey === b.contextKey;
export const sameSelection = (a: SelectionView, b: SelectionView) =>
  a.modelKey === b.modelKey && a.reasoningKey === b.reasoningKey && a.speedKey === b.speedKey;

export const fieldClass = "w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50";
export const buttonClass = "rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 disabled:cursor-not-allowed";
export const sectionClass = "rounded-2xl border border-border/50 bg-card/70 p-5 space-y-4";
