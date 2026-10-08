type Resource = { close?(): void | Promise<void> };

/** Cleanup only: never retries provider creation, writing, or publication. */
export function createPublisherCleanup(stages: () => readonly (readonly Resource[])[], beforeClose?: () => Promise<unknown>) {
  const completed = new Set<Resource>();
  let requested = false, pending: Promise<void> | undefined;
  return {
    get requested() { return requested; },
    close(): Promise<void> {
      requested = true;
      return pending ??= (async () => {
        await beforeClose?.();
        const errors: unknown[] = [];
        for (const resources of stages()) {
          const results = await Promise.allSettled([...new Set(resources)].map(async resource => {
            if (completed.has(resource)) return;
            await resource.close?.();
            completed.add(resource);
          }));
          for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
        }
        if (errors.length) throw new AggregateError(errors, 'Publisher cleanup failed.');
      })().catch(error => { pending = undefined; throw error; });
    },
  };
}

/** Retains every unfinished resource when a loader cannot return its publisher. */
export class PublisherStartupCleanupError extends AggregateError {
  readonly code = 'PUBLISHING_STARTUP_CLEANUP_FAILED';
  constructor(startupError: unknown, cleanupError: unknown, readonly cleanup: { close(): Promise<void> },
    message = 'Publisher startup and cleanup failed.') {
    super([startupError, cleanupError], message);
    this.name = 'PublisherStartupCleanupError';
  }
}
