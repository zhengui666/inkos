import { z } from 'zod';
import type { JsonObject } from '@earendil-works/pi-durable';
import { StoryGraphSchema } from '../../interactive-film/graph-schema.js';
import { validateStoryGraph } from '../../interactive-film/validation.js';
import { PlayEntitySchema, PlayEdgeSchema, PlayStateSlotSchema, PlayEventSchema } from '../../models/play.js';
import { parseJson } from './review.js';

export const ScriptSchema = z.object({
  characters: z.array(z.unknown()),
  episodes: z.array(z.object({ id: z.string().min(1), title: z.string(), scenes: z.array(z.object({
    id: z.string().min(1), location: z.string(), time: z.string(), action: z.string(),
    dialogue: z.array(z.object({ speaker: z.string(), text: z.string() }).passthrough()),
  }).passthrough()) }).passthrough()),
}).passthrough();
export const StoryboardSchema = z.object({ shots: z.array(z.object({
  id: z.string().min(1), sceneId: z.string().min(1), framing: z.string(), movement: z.string(),
  duration: z.union([z.number(), z.string()]), action: z.string(), dialogue: z.string(), sound: z.string(),
}).passthrough()) }).passthrough();
export const PlayWorldSchema = z.object({
  entities: z.array(PlayEntitySchema), edges: z.array(PlayEdgeSchema), stateSlots: z.array(PlayStateSlotSchema),
  events: z.array(PlayEventSchema), presentation: z.object({ scene: z.string(), choices: z.array(z.unknown()) }).passthrough(),
}).passthrough();
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value));
export const structureParsers: Record<string, (text: string) => JsonObject> = {
  script: text => ({ script: json(ScriptSchema.parse(parseJson(text))) }),
  storyboard: text => ({ storyboard: json(StoryboardSchema.parse(parseJson(text))) }),
  play: text => ({ play: json(PlayWorldSchema.parse(parseJson(text))) }),
  'interactive-film': text => {
    const graph = StoryGraphSchema.parse(parseJson(text)), result = validateStoryGraph(graph);
    if (!result.ok) throw new Error(`Invalid story graph: ${result.issues.filter(issue => issue.level === 'error').map(issue => issue.message).join('; ')}`);
    return { graph: json(graph) };
  },
};
