/** Public, credential-free Studio contract. Never include app-server auth tokens. */
export interface StudioCodexLogin {
  readonly loginId: string;
  readonly status: "pending" | "completed" | "cancelled" | "failed";
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly error?: string;
}

export interface StudioCodexAccount {
  readonly connected: boolean;
  readonly account: { readonly type: "chatgpt"; readonly email: string | null; readonly planType: string } | null;
  readonly requiresOpenaiAuth: boolean;
  readonly login: StudioCodexLogin | null;
}

export interface StudioCodexSettings {
  readonly model?: string;
  readonly reasoningEffort: string;
  readonly serviceTier: string;
}

export interface StudioCodexModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly isDefault: boolean;
  readonly supportedReasoningEfforts: ReadonlyArray<{ readonly reasoningEffort: string; readonly description: string }>;
  readonly defaultReasoningEffort: string;
  readonly serviceTiers: ReadonlyArray<{ readonly id: string; readonly name: string; readonly description: string }>;
  readonly defaultServiceTier: string | null;
}

export function isCodexVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && (url.hostname === "auth.openai.com" || url.hostname === "chatgpt.com");
  } catch {
    return false;
  }
}
