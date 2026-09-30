/** Public, credential-free projections of the official Codex App Server protocol. */
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface CodexSettings {
  model?: string;
  reasoningEffort: CodexReasoningEffort;
  /** `default` uses the account/model's standard tier; other IDs come from model/list. */
  serviceTier: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
  defaultReasoningEffort: string;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  defaultServiceTier: string | null;
}

export interface CodexDeviceLogin {
  type: 'chatgptDeviceCode';
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexLoginState {
  loginId: string;
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  error?: string;
  verificationUrl?: string;
  userCode?: string;
}

export interface CodexAccountStatus {
  connected: boolean;
  account: { type: 'chatgpt'; email: string | null; planType: string } | null;
  requiresOpenaiAuth: boolean;
  login: CodexLoginState | null;
}
