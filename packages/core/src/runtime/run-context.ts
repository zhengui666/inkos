import { AsyncLocalStorage } from 'node:async_hooks';
import type { CodexClient } from '../codex/app-server.js';
import type { HarnessPreferences, RuntimeSelection } from './contracts.js';
import type { CodexAuthenticationOwner } from './auth/codex-owner.js';
import type { RunHistoryBinding } from './run-history.js';
import type { PiExecutionLease } from './auth/pi-owner.js';
import type { PiRuntimeContext } from './adapters/pi/runtime-context.js';

export interface CodexRunContext {
  readonly harnessId: 'codex';
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
export interface PiRunContext {
  readonly harnessId: 'pi';
  readonly projectRoot: string;
  readonly selection: Readonly<RuntimeSelection>;
  readonly saved: Readonly<HarnessPreferences>;
  readonly history?: RunHistoryBinding;
  readonly onHistoryFailure?: (failure: Error) => void;
  readonly lease: PiExecutionLease;
  readonly runtime: PiRuntimeContext;
  guard(signal?: AbortSignal): Promise<void>;
}
export type RuntimeRunContext = CodexRunContext | PiRunContext;
const runs = new AsyncLocalStorage<RuntimeRunContext>();
export function currentRuntimeRun(): RuntimeRunContext | undefined { return runs.getStore(); }
export function currentCodexRun(): CodexRunContext | undefined { const context = runs.getStore(); return context?.harnessId === 'pi' ? undefined : context; }
export function runWithRuntimeContext<T>(context: RuntimeRunContext, task: () => Promise<T>): Promise<T> { return runs.run(context, task); }
export function runWithCodexContext<T>(context: CodexRunContext, task: () => Promise<T>): Promise<T> {
  return runs.run(context, task);
}
