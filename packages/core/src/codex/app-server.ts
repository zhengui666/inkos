import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Dynamic tools are experimental, so the runtime and protocol are deliberately pinned. */
export const CODEX_APP_SERVER_VERSION = '0.159.2';
export type CodexNotificationListener = (method: string, params: unknown) => void;
export type CodexRequestListener = (method: string, params: unknown) => unknown | Promise<unknown>;
export interface CodexRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface CodexClient {
  readonly cwd: string;
  readonly codexHome: string;
  readonly closed: boolean;
  request<T = unknown>(method: string, params?: unknown, options?: CodexRequestOptions): Promise<T>;
  onNotification(listener: CodexNotificationListener): () => void;
  /** Return undefined for unhandled requests. The first other result is sent as the response. */
  onRequest(listener: CodexRequestListener): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}
export interface CodexClientOptions {
  /** Trusted deployment override, never accepted from model output or HTTP request data. */
  command?: string;
  args?: string[];
  stateRoot?: string;
  requestTimeoutMs?: number;
}

/** Verified against openai/codex rust-v0.159.2/config.schema.json. No API-key/provider override. */
export const CODEX_ISOLATED_CONFIG: Readonly<Record<string, string | number | boolean | string[]>> = Object.freeze({
  approval_policy: 'never', sandbox_mode: 'read-only', forced_login_method: 'chatgpt',
  cli_auth_credentials_store: 'file', project_doc_max_bytes: 0,
  project_doc_fallback_filenames: [], web_search: 'disabled', notify: [],
  allow_login_shell: false, 'shell_environment_policy.inherit': 'none',
  'analytics.enabled': false, 'feedback.enabled': false,
  'skills.bundled.enabled': false, 'skills.include_instructions': false,
  'features.skip_host_skill_discovery': true,
  'features.shell_tool': false, 'features.unified_exec': false,
  'features.shell_snapshot': false, 'features.shell_snapshot_v2': false,
  'features.apply_patch_freeform': false, 'features.view_image': false,
  'features.apps': false, 'features.connectors': false, 'features.plugins': false,
  'features.remote_plugin': false, 'features.recommended_plugins': false,
  'features.hooks': false, 'features.plugin_hooks': false,
  'features.memories': false, 'features.memory_tool': false,
  'features.multi_agent': false, 'features.multi_agent_v2': false,
  'features.browser_use': false, 'features.browser_use_external': false,
  'features.computer_use': false, 'features.image_generation': false,
  'features.code_mode': false,
  // Code-mode-only catalog models still route Inkos tools through functions.exec.
  // Enable its isolated JS dispatcher, never a native filesystem/shell environment.
  'features.code_mode_host': true,
  'features.js_repl': false, 'features.tool_search': false,
  'features.tool_suggest': false, 'features.skill_search': false,
  'features.skill_mcp_dependency_install': false,
  'features.skill_env_var_dependency_prompt': false,
  'features.request_permissions': false, 'features.request_permissions_tool': false,
  'features.default_mode_request_user_input': false, 'features.goals': false,
  'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false,
  'agents.enabled': false, 'apps._default.enabled': false,
});

export class CodexRpcError extends Error {
  constructor(public readonly code: number, public readonly method: string) {
    // Never copy raw provider errors/data into browser-facing errors: they can contain credentials.
    super(`Codex request ${method} failed (RPC ${code})`);
    this.name = 'CodexRpcError';
  }
}

/** Environment allowlist: never forward developer authentication, hooks, or endpoint overrides. */
export function createCodexEnvironment(home: string, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_STATE_HOME = join(home, '.local', 'state');
  env.TMPDIR = join(home, 'tmp');
  return env;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Codex state directory must not be a symbolic link');
  await chmod(path, 0o700);
}

async function launchCommand(options: CodexClientOptions): Promise<{ command: string; args: string[] }> {
  if (options.command) return { command: options.command, args: options.args ?? [] };
  try {
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve('@openai/codex/package.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
    if (pkg.version !== CODEX_APP_SERVER_VERSION) throw new Error('Incompatible runtime version');
    return { command: process.execPath, args: [join(dirname(packagePath), 'bin', 'codex.js')] };
  } catch (error) {
    throw new Error(`Install the pinned @openai/codex@${CODEX_APP_SERVER_VERSION} dependency before connecting Codex`, { cause: error });
  }
}

export async function createCodexClient(projectRoot: string, options: CodexClientOptions = {}): Promise<CodexClient> {
  const command = await launchCommand(options);
  const projectId = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 24);
  const stateRoot = options.stateRoot ?? process.env.INKOS_CODEX_STATE_ROOT ?? join(homedir(), '.inkos', 'codex');
  await privateDirectory(stateRoot);
  const codexHome = join(stateRoot, projectId);
  await privateDirectory(codexHome);
  const workspace = await mkdtemp(join(tmpdir(), 'inkos-codex-'));
  const cwd = join(workspace, 'work');
  const home = join(workspace, 'home');
  await Promise.all([privateDirectory(cwd), privateDirectory(join(home, 'tmp'))]);
  const config = Object.entries(CODEX_ISOLATED_CONFIG).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
  try {
    // Config is owned by Inkos. Codex alone owns its sibling auth.json, which Inkos never reads.
    const configTemp = join(codexHome, `config.${randomUUID()}.tmp`);
    try {
      await writeFile(configTemp, `${config}\nmcp_servers = {}\nplugins = {}\n`, { mode: 0o600, flag: 'wx' });
      await rename(configTemp, join(codexHome, 'config.toml'));
    } finally { await rm(configTemp, { force: true }); }
    const child = spawn(command.command, [...command.args, 'app-server', '--listen', 'stdio://', '--strict-config'], {
      cwd, env: createCodexEnvironment(home, codexHome), stdio: 'pipe', windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const client = new StdioCodexClient(child, cwd, codexHome, () => rm(workspace, { recursive: true, force: true }), options.requestTimeoutMs);
    try {
      await client.request('initialize', {
        clientInfo: { name: 'inkos', title: 'Inkos', version: '2.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      client.notify('initialized', {});
      return client;
    } catch (error) { await client.close(); throw error; }
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

type Pending = { method: string; resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };
/** Exported for deterministic transport tests; production callers use createCodexClient. */
export class StdioCodexClient implements CodexClient {
  private nextId = 0;
  private buffer = '';
  private pending = new Map<string | number, Pending>();
  private notifications = new Set<CodexNotificationListener>();
  private requests = new Set<CodexRequestListener>();
  private closeListeners = new Set<() => void>();
  private closePromise?: Promise<void>;
  private exitPromise: Promise<void>;
  private failReason?: Error;
  private ended = false;
  get closed(): boolean { return this.ended; }

  constructor(private child: ChildProcessWithoutNullStreams, readonly cwd: string, readonly codexHome: string,
    private cleanup: () => Promise<unknown> = async () => undefined, private timeoutMs = 60_000) {
    this.exitPromise = new Promise(resolveExit => {
      child.once('close', () => { this.fail(new Error('Codex app-server closed')); resolveExit(); this.closeInBackground(); });
      child.once('error', () => { this.fail(new Error('Could not start Codex app-server')); resolveExit(); this.closeInBackground(); });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stdin.on('error', () => { this.fail(new Error('Codex app-server input stream failed')); this.closeInBackground(); });
    child.stdout.on('error', () => { this.fail(new Error('Codex app-server output stream failed')); this.closeInBackground(); });
    // Drain diagnostic output without storing or exposing account/token-containing logs.
    child.stderr.resume();
  }

  request<T = unknown>(method: string, params: unknown = {}, options: CodexRequestOptions = {}): Promise<T> {
    if (this.ended) return Promise.reject(this.failReason ?? new Error('Codex app-server is closed'));
    if (options.signal?.aborted) return Promise.reject(new Error('Codex request cancelled'));
    const id = ++this.nextId;
    return new Promise<T>((resolveResult, reject) => {
      const cancel = () => finish(new Error('Codex request cancelled'));
      const timer = setTimeout(() => finish(new Error(`Codex request ${method} timed out`)), options.timeoutMs ?? this.timeoutMs);
      const finish = (error: Error) => { const item = this.pending.get(id); if (item) { this.pending.delete(id); item.cleanup(); reject(error); } };
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
      this.pending.set(id, { method, resolve: value => resolveResult(value as T), reject, cleanup });
      options.signal?.addEventListener('abort', cancel, { once: true });
      try { this.write({ id, method, params }); } catch { finish(new Error('Could not send Codex request')); }
    });
  }

  notify(method: string, params: unknown): void { this.write({ method, params }); }
  onNotification(listener: CodexNotificationListener): () => void { this.notifications.add(listener); return () => this.notifications.delete(listener); }
  onRequest(listener: CodexRequestListener): () => void { this.requests.add(listener); return () => this.requests.delete(listener); }
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    if (this.ended) queueMicrotask(() => {
      if (this.closeListeners.delete(listener)) { try { listener(); } catch { /* Isolate subscriber failures. */ } }
    });
    return () => this.closeListeners.delete(listener);
  }

  private write(payload: unknown): void {
    if (this.ended || !this.child.stdin.writable) throw new Error('Codex app-server is closed');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error('Codex protocol frame is too large')); this.closeInBackground(); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.dispatch(JSON.parse(line)); }
      catch { this.fail(new Error('Invalid Codex app-server response')); this.closeInBackground(); return; }
    }
  }

  private dispatch(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid protocol object');
    const message = value as Record<string, unknown>;
    const id = message.id;
    if (typeof message.method === 'string') {
      if (typeof id === 'string' || typeof id === 'number') void this.handleRequest(id, message.method, message.params);
      else for (const listener of this.notifications) { try { Promise.resolve(listener(message.method, message.params)).catch(() => undefined); } catch { /* Isolate subscriber failures. */ } }
      return;
    }
    if (typeof id !== 'string' && typeof id !== 'number') throw new Error('Missing response ID');
    const pending = this.pending.get(id);
    if (!pending) return; // Late response after cancellation/timeout.
    this.pending.delete(id); pending.cleanup();
    if (message.error) {
      const error = message.error as { code?: number };
      pending.reject(new CodexRpcError(typeof error.code === 'number' ? error.code : -32603, pending.method));
    } else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('Malformed Codex RPC response'));
  }

  private async handleRequest(id: string | number, method: string, params: unknown): Promise<void> {
    try {
      for (const listener of this.requests) {
        const result = await listener(method, params);
        if (result !== undefined) { this.write({ id, result }); return; }
      }
      this.write({ id, error: { code: -32601, message: 'This capability is not exposed by Inkos' } });
    } catch {
      if (!this.ended) this.write({ id, error: { code: -32603, message: 'Inkos tool handler failed' } });
    }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true; this.failReason = error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.closeListeners) { try { listener(); } catch { /* Isolate subscriber failures. */ } }
    this.closeListeners.clear();
  }

  private closeInBackground(): void {
    // The caller still observes cleanup failures when it awaits close(); prevent
    // an unhandled rejection when the transport dies before that caller resumes.
    queueMicrotask(() => { void this.close().catch(() => undefined); });
  }

  close(): Promise<void> {
    this.closePromise ??= this.shutdown();
    return this.closePromise;
  }

  private kill(signal: NodeJS.Signals): void {
    try {
      if (this.child.pid && process.platform !== 'win32') process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.child.kill(signal);
    }
  }

  private async shutdown(): Promise<void> {
    this.fail(new Error('Codex app-server was closed'));
    this.child.stdin.end(); this.kill('SIGTERM');
    const timer = setTimeout(() => this.kill('SIGKILL'), 1000);
    try { await this.exitPromise; } finally {
      clearTimeout(timer); this.notifications.clear(); this.requests.clear(); await this.cleanup();
    }
  }
}
