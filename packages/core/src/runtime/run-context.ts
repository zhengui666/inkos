import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodexClient } from '../codex/app-server.js';
import type { HarnessPreferences, RuntimeSelection } from './contracts.js';
import type { CodexAuthenticationOwner } from './auth/codex-owner.js';
import type { RunHistoryBinding } from './run-history.js';

export interface CodexRunContext {
  readonly projectRoot: string;
  readonly selection: Readonly<RuntimeSelection>;
  readonly saved: Readonly<HarnessPreferences>;
  readonly owner: CodexAuthenticationOwner;
  /** Existing core request/episode, scoped by its caller; never a transport ID. */
  readonly history?: RunHistoryBinding;
  /** Retain a failed durable receipt even if a domain action wraps its error. */
  readonly onHistoryFailure?: (failure: Error) => void;
  /** Lease the admission peer once; subsequent workers use their own isolated peers. */
  takeClient(): Promise<CodexClient>;
  guard(client?: CodexClient, signal?: AbortSignal): Promise<void>;
}
const runs = new AsyncLocalStorage<CodexRunContext>();
export function currentCodexRun(): CodexRunContext | undefined { return runs.getStore(); }
export function runWithCodexContext<T>(context: CodexRunContext, task: () => Promise<T>): Promise<T> {
  return runs.run(context, task);
}
