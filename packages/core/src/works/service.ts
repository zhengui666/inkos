import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness, JsonObject, Tx } from '@earendil-works/pi-durable';
import { Artifacts, ProjectDoc, Works, defaultPlan, type Work, type WorkPlan, type ArtifactRevision } from './documents.js';
import { assertId, readArtifact, saveArtifact } from './artifacts.js';
import { readFile } from 'node:fs/promises';
import { artifactPath } from './artifacts.js';
import { deriveDistributions } from '../publishing/service.js';

export type CreateWork = { id?: string; title: string; profile?: string; locale?: string; brief?: string; plan?: Partial<WorkPlan>; domain?: JsonObject };
export async function commitRevision(tx: Tx, work: Work, revision: ArtifactRevision, domain?: JsonObject, rootDir?: string): Promise<void> {
  const doc = await tx.doc(Works, work.id, work);
  const artifact = await tx.doc(Artifacts, revision.artifactId, {
    id: revision.artifactId, workId: work.id, title: revision.title, currentRevision: revision.id, revisions: [],
  });
  if (artifact.workId !== work.id) throw new Error('Artifact belongs to another work');
  if (!artifact.revisions.some(item => item.id === revision.id)) artifact.revisions.push(revision);
  artifact.currentRevision = revision.id;
  artifact.title = revision.title;
  if (!doc.artifactIds.includes(artifact.id)) doc.artifactIds.push(artifact.id);
  if (domain) doc.domain = { ...doc.domain, ...domain };
  doc.updatedAt = Date.now();
  if (rootDir) await deriveDistributions(tx, rootDir, doc, revision);
}
export class WorksService {
  constructor(readonly harness: Harness, readonly rootDir: string) {}
  async list(): Promise<Work[]> {
    const project = await this.harness.snapshot(ProjectDoc, BACKGROUND_CONTEXT);
    const works = await Promise.all((project?.workIds ?? []).map(id => this.harness.snapshot(Works, id, BACKGROUND_CONTEXT)));
    return works.filter((work): work is Work => work !== undefined);
  }
  async get(id: string): Promise<Work> {
    const work = await this.harness.snapshot(Works, id, BACKGROUND_CONTEXT);
    if (!work) throw new Error(`Work not found: ${id}`);
    return work;
  }
  async create(input: CreateWork): Promise<Work> {
    const id = assertId(input.id ?? randomUUID());
    if (!input.title?.trim()) throw new Error('Work title is required');
    const locale = new Intl.Locale(input.locale ?? 'en').toString();
    const now = Date.now();
    const plan = { ...defaultPlan(input.brief), ...input.plan,
      review: { ...defaultPlan().review, ...input.plan?.review },
      production: { ...defaultPlan().production, ...input.plan?.production },
    };
    if (!plan.serial && (plan.units === null || plan.units < 1)) throw new Error('Finite work needs a positive goal unit count');
    const seed: Work = {
      id, title: input.title, profile: input.profile ?? 'fiction', locale, plan,
      status: 'draft', artifactIds: [], targetIds: [], materialIds: [], domain: input.domain ?? {}, history: [], legacy: {},
      pauseRequested: false, createdAt: now, updatedAt: now,
    };
    await this.harness.commit(async tx => {
      const project = await tx.doc(ProjectDoc);
      if (project.workIds.includes(id)) throw new Error(`Work already exists: ${id}`);
      await tx.doc(Works, id, seed);
      project.workIds.push(id);
    }, BACKGROUND_CONTEXT);
    return this.get(id);
  }
  async update(id: string, changes: { title?: string; locale?: string; plan?: Partial<WorkPlan>; domain?: JsonObject; materialIds?: string[] }): Promise<Work> {
    const work = await this.get(id);
    await this.harness.commit(async tx => {
      const doc = await tx.doc(Works, id, work);
      if (changes.title !== undefined) doc.title = changes.title;
      if (changes.locale !== undefined) doc.locale = new Intl.Locale(changes.locale).toString();
      if (changes.plan) doc.plan = { ...doc.plan, ...changes.plan, review: { ...doc.plan.review, ...changes.plan.review }, production: { ...doc.plan.production, ...changes.plan.production } };
      if (changes.domain) doc.domain = changes.domain;
      if (changes.materialIds) doc.materialIds = changes.materialIds;
      doc.updatedAt = Date.now();
    }, BACKGROUND_CONTEXT);
    return this.get(id);
  }
  async pause(id: string, paused: boolean): Promise<Work> {
    const work = await this.get(id);
    await this.harness.commit(async tx => {
      const doc = await tx.doc(Works, id, work);
      doc.pauseRequested = paused;
      if (doc.status !== 'completed' && doc.status !== 'cancelled') doc.status = paused ? 'paused' : 'active';
    }, BACKGROUND_CONTEXT);
    return this.get(id);
  }
  async artifact(id: string) {
    const artifact = await this.harness.snapshot(Artifacts, id, BACKGROUND_CONTEXT);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    return artifact;
  }
  async read(id: string, revisionId?: string) {
    const artifact = await this.artifact(id);
    const revision = artifact.revisions.find(item => item.id === (revisionId ?? artifact.currentRevision));
    if (!revision) throw new Error('Revision not found');
    const binary = revision.format.startsWith('image/') || revision.format === 'application/octet-stream';
    return { artifact, revision, content: binary ? '' : await readArtifact(this.rootDir, revision),
      ...(binary ? { dataUrl: `data:${revision.format};base64,${(await readFile(artifactPath(this.rootDir, revision.path))).toString('base64')}` } : {}) };
  }
  async save(input: { workId: string; artifactId?: string; revisionId?: string; title: string; content: string; format?: string; metadata?: JsonObject }) {
    const work = await this.get(input.workId);
    const revision = await saveArtifact(this.rootDir, {
      id: input.revisionId ?? randomUUID(), workId: work.id, artifactId: input.artifactId ?? randomUUID(),
      title: input.title, content: input.content, format: input.format ?? 'text', metadata: { role: 'content', ...input.metadata },
    });
    await this.harness.commit(tx => commitRevision(tx, work, revision, undefined, this.rootDir), BACKGROUND_CONTEXT);
    this.harness.resume();
    return revision;
  }
}
