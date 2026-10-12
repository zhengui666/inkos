import { join } from 'node:path';
import { EPub } from 'epub-gen-memory';
import type { WorksService } from '../works/service.js';
import { commitAtomicFileSet } from '../utils/atomic-file-set.js';
import { textSelectionEditContract } from '../utils/text-range-edits.js';
import { StoryGraphSchema } from '../interactive-film/graph-schema.js';
import { buildPlayableHtml } from '../interactive-film/export-html.js';
import { exportInk } from '../interactive-film/export-ink.js';
import { assertId } from '../works/artifacts.js';

export async function editArtifact(works: WorksService, input: { id: string; revisionId?: string; targetText: string; replacement: string }) {
  const { artifact, revision, content } = await works.read(input.id, input.revisionId);
  const edited = textSelectionEditContract(content, input.targetText).apply({ range_0_content: input.replacement });
  return works.save({ workId: artifact.workId, artifactId: artifact.id, title: artifact.title, content: edited, format: revision.format, metadata: { parentRevisionId: revision.id } });
}
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export async function exportArtifact(works: WorksService, input: { artifactId: string; revisionId?: string; format?: string }) {
  const { artifact, revision, content } = await works.read(input.artifactId, input.revisionId);
  const work = await works.get(artifact.workId); const format = input.format ?? 'txt';
  if (!['txt', 'md', 'json', 'epub', 'html', 'ink'].includes(format)) throw new Error('Unsupported export format');
  let output: string | Uint8Array = content;
  if ((format === 'html' || format === 'ink') && work.profile === 'interactive-film') {
    const graph = StoryGraphSchema.parse(JSON.parse(content)); output = format === 'html' ? buildPlayableHtml(graph, { title: work.title, locale: work.locale }) : exportInk(graph);
  } else if (format === 'ink') throw new Error('Ink export requires an interactive story graph');
  else if (format === 'html') output = `<!doctype html><html lang="${escape(work.locale)}"><meta charset="utf-8"><title>${escape(artifact.title)}</title><body><pre>${escape(content)}</pre></body></html>`;
  else if (format === 'epub') output = await new EPub({ title: work.title, lang: work.locale }, [{ title: artifact.title, content: content.split(/\r?\n/u).map(line => `<p>${escape(line)}</p>`).join('\n') }]).genEpub();
  const path = join('exports', assertId(work.id), `${assertId(artifact.id)}-${assertId(revision.id)}.${format}`);
  await commitAtomicFileSet({ rootDir: works.rootDir, writes: [{ relativePath: path, content: output }] });
  return { path, artifactId: artifact.id, revisionId: revision.id, format };
}
