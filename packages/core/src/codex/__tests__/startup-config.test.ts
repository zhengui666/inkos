import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { CODEX_ISOLATED_CONFIG, codexIsolationArgs, createCodexClient, resolveCodexHome } from '../app-server.js';
import { createCodexAccountService } from '../account.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), chmod: vi.fn(actual.chmod),
    writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), rm: vi.fn(actual.rm), readFile: vi.fn(actual.readFile) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
const legacyConfig = () => Object.entries(CODEX_ISOLATED_CONFIG)
  .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n') + '\nmcp_servers = {}\nplugins = {}\n';
// A stdio protocol peer with no filesystem or network calls in its implementation.
const peer = `
const { readSync, writeSync } = require('node:fs');
const buffer = Buffer.alloc(65536);
let pending = '';
for (;;) {
  const count = readSync(0, buffer, 0, buffer.length, null);
  if (!count) break;
  pending += buffer.subarray(0, count).toString();
  let newline;
  while ((newline = pending.indexOf('\\n')) >= 0) {
    const message = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (!('id' in message)) continue;
    const result = message.method === 'account/read'
      ? {account: {type:'chatgpt', email: null, planType:'fixture'}, requiresOpenaiAuth:true}
      : message.method === 'probe' ? {argv:process.argv.slice(1), home:process.env.CODEX_HOME} : {};
    writeSync(1, JSON.stringify({id:message.id, result}) + '\\n');
  }
}
`;
async function fixture(config: string | null = legacyConfig()) {
  const root = await fs.mkdtemp(join(tmpdir(), 'inkos-startup-test-')); roots.push(root);
  const projectRoot = join(root, 'project');
  const stateRoot = join(root, 'state');
  const codexHome = join(stateRoot, 'recorded-legacy-home');
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  if (config !== null) await fs.writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600 });
  await fs.writeFile(join(codexHome, 'auth.json'), 'fixture sentinel, not credentials', { mode: 0o600 });
  const options = { stateRoot, codexHome, command: process.execPath, args: ['--input-type=commonjs', '-e', peer, '--'], requestTimeoutMs: 2000 };
  return { root, projectRoot, stateRoot, codexHome, options };
}
function assertNoStateMutation(stateRoot: string) {
  for (const fn of [fs.mkdir, fs.chmod, fs.writeFile, fs.rename, fs.rm]) {
    for (const args of vi.mocked(fn).mock.calls) {
      expect(args.some(path => typeof path === 'string' && (path === stateRoot || path.startsWith(stateRoot + sep)))).toBe(false);
    }
  }
  expect(vi.mocked(fs.readFile).mock.calls.some(([path]) => /[\\/]auth\.json$/.test(String(path)))).toBe(false);
}
async function snapshot(path: string) {
  const stat = await fs.lstat(path, { bigint: true });
  return { ino: stat.ino, mode: stat.mode, uid: stat.uid, mtime: stat.mtimeNs, ctime: stat.ctimeNs };
}

describe('Codex startup config is process-local', () => {
  it('leaves native model, effort and speed defaults while retaining isolation', () => {
    expect(CODEX_ISOLATED_CONFIG).not.toHaveProperty('model');
    expect(CODEX_ISOLATED_CONFIG).not.toHaveProperty('model_reasoning_effort');
    expect(CODEX_ISOLATED_CONFIG).not.toHaveProperty('service_tier');
    expect(CODEX_ISOLATED_CONFIG).toMatchObject({ 'features.shell_tool': false, web_search: 'disabled' });
    expect(CODEX_ISOLATED_CONFIG).not.toHaveProperty('model_provider');
  });
  it('uses plain project-local homes and gives explicit recorded homes priority', () => {
    vi.stubEnv('INKOS_CODEX_HOME', ''); vi.stubEnv('INKOS_CODEX_STATE_ROOT', '');
    // Remove empty environment overrides rather than treating cwd as a state root.
    delete process.env.INKOS_CODEX_HOME; delete process.env.INKOS_CODEX_STATE_ROOT;
    const one = resolve('/fixture/one'), two = resolve('/fixture/two');
    const stateRoot = resolve('/fixture/old-root'), recordedHome = join(stateRoot, 'recorded-id');
    expect(resolveCodexHome(one)).toBe(join(one, '.inkos', 'codex', 'home'));
    expect(resolveCodexHome(two)).toBe(join(two, '.inkos', 'codex', 'home'));
    vi.stubEnv('INKOS_CODEX_STATE_ROOT', stateRoot);
    expect(resolveCodexHome(one)).toBe(join(stateRoot, 'home'));
    vi.stubEnv('INKOS_CODEX_HOME', recordedHome);
    expect(resolveCodexHome(one)).toBe(recordedHome);
    expect(resolveCodexHome(one, {stateRoot: resolve('/ignored')})).toBe(recordedHome);
    const explicitHome = resolve('/fixture/explicit');
    expect(resolveCodexHome(one, {codexHome: explicitHome})).toBe(explicitHome);
  });
  it('retains existing shared bytes, inode, permissions and directories across account startup/disposal', async () => {
    const f = await fixture();
    const paths = [f.stateRoot, f.codexHome, join(f.codexHome, 'config.toml')];
    const before = await Promise.all(paths.map(snapshot)); const entries = await fs.readdir(f.codexHome);
    vi.clearAllMocks();
    const service = createCodexAccountService({ projectDir: f.projectRoot,
      clientFactory: project => createCodexClient(project, f.options) });
    try { expect((await service.readAccount()).connected).toBe(true); }
    finally { await service.dispose(); }
    assertNoStateMutation(f.stateRoot);
    expect(await Promise.all(paths.map(snapshot))).toEqual(before);
    expect(await fs.readdir(f.codexHome)).toEqual(entries);
    expect(await fs.readFile(join(f.codexHome, 'config.toml'), 'utf8')).toBe(legacyConfig());
  });
  it('passes every isolation setting as an official CLI override for worker peers too', async () => {
    const f = await fixture('features.shell_tool = true\nnotify = ["not-run"]\nmcp_servers = {}\nplugins = {}\n');
    vi.clearAllMocks(); const client = await createCodexClient(f.projectRoot, f.options);
    try {
      const result = await client.request<{ argv: string[]; home: string }>('probe');
      expect(result.argv).toEqual(['app-server', '--listen', 'stdio://', '--strict-config', ...codexIsolationArgs()]);
      expect(result.home).toBe(f.codexHome);
      for (const [key, value] of Object.entries(CODEX_ISOLATED_CONFIG)) expect(result.argv).toContain(`${key}=${JSON.stringify(value)}`);
      expect(result.argv).toContain('features.shell_tool=false'); expect(result.argv).toContain('notify=[]');
    } finally { await client.close(); }
    assertNoStateMutation(f.stateRoot);
  });
  it('does not create config.toml when an existing account directory has no config', async () => {
    const f = await fixture(null); vi.clearAllMocks();
    const client = await createCodexClient(f.projectRoot, f.options); await client.close();
    assertNoStateMutation(f.stateRoot); expect(await fs.readdir(f.codexHome)).toEqual(['auth.json']);
  });
  it('creates a new private project directory without persisting config', async () => {
    const f = await fixture(); const newState = join(f.root, 'new-state'); vi.clearAllMocks();
    const client = await createCodexClient(f.projectRoot, { ...f.options, codexHome: undefined, stateRoot: newState });
    const home = client.codexHome; await client.close(); expect(await fs.readdir(home)).toEqual([]);
    if (process.platform !== 'win32') {
      expect((await fs.stat(home)).mode & 0o777).toBe(0o700); expect((await fs.stat(newState)).mode & 0o777).toBe(0o700);
    }
    expect(fs.chmod).not.toHaveBeenCalled(); expect(fs.writeFile).not.toHaveBeenCalled(); expect(fs.rename).not.toHaveBeenCalled();
  });
  it.each([
    'mcp_servers = { unexpected = { command = "do-not-run" } }\n',
    '[mcp_servers.unexpected]\ncommand = "do-not-run"\n',
    'plugins = { unexpected = { enabled = true } }\n',
    'profile = "custom"\n', 'model_provider = "custom"\n', 'model_instructions_file = "/not-read"\n',
    'features = { shell_tool = true }\n', '"features.shell_tool" = true\n',
    'features.shell_tool = true\nfeatures.shell_tool = false\n',
    'notify = ["x"] # unsupported trailing syntax\n', 'notify = """\ncommands\n"""\n',
    'notify = { nested = "value" }\n', 'notify = [1]\n', '# normal comment\nunknown = true\n',
  ])('rejects unsupported existing config before spawn without modifying state: %s', async config => {
    const f = await fixture(config); vi.clearAllMocks();
    await expect(createCodexClient(f.projectRoot, f.options)).rejects.toThrow('outside the supported Inkos isolation format');
    expect(spawn).not.toHaveBeenCalled(); assertNoStateMutation(f.stateRoot);
    expect(await fs.readFile(join(f.codexHome, 'config.toml'), 'utf8')).toBe(config);
  });
  it.skipIf(process.platform === 'win32')('fails on non-private state instead of repairing existing permissions', async () => {
    const f = await fixture(); await fs.chmod(f.codexHome, 0o755); vi.clearAllMocks();
    await expect(createCodexClient(f.projectRoot, f.options)).rejects.toThrow('will not change existing permissions');
    expect(spawn).not.toHaveBeenCalled(); assertNoStateMutation(f.stateRoot);
    expect((await fs.stat(f.codexHome)).mode & 0o777).toBe(0o755);
  });
  it('keeps concurrent startup and initialization failure from modifying shared state', async () => {
    const f = await fixture(); const before = await snapshot(f.codexHome); vi.clearAllMocks();
    const clients = await Promise.all([createCodexClient(f.projectRoot, f.options), createCodexClient(f.projectRoot, f.options)]);
    await Promise.all(clients.map(client => client.close()));
    const failingPeer = peer.replace('JSON.stringify({id:message.id, result})',
      'JSON.stringify({id:message.id, error:{code:-1,message:"fixture failure"}})');
    await expect(createCodexClient(f.projectRoot, { ...f.options, args: ['-e', failingPeer, '--'] })).rejects.toThrow('initialize failed');
    assertNoStateMutation(f.stateRoot); expect(await snapshot(f.codexHome)).toEqual(before);
  });
  it('preserves the configured environment state namespace without consulting auth', async () => {
    const f = await fixture(); vi.stubEnv('INKOS_CODEX_STATE_ROOT', f.stateRoot); vi.stubEnv('INKOS_CODEX_HOME', f.codexHome); vi.clearAllMocks();
    const client = await createCodexClient(f.projectRoot, { ...f.options, stateRoot: undefined, codexHome: undefined });
    expect(client.codexHome).toBe(f.codexHome); await client.close(); assertNoStateMutation(f.stateRoot);
  });
  it('rejects symlink state directories without following or repairing them', async () => {
    const f = await fixture(); const alias = join(f.root, 'state-alias');
    await fs.symlink(f.stateRoot, alias); vi.clearAllMocks();
    await expect(createCodexClient(f.projectRoot, { ...f.options, stateRoot: alias, codexHome: join(alias, 'recorded-legacy-home') })).rejects.toThrow('symbolic link');
    expect(spawn).not.toHaveBeenCalled(); assertNoStateMutation(f.stateRoot);
    expect(fs.chmod).not.toHaveBeenCalled();
  });
  it('rejects a symlink config without following it', async () => {
    const f = await fixture(null); const target = join(f.root, 'unread-config');
    await fs.writeFile(target, 'unknown = true'); await fs.symlink(target, join(f.codexHome, 'config.toml')); vi.clearAllMocks();
    await expect(createCodexClient(f.projectRoot, f.options)).rejects.toThrow('outside the supported Inkos isolation format');
    expect(fs.readFile).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); assertNoStateMutation(f.stateRoot);
  });
});
