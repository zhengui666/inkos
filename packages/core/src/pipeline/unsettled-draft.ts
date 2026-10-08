import { loadPersistedPlan } from "./persisted-governed-plan.js";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { z } from "zod";
import type { GeneratedChapterDraft, WriteChapterInput } from "../agents/writer.js";
import { ChapterDraftToolSchema } from "../agents/writer-tool.js";
import { BookConfigSchema } from "../models/book.js";
import { ChapterMetaSchema } from "../models/chapter.js";
import { ChapterIntentSchema, ChapterMemoSchema, ContextPackageSchema } from "../models/input-governance.js";
import { LengthSpecSchema } from "../models/length-governance.js";
import { currentExecutionProfile, currentExecutionWork, currentExecutionAuthorRequest } from "../harness/execution-evidence.js";
import { loadWorkManifest } from "../harness/work-store.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { loadAvailableAgentSkills } from "../skills/builtin-loader.js";
import { requiredWorkSkillIds, resolveProfileSkillActivations, resolveWorkSkillActivations, mergeActivatedSkillGuidance } from "../skills/activations.js";
import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import { listBookReferences } from "../references/book-references.js";
import { commitAtomicFileSet, recoverAtomicFileSets } from "../utils/atomic-file-set.js";
import { assertSafeBookId } from "../utils/book-id.js";
import { safeChildPath } from "../utils/path-safety.js";

// This is a recoverable draft, never a Work source artifact or accepted fact.
const InputSchema = z.object({
  book: BookConfigSchema,
  chapterNumber: z.number().int().positive(),
  externalContext: z.string().optional(),
  chapterIntent: z.string(),
  chapterMemo: ChapterMemoSchema,
  chapterIntentData: ChapterIntentSchema.optional(),
  contextPackage: ContextPackageSchema,
  lengthSpec: LengthSpecSchema,
  temperatureOverride: z.number().optional(),
}).strict().refine(input => input.chapterMemo.chapter === input.chapterNumber
  && input.contextPackage.chapter === input.chapterNumber
  && (!input.chapterIntentData || input.chapterIntentData.chapter === input.chapterNumber), "Draft inputs must identify the same chapter.");
const CheckpointSchema = z.object({
  version: z.literal(1),
  input: InputSchema,
  authorRequest: z.string().optional(),
  sources: z.array(z.tuple([z.string(), z.string()])),
  draft: z.custom<GeneratedChapterDraft>(value => Value.Check(ChapterDraftToolSchema, value)
    && !!(value as GeneratedChapterDraft).content.trim()),
  tokenUsage: ChapterMetaSchema.shape.tokenUsage,
}).strict();
export type UnsettledDraft = z.infer<typeof CheckpointSchema>;
type DraftRequest = Pick<WriteChapterInput, "book" | "bookDir" | "chapterNumber" | "externalContext" | "temperatureOverride"> & {
  readonly lengthSpec: z.infer<typeof LengthSpecSchema>;
  readonly activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>;
};

function checkpointLocation(projectRoot: string, bookId: string, chapter: number) {
  if (!Number.isInteger(chapter) || chapter < 1) throw new Error("Invalid draft chapter number.");
  return { rootDir: join(projectRoot, ".inkos", "unsettled-drafts", assertSafeBookId(bookId)),
    file: `chapter-${String(chapter).padStart(4, "0")}.json` };
}

/** Exact source contents, not mtimes, digests, or generated retrieval caches. */
export async function captureDraftSources(projectRoot: string, bookDir: string, bookId: string, chapter: number, activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>): Promise<[string, string][]> {
  const sources: [string, string][] = [];
  const slug = `chapter-${String(chapter).padStart(4, "0")}.`;
  const visit = async (path: string): Promise<void> => {
    let entries;
    try {
      if ((await lstat(join(bookDir, path))).isSymbolicLink()) throw new Error(`Draft input cannot be a symbolic link: ${path}`);
      entries = await readdir(join(bookDir, path), { withFileTypes: true });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${path}/${entry.name}`;
      if (relative === "story/snapshots" || relative === "story/versions") continue;
      if (path === "story/runtime" && (!entry.name.startsWith(slug) || !/\.(plan\.json|intent\.md|context\.json|user-brief\.md)$/.test(entry.name))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Draft input cannot be a symbolic link: ${relative}`);
      if (entry.isDirectory()) { if (path !== "chapters") await visit(relative); }
      else if (/\.(md|json)$/.test(entry.name)) {
        sources.push([relative, await readFile(join(bookDir, relative), "utf8")]);
      }
    }
  };
  await visit("story");
  await visit("chapters");
  // Bound materials live outside the book; comparing only the binding manifest
  // would miss a changed or newly available reference at the same path.
  const references = await listBookReferences(projectRoot, bookId);
  for (const reference of references.references) {
    sources.push([`reference/${reference.materialId}`, JSON.stringify(reference)]);
    if (reference.available && reference.asset) sources.push([`reference/${reference.materialId}/content`,
      await readFile(safeChildPath(projectRoot, reference.asset.markdownPath), "utf8")]);
  }
  sources.push(...await captureDraftGuidance(projectRoot, bookId, activatedSkills));
  return sources;
}

/** Snapshot the same effective methods and Work metadata used by BaseAgent.
 * Resource bytes are a conservative superset: retrieval remains free to select
 * different relevant sections without letting an edited method reuse old prose. */
async function captureDraftGuidance(projectRoot: string, bookId: string, activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>): Promise<[string, string][]> {
  const scopedWork = currentExecutionWork();
  const work = scopedWork?.id === bookId ? scopedWork : await loadWorkManifest(projectRoot, bookId);
  const scopedProfile = currentExecutionProfile();
  const profile = scopedProfile?.id === work.profileId ? scopedProfile : createBuiltInWorkProfileRegistry(projectRoot).require(work.profileId);
  let selected = activatedSkills ?? [];
  if ([...profile.requiredSkillIds, ...requiredWorkSkillIds(work)].some(id => !selected.some(item => item.skill.id === id))) {
    const available = await loadAvailableAgentSkills({ projectRoot });
    selected = mergeActivatedSkillGuidance(resolveProfileSkillActivations(available.skills, profile), resolveWorkSkillActivations(available.skills, work), selected);
  }
  const sources: [string, string][] = [["worker/authority", JSON.stringify({ profile,
    work: { id: work.id, title: work.title, profileId: work.profileId, language: work.language, lineage: work.lineage, creationKind: work.metadata.creationKind }, selected })]];
  for (const { skill } of selected) {
    if (!skill.baseDir) continue;
    const visit = async (directory: string, relative: string): Promise<void> => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) continue; // Same boundary as skill resource retrieval.
        const path = join(directory, entry.name), key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path, key);
        else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) sources.push([`skill/${skill.id}/${key}`, await readFile(path, "utf8")]);
      }
    };
    await visit(skill.baseDir, "");
  }
  return sources;
}

export async function saveUnsettledDraft(projectRoot: string, input: WriteChapterInput, sources: UnsettledDraft["sources"], draft: GeneratedChapterDraft): Promise<UnsettledDraft> {
  const checkpoint = CheckpointSchema.parse({ version: 1,
    input: { book: input.book, chapterNumber: input.chapterNumber, externalContext: input.externalContext,
      chapterIntent: input.chapterIntent, chapterMemo: input.chapterMemo, chapterIntentData: input.chapterIntentData,
      contextPackage: input.contextPackage, lengthSpec: input.lengthSpec, temperatureOverride: input.temperatureOverride },
    authorRequest: currentExecutionAuthorRequest(), sources,
    draft: { title: draft.title, content: draft.content }, tokenUsage: draft.tokenUsage,
  });
  const { rootDir, file } = checkpointLocation(projectRoot, input.book.id, input.chapterNumber);
  await commitAtomicFileSet({ rootDir, writes: [{ relativePath: file, content: `${JSON.stringify(checkpoint)}\n` }] });
  return checkpoint;
}

/** Retain a stale draft for inspection while allowing a fresh authorized attempt. */
export async function loadUnsettledDraft(projectRoot: string, request: DraftRequest): Promise<UnsettledDraft | null> {
  const { rootDir, file } = checkpointLocation(projectRoot, request.book.id, request.chapterNumber);
  await recoverAtomicFileSets(rootDir);
  let raw: string;
  try { raw = await readFile(join(rootDir, file), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const checkpoint = CheckpointSchema.parse(JSON.parse(raw));
  const saved = checkpoint.input;
  const sameRequest = isDeepStrictEqual(saved.book, request.book) && saved.chapterNumber === request.chapterNumber
    && saved.externalContext === request.externalContext && isDeepStrictEqual(saved.lengthSpec, request.lengthSpec)
    && saved.temperatureOverride === request.temperatureOverride && checkpoint.authorRequest === currentExecutionAuthorRequest();
  if (sameRequest && isDeepStrictEqual(checkpoint.sources,
    await captureDraftSources(projectRoot, request.bookDir, request.book.id, request.chapterNumber, request.activatedSkills))) return checkpoint;
  await commitAtomicFileSet({ rootDir, writes: [{ relativePath: join("stale", `${file}.${randomUUID()}.json`), content: raw }], deletes: [file] });
  return null;
}

export async function assertDraftSourcesCurrent(projectRoot: string, input: WriteChapterInput, checkpoint: Pick<UnsettledDraft, "sources" | "authorRequest">, activatedSkills?: ReadonlyArray<ActivatedSkillGuidance>): Promise<void> {
  const currentBook = BookConfigSchema.parse(JSON.parse(await readFile(join(input.bookDir, "book.json"), "utf8")));
  if (!isDeepStrictEqual(currentBook, input.book) || checkpoint.authorRequest !== currentExecutionAuthorRequest()
    || !isDeepStrictEqual(checkpoint.sources, await captureDraftSources(projectRoot, input.bookDir, input.book.id, input.chapterNumber, activatedSkills))) {
    throw Object.assign(new Error("Chapter inputs changed while writing. The generated draft was retained; retry with the current inputs."), {
      code: "CHAPTER_DRAFT_INPUTS_CHANGED", chapterNumber: input.chapterNumber,
    });
  }
}

/** Compare actual prepared artifacts too: a concurrent author edit is not our planning output. */
export async function assertPreparedDraftInputs(input: WriteChapterInput): Promise<void> {
  const plan = await loadPersistedPlan(input.bookDir, input.chapterNumber);
  const context = ContextPackageSchema.parse(JSON.parse(await readFile(join(input.bookDir, "story", "runtime",
    `chapter-${String(input.chapterNumber).padStart(4, "0")}.context.json`), "utf8")));
  if (!plan || !isDeepStrictEqual(plan.memo, input.chapterMemo) || !isDeepStrictEqual(plan.intent, input.chapterIntentData)
    || plan.intentMarkdown !== input.chapterIntent || !isDeepStrictEqual(context, input.contextPackage)) {
    throw Object.assign(new Error("Prepared chapter inputs changed; retry with the current plan and context."), { code: "CHAPTER_DRAFT_INPUTS_CHANGED" });
  }
}

/** Plan/context files are legitimate outputs of preparation; all other input changes invalidate it. */
export function sameDraftPlanningSources(before: UnsettledDraft["sources"], after: UnsettledDraft["sources"]): boolean {
  const external = (sources: UnsettledDraft["sources"]) => sources.filter(([path]) =>
    !/^story\/runtime\/chapter-\d+\.(plan\.json|intent\.md|context\.json)$/.test(path));
  return isDeepStrictEqual(external(before), external(after));
}

export async function clearUnsettledDraft(projectRoot: string, bookId: string, chapter: number): Promise<void> {
  const { rootDir, file } = checkpointLocation(projectRoot, bookId, chapter);
  try { await readFile(join(rootDir, file)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await commitAtomicFileSet({ rootDir, writes: [], deletes: [file] });
}
