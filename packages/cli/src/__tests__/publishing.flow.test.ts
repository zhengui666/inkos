import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitAtomicFileSet, createInitialWorkManifestWrite } from '@actalk/inkos-core';

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'inkos-publishing-cli-')); });
afterEach(async () => { await rm(root, {recursive: true, force: true}); });
function run(args: string[], expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, 'publishing', ...args, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: {...process.env, HOME: root},
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr + result.stdout).toBe(expectedStatus);
  return JSON.parse(result.stdout);
}

describe('manual publishing CLI', () => {
  it('prepares, verifies, begins and reconciles a real package across separate CLI processes', async () => {
    expect(run(['capabilities']).map((capability: {platform: string}) => capability.platform).sort())
      .toEqual(['dreame', 'fanqie', 'goodnovel', 'meganovel', 'qidian', 'qimao']);
    const content = '# 第1章 归来\n\n这是待作者检查后自行提交的正文。\n';
    const writes = [{relativePath: 'works/novel/source/chapters/1.md', content}];
    const initial = createInitialWorkManifestWrite({workId: 'novel', title: '归来', profileId: 'long-form', language: 'zh', writes});
    await commitAtomicFileSet({rootDir: root, writes: [...writes, initial.write]});
    const mapping = run(['map-book', 'qimao', 'external-book', '--account', 'local-author-label']);
    const artifact = initial.manifest.artifacts[0]!;
    await writeFile(join(root, 'selection.json'), JSON.stringify([{artifactId: artifact.id, revisionId: artifact.currentRevisionId, number: 1, title: '归来'}]));
    const prepared = run(['prepare', mapping.id, '--selection', 'selection.json', '--formats', 'txt,md']);
    const id = prepared.package.manifest.id;
    expect(prepared.package.chapters[0].status).toBe('awaiting_submission');
    expect(await readFile(join(prepared.directory, 'chapters/000001_chapter.md'), 'utf8')).toBe(content);
    expect(run(['prepare', mapping.id, '--selection', 'selection.json', '--formats', 'txt,md']).package.manifest.id).toBe(id);
    expect(run(['verify', id]).package.remoteVerified).toBe(false);
    expect(run(['begin', id, '1', '--version', '0', '--event-id', 'manual-1']).version).toBe(1);
    const unknown = run(['receipt', id, '1', '--version', '1', '--event-id', 'unknown-1', '--status', 'submission_unknown', '--evidence', 'The author portal timed out.']);
    expect(unknown.chapters[0].status).toBe('submission_unknown');
    expect(run(['begin', id, '1', '--version', '2', '--event-id', 'retry'], 1).code).toBe('PUBLISHING_RECONCILIATION_REQUIRED');
    const submitted = run(['receipt', id, '1', '--version', '2', '--event-id', 'submitted-1', '--status', 'submitted_reported', '--evidence', 'Author checked the review queue.', '--remote-chapter', 'external-chapter']);
    expect(submitted.chapters[0].status).toBe('submitted_reported');
    const published = run(['receipt', id, '1', '--version', '3', '--event-id', 'published-1', '--status', 'published_reported', '--evidence', 'Author checked the published chapter.', '--remote-chapter', 'external-chapter']);
    expect(published.chapters[0]).toMatchObject({status: 'published_reported', provenance: 'user_reported'});
    expect(published.remoteVerified).toBe(false);
    expect(run(['show', id])).toEqual(published);
    expect(run(['list', '--target', mapping.id])).toHaveLength(1);
    expect(await readFile(join(root, writes[0]!.relativePath), 'utf8')).toBe(content);
  }, 30000);

  it('reports invalid selections as errors and never invents a target account or Work', async () => {
    expect(run(['map-book', 'fanqie', 'remote-id', '--account', 'author'], 1).error).toContain('Specify work-id');
    expect(run(['show', 'missing'], 1).code).toBe('PUBLISHING_PACKAGE_MISSING');
  });
});
