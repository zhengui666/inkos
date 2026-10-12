import { useMemo, useState } from 'react';
import { Background, Controls, ReactFlow, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { StoryGraph } from '@actalk/inkos-core/interactive-film/graph-schema';
import { layoutStoryGraph } from '../../lib/story-flow-layout';
import { reviewIssueCount } from '../../lib/review-status';
import type { RecordData, Work } from '../../runtime/types';
import { Action, Badge, DataDetails, Empty } from '../../components/workbench';

export function DomainView({ work, content }: { work: Work; content?: string }) {
  const domain = work.domain ?? {};
  const parsed = useMemo(() => {
    if (!content || !['interactive-film', 'translation', 'storyboard', 'play'].includes(work.profile)) return null;
    try { return JSON.parse(content); } catch { return null; }
  }, [content, work.profile]);
  const graph = parsed?.graph ?? (parsed?.nodes ? parsed : null) ?? domain.storyGraph ?? domain.graph ?? domain.interactiveFilm?.graph;
  const translation = parsed?.translation ?? (parsed?.segments || parsed?.chapters ? parsed : null) ?? domain.translation ?? (work.profile === 'translation' ? domain : null);
  if (!graph && !translation && !Object.keys(domain).length) return null;
  return <section className="panel stack" aria-label="Professional domain data">
    <div className="panel-heading"><h2>{work.profile === 'translation' ? 'Translation workspace' : work.profile === 'interactive-film' ? 'Interactive story graph' : 'Domain data'}</h2><Badge value={work.profile} /></div>
    {graph && Array.isArray(graph.nodes) && <GraphView graph={graph} />}
    {translation && <TranslationView translation={translation} />}
    <DataDetails title="Complete professional data" data={parsed ?? domain} />
  </section>;
}
function GraphView({ graph }: { graph: RecordData }) {
  const [selected, setSelected] = useState<string>('');
  const layout = useMemo(() => layoutStoryGraph(graph as StoryGraph), [graph]);
  const nodes: Node[] = layout.nodes.map(node => ({ ...node, type: 'default', data: { label: `${node.data.nodeType} · ${node.data.label}` }, selected: node.id === selected }));
  const edges: Edge[] = layout.edges.map(edge => ({ ...edge, type: 'smoothstep' }));
  const node = graph.nodes.find((value: RecordData) => value.id === selected);
  return <div className="stack"><div className="graph-canvas" aria-label="Interactive graph; use the node selector for keyboard access"><ReactFlow nodes={nodes} edges={edges} onNodeClick={(_, value) => setSelected(value.id)} fitView nodesDraggable={false} nodesConnectable={false} minZoom={0.15} maxZoom={2}><Background gap={24} /><Controls showInteractive={false} /></ReactFlow></div>
    <label className="field"><span>Inspect story node</span><select value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a node</option>{graph.nodes.map((value: RecordData) => <option key={value.id} value={value.id}>{value.title ?? value.id} · {value.type}</option>)}</select></label>
    {node && <div className="node-inspector"><h3>{node.title ?? node.id}</h3><p className="prose-text">{node.sceneDesc ?? node.content ?? node.text ?? node.sceneText}</p>{(node.dialogue ?? []).map((line: RecordData, index: number) => <div className="message" key={index}><strong>{line.speaker}</strong>{line.emotion && <span className="small muted"> · {line.emotion}</span>}<p className="prose-text">{line.text}</p></div>)}<div className="actions">{(node.choices ?? []).map((choice: RecordData) => <Action key={choice.id} onClick={() => setSelected(choice.targetNodeId)}>{choice.text} → {choice.targetNodeId}</Action>)}</div><DataDetails title="Node conditions, effects & metadata" data={node} /></div>}
    {!graph.nodes.length && <Empty title="No story nodes">The graph artifact is empty.</Empty>}
    {selected && !node && <Empty title="Story node not found">This choice points to a missing node. Inspect the artifact JSON to repair the target ID.</Empty>}
  </div>;
}
function TranslationView({ translation }: { translation: RecordData }) {
  const chapters: RecordData[] = Array.isArray(translation.chapters) ? translation.chapters : Array.isArray(translation.manifest?.chapters) ? translation.manifest.chapters : [{ title: 'Segments', segments: translation.segments ?? [] }];
  return <div className="stack"><div className="actions"><Badge value={translation.sourceLanguage ?? translation.sourceLocale ?? 'source'} /><span aria-hidden="true">→</span><Badge value={translation.targetLanguage ?? translation.targetLocale ?? 'target'} /><span className="muted small">Alignment · terminology · review observations</span></div>
    {chapters.map((chapter, i) => <section key={chapter.number ?? i} className="translation-chapter"><div className="panel-heading"><h3>{chapter.title ?? `Chapter ${chapter.number ?? i + 1}`}</h3><span className="small muted">{chapter.translatedSegments ?? chapter.segments?.filter((s: RecordData) => s.target).length ?? 0} translated · {reviewIssueCount(chapter.observations ?? [])} review issues</span></div>
      {!!chapter.segments?.length && <div className="translation-columns"><strong>Source</strong><strong>Translation & notes</strong></div>}
      {(chapter.segments ?? []).map((segment: RecordData, j: number) => <div className="translation-segment" key={segment.id ?? segment.index ?? j}><div><span className="segment-index">{segment.index ?? j + 1}</span><p>{segment.source}</p></div><div><p>{segment.target || 'Not translated yet'}</p>{segment.notes && <p className="muted small">{segment.notes}</p>}<DataDetails title="Segment metadata" data={segment} /></div></div>)}
      <DataDetails title="Chapter review & terminology" data={chapter} />
    </section>)}
    {translation.report && <div className="prose-text">{translation.report}</div>}
  </div>;
}
