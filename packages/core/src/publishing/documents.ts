import { defineDocFamily } from '@earendil-works/pi-durable';
import type { Distribution, PublishingTarget } from './contracts.js';

export const PublishingTargets = defineDocFamily<PublishingTarget, PublishingTarget | null>({
  kind: 'inkos.publishing.target', version: 1, scope: 'session', family: true,
  initial: seed => { if (!seed) throw new Error('Publishing target does not exist'); return seed; },
});
export const Distributions = defineDocFamily<Distribution, Distribution | null>({
  kind: 'inkos.publishing.distribution', version: 1, scope: 'session', family: true,
  initial: seed => { if (!seed) throw new Error('Distribution does not exist'); return seed; },
});
