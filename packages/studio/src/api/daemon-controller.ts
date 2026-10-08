import { PublisherStartupCleanupError, Scheduler, type SchedulerConfig } from "@actalk/inkos-core";

type Daemon = Pick<Scheduler, "start" | "stop" | "isRunning">;
type Phase = "stopped" | "starting" | "running" | "stopping" | "failed";

function lifecycleError(message: string, code = "DAEMON_BUSY"): Error {
  return Object.assign(new Error(message), { code });
}

/** Studio owns only its explicitly started daemon, never another CLI/service owner. */
export class StudioDaemonController {
  private instance?: Daemon;
  private phase: Phase = "stopped";
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private pendingPublisher?: SchedulerConfig["publisher"];
  private failedPublisherStartup?: PublisherStartupCleanupError;
  private cleanup?: Promise<void>;
  private stopRequested = false;
  private stopRevision = 0;
  private closing = false;

  constructor(
    private readonly loadConfig: () => Promise<SchedulerConfig>,
    private readonly broadcast: (type: string, data: object) => void,
    private readonly create: (config: SchedulerConfig) => Daemon = config => new Scheduler(config),
  ) {}

  status() {
    if (this.phase === "running" && !this.instance?.isRunning) {
      void this.stop().catch(error => this.broadcast("daemon:error", { bookId: "shutdown", error: String(error) }));
    }
    return { running: this.instance?.isRunning ?? false, phase: this.phase, scope: "studio" as const };
  }

  start(loadConfig = this.loadConfig): Promise<void> {
    // Reserve admission before the first async configuration read.
    if (this.closing) return Promise.reject(lifecycleError("Studio is shutting down.", "STUDIO_SHUTTING_DOWN"));
    if (this.phase === "running" && !this.instance?.isRunning) {
      const stopped = this.stop(), revision = this.stopRevision;
      return stopped.then(() => {
        if (revision !== this.stopRevision) throw lifecycleError("Daemon start was cancelled.", "DAEMON_START_CANCELLED");
        return this.start(loadConfig);
      });
    }
    if (this.phase !== "stopped" || this.starting || this.stopping) return Promise.reject(lifecycleError(`Studio daemon is ${this.phase}.`));
    this.phase = "starting";
    this.stopRequested = false;
    this.cleanup = undefined;
    const start = this.startOnce(loadConfig);
    this.starting = start;
    return start;
  }

  private async startOnce(loadConfig: () => Promise<SchedulerConfig>): Promise<void> {
    try {
      const config = await loadConfig();
      // Loading may open a publisher before cancellation or scheduler construction.
      // Keep ownership here until a successfully constructed scheduler takes it.
      this.pendingPublisher = config.publisher;
      if (this.stopRequested) throw lifecycleError("Daemon start was cancelled.", "DAEMON_START_CANCELLED");
      this.instance = this.create(config);
      this.pendingPublisher = undefined;
      await this.instance.start();
      if (this.stopRequested) throw lifecycleError("Daemon start was cancelled.", "DAEMON_START_CANCELLED");
      this.phase = "running";
      this.broadcast("daemon:started", {});
    } catch (error) {
      if (error instanceof PublisherStartupCleanupError && !this.instance) {
        this.failedPublisherStartup = error;
        this.phase = "failed";
        throw error;
      }
      try {
        await this.cleanupOnce();
        this.phase = this.stopping ? "stopping" : "stopped";
      } catch (cleanupError) {
        this.phase = "failed";
        throw new AggregateError([error, cleanupError], "Daemon startup and cleanup failed.");
      }
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  stop(): Promise<void> {
    this.stopRevision++;
    if (this.stopping) return this.stopping;
    if (this.phase === "stopped") return Promise.resolve();
    // Overlapping Stop observes the startup failure; a later explicit Stop is
    // the retry authority for the retained loader's cleanup-only handle.
    const retryLoaderCleanup = this.phase === "failed" && !this.starting;
    this.stopRequested = true;
    this.phase = "stopping";
    this.stopping = this.stopOnce(retryLoaderCleanup);
    return this.stopping;
  }

  private async stopOnce(retryLoaderCleanup: boolean): Promise<void> {
    try {
      // A stop during configuration must not permit a late background start.
      await this.starting?.catch(() => undefined);
      if (this.failedPublisherStartup) {
        if (!retryLoaderCleanup) throw this.failedPublisherStartup;
        await this.failedPublisherStartup.cleanup.close();
        this.failedPublisherStartup = undefined;
      }
      await this.cleanupOnce();
      this.phase = "stopped";
      this.broadcast("daemon:stopped", {});
    } catch (error) {
      this.phase = "failed";
      throw error;
    } finally {
      this.stopping = undefined;
    }
  }

  private cleanupOnce(): Promise<void> {
    // Share both pending and failed cleanup with stop(). A failed close must not
    // lose its resource handle or be reported stopped by an overlapping request.
    return this.cleanup ??= (async () => {
      if (this.instance) await this.instance.stop();
      else await this.pendingPublisher?.close?.();
      this.instance = undefined;
      this.pendingPublisher = undefined;
    })();
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.stop();
  }
}
