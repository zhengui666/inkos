import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createCodexClient } from '../app-server.js';

/** Keep fixture overrides in the same CLI scope as process-local isolation.
 * Clap replaces a global Append vector when it also occurs after a subcommand;
 * flags before `app-server` would otherwise lose the credential-free provider.
 * Production isolation and authentication checks remain unchanged. */
export async function createLoopbackCodexClient(root: string, fixtureOverrides: readonly string[]) {
  const allowed = new Set(['features.enable_request_compression', 'features.code_mode_host',
    'model_provider', 'model', 'model_providers.fixture', 'model_context_window', 'model_auto_compact_token_limit']);
  const seen = new Set<string>();
  for (let index = 0; index < fixtureOverrides.length; index += 2) {
    const value = fixtureOverrides[index + 1];
    const equals = value?.indexOf('=') ?? -1;
    const key = value && equals > 0 ? value.slice(0, equals).trim() : undefined;
    if (fixtureOverrides[index] !== '-c' || !value || !key || !allowed.has(key) || seen.has(key)) {
      throw new Error('Native fixture requires unique known loopback config overrides');
    }
    seen.add(key);
  }
  const provider = fixtureOverrides.find(value => value.startsWith('model_providers.fixture='));
  const expectedUrl = provider?.match(/base_url="(http:\/\/127\.0\.0\.1:\d+\/v1)"/)?.[1];
  if (!fixtureOverrides.includes('model_provider="fixture"')
    || !provider || !expectedUrl
    || !provider.includes('requires_openai_auth=false')) {
    throw new Error('Native fixture requires a credential-free loopback provider');
  }
  const packageRoot = dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json'));
  const codexScript = join(packageRoot, 'bin', 'codex.js');
  const launcherRoot = await mkdtemp(join(root, 'loopback-launcher-'));
  const launcher = join(launcherRoot, 'launch.mjs');
  await writeFile(launcher, [
    "import { pathToFileURL } from 'node:url';",
    `const script = ${JSON.stringify(codexScript)};`,
    `process.argv = [process.execPath, script, ...process.argv.slice(2), ...${JSON.stringify(fixtureOverrides)}];`,
    'await import(pathToFileURL(script).href);',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  const client = await createCodexClient(root, {
    stateRoot: join(root, 'state'), codexHome: join(root, 'state', 'home'),
    command: process.execPath, args: [launcher],
  });
  try {
    const loaded = await client.request<{ config: {
      model_provider?: string; model_providers?: { fixture?: { base_url?: string; requires_openai_auth?: boolean } };
    } }>('config/read', { includeLayers: false });
    const effective = loaded.config.model_providers?.fixture;
    if (loaded.config.model_provider !== 'fixture' || effective?.base_url !== expectedUrl
      || effective.requires_openai_auth !== false) {
      throw new Error('Native fixture effective configuration must retain its exact credential-free loopback endpoint');
    }
    const account = await client.request<{ requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false });
    if (account.requiresOpenaiAuth !== false) throw new Error('Native loopback provider unexpectedly requires authentication');
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
