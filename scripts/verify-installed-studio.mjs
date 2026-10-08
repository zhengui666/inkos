// Installed-package smoke test. Never builds, installs, or invokes an agent/provider.
// Usage: node scripts/verify-installed-studio.mjs --root <fresh-install-root> --output <new-json>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstalledPackage } from './verify-installed-release.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mimeTypes = {
  '.js': ['application/javascript', 'text/javascript'],
  '.mjs': ['application/javascript', 'text/javascript'],
  '.css': ['text/css'], '.svg': ['image/svg+xml'], '.png': ['image/png'],
  '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.gif': ['image/gif'],
  '.webp': ['image/webp'], '.ico': ['image/x-icon', 'image/vnd.microsoft.icon'],
  '.json': ['application/json'], '.woff': ['font/woff'], '.woff2': ['font/woff2'],
};

async function timed(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function requireFile(path) {
  assert((await stat(path)).isFile(), `Not a file: ${path}`);
}

// Vite's index references are ordinary src/href attributes; never follow remote URLs.
function assetsIn(html, pageUrl) {
  const base = new URL(pageUrl);
  const assets = new Set();
  for (const tag of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<([a-z][a-z0-9:-]*)(?:[^'">]|"[^"]*"|'[^']*')*>/gi)) {
    for (const attr of tag[0].matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      if (/^\s+href/i.test(attr[0]) && tag[1].toLowerCase() !== 'link') continue;
      const url = new URL((attr[1] ?? attr[2] ?? attr[3]).replaceAll('&amp;', '&'), base);
      if (url.origin === base.origin) {
        assets.add(url.pathname + url.search);
      }
    }
  }
  const list = [...assets];
  assert(list.some(path => /\.m?js$/i.test(new URL(path, base).pathname)), 'HTML has no local JavaScript reference');
  assert(list.some(path => /\.css$/i.test(new URL(path, base).pathname)), 'HTML has no local CSS reference');
  return list;
}

async function randomPort() {
  const listener = createServer();
  try {
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    return listener.address().port;
  } finally {
    if (listener.listening) await new Promise(resolve => listener.close(resolve));
  }
}

async function portOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Port probe timed out')); });
  });
}

function launch(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, stderr: '', exit: null };
  child.stdout.resume();
  child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-4096); });
  state.closed = new Promise(resolve => {
    child.once('error', error => {
      state.exit = { code: null, signal: null, error: error.message };
      resolve(state.exit);
    });
    child.once('exit', (code, signal) => { state.exit = { code, signal }; });
    child.once('close', (code, signal) => {
      state.exit ??= { code, signal };
      resolve(state.exit);
    });
  });
  return state;
}

export async function verifyInstalledStudio({ root, output, timeoutMs = 10000 }) {
  root = resolve(root);
  output = resolve(output);
  // Reserve before doing any work. Existing evidence (including symlinks) is never overwritten.
  const outputFile = await open(output, 'wx', 0o600);
  const skipped = name => ({ name, status: 'skipped', startedAt: null, completedAt: null, elapsedMs: 0 });
  const report = { passed: false, root, entry: null, startedAt: new Date().toISOString(),
    steps: ['installed-files', 'temporary-project', 'listening', 'html:/', 'html:/settings',
      'daemon-status', 'daemon-start', 'sse-ping', 'sigterm', 'sse-closed', 'process-exit', 'port-closed', 'cleanup'].map(skipped) };
  const children = [];
  let temporaryRoot, studio, reader, sseAbort, childEnv;
  const step = async (name, run) => {
    const result = report.steps.find(item => item.name === name);
    Object.assign(result, { status: 'running', startedAt: new Date().toISOString() });
    const before = Date.now();
    try {
      Object.assign(result, await run(), { status: 'passed' });
    } catch (error) {
      Object.assign(result, { status: 'failed', error: error.message });
      throw error;
    } finally {
      result.completedAt = new Date().toISOString();
      result.elapsedMs = Date.now() - before;
    }
  };
  const request = (path, options = {}) => fetch(`${report.baseUrl}${path}`, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  });
  let indexAssets, dist, coreEntry;
  try {
    await step('installed-files', async () => {
      // Resolution runs in an empty HOME too; no parent configuration is inherited.
      temporaryRoot = await mkdtemp(join(tmpdir(), 'inkos-installed-studio-'));
      await mkdir(join(temporaryRoot, 'home'));
      childEnv = { PATH: process.env.PATH ?? '', HOME: join(temporaryRoot, 'home'),
        INKOS_STUDIO_PORT: '0', INKOS_STUDIO_HOST: '127.0.0.1', NO_COLOR: '1' };
      const childOptions = { env: childEnv, cwd: temporaryRoot, timeout: timeoutMs, maxBuffer: 1024 * 1024 };
      const cli = resolveInstalledPackage({ root, specifier: '@actalk/inkos/package.json',
        parent: join(root, 'release-probe.mjs'), name: '@actalk/inkos', childOptions });
      const declaredBin = typeof cli.manifest.bin === 'string' ? cli.manifest.bin : cli.manifest.bin?.inkos;
      assert(typeof declaredBin === 'string' && declaredBin, 'CLI has no declared inkos bin');
      const binPath = resolve(cli.dir, declaredBin);
      const binRelative = relative(cli.dir, binPath);
      assert(binRelative !== '..' && !binRelative.startsWith('..' + sep) && !isAbsolute(binRelative), 'CLI bin escapes its package');
      report.cliBin = await realpath(binPath);
      const actualBinRelative = relative(cli.dir, report.cliBin);
      assert(actualBinRelative !== '..' && !actualBinRelative.startsWith('..' + sep) && !isAbsolute(actualBinRelative), 'CLI bin escapes its package');
      await requireFile(report.cliBin);
      const installedStudio = resolveInstalledPackage({ root, specifier: '@actalk/inkos-studio',
        parent: report.cliBin, name: '@actalk/inkos-studio', childOptions });
      report.entry = installedStudio.entry;
      assert.equal(report.entry, await realpath(join(installedStudio.dir, 'dist/api/index.js')), 'Resolved Studio entry must be dist/api/index.js');
      await requireFile(report.entry);
      dist = join(installedStudio.dir, 'dist');
      await requireFile(join(dist, 'index.html'));
      assert((await stat(join(dist, 'assets'))).isDirectory(), 'Missing dist/assets directory');
      indexAssets = assetsIn(await readFile(join(dist, 'index.html'), 'utf8'), 'http://127.0.0.1/');
      report.steps.splice(5, 0, ...indexAssets.map(asset => skipped(`asset:${asset}`)));
      for (const asset of indexAssets) {
        const file = resolve(dist, '.' + decodeURIComponent(new URL(asset, 'http://127.0.0.1').pathname));
        const rel = relative(dist, file);
        assert(rel !== '..' && !rel.startsWith('..' + sep), `Asset outside dist: ${asset}`);
        await requireFile(file);
      }
      const installedCore = resolveInstalledPackage({ root, specifier: '@actalk/inkos-core',
        parent: report.entry, name: '@actalk/inkos-core', childOptions });
      coreEntry = installedCore.entry;
      report.coreEntry = coreEntry;
      return { assets: indexAssets };
    });
    await step('temporary-project', async () => {
      await writeFile(join(temporaryRoot, 'inkos.json'), JSON.stringify({
        name: 'installed-studio-verification', version: '0.1.0', language: 'en',
        llm: { provider: 'openai', model: 'test-no-agent-run' },
        daemon: { workIds: [], schedule: { writeCron: '*/15 * * * *', radarCron: '0 */6 * * *' } },
      }));
      report.port = await randomPort();
      report.baseUrl = `http://127.0.0.1:${report.port}`;
      childEnv.INKOS_STUDIO_PORT = String(report.port);
      const seed = launch(['--input-type=module', '-e', `
        import { pathToFileURL } from 'node:url';
        const { SchedulerStore } = await import(pathToFileURL(${JSON.stringify(coreEntry)}).href);
        const store = new SchedulerStore(${JSON.stringify(join(temporaryRoot, '.inkos/harness.sqlite'))});
        try { store.schedule('write', Date.now() + 3600000); store.schedule('radar', Date.now() + 3600000); }
        finally { store.close(); }
      `], temporaryRoot, childEnv);
      children.push(seed);
      assert.deepEqual(await timed(seed.closed, timeoutMs, 'Schedule setup'), { code: 0, signal: null }, 'Schedule setup failed');
      // Run the installed standalone entry itself, with the new project as its argument.
      studio = launch([report.entry, temporaryRoot], temporaryRoot, childEnv);
      children.push(studio);
      return { workIds: [], schedulesSeeded: ['write', 'radar'] };
    });
    await step('listening', async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        assert(!studio.exit, `Installed entry exited before listening: ${JSON.stringify(studio.exit)}`);
        if (await portOpen(report.port)) return {};
        await sleep(50);
      }
      throw new Error('Installed entry did not listen on the loopback port');
    });
    for (const path of ['/', '/settings']) {
      await step(`html:${path}`, async () => {
        const response = await request(path);
        assert.equal(response.status, 200, `${path} HTTP status`);
        assert.equal(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), 'text/html', `${path} MIME`);
        const html = await response.text();
        assert.match(html, /<!doctype\s+html|<html\b/i, `${path} is not HTML`);
        const assets = assetsIn(html, `${report.baseUrl}${path}`);
        for (const asset of indexAssets) assert(assets.includes(asset), `${path} is missing index asset ${asset}`);
        return { httpStatus: response.status, assets };
      });
    }
    for (const asset of indexAssets) {
      await step(`asset:${asset}`, async () => {
        const response = await request(asset);
        assert.equal(response.status, 200, `${asset} HTTP status`);
        const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        const expected = mimeTypes[extname(new URL(asset, report.baseUrl).pathname).toLowerCase()];
        assert(expected?.includes(mime), `${asset} MIME ${mime}; expected ${expected?.join(' or ') ?? 'known asset type'}`);
        const body = await response.arrayBuffer();
        assert(body.byteLength > 0, `Empty asset: ${asset}`);
        return { httpStatus: response.status, mime, bytes: body.byteLength };
      });
    }
    await step('daemon-status', async () => {
      const response = await request('/api/v1/daemon');
      assert.equal(response.status, 200, 'Daemon HTTP status');
      assert.equal(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), 'application/json', 'Daemon MIME');
      const status = await response.json();
      assert(status && typeof status.running === 'boolean' && typeof status.phase === 'string' && status.scope === 'studio', 'Invalid daemon status JSON');
      return { httpStatus: response.status, daemon: status };
    });
    await step('daemon-start', async () => {
      const response = await request('/api/v1/daemon/start', { method: 'POST' });
      assert.equal(response.status, 200, 'Daemon start HTTP status');
      const status = await response.json();
      assert(status.ok === true && status.running === true && status.phase === 'running', 'Daemon did not start');
      return { httpStatus: response.status };
    });
    await step('sse-ping', async () => {
      sseAbort = new AbortController();
      const response = await timed(fetch(`${report.baseUrl}/api/v1/events`, {
        redirect: 'error', signal: sseAbort.signal,
      }), timeoutMs, 'SSE headers');
      assert.equal(response.status, 200, 'SSE HTTP status');
      assert.equal(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), 'text/event-stream', 'SSE MIME');
      reader = response.body.getReader();
      await timed((async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const chunk = await reader.read();
          assert(!chunk.done, 'SSE ended before ping');
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.split(/\r?\n\r?\n/).slice(0, -1).some(frame => /^event:\s*ping\s*$/m.test(frame))) break;
          assert(buffer.length < 65536, 'SSE did not contain a ping');
        }
      })(), timeoutMs, 'SSE ping');
      return { httpStatus: response.status, pingReceived: true };
    });
    await step('sigterm', async () => {
      assert(!studio.exit, 'Installed entry exited before SIGTERM');
      assert(studio.child.kill('SIGTERM'), 'Could not send SIGTERM');
      return {};
    });
    await step('sse-closed', async () => {
      await timed((async () => { while (!(await reader.read()).done) { /* Drain to real EOF. */ } })(), timeoutMs, 'SSE close after SIGTERM');
      return { sseClosed: true };
    });
    await step('process-exit', async () => {
      const exit = await timed(studio.closed, timeoutMs, 'Exit after SIGTERM');
      assert.deepEqual(exit, { code: 0, signal: null }, 'Installed entry did not exit cleanly');
      return { exit };
    });
    await step('port-closed', async () => {
      assert.equal(await portOpen(report.port), false, 'Loopback port is still open');
      return { portClosed: true };
    });
    report.passed = true;
  } catch (error) {
    report.error = error.message;
  } finally {
    await step('cleanup', async () => {
      sseAbort?.abort();
      const stopped = await Promise.allSettled(children.map(async child => {
        if (!child.exit) child.child.kill('SIGKILL');
        await timed(child.closed, 2000, 'Child cleanup');
      }));
      for (const result of stopped) if (result.status === 'rejected') throw result.reason;
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      return { temporaryDirectoryRemoved: Boolean(temporaryRoot) };
    }).catch(error => { report.passed = false; report.error ??= error.message; });
    report.processExit = studio?.exit ?? null;
    report.stderrTail = children.map(child => child.stderr).filter(Boolean).join('\n').slice(-4096);
    report.completedAt = new Date().toISOString();
    report.elapsedMs = Date.parse(report.completedAt) - Date.parse(report.startedAt);
    try { await outputFile.writeFile(JSON.stringify(report, null, 2) + '\n'); }
    finally { await outputFile.close(); }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 4, 'Usage: node scripts/verify-installed-studio.mjs --root <fresh-install-root> --output <new-json>');
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      assert(['--root', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && !options[args[i].slice(2)], 'Expected one --root and one --output');
      options[args[i].slice(2)] = args[i + 1];
    }
    assert(options.root && options.output, 'Expected --root and --output');
    const report = await verifyInstalledStudio(options);
    console.log(JSON.stringify({ passed: report.passed, output: resolve(options.output) }));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
