import { Scheduler, type SchedulerConfig } from "@actalk/inkos-core";

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
  private stopRequested = false;
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

  start(): Promise<void> {
    // Reserve admission before the first async configuration read.
    if (this.phase === "running" && !this.instance?.isRunning) return this.stop().then(() => this.start());
    if (this.closing) return Promise.reject(lifecycleError("Studio is shutting down.", "STUDIO_SHUTTING_DOWN"));
    if (this.phase !== "stopped") return Promise.reject(lifecycleError(`Studio daemon is ${this.phase}.`));
    this.phase = "starting";
    this.stopRequested = false;
    const start = this.startOnce();
    this.starting = start;
    return start;
  }

  private async startOnce(): Promise<void> {
    try {
      const config = await this.loadConfig();
      if (this.stopRequested) throw lifecycleError("Daemon start was cancelled.", "DAEMON_START_CANCELLED");
      this.instance = this.create(config);
      await this.instance.start();
      if (this.stopRequested) throw lifecycleError("Daemon start was cancelled.", "DAEMON_START_CANCELLED");
      this.phase = "running";
      this.broadcast("daemon:started", {});
    } catch (error) {
      try {
        await this.instance?.stop();
        this.instance = undefined;
        this.phase = "stopped";
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
    if (this.stopping) return this.stopping;
    if (this.phase === "stopped") return Promise.resolve();
    this.stopRequested = true;
    this.phase = "stopping";
    this.stopping = this.stopOnce();
    return this.stopping;
  }

  private async stopOnce(): Promise<void> {
    try {
      // A stop during configuration must not permit a late background start.
      await this.starting?.catch(() => undefined);
      await this.instance?.stop();
      this.instance = undefined;
      this.phase = "stopped";
      this.broadcast("daemon:stopped", {});
    } catch (error) {
      this.phase = "failed";
      throw error;
    } finally {
      this.stopping = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.stop();
  }
}
