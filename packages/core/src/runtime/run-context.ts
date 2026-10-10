import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodexClient } from '../codex/app-server.js';
import type { HarnessPreferences, RuntimeSelection } from './contracts.js';
import type { CodexAuthenticationOwner } from './auth/codex-owner.js';

export interface CodexRunContext {
  readonly projectRoot: string;
  readonly selection: Readonly<RuntimeSelection>;
  readonly saved: Readonly<HarnessPreferences>;
  readonly owner: CodexAuthenticationOwner;
  /** Lease the admission peer once; subsequent workers use their own isolated peers. */
  takeClient(): Promise<CodexClient>;
  guard(client?: CodexClient, signal?: AbortSignal): Promise<void>;
}
const runs = new AsyncLocalStorage<CodexRunContext>();
export function currentCodexRun(): CodexRunContext | undefined { return runs.getStore(); }
export function runWithCodexContext<T>(context: CodexRunContext, task: () => Promise<T>): Promise<T> {
  return runs.run(context, task);
}
