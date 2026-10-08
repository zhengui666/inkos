import { AsyncLocalStorage } from "node:async_hooks";

const unboundedExecution = new AsyncLocalStorage<boolean>();

/** Opt a creation workflow into uncapped host execution without changing other workers. */
export function withUnboundedWorkerExecution<T>(task: () => Promise<T>): Promise<T> {
  return unboundedExecution.run(true, task);
}

/** Only application deadlines/output caps change; model limits and cancellation remain. */
export function isUnboundedWorkerExecution(): boolean {
  return unboundedExecution.getStore() === true;
}
