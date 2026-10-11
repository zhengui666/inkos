import type { Api, Model } from '@mariozechner/pi-ai';
import { Agent as CodexAgent, type CodexAgentOptions } from '../codex/agent.js';
import { resolveCodexModel } from '../codex/model.js';
import { RuntimeAuthenticationError } from './auth/codex-owner.js';
import { currentRuntimeRun } from './run-context.js';

export interface RuntimeAgent {
  readonly state: CodexAgent['state'];
  readonly finalOutput?: string;
  readonly modelError?: Error & { code: string };
  subscribe: CodexAgent['subscribe'];
  prompt: CodexAgent['prompt'];
  continue: CodexAgent['continue'];
  abort(): void;
  clearAllQueues?(): void;
}
export function resolveRuntimeModel(): Model<Api> {
  const run = currentRuntimeRun();
  if (!run) throw new RuntimeAuthenticationError('No admitted runtime context');
  if (run.harnessId !== 'pi') return resolveCodexModel({ model: run.selection.modelId });
  // Common host metadata only. The Pi adapter resolves the real model again from its own runtime.
  return structuredClone(run.runtime.resolveModel(run.selection.modelId)) as unknown as Model<Api>;
}
export async function createRuntimeAgent(options: CodexAgentOptions): Promise<RuntimeAgent> {
  const run = currentRuntimeRun();
  if (!run) throw new RuntimeAuthenticationError('No admitted runtime context');
  if (run.harnessId !== 'pi') return new CodexAgent(options);
  await run.guard(options.signal);
  const { PiAgent } = await import('./adapters/pi/provider.js');
  const agent = new PiAgent(options);
  await run.guard(options.signal);
  return agent;
}
