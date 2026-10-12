import { defineExtension, defineTool, section } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import type { InkExtension } from '../../runtime/plugins.js';
import type { CreateTargetInput, UpdateTargetInput, QueueDistributionInput } from '../../publishing/contracts.js';
import { createDistributionTask } from '../../publishing/task.js';
import { listPublishingTargets, listDistributions, createPublishingTarget, updatePublishingTarget, queueDistribution } from '../../publishing/service.js';
import { createBrowserExtension } from '../browser/index.js';
import { createBrowserPublisherExtension } from './browser-publisher.js';
import { createMegaNovelExtension } from './meganovel.js';

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
const config = Type.Object({ entryUrl: Type.String(), accountId: Type.String(), browser: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  remote: Type.Optional(Type.Record(Type.String(), Type.Unknown())), skill: Type.Optional(Type.String()), metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
/** One install supplies the distribution task, browser tools and the two actual built-in browser skills. */
export function createPublishingExtension(rootDir: string): InkExtension {
  const browser = createBrowserExtension(rootDir), generic = createBrowserPublisherExtension(), megaNovel = createMegaNovelExtension();
  return { ...defineExtension({
    name: 'inkos.publishing', tasks: [createDistributionTask(rootDir)],
    tools: [
      ...(browser.tools ?? []),
      defineTool({ name: 'publishing_targets', description: 'List independent account/work publishing targets.', parameters: Type.Object({}), replay: 'safe',
        execute: async (_args, api) => json(await listPublishingTargets(api)) }),
      defineTool({ name: 'publishing_create_target', description: 'Create an independent target, entry, account/session, metadata and optional remote mapping.',
        parameters: Type.Object({ id: Type.Optional(Type.String()), workId: Type.String(), platform: Type.String(), label: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()), config }), replay: 'unsafe',
        execute: async (args, api) => json(await createPublishingTarget(api, args as CreateTargetInput)) }),
      defineTool({ name: 'publishing_update_target', description: 'Update target configuration; another account uses a separate target.',
        parameters: Type.Object({ id: Type.String(), changes: Type.Record(Type.String(), Type.Unknown()) }), replay: 'unsafe',
        execute: async (args, api) => json(await updatePublishingTarget(api, args.id, args.changes as UpdateTargetInput)) }),
      defineTool({ name: 'publishing_list', description: 'List stable target/artifact distributions, including unknown outcomes.', parameters: Type.Object({}), replay: 'safe',
        execute: async (_args, api) => json(await listDistributions(api)) }),
      defineTool({ name: 'publishing_queue', description: 'Queue one retained artifact revision for a target. Already submitted content needs explicit update, never publish again.',
        parameters: Type.Object({ targetId: Type.String(), artifactId: Type.String(), revisionId: Type.Optional(Type.String()),
          operation: Type.Optional(Type.Union([Type.Literal('publish'), Type.Literal('update')])), scheduledAt: Type.Optional(Type.Number()), requestId: Type.Optional(Type.String()) }), replay: 'unsafe',
        execute: async (args, api) => json(await queueDistribution(api, rootDir, args as QueueDistributionInput)) }),
    ],
    sections: [...(browser.sections ?? []), ...(generic.sections ?? []), ...(megaNovel.sections ?? []),
      section('publishing', () => 'Distribution is independent of creation. Queue retained artifact revisions for any number of account-scoped targets. '
        + 'Inspect before changing a site. An external timeout is unknown; use publishing.observe/resume on its stable distribution ID. '
        + 'submitted is not published. A new revision of submitted/published content requires explicit operation:update and an installed update capability.')],
  }), publishers: [...(generic.publishers ?? []), ...(megaNovel.publishers ?? [])] };
}
export { createBrowserPublisherExtension } from './browser-publisher.js';
export { createMegaNovelExtension } from './meganovel.js';
export { createDistributionTask } from '../../publishing/task.js';
export { PublishingService } from '../../publishing/service.js';
export default (context: { rootDir: string }): InkExtension => createPublishingExtension(context.rootDir);
