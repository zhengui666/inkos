import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntimeService } from '@actalk/inkos-core';
import { startStudio } from '../src/api/server.js';

const root = process.env.INKOS_E2E_ROOT ?? await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'inkos-studio-ui-'));
await mkdir(root, { recursive: true });
// Isolate native credential discovery. No account, model or site is used by this suite.
for (const key of Object.keys(process.env)) if (/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN)$/u.test(key) || /^(?:AWS_|GOOGLE_|GCLOUD_|AZURE_|ANTHROPIC_|OPENAI_|GEMINI_|VERTEX_)/u.test(key)) delete process.env[key];
process.env.HOME = root;
process.env.XDG_CONFIG_HOME = join(root, '.config');
await writeFile(join(root, 'research.md'), '# Offline research\n\nKyoto archive: a handwritten letter beneath the maple tree.\n');
const runtime = await startRuntimeService(root);
const studio = await startStudio(root, { port: Number(process.env.INKOS_STUDIO_PORT ?? 4580) });
console.log(`Studio test project: ${root}\nStudio test URL: ${studio.url}`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await studio.close();
  await runtime.close();
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
