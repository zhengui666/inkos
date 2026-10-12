import type { ContentProfile } from '../../runtime/plugins.js';
import { structureParsers } from './structures.js';

export const contentProfiles: ContentProfile[] = [
  { id: 'fiction', label: 'Novel / serial fiction', format: 'text', countingUnit: 'word', domainKind: 'story', instructions:
    'Write fiction from the author brief, established facts and current plan. Distinguish required events, prohibitions, chronology, background and future intentions. Author instructions supersede generated plans; future payments are not received money, and setup or aftermath need not force a victory. Preserve character motivation, voice, causality, viewpoint and unresolved hooks. Do not impose commercial pacing, a fixed chapter count or an ending proof. Novel memory contains facts, character state, summaries and hooks; only new established events become facts.' },
  { id: 'short-fiction', label: 'Short fiction', format: 'text', countingUnit: 'word', domainKind: 'short-story', instructions:
    'Write a self-contained short story in the requested form. Develop the central situation, character choices and consequences economically. Preserve the requested voice and ending goal, not an obligatory twist or commercial template.' },
  { id: 'script', label: 'Script', format: 'json', countingUnit: 'word', domainKind: 'script', instructions:
    'Return JSON {characters:[],episodes:[{id,title,scenes:[{id,location,time,action,dialogue:[{speaker,text}]}]}]}. Maintain scene continuity, playable action and individual dialogue voices. Episode counts and format come from the brief, not novel chapters.' },
  { id: 'storyboard', label: 'Storyboard', format: 'json', countingUnit: 'word', domainKind: 'storyboard', instructions:
    'Return JSON {shots:[{id,sceneId,framing,movement,duration,action,dialogue,sound}]}. Preserve spatial/temporal continuity, shot intent and the supplied script. Use explicit scene/shot IDs, not invented novel chapters.' },
  { id: 'interactive-film', label: 'Interactive film', format: 'json', countingUnit: 'word', domainKind: 'story-graph', instructions:
    'Return a StoryGraph JSON: schemaVersion:1, projectId, title, worldAnchor:{storyCore,theme,genre,worldRules,durationMinutes}, characters:[{id,name,role,motivation}], nodes:[{id,title,type,sceneDesc,dialogue:[{speaker,text,emotion}],choices:[{id,text,targetNodeId,effects:[{var,op,value}]}]}], variables:[{name,type,default,desc}], endings:[{id,nodeId,title,type,description}]. Node type is start/normal/branch/merge/ending/explore. Maintain reachable branches, meaningful consequences, conditions and variable effects. Never flatten a branching graph into chapters.' },
  { id: 'play', label: 'Interactive world', format: 'json', countingUnit: 'word', domainKind: 'play-world', instructions:
    'Return JSON {entities:[],edges:[],stateSlots:[],events:[],presentation:{scene,choices:[]}} preserving stable entity/edge/event IDs, evidence states, resources, relationships and visibility. Resolve the player action from the existing graph; describe perceived changes separately from hidden facts. Keep free-form actions and consequences, not a fixed victory loop.' },
  { id: 'translation', label: 'Translation', format: 'text', countingUnit: 'word', domainKind: 'translation', instructions:
    'Translate the supplied source into the requested locale. Preserve segment IDs, meaning, narrative voice, terminology/glossary and character names. Keep structure and continuity across units. Do not add plot or replace translation with a novel-writing outline. Preserve source/target and glossary metadata in the work domain.' },
  { id: 'article', label: 'Article / general content', format: 'text', countingUnit: 'word', domainKind: 'content', instructions:
    'Produce the requested content format and locale. Distinguish supported research from inference; preserve citations and author constraints. No publishing target or novel-specific structure is required.' },
].map(profile => ({ ...profile, parseDomain: structureParsers[profile.id] })) as ContentProfile[];
