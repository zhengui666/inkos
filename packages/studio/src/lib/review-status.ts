/** Positive coverage is visible evidence, not a warning. Old untyped findings remain conservative. */
export function reviewIssueCount(observations: readonly unknown[]): number {
  return observations.filter(value => {
    if (!value || typeof value !== 'object') return true;
    const item = value as { assessment?: string; category?: string; code?: string };
    return item.assessment !== 'resolved' && (item.assessment === 'issue' || item.assessment === 'unavailable'
      || /(?:review-unavailable|state-sync-required|state-validation|state-reconciliation)/u.test(item.code ?? '')
      || (item.assessment === undefined && item.category !== 'scope'));
  }).length;
}
