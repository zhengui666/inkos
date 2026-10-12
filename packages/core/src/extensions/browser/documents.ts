import { defineDoc } from '@earendil-works/pi-durable';
import type { BrowserObservation, PublishingOperation, PublishingTarget } from '../../publishing/contracts.js';

export type BrowserRun = {
  distributionId: string; target: PublishingTarget | null; mode: 'observe' | 'mutate'; operation: PublishingOperation;
  mcpCalls: number; report: BrowserObservation | null;
};
export const BrowserRunDoc = defineDoc<BrowserRun>({
  kind: 'inkos.browser.run', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ distributionId: '', target: null, mode: 'observe', operation: 'publish', mcpCalls: 0, report: null }),
});
