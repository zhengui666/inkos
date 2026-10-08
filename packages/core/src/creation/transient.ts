/** Transient transport/model unavailability is different from quality failure,
 * account/contract gates and uncertain side effects. Unknown codes stay blocked. */
export function isCreationTransientFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    // Cleanup/persistence failure alongside a provider error is an uncertain
    // outcome, not permission to repeat the operation.
    if (error instanceof AggregateError) return false;
    const code = (error as { code?: unknown }).code;
    if (code !== undefined) return typeof code === 'string' && [
      'MODEL_UNAVAILABLE', 'WORKER_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'RATE_LIMITED',
      'CHAPTER_REVIEW_UNAVAILABLE', 'PUBLISHING_UNAVAILABLE',
    ].includes(code);
    // Foundation preservation adds context using Error({ cause }); explicit
    // outer failure codes remain authoritative, including nontransient gates.
    error = error instanceof Error ? error.cause : undefined;
  }
  return false;
}
