import type { RankingSnapshot, RankingSourceConfig } from '../extensions/research/ranking.js';

export type AutonomyConfig = {
  sources: RankingSourceConfig[]; chapterEveryMs: number; researchEveryMs: number;
  adoptSelection: boolean; chapterLength: number;
};
export type TopicSelection = { topic: string; title: string; brief: string; blueprint: string; evidence: { sourceId: string; quote: string }[] };
export type WorkAutonomy = {
  config: AutonomyConfig; research: RankingSnapshot[]; selection?: TopicSelection;
  taskId: number | null; deadlineTaskId: number | null; startedAt: number | null; endAt: number | null;
  nextChapterAt?: number; nextResearchAt?: number; lastError?: string | null;
  stoppedAt?: number; stopReason?: 'deadline' | 'user' | 'completed';
};
export const defaultAutonomyConfig = (): AutonomyConfig => ({
  sources: [], chapterEveryMs: 3_600_000, researchEveryMs: 21_600_000, adoptSelection: false, chapterLength: 2000,
});
