export type RecordData = Record<string, any>;
export type Work = {
  id: string; title: string; profile: string; locale: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
  pauseRequested?: boolean;
  plan: { brief: string; serial: boolean; units: number | null; needsPlanning: boolean;
    review: { id: string; enabled: boolean; maxRevisions: number; maxCost: number | null };
    production: { backlog: number; cron: string | null; nextAt: number | null } };
  artifactIds: string[]; targetIds: string[]; materialIds: string[];
  domain: RecordData; history: RecordData[]; legacy?: RecordData;
};
export type RuntimeStatus = {
  pid: number; rootDir: string; works: Work[]; targets: RecordData[];
  distributions: RecordData[]; tasks: RecordData[];
  taskGraph: { tasks: Record<string, RecordData> };
  usage: RecordData; plugins: RecordData[]; model: RecordData | null;
};
export type ModelCatalog = {
  providers: { id: string; name: string; configured: boolean; authTypes: string[] }[];
  models: RecordData[]; selected: { provider: string; modelId?: string; id?: string } | null;
};
export type ArtifactRead = { artifact: RecordData; revision: RecordData; content: string };
export const builtinProfiles = ['fiction', 'short-fiction', 'script', 'storyboard', 'interactive-film', 'play', 'translation', 'article'];
