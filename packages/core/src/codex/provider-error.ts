/**
 * Narrow runtime view of @openai/codex 0.159.2's generated v2/CodexErrorInfo,
 * TurnError, ErrorNotification and TurnCompletedNotification contracts.
 * Keep native provenance distinct from the host's existing scheduler codes.
 */
const nativeNames = ['contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded',
  'rateLimitExceeded', 'flexUnavailable', 'serverOverloaded', 'cyberPolicy',
  'misalignmentPolicyViolation', 'tooManyDenials', 'internalServerError', 'unauthorized',
  'badRequest', 'threadRollbackFailed', 'sandboxError', 'other'] as const;
const connectionNames = ['httpConnectionFailed', 'responseStreamConnectionFailed',
  'responseStreamDisconnected', 'responseTooManyFailedAttempts'] as const;
type ConnectionName = typeof connectionNames[number];
type NativeErrorInfo = typeof nativeNames[number]
  | { [K in ConnectionName]: { [P in K]: { readonly httpStatusCode: number | null } } }[ConnectionName]
  | { readonly activeTurnNotSteerable: { readonly turnKind: 'review' | 'compact' } };
export type CodexFailureFrame = { readonly source: 'error'; readonly willRetry: false }
  | { readonly source: 'turn/completed'; readonly turnStatus: unknown };
const turnStatuses = ['completed', 'interrupted', 'failed', 'inProgress'] as const;
export type CodexProviderFailure = ({ readonly source: 'error'; readonly willRetry: false }
  | { readonly source: 'turn/completed'; readonly turnStatus: typeof turnStatuses[number] | 'unknown' })
  & { readonly codexErrorInfo: NativeErrorInfo | null };
type HostFailureCode = 'RATE_LIMITED' | 'MODEL_UNAVAILABLE' | 'WORKER_MODEL_ERROR';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Copy only bounded protocol fields; never retain raw provider data/details. */
function nativeInfo(raw: unknown): NativeErrorInfo | null {
  if (typeof raw === 'string') return nativeNames.includes(raw as typeof nativeNames[number]) ? raw as typeof nativeNames[number] : null;
  const info = record(raw);
  if (!info || Object.keys(info).length !== 1) return null;
  for (const kind of connectionNames) {
    if (!Object.hasOwn(info, kind)) continue;
    const detail = record(info[kind]), status = detail?.httpStatusCode;
    if (!detail || Object.keys(detail).length !== 1 || !Object.hasOwn(detail, 'httpStatusCode')
      || status !== null && !(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)) return null;
    return Object.freeze({ [kind]: Object.freeze({ httpStatusCode: status }) }) as NativeErrorInfo;
  }
  const detail = record(info.activeTurnNotSteerable);
  if (detail && Object.keys(detail).length === 1 && (detail.turnKind === 'review' || detail.turnKind === 'compact')) {
    return Object.freeze({ activeTurnNotSteerable: Object.freeze({ turnKind: detail.turnKind }) });
  }
  return null;
}

function hostCode(failure: CodexProviderFailure): HostFailureCode {
  if (failure.source === 'turn/completed' && failure.turnStatus !== 'failed') return 'WORKER_MODEL_ERROR';
  const info = failure.codexErrorInfo;
  if (info === 'rateLimitExceeded') return 'RATE_LIMITED';
  if (info === 'serverOverloaded' || info === 'flexUnavailable') return 'MODEL_UNAVAILABLE';
  if (info && typeof info === 'object') {
    const connection = 'httpConnectionFailed' in info ? info.httpConnectionFailed
      : 'responseStreamConnectionFailed' in info ? info.responseStreamConnectionFailed : undefined;
    // Only explicit temporary transport statuses. A missing status cannot
    // distinguish network unavailability from configuration/TLS failure, and
    // 429 alone can mean an account/quota gate. Disconnected
    // streams and exhausted stream attempts have uncertain output, so stay blocked.
    if (connection && connection.httpStatusCode !== null && [408, 502, 503, 504].includes(connection.httpStatusCode)) {
      return 'MODEL_UNAVAILABLE';
    }
  }
  return 'WORKER_MODEL_ERROR';
}

export class CodexModelError extends Error {
  readonly code: HostFailureCode;
  readonly stopReason = 'error';
  constructor(message: string, readonly providerFailure: CodexProviderFailure, readonly hostToolCalls = 0, readonly turnIdConfirmed = true) {
    super(message);
    this.name = 'CodexModelError';
    // Dynamic tool validators can persist candidates before returning. A native
    // provider failure cannot establish whether those effects are safe to repeat.
    this.code = hostToolCalls === 0 && turnIdConfirmed ? hostCode(providerFailure) : 'WORKER_MODEL_ERROR';
  }
}

/** The native message is already surfaced by the bridge; no text-based retry inference. */
export function codexModelError(raw: unknown, frame: CodexFailureFrame, hostToolCalls = 0, turnIdConfirmed = true): CodexModelError {
  const error = record(raw);
  const provenance = frame.source === 'error'
    ? { source: 'error' as const, willRetry: false as const }
    : { source: 'turn/completed' as const, turnStatus: turnStatuses.includes(frame.turnStatus as typeof turnStatuses[number])
      ? frame.turnStatus as typeof turnStatuses[number] : 'unknown' as const };
  return new CodexModelError(typeof error?.message === 'string' ? error.message : 'Codex model request failed',
    Object.freeze({ ...provenance, codexErrorInfo: nativeInfo(error?.codexErrorInfo) }), hostToolCalls, turnIdConfirmed);
}


/** Cleanup uncertainty must survive a worker deadline/cancellation during close. */
export class CodexCleanupError extends AggregateError {
  constructor(runFailure: unknown, cleanupError: unknown, modelError?: CodexModelError) {
    const failures = [...new Set([runFailure, modelError, cleanupError].filter(error => error !== undefined))];
    super(failures, 'Codex peer cleanup failed; the turn outcome is uncertain', { cause: runFailure ?? modelError ?? cleanupError });
    this.name = 'CodexCleanupError';
  }
}


/** Conflicting protocol identities cannot establish a safe retry outcome. */
export class CodexTurnIdentityError extends Error {
  readonly code = 'WORKER_MODEL_ERROR';
  constructor(cause?: CodexModelError) {
    super('Codex turn/start identity disagrees with its notifications', { cause });
    this.name = 'CodexTurnIdentityError';
  }
}


/** A host/persistence failure must not inherit an accompanying provider retry. */
export class CodexHostError extends AggregateError {
  constructor(hostFailure: unknown, modelError: CodexModelError) {
    super([hostFailure, modelError], 'Codex host operation failed alongside the model; the outcome is uncertain', { cause: hostFailure });
    this.name = 'CodexHostError';
  }
}
