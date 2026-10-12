import type { BrowserObservation, Distribution, DistributionRequest, PublishingTarget } from './contracts.js';
import { normalizeMegaNovelBodyText } from './meganovel-contracts.js';

export function observationMatches(target: PublishingTarget, observation: BrowserObservation, title: string, body: string): boolean {
  const normalize = target.platform === 'meganovel' ? normalizeMegaNovelBodyText : (text: string) => text;
  return observation.title === title && observation.body !== null && normalize(observation.body) === normalize(body);
}
function sameScope(record: Distribution, target: PublishingTarget, seen: BrowserObservation): boolean {
  if (seen.accountId !== target.config.accountId || seen.state === 'unknown' || !seen.complete) return false;
  const mapping = target.config.remote;
  if ([mapping.workId, record.remote.workId].some(id => id && id !== seen.remote.workId)) return false;
  if ([mapping.artifactIds[record.artifactId], record.remote.artifactId].some(id => id && id !== seen.remote.artifactId)) return false;
  if (seen.state !== 'absent' && (!seen.remote.workId || !seen.remote.artifactId || !seen.remote.authorUrl)) return false;
  if (seen.state === 'published' && !seen.remote.readerUrl) return false;
  return !Object.entries(mapping.artifactIds).some(([id, remoteId]) => id !== record.artifactId && remoteId === seen.remote.artifactId);
}
export type DistributionDecision = 'mutate' | 'settled' | 'needs-observation' | 'update-required' | 'unsupported';
/** Domain protocol only. Observations come from fresh browser reads, never mutation return values. */
export function distributionDecision(input: {
  distribution: Distribution; target: PublishingTarget; request: DistributionRequest;
  observation: BrowserObservation; title: string; body: string; capabilities: readonly string[]; observeOnly: boolean;
}): DistributionDecision {
  const { distribution: record, target, request, observation: seen } = input;
  if (seen.state === 'user-action') return 'settled';
  if (!sameScope(record, target, seen)) return 'needs-observation';
  const matches = observationMatches(target, seen, input.title, input.body);
  const committed = ['submitted', 'reviewing', 'rejected', 'published'].includes(seen.state);
  if (committed && matches) return 'settled';
  // A timed-out publish is not cleared by a draft-looking editor or a negative lookup.
  if (record.intent && !seen.notApplied) return 'needs-observation';
  if (input.observeOnly) return 'settled';
  if ((committed || record.submittedRevisionId || record.publishedRevisionId) && request.operation !== 'update') return 'update-required';
  if (!input.capabilities.includes(request.operation)) return 'unsupported';
  if (request.operation === 'update' && !seen.remote.artifactId) return 'needs-observation';
  if (!seen.remote.workId && !target.config.remote.workId && !input.capabilities.includes('create-work')) return 'unsupported';
  if (seen.state !== 'absent' && !matches && request.operation !== 'update') return 'needs-observation';
  return 'mutate';
}

/** Keep historical publishedRevisionId; author-only evidence never establishes a new published revision. */
export function applyObservation(record: Distribution, seen: BrowserObservation, target: PublishingTarget,
  revision: { id: string; title: string }, body: string): void {
  record.lastObservation = seen;
  record.updatedAt = seen.observedAt;
  if (seen.state === 'user-action') { record.status = 'user-action'; record.error = seen.evidence; return; }
  if (!sameScope(record, target, seen)) { record.status = 'needs-observation'; return; }
  record.remote = seen.remote;
  const matches = observationMatches(target, seen, revision.title, body);
  const committed = ['submitted', 'reviewing', 'rejected', 'published'].includes(seen.state);
  if (matches) record.observedRevisionId = revision.id;
  if (matches && committed) {
    record.submittedRevisionId = revision.id;
    if (seen.state === 'published') record.publishedRevisionId = revision.id;
    record.intent = null;
  } else if (record.intent && seen.notApplied) record.intent = null;
  record.status = record.intent ? 'needs-observation' : seen.state;
}
