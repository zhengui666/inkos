import type { JsonObject } from '@earendil-works/pi-durable';
import type { McpConfig } from '../runtime/mcp.js';

export type PublishingOperation = 'publish' | 'update';
export type BrowserConfig = {
  /** Omit mcp to launch the installed official Playwright MCP. */
  mcp?: McpConfig; userDataDir?: string; headless?: boolean; executablePath?: string; args?: string[];
};
export type RemoteMapping = {
  workId: string | null; workUrl: string | null;
  artifactIds: Record<string, string>; artifactUrls: Record<string, string>; readerUrls: Record<string, string>;
};
export type TargetConfig = {
  entryUrl: string; accountId: string; remote: RemoteMapping; browser: BrowserConfig;
  skill: string; metadata: JsonObject; cadence?: { cron: string; timeZone?: string };
};
export type CreateTargetInput = {
  id?: string; workId: string; platform: string; label?: string; enabled?: boolean;
  config: Pick<TargetConfig, 'entryUrl' | 'accountId'> & Partial<Omit<TargetConfig, 'entryUrl' | 'accountId' | 'remote'>> & { remote?: Partial<RemoteMapping> };
};
export type UpdateTargetInput = {
  label?: string; enabled?: boolean;
  config?: Partial<Omit<TargetConfig, 'remote'>> & { remote?: Partial<RemoteMapping> };
};
export type PublishingTarget = {
  id: string; workId: string; platform: string; label: string; enabled: boolean; config: TargetConfig;
  conversationId: number; createdAt: number; updatedAt: number;
};
export type QueueDistributionInput = {
  targetId: string; artifactId: string; revisionId?: string; operation?: PublishingOperation;
  /** Epoch milliseconds. Scheduling is local; the platform receives one Now action when due. */
  scheduledAt?: number; requestId?: string;
};
export type DistributionRequest = {
  revisionId: string; operation: PublishingOperation; scheduledAt: number | null; requestId: string | null;
};
export type RemoteIdentity = { workId: string | null; artifactId: string | null; authorUrl: string | null; readerUrl: string | null };
export type BrowserObservation = {
  state: 'absent' | 'draft' | 'submitted' | 'reviewing' | 'rejected' | 'published' | 'user-action' | 'unknown';
  accountId: string | null; remote: RemoteIdentity; title: string | null; body: string | null;
  complete: boolean;
  /** Positive evidence the retained intent did not take effect, NOT merely a missing row. */
  notApplied: boolean; evidence: string; observedAt: number;
};
export type DistributionIntent = {
  request: DistributionRequest; target: PublishingTarget; conversationId: number; startedAt: number;
};
export type DistributionStatus = BrowserObservation['state'] | 'queued' | 'observing' | 'needs-observation' | 'unsupported' | 'failed';
export type Distribution = {
  id: string; targetId: string; artifactId: string; workId: string;
  desired: DistributionRequest; taskId: number | null; status: DistributionStatus;
  intent: DistributionIntent | null; observationConversationId: number | null;
  remote: RemoteIdentity; lastObservation: BrowserObservation | null;
  observedRevisionId: string | null; submittedRevisionId: string | null; publishedRevisionId: string | null;
  requests: Record<string, DistributionRequest>; error: string | null; createdAt: number; updatedAt: number;
};
export type DistributionTaskInput = { distributionId: string; request: DistributionRequest; mode: 'deliver' | 'observe' };
export type DistributionCheckpoint = { phase: 'start' } | { phase: 'recover' };
export type DistributionResult = { id: string; status: DistributionStatus };
export const distributionKey = (targetId: string, artifactId: string): string => JSON.stringify([targetId, artifactId]);
export const emptyRemote = (): RemoteIdentity => ({ workId: null, artifactId: null, authorUrl: null, readerUrl: null });
export const emptyMapping = (): RemoteMapping => ({ workId: null, workUrl: null, artifactIds: {}, artifactUrls: {}, readerUrls: {} });
