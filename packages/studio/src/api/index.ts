import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudio } from './server.js';

export { startStudio, createStudioApp } from './server.js';

// Safe to import from the CLI: standalone startup only when this file is executed.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.env.INKOS_PROJECT_ROOT ?? process.argv[2] ?? process.cwd());
  const port = Number(process.env.INKOS_STUDIO_PORT ?? 4567);
  const host = process.env.INKOS_STUDIO_HOST ?? '127.0.0.1';
  startStudio(root, { port, host }).then(studio => {
    console.log(`InkOS Studio: ${studio.url}`);
    const close = () => { void studio.close().then(() => process.exit(0)); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }).catch(error => {
    console.error('Studio failed to start:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
