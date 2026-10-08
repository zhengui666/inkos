// Synthetic installed-package fixtures only; this is not acceptance of an npm release.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyInstalledStudio } from './verify-installed-studio.mjs';

const verifier = fileURLToPath(new URL('./verify-installed-studio.mjs', import.meta.url));
const releaseVerifier = fileURLToPath(new URL('./verify-installed-release.mjs', import.meta.url));
const html = '<!DOCTYPE html><html><head><link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'><text>Fixture</text></svg>"><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><a href="/settings">Settings</a><div data-src="/assets/ignored.js">Fixture</div></body></html>';

async function fixture(t, mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'inkos-installed-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const studio = join(root, 'node_modules/@actalk/inkos-studio');
  const core = join(root, 'node_modules/@actalk/inkos-core');
  const cli = join(root, 'node_modules/@actalk/inkos');
  const bin = join(cli, 'dist/actual-bin.js');
  const entry = join(studio, 'dist/api/index.js');
  const output = join(root, 'report.json');
  const pageHtml = mode === 'root-asset' ? html.replace('</body>', '<img src="/logo.png"></body>') : html;
  await mkdir(join(studio, 'dist/api'), { recursive: true });
  await mkdir(join(studio, 'dist/assets'));
  await mkdir(join(core, 'dist'), { recursive: true });
  await mkdir(join(cli, 'dist'), { recursive: true });
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@actalk/inkos', version: '2.0.0', type: 'module', bin: { inkos: 'dist/actual-bin.js' } }));
  await writeFile(bin, 'if (process.argv.includes("--version")) console.log("2.0.0"); else throw new Error("Fixture CLI bin must only be resolved, not run");');
  await writeFile(join(studio, 'package.json'), JSON.stringify({ name: '@actalk/inkos-studio', version: '2.0.0', type: 'module', main: 'dist/api/index.js' }));
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@actalk/inkos-core', version: '2.0.0', type: 'module', main: 'dist/index.js',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }));
  await writeFile(join(core, 'dist/index.d.ts'), 'export declare class SchedulerStore {}');
  // The fixture uses JSON instead of SQLite, exposing exactly the scheduling API used by setup.
  await writeFile(join(core, 'dist/index.js'), `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    export class SchedulerStore {
      constructor(path) { this.path = path; this.timers = {}; mkdirSync(dirname(path), { recursive: true }); }
      schedule(name, nextAt) { this.timers[name] = nextAt; }
      close() { writeFileSync(this.path, JSON.stringify(this.timers)); }
    }
  `);
  await writeFile(join(studio, 'dist/index.html'), pageHtml);
  await writeFile(join(studio, 'dist/logo.png'), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(studio, 'dist/assets/app.js'), 'console.log("fixture");');
  await writeFile(join(studio, 'dist/assets/app.css'), 'body { color: black; }');
  await writeFile(entry, `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = process.argv[2];
    const mode = ${JSON.stringify(mode)};
    const config = JSON.parse(readFileSync(join(root, 'inkos.json'), 'utf8'));
    const timers = JSON.parse(readFileSync(join(root, '.inkos/harness.sqlite'), 'utf8'));
    assert.deepEqual(config.daemon.workIds, []);
    assert(timers.write > Date.now() + 3500000 && timers.radar > Date.now() + 3500000);
    assert.equal(process.cwd(), root);
    assert.equal(process.env.HOME, join(root, 'home'));
    assert.equal(process.env.INKOS_STUDIO_HOST, '127.0.0.1');
    assert.deepEqual(Object.keys(process.env).sort(), ['HOME', 'INKOS_STUDIO_HOST', 'INKOS_STUDIO_PORT', 'NO_COLOR', 'PATH'].sort());
    const observed = { entry: process.argv[1], project: root, requests: [], envKeys: Object.keys(process.env).sort() };
    const save = () => writeFileSync(${JSON.stringify(join(root, 'observed.json'))}, JSON.stringify(observed));
    save();
    if (mode === 'early-exit') { console.error('fixture early exit'); process.exit(23); }
    if (mode === 'no-listen') { console.error('fixture refuses to listen'); setInterval(() => {}, 1000); }
    else {
      let running = false;
      const streams = new Set();
      const server = createServer((req, res) => {
        observed.requests.push(req.method + ' ' + req.url); save();
        if (req.url === '/api/v1/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.flushHeaders(); streams.add(res);
          res.on('close', () => streams.delete(res));
          if (mode === 'no-ping') res.write('event: other\\ndata: fixture\\n\\n');
          else { res.write('event: pi'); setTimeout(() => res.write('ng\\ndata: \\n\\n'), 10); }
        } else if (req.url === '/api/v1/daemon' || req.url === '/api/v1/daemon/start') {
          if (req.url.endsWith('/start')) { assert.equal(req.method, 'POST'); running = true; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(mode === 'invalid-json' ? '{broken' : JSON.stringify({ ok: true, running, phase: running ? 'running' : 'stopped', scope: 'studio' }));
        } else if (req.url === '/' || req.url === '/settings') {
          res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
          res.end(mode === 'settings-no-assets' && req.url === '/settings' ? '<html>Missing references</html>' : ${JSON.stringify(pageHtml)});
        } else if (req.url === '/logo.png') {
          res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from([137, 80, 78, 71]));
        } else if (req.url === '/assets/app.js' || req.url === '/assets/app.css') {
          const isCss = req.url.endsWith('.css');
          res.writeHead(mode === 'asset-404' && isCss ? 404 : 200, {
            'content-type': mode === 'asset-mime' && isCss ? 'text/html' : isCss ? 'text/css' : 'application/javascript',
          });
          res.end(isCss ? 'body { color: black; }' : 'console.log("fixture");');
        } else { res.writeHead(500); res.end('Unexpected request'); }
      });
      server.listen(Number(process.env.INKOS_STUDIO_PORT), process.env.INKOS_STUDIO_HOST);
      process.on('SIGTERM', () => {
        observed.sigterm = true; save();
        if (mode === 'sse-open') return;
        for (const stream of streams) stream.end();
        server.close(() => { process.exitCode = mode === 'exit-nonzero' ? 9 : 0; });
        server.closeIdleConnections();
      });
    }
  `);
  return { root, cli, bin, studio, entry, output };
}

async function nestedFixture(t, mode = 'ok', withDecoy = false) {
  const f = await fixture(t, mode);
  const scoped = join(f.cli, 'node_modules/@actalk');
  await mkdir(scoped, { recursive: true });
  const nestedStudio = join(scoped, 'inkos-studio');
  await rename(f.studio, nestedStudio);
  await rename(join(f.root, 'node_modules/@actalk/inkos-core'), join(scoped, 'inkos-core'));
  f.studio = nestedStudio;
  f.entry = join(nestedStudio, 'dist/api/index.js');
  if (withDecoy) {
    const decoy = await fixture(t);
    await rename(decoy.studio, join(f.root, 'node_modules/@actalk/inkos-studio'));
    await rename(join(decoy.root, 'node_modules/@actalk/inkos-core'), join(f.root, 'node_modules/@actalk/inkos-core'));
    f.decoyObserved = join(decoy.root, 'observed.json');
  }
  return f;
}

async function verify(f) {
  const report = await verifyInstalledStudio({ root: f.root, output: f.output, timeoutMs: 1000 });
  assert.deepEqual(JSON.parse(await readFile(f.output, 'utf8')), report);
  if (report.entry) assert.equal(report.entry, f.entry);
  assert.equal(report.steps.at(-1).name, 'cleanup');
  assert.equal(report.steps.at(-1).status, 'passed');
  for (const step of report.steps) {
    if (step.status === 'skipped') {
      assert.equal(step.startedAt, null);
      assert.equal(step.completedAt, null);
      continue;
    }
    assert(!Number.isNaN(Date.parse(step.startedAt)));
    assert(!Number.isNaN(Date.parse(step.completedAt)));
    assert(step.elapsedMs >= 0);
  }
  if (report.port) assert(report.baseUrl.startsWith('http://127.0.0.1:'));
  try {
    const observed = JSON.parse(await readFile(join(f.root, 'observed.json'), 'utf8'));
    await assert.rejects(stat(observed.project), { code: 'ENOENT' });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(!Object.hasOwn(report, 'env'));
  return report;
}

function cli(args, script = verifier) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function verifyRelease(f) {
  const output = join(f.root, 'release-report.json');
  const result = await cli(['--root', f.root, '--version', '2.0.0', '--output', output], releaseVerifier);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.checks.find(check => check.id === 'cli.studio.package').entry, f.entry);
  await assert.rejects(stat(join(f.root, 'observed.json')), { code: 'ENOENT' });
  return report;
}

test('CLI starts the installed entry with isolated HOME, verifies HTTP/SSE, and exits cleanly', async t => {
  const f = await fixture(t);
  const result = await cli(['--root', f.root, '--output', f.output]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const report = JSON.parse(await readFile(f.output, 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.entry, f.entry);
  assert.deepEqual(report.processExit, { code: 0, signal: null });
  assert(report.steps.every(step => step.status === 'passed'));
  const observed = JSON.parse(await readFile(join(f.root, 'observed.json'), 'utf8'));
  assert.equal(observed.entry, f.entry);
  assert.equal(observed.sigterm, true);
  assert.deepEqual(observed.requests, ['GET /', 'GET /settings', 'GET /assets/app.js', 'GET /assets/app.css', 'GET /api/v1/daemon', 'POST /api/v1/daemon/start', 'GET /api/v1/events']);
  await assert.rejects(stat(observed.project), { code: 'ENOENT' });
  assert.equal((await readFile(join(f.studio, 'dist/index.html'), 'utf8')), html);
});

test('CLI-only install resolves and verifies its nested Studio without a top-level Studio', async t => {
  const f = await nestedFixture(t);
  await verifyRelease(f);
  const report = await verify(f);
  assert.equal(report.passed, true, report.error);
  assert.equal(report.entry, f.entry);
});

test('broken nested Studio fails even when a healthy top-level Studio decoy exists', async t => {
  const f = await nestedFixture(t, 'early-exit', true);
  await verifyRelease(f);
  const report = await verify(f);
  assert.equal(report.entry, f.entry);
  assert.equal(report.passed, false);
  assert.deepEqual(report.processExit, { code: 23, signal: null });
  assert.equal(report.steps.find(step => step.status === 'failed').name, 'listening');
  await assert.rejects(stat(f.decoyObserved), { code: 'ENOENT' });
});

test('a resolved Studio entry different from dist/api/index.js fails before launch', async t => {
  const f = await fixture(t);
  await mkdir(join(f.studio, 'runtime'));
  await writeFile(join(f.studio, 'runtime/index.js'), 'throw new Error("Must not launch this alternate entry");');
  const manifestPath = join(f.studio, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.main = 'runtime/index.js';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const report = await verifyInstalledStudio({ root: f.root, output: f.output, timeoutMs: 1000 });
  assert.equal(report.passed, false);
  assert.equal(report.entry, join(f.studio, 'runtime/index.js'));
  assert.match(report.error, /Resolved Studio entry must be dist\/api\/index.js/);
  await assert.rejects(stat(join(f.root, 'observed.json')), { code: 'ENOENT' });
});

test('import-only core resolves in a pnpm-style nested dependency layout', async t => {
  const f = await fixture(t);
  const scoped = join(f.root, 'node_modules/.pnpm/fixture/node_modules/@actalk');
  await mkdir(scoped, { recursive: true });
  await rename(f.studio, join(scoped, 'inkos-studio'));
  await rename(join(f.root, 'node_modules/@actalk/inkos-core'), join(scoped, 'inkos-core'));
  await symlink(join(scoped, 'inkos-studio'), f.studio, 'dir');
  f.entry = await realpath(f.entry);
  const report = await verify(f);
  assert.equal(report.passed, true, report.error);
});

test('direct local assets outside /assets are also fetched and checked', async t => {
  const f = await fixture(t, 'root-asset');
  const report = await verify(f);
  assert.equal(report.passed, true, report.error);
  const asset = report.steps.find(step => step.name === 'asset:/logo.png');
  assert.equal(asset.status, 'passed');
  assert.equal(asset.mime, 'image/png');
  const observed = JSON.parse(await readFile(join(f.root, 'observed.json'), 'utf8'));
  assert(observed.requests.includes('GET /logo.png'));
  assert(!observed.requests.includes('GET /assets/ignored.js'));
});

test('missing compiled core fails before launching the installed entry', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'node_modules/@actalk/inkos-core'), { recursive: true });
  const report = await verify(f);
  assert.equal(report.passed, false);
  assert.match(report.error, /Cannot find package '@actalk\/inkos-core'/);
  await assert.rejects(stat(join(f.root, 'observed.json')), { code: 'ENOENT' });
});

for (const [name, missing] of [['index', 'dist/index.html'], ['entry', 'dist/api/index.js'], ['asset', 'dist/assets/app.css']]) {
  test(`missing ${name} fails before launching or rebuilding`, async t => {
    const f = await fixture(t);
    await rm(join(f.studio, missing));
    const report = await verify(f);
    assert.equal(report.passed, false);
    assert.equal(report.steps.find(step => step.status === 'failed').name, 'installed-files');
    assert.match(report.error, name === 'entry' ? /ERR_MODULE_NOT_FOUND|ENOENT/ : /ENOENT/);
    await assert.rejects(stat(join(f.root, 'observed.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(f.studio, missing)), { code: 'ENOENT' });
  });
}

for (const [mode, failedStep, error] of [
  ['early-exit', 'listening', /exited before listening/],
  ['no-listen', 'listening', /did not listen/],
  ['asset-404', 'asset:/assets/app.css', /HTTP status/],
  ['asset-mime', 'asset:/assets/app.css', /MIME text\/html/],
  ['settings-no-assets', 'html:/settings', /no local JavaScript/],
  ['invalid-json', 'daemon-status', /JSON/],
  ['no-ping', 'sse-ping', /SSE ping timed out/],
  ['sse-open', 'sse-closed', /SSE close after SIGTERM timed out/],
  ['exit-nonzero', 'process-exit', /did not exit cleanly/],
]) {
  test(`${mode} produces a failed report and cleans up the child/project`, async t => {
    const f = await fixture(t, mode);
    const report = await verify(f);
    assert.equal(report.passed, false);
    assert.equal(report.steps.find(step => step.status === 'failed').name, failedStep);
    assert.match(report.error, error);
    assert(report.processExit);
    if (mode === 'early-exit') {
      assert.deepEqual(report.processExit, { code: 23, signal: null });
      assert.match(report.stderrTail, /fixture early exit/);
    }
    if (mode === 'no-listen' || mode === 'no-ping' || mode === 'sse-open') assert.equal(report.processExit.signal, 'SIGKILL');
  });
}

test('existing output is preserved and no child is launched', async t => {
  const f = await fixture(t);
  await writeFile(f.output, 'existing evidence\n');
  await assert.rejects(verifyInstalledStudio({ root: f.root, output: f.output }), { code: 'EEXIST' });
  const result = await cli(['--output', f.output, '--root', f.root]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /EEXIST/);
  assert.equal(await readFile(f.output, 'utf8'), 'existing evidence\n');
  await assert.rejects(stat(join(f.root, 'observed.json')), { code: 'ENOENT' });
});

test('missing installed package writes a failed report without ancestor/source fallback', async t => {
  const f = await fixture(t);
  await rm(join(f.root, 'node_modules'), { recursive: true });
  const report = await verify(f);
  assert.equal(report.passed, false);
  assert.match(report.error, /Cannot find package '@actalk\/inkos'/);
});

test('invalid CLI flags fail before creating output', async t => {
  const f = await fixture(t);
  const result = await cli(['--root', f.root, '--unknown', f.output]);
  assert.equal(result.code, 1);
  await assert.rejects(stat(f.output), { code: 'ENOENT' });
});
