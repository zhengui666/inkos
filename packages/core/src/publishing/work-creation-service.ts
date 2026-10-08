import { publishingError } from './contracts.js';
import { RemoteWorkStore } from './work-creation-store.js';
import { RemoteWorkDestinationSchema, RemoteWorkReceiptSchema, type RemoteWorkInput, type RemoteWorkRun,
  type RemoteWorkDestination, type RemoteWorkBlocker, type RemoteWorkReceipt } from './work-creation-contracts.js';

export type RemoteWorkObservation = {status: 'found'; receipt: RemoteWorkReceipt}
  | {status: 'not_found' | 'unknown'} | {status: 'blocked'; blocker: RemoteWorkBlocker};
/** Installed trusted adapters only. JSON configuration cannot implement this interface.
 * Scope must serialize the actual account/session and independently verify its identity.
 * inspect/observe are read-only. create includes ALL mutation, including form autosave;
 * it must honor the signal before every write and never accept new agreements itself.
 * A found observation must independently identify this operation, account, exact metadata
 * and actual remote ID. A title match or create response alone is not sufficient proof.
 */
export interface RemoteWorkCreationPort {
  withScope<T>(destination: RemoteWorkDestination, signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  inspect(input: RemoteWorkInput, signal: AbortSignal): Promise<{destination: RemoteWorkDestination; blocker?: RemoteWorkBlocker}>;
  create(run: RemoteWorkRun, signal: AbortSignal): Promise<{remoteBookId?: string}>;
  observe(run: RemoteWorkRun, signal: AbortSignal): Promise<RemoteWorkObservation>;
  close?(): Promise<void>;
}
const uncertain: RemoteWorkBlocker = {status: 'reconciliation_required', code: 'REMOTE_WORK_RECONCILIATION_REQUIRED',
  message: 'Creation may have reached the platform. Only independent readback of this retained operation is allowed; no new book will be created.'};
const unsupported: RemoteWorkBlocker = {status: 'unsupported', code: 'REMOTE_WORK_UNSUPPORTED',
  message: 'This installed adapter has no verified new-book creation and readback contract. Configure an existing remote book through the supported binding flow, or install a verified creation adapter.'};

/** One mutation attempt per Work for its entire lifetime, including crashes and restarts. */
export class RemoteWorkCreationService {
  constructor(private readonly store: RemoteWorkStore, private readonly port?: RemoteWorkCreationPort) {}

  async ensure(input: RemoteWorkInput, signal: AbortSignal, beforeMutation?: () => void | Promise<void>): Promise<RemoteWorkRun> {
    signal.throwIfAborted();
    let run = this.store.reserve(input);
    if (run.phase === 'bound') return run;
    if (run.phase === 'observed') return this.store.bindObserved(run.id, run.version);
    if (!this.port) return this.block(run, unsupported);
    try {
      return await this.port.withScope(run.input.destination, signal, async () => {
        run = this.store.get(run.id);
        if (run.phase === 'bound') return run;
        if (run.phase === 'observed') return this.store.bindObserved(run.id, run.version);
        // Inspection never creates remote drafts or accepts a legal/identity step.
        const check = await this.port!.inspect(run.input, signal);
        if (JSON.stringify(RemoteWorkDestinationSchema.parse(check.destination)) !== JSON.stringify(run.input.destination)) {
          return this.block(run, {status: 'needs_setup', code: 'REMOTE_WORK_ACCOUNT_MISMATCH',
            message: 'The independently observed platform/account/session does not match this frozen destination.'});
        }
        if (check.blocker) return this.block(run, check.blocker);
        signal.throwIfAborted();
        if (run.phase === 'ready') {
          await beforeMutation?.();
          signal.throwIfAborted();
          if (run.blocker) run = this.store.setBlocker(run.id, run.version, null);
          // Commit uncertainty before any remotely autosaving form field or create call.
          run = this.store.beginCreation(run.id, run.version);
          try {
            await beforeMutation?.();
            signal.throwIfAborted();
            const hint = await this.port!.create(run, signal);
            if (hint.remoteBookId !== undefined) run = this.store.recordHint(run.id, run.version, hint.remoteBookId);
          } catch {
            // Never re-issue create. Even a thrown transport error may follow a remote commit.
            run = this.store.get(run.id);
            if (signal.aborted) return this.block(run, uncertain);
          }
        }
        signal.throwIfAborted();
        run = this.store.get(run.id);
        if (run.phase === 'bound') return run;
        if (run.phase === 'observed') return this.store.bindObserved(run.id, run.version);
        const observed = await this.port!.observe(run, signal);
        if (observed.status === 'blocked') return this.block(run, observed.blocker);
        if (observed.status !== 'found') return this.block(run, uncertain);
        run = this.store.recordObserved(run.id, run.version, RemoteWorkReceiptSchema.parse(observed.receipt));
        return this.store.bindObserved(run.id, run.version);
      });
    } catch (error) {
      const current = this.store.get(run.id);
      // Another owner can win a CAS; observing its state must not repeat any mutation.
      if (current.phase === 'bound') return current;
      if ((error as {code?: string}).code === 'REMOTE_WORK_VERSION_CONFLICT') return current;
      if (current.attempts === 1) return this.block(current, uncertain);
      if (signal.aborted) throw error;
      return this.block(current, {status: 'needs_setup', code: 'REMOTE_WORK_INSPECTION_REQUIRED',
        message: 'The selected account/session could not be verified. Restore the existing setup and retry this same operation.'});
    }
  }
  private block(run: RemoteWorkRun, blocker: RemoteWorkBlocker): RemoteWorkRun {
    return this.store.setBlocker(run.id, run.version, blocker);
  }
}

export function requireBoundRemoteWork(run: RemoteWorkRun): asserts run is RemoteWorkRun & {targetId: string; receipt: RemoteWorkReceipt} {
  if (run.phase !== 'bound' || !run.targetId || !run.receipt || run.blocker) {
    throw publishingError(run.blocker?.code ?? 'REMOTE_WORK_RECONCILIATION_REQUIRED',
      run.blocker?.message ?? uncertain.message);
  }
}
