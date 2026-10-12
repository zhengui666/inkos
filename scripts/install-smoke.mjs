import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const exec = promisify(execFile), repo = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? process.env.RUNNER_TEMP ?? tmpdir(), 'inkos-install-'));
let runtime, studio;
try {
  const pack = join(temporary, 'packs'), installed = join(temporary, 'installed'), project = join(temporary, 'project');
  await Promise.all([pack, installed, project].map(path => mkdir(path)));
  const tarballs = [];
  for (const name of ['core', 'studio', 'cli']) {
    const pkg = JSON.parse(await readFile(join(repo, 'packages', name, 'package.json'), 'utf8'));
    await exec('pnpm', ['pack', '--pack-destination', pack], { cwd: join(repo, 'packages', name), maxBuffer: 8 * 1024 * 1024 });
    tarballs.push(join(pack, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`));
    console.log(`Packed ${pkg.name}@${pkg.version}`);
  }
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'inkos-install-smoke', private: true, type: 'module' }));
  await exec('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: installed, maxBuffer: 8 * 1024 * 1024, timeout: 240000 });
  const resolvePackage = async name => (await exec(process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(name)}))`], { cwd: installed })).stdout.trim();
  const core = await import(await resolvePackage('@actalk/inkos-core'));
  const ui = await import(await resolvePackage('@actalk/inkos-studio'));
  console.log('Clean npm installation and public ESM imports passed');
  const cli = join(installed, 'node_modules/@actalk/inkos/dist/index.js');
  const run = args => exec(process.execPath, [cli, '--project', project, ...args], { cwd: project, maxBuffer: 4 * 1024 * 1024 });
  assert.match((await run(['--version'])).stdout, /2\./);
  assert.match((await run(['--help'])).stdout, /work/);
  await run(['init', '--lang', 'ja']); await run(['up', '--no-studio']);
  runtime = await core.RuntimeClient.connect(project, { start: false });
  const created = JSON.parse((await run(['work', 'create', '--title', 'Installed manuscript', '--locale', 'ja', '--review', '{"enabled":false}'])).stdout);
  const saved = JSON.parse((await run(['write', created.id, '--content', 'インストール後の原稿。', '--wait'])).stdout);
  assert.equal(saved.task.state.outcome.status, 'completed');
  const artifactId = saved.task.state.outcome.result.artifactId;
  assert.equal((await runtime.rpc('artifacts.read', { id: artifactId })).content, 'インストール後の原稿。');
  studio = await ui.startStudio(project, { port: 0, host: '127.0.0.1' });
  assert.equal((await fetch(studio.url)).status, 200);
  const status = await runtime.rpc('status'); assert.equal(status.pid, runtime.endpoint.pid); assert.equal(status.works.length, 1);
  assert.equal((await (await fetch(`${studio.url}/api/v1/status`)).json()).pid, status.pid);
  const beforeClose = status.pid; await studio.close(); studio = undefined;
  assert.equal((await runtime.rpc('status')).pid, beforeClose);
  await run(['down']);
  for (let i = 0; i < 100 && await core.RuntimeClient.find(project); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await core.RuntimeClient.find(project), undefined); runtime = undefined;
  console.log('Installed three tarballs: CLI, runtime and Studio start/stop; manuscript persisted; one project owner. PASS');
} finally {
  await studio?.close();
  if (runtime) {
    await runtime.stop().catch(() => {});
    for (let i = 0; i < 100 && await runtime.constructor.find(runtime.endpoint.rootDir); i++) await new Promise(resolve => setTimeout(resolve, 50));
  }
  await rm(temporary, { recursive: true, force: true });
}
