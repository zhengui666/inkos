import { isUnboundedWorkerExecution } from "./worker-execution-policy.js";

/** Host limits survive correction turns; timeouts never authorize a retry. */
export function executionTimeoutMs(value: number | undefined, env: string, fallback: number): number {
  const configured = process.env[env]?.trim();
  const result = value ?? (configured ? Number(configured) : fallback);
  if (!Number.isInteger(result) || result < 1 || result > 2_147_483_647) {
    throw new Error(`${env} must be an integer between 1 and 2147483647 milliseconds`);
  }
  return result;
}

export async function withAgentRequestDeadline<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (isUnboundedWorkerExecution()) {
    const active = signal ?? new AbortController().signal;
    active.throwIfAborted();
    return run(active);
  }
  const timeoutMs = executionTimeoutMs(undefined, "INKOS_AGENT_TIMEOUT_MS", 24 * 60 * 60_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(
    `Agent request exceeded its execution budget (${timeoutMs}ms). Saved results are retained; no automatic retry was started.`,
  ), { code: "AGENT_REQUEST_TIMEOUT", timeoutMs })), timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try { bounded.throwIfAborted(); return await run(bounded); }
  finally { clearTimeout(timer); }
}
