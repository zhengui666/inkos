/** A test timeout rejects Vitest's waiter, but does not settle the async test body. */
export class DrainedTestScope {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  readonly signal: AbortSignal;

  constructor(signal?: AbortSignal) {
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const work = Promise.resolve().then(() => {
      this.signal.throwIfAborted();
      return task(this.signal);
    });
    this.pending.add(work);
    // Observe both outcomes without creating a detached rejected promise.
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  async drain(): Promise<void> {
    this.controller.abort(new Error("Test fixture is closing."));
    // Keep mocks, SQLite handles and files alive until even uncooperative I/O
    // and the surrounding test body have settled. Never race cleanup with them.
    await Promise.allSettled([...this.pending]);
  }
}
