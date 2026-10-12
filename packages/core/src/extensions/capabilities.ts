import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import type { RuntimeHost } from '../runtime/host.js';
import type { InkExtension } from '../runtime/plugins.js';
import { createContentTask } from './fiction/task.js';
import { createProductionTask } from './fiction/production.js';
import { createAutonomyTask, createAutonomyDeadline } from './fiction/autonomy.js';
import { publicRankingSource } from './research/ranking.js';
import { contentProfiles } from './fiction/profiles.js';
import { searchWeb, fetchUrl } from '../utils/web-search.js';
import { generateMedia } from './media.js';

export function createCapabilities(rootDir: string, host: () => RuntimeHost): InkExtension {
  const rpcTool = (name: string, description: string, method: string, parameters: ReturnType<typeof Type.Object>, safe = false) => defineTool({
    name, description, parameters, replay: safe ? 'safe' as const : undefined,
    execute: async (args, api) => {
      const result = await host().rpc(method, { ...args, ...(method === 'creation.start' ? { requestId: `tool:${api.taskId}` } : {}) });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  });
  const tools = [
    rpcTool('work_list', 'List project works and domain progress, independently of distribution.', 'works.list', Type.Object({}), true),
    rpcTool('work_create', 'Create content without requiring a publishing platform. Locale and profile are configurable.', 'works.create', Type.Object({ title: Type.String(), profile: Type.Optional(Type.String()), locale: Type.Optional(Type.String()), brief: Type.Optional(Type.String()), plan: Type.Optional(Type.Record(Type.String(), Type.Unknown())) })),
    rpcTool('work_update', 'Update title, brief, plan or professional domain data; changes affect relevant subsequent steps.', 'works.update', Type.Object({ id: Type.String(), changes: Type.Record(Type.String(), Type.Unknown()) })),
    rpcTool('content_create', 'Create or modify one content unit as a background durable child task. Reviews and necessary revisions follow the selected profile.', 'creation.start', Type.Object({ workId: Type.String(), artifactId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), instruction: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }), true),
    rpcTool('content_produce', 'Start durable production for a finite goal or ongoing serial with configured backlog and calendar.', 'creation.produce', Type.Object({ workId: Type.String() })),
    rpcTool('autonomy_configure', 'Configure installed ranking sources, research and chapter pacing for a work.', 'autonomy.configure', Type.Object({ workId: Type.String(), config: Type.Record(Type.String(), Type.Unknown()) })),
    rpcTool('autonomy_start', 'Start a time-bounded native ranking, original topic/title selection and continuous writing run. Saved revisions derive independent publishing tasks only for configured targets.', 'autonomy.start', Type.Object({ workId: Type.String(), durationMs: Type.Optional(Type.Number()), requestId: Type.Optional(Type.String()) })),
    rpcTool('autonomy_stop', 'Stop this work’s unattended run without deleting drafts, history or independent publishing receipts.', 'autonomy.stop', Type.Object({ workId: Type.String() })),
    rpcTool('ranking_read', 'Read evidence from an installed ranking-source extension. Unreadable sources are errors, not fabricated rankings.', 'ranking.read', Type.Object({ id: Type.String(), source: Type.String(), url: Type.String(), label: Type.Optional(Type.String()) }), true),
    rpcTool('work_pause', 'Persist pause/resume intent for a work. Pause takes effect at a step boundary, not terminal abort.', 'works.pause', Type.Object({ id: Type.String(), paused: Type.Boolean() })),
    rpcTool('artifact_read', 'Read a selected artifact revision.', 'artifacts.read', Type.Object({ id: Type.String(), revisionId: Type.Optional(Type.String()) }), true),
    rpcTool('artifact_edit', 'Make an exact selected-text edit, preserving unaffected text as a new revision. Does not republish.', 'artifacts.edit', Type.Object({ id: Type.String(), targetText: Type.String(), replacement: Type.String() })),
    rpcTool('artifact_export', 'Export a selected content version. Export is independent of automatic publishing.', 'artifacts.export', Type.Object({ artifactId: Type.String(), format: Type.Optional(Type.String()) })),
    rpcTool('materials_ingest', 'Archive a local file or URL as a reusable material.', 'materials.ingest', Type.Object({ sourceKind: Type.Union([Type.Literal('file'), Type.Literal('url')]), filePath: Type.Optional(Type.String()), url: Type.Optional(Type.String()), title: Type.Optional(Type.String()), purpose: Type.Optional(Type.String()) })),
    rpcTool('materials_query', 'Retrieve archived research and source materials without another model call.', 'materials.query', Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()), purpose: Type.Optional(Type.String()) }), true),
    defineTool({ name: 'research_search', description: 'Search configured research service; returns source links, not verified story facts.', parameters: Type.Object({ query: Type.String() }), replay: 'safe', execute: async args => ({ content: [{ type: 'text', text: JSON.stringify(await searchWeb(args.query)) }] }) }),
    defineTool({ name: 'research_fetch', description: 'Read a public source URL.', parameters: Type.Object({ url: Type.String() }), replay: 'safe', execute: async args => ({ content: [{ type: 'text', text: await fetchUrl(args.url) }] }) }),
    defineTool({ name: 'media_generate', description: 'Generate a cover, scene or entity illustration through configured pi-ai image providers or the retained thin image service. External generation is not replay-safe.', parameters: Type.Object({ workId: Type.String(), prompt: Type.String(), provider: Type.Optional(Type.String()), modelId: Type.Optional(Type.String()), reference: Type.Optional(Type.String()), size: Type.Optional(Type.String()) }), execute: async (args, api, context) => {
      const result = await generateMedia(host(), { ...args, revisionId: `media-${api.taskId}` }, context.abortSignal);
      return { content: [{ type: 'text', text: JSON.stringify(result.revision) }], ...(result.usage ? { usage: result.usage } : {}) };
    } }),
  ];
  return Object.assign(defineExtension({ name: 'inkos.content', tools, tasks: [createContentTask(rootDir), createProductionTask(rootDir), createAutonomyTask(rootDir), createAutonomyDeadline((id, expected) => host().stopAutonomy(id, expected, true))], sections: [
    section('inkos', () => 'InkOS manages works, artifacts and independent distribution targets. Use domain tools for stable revisions and durable content tasks. Read the author brief and existing domain data before changing content. Do not impose platforms, commercial structures, fixed chapter counts or English/Chinese-only locale rules. Creation continues independently of publishing approval. Pause persists intent; cancellation is terminal. Model/service failure does not authorize a rewrite or blind browser mutation.'),
  ] }), { profiles: contentProfiles, rankingSources: [publicRankingSource] });
}
