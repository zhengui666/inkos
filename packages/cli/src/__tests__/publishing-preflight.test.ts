import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
let root: string;
beforeEach(async () => {root = await mkdtemp(join(tmpdir(), 'inkos-rebuilt-preflight-cli-'));});
afterEach(async () => {await rm(root, {recursive: true, force: true});});
function run(args: string[]) {return spawnSync(process.execPath, [cli, 'publishing', ...args], {cwd: root, encoding: 'utf8', timeout: 15000, env: {...process.env, HOME: root}});}
async function tree(directory = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name), key = path.slice(root.length);
    if (entry.isDirectory()) {result[key + '/'] = 'directory'; Object.assign(result, await tree(path));}
    else result[key] = (await readFile(path)).toString('base64');
  }
  return result;
}
async function pendingTransaction() {
  const txn = join(root, '.inkos-file-txn-fixture'); await mkdir(txn);
  await writeFile(join(txn, 'journal.json'), JSON.stringify({version: 1, pid: 0, phase: 'prepared', entries: [{path: 'untouched.txt', existed: false}]}));
  await writeFile(join(root, 'untouched.txt'), 'Preserve this interrupted file');
}
describe('rebuilt preflight actual compiled CLI boundary', () => {
  it('exposes the dedicated observation command', () => {
    const child = run(['preflight', '--help']); expect(child.status).toBe(0);
    expect(child.stdout).toContain('observation only'); expect(child.stdout).toContain('--config'); expect(child.stdout).toContain('--chapter');
  });
  it('does not run global recovery or create a database for a rejected observation', async () => {
    await pendingTransaction();
    await writeFile(join(root, 'preflight.json'), JSON.stringify({version: 1, bindings: [{provider: 'qidian', workId: 'fixture', configuration: {}}]}));
    const before = await tree(), child = run(['preflight', 'fixture', '--chapter', '1', '--config', 'preflight.json', '--json']);
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toMatchObject({observationOnly: true, publicationAuthorized: false, errors: [{code: 'PUBLISHING_PREFLIGHT_UNSUPPORTED'}]});
    expect(await tree()).toEqual(before);
  });
  it('redacts invalid configuration contents and raw parser errors', async () => {
    await writeFile(join(root, 'bad.json'), 'SECRET_MANUSCRIPT_OR_TOKEN');
    const child = run(['preflight', 'fixture', '--chapter', '1', '--config', 'bad.json', '--json']);
    expect(child.status).toBe(1); expect(JSON.parse(child.stdout).errors[0].code).toBe('PUBLISHING_PREFLIGHT_FAILED');
    expect(child.stdout + child.stderr).not.toContain('SECRET_MANUSCRIPT_OR_TOKEN'); expect(await readdir(root)).toEqual(['bad.json']);
  });
  it('keeps recovery enabled when preflight is only an argument to another command', async () => {
    await pendingTransaction(); const child = run(['show', 'preflight', '--json']);
    expect(child.status).toBe(1); expect(JSON.parse(child.stdout).code).toBe('PUBLISHING_PACKAGE_MISSING');
    expect(await readdir(root)).not.toContain('untouched.txt'); expect(await readdir(root)).not.toContain('.inkos-file-txn-fixture');
  });
});
