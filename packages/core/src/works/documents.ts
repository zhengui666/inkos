import { defineDoc, defineDocFamily, type JsonObject } from '@earendil-works/pi-durable';
import type { WorkAutonomy } from './autonomy.js';

export type ReviewPolicy = { id: string; enabled: boolean; maxRevisions: number; maxCost: number | null };
export type WorkPlan = {
  brief: string; serial: boolean; units: number | null; needsPlanning: boolean;
  review: ReviewPolicy; production: { backlog: number; cron: string | null; nextAt: number | null };
};
export type Work = {
  id: string; title: string; profile: string; locale: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
  plan: WorkPlan; artifactIds: string[]; targetIds: string[]; materialIds: string[];
  domain: JsonObject; history: JsonObject[]; legacy: JsonObject;
  pauseRequested: boolean; createdAt: number; updatedAt: number;
  autonomy?: WorkAutonomy;
};
export type ArtifactRevision = {
  id: string; artifactId: string; workId: string; title: string; path: string;
  format: string; createdAt: number; metadata: JsonObject;
};
export type Artifact = {
  id: string; workId: string; title: string; currentRevision: string;
  revisions: ArtifactRevision[];
};
export type ReviewIssue = { kind: 'requirement' | 'contradiction' | 'suggestion'; message: string };
export type ReviewResult = {
  revisionId: string; policyId: string; issues: ReviewIssue[]; storyState: JsonObject; completedAt: number;
};
export type ProjectState = {
  workIds: string[]; targetIds: string[]; distributionIds: string[];
  migrations: Record<string, JsonObject>; requests: Record<string, { taskId: number; artifactId: string }>;
  model: { provider: string; modelId: string } | null; legacyConfig: JsonObject;
  deviceId?: string;
};
export const ProjectDoc = defineDoc<ProjectState>({
  kind: 'inkos.project', version: 1, scope: 'session',
  initial: () => ({ workIds: [], targetIds: [], distributionIds: [], migrations: {}, requests: {}, model: null, legacyConfig: {} }),
});
export const Works = defineDocFamily<Work, Work>({
  kind: 'inkos.work', version: 1, scope: 'session', family: true, initial: seed => seed,
});
export const Artifacts = defineDocFamily<Artifact, Artifact>({
  kind: 'inkos.artifact', version: 1, scope: 'session', family: true, initial: seed => seed,
});
export const Reviews = defineDocFamily<ReviewResult, ReviewResult>({
  kind: 'inkos.review', version: 1, scope: 'session', family: true, initial: seed => seed,
});
export const reviewKey = (revisionId: string, policyId: string): string => JSON.stringify([revisionId, policyId]);
export const defaultPlan = (brief = ''): WorkPlan => ({
  brief, serial: false, units: 1, needsPlanning: false,
  review: { id: 'author-intent-v1', enabled: true, maxRevisions: 2, maxCost: null },
  production: { backlog: 3, cron: null, nextAt: null },
});
