import { Command } from "commander";
import { Scheduler, SchedulerStore, loadSchedulerPublisher, type SchedulerPublisher } from "@actalk/inkos-core";
import { loadConfig, findProjectRoot, buildPipelineConfig, log, logError } from "../utils.js";
import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const PID_FILE = "inkos.pid";
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function removeOwnedPid(path: string, pid: number): Promise<void> {
  try { if ((await readFile(path, "utf8")).trim() === String(pid)) await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export const upCommand = new Command("up")
  .description("Start the persistent InkOS daemon (writing and configured publication)")
  .option("-q, --quiet", "Suppress console output")
  .option("--work <id...>", "Limit this daemon to selected works; paused works remain paused")
  .option("--publish-config <path>", "Use explicit per-work publisher bindings (or legacy MegaNovel arrays); unknown/manual-only providers fail before writing")
  .action(async (opts) => {
    let logStream: WriteStream | undefined;
    let scheduler: Scheduler | undefined;
    let publisher: SchedulerPublisher | undefined;
    let ownsPid = false;
    const root = findProjectRoot(), pidPath = join(root, PID_FILE);
    try {
      const config = await loadConfig({ requireApiKey: false });
      const publisherConfig = opts.publishConfig ?? config.daemon.publisherConfig;
      publisher = publisherConfig ? await loadSchedulerPublisher(root, publisherConfig) : undefined;
      logStream = createWriteStream(join(root, "inkos.log"), { flags: "a" });
      scheduler = new Scheduler({
        ...buildPipelineConfig(config, root, { logFile: logStream, quiet: opts.quiet }),
        ...config.daemon,
        radarCron: config.daemon.schedule.radarCron,
        writeCron: config.daemon.schedule.writeCron,
        workIds: opts.work ?? config.daemon.workIds,
        publisher,
        onChapterComplete: (bookId, chapter) => log(`  [+] ${bookId} Ch.${chapter}`),
        onError: (bookId, error) => logError(`${bookId}: ${error.message}`),
      });
      let stopping = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        log("Stopping daemon; waiting for in-flight operations to settle...");
        try { await scheduler!.stop(); }
        finally { if (ownsPid) await removeOwnedPid(pidPath, process.pid); logStream?.end(); }
        process.exitCode = 0;
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      // The durable SQLite owner, not a leftover PID file, arbitrates startup.
      await scheduler.start();
      if (stopping) return;
      await writeFile(pidPath, String(process.pid), "utf8");
      ownsPid = true;
      if (stopping) { await removeOwnedPid(pidPath, process.pid); return; }
      log(`Daemon running (PID ${process.pid}); UTC write ${config.daemon.schedule.writeCron}, radar ${config.daemon.schedule.radarCron}.`);
      log(publisher ? "Mode: reviewed writing and remote publication readback." : "Mode: reviewed chapter writing; automatic publication is not configured.");
    } catch (error) {
      if (scheduler) await scheduler.stop();
      else await publisher?.close?.();
      if (ownsPid) await removeOwnedPid(pidPath, process.pid);
      logStream?.end();
      logError(`Failed to start daemon: ${error}`);
      process.exitCode = 1;
    }
  });

export const downCommand = new Command("down")
  .description("Stop the InkOS daemon after its in-flight operations settle")
  .action(async () => {
    const root = findProjectRoot(), pidPath = join(root, PID_FILE);
    const store = new SchedulerStore(join(root, ".inkos", "harness.sqlite"));
    try {
      const owner = store.requestStop();
      if (!owner) {
        try {
          await readFile(pidPath, "utf8");
          log("A legacy PID file exists, but no current ledger owner can confirm that process. No signal was sent.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          log("No daemon owns this project.");
        }
        return;
      }
      const deadline = Date.now() + 30_000;
      while (store.runningOwner()?.token === owner.token && isAlive(owner.pid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (store.runningOwner()?.token === owner.token && isAlive(owner.pid)) {
        log("Stop requested through the project ledger; the daemon is still draining. Its PID file was retained.");
        return;
      }
      await removeOwnedPid(pidPath, owner.pid);
      log(`Daemon (PID ${owner.pid}) stopped.`);
    } catch (error) { logError(String(error)); process.exitCode = 1; }
    finally { store.close(); }
  });

export const daemonStatusCommand = new Command("daemon-status")
  .description("Read durable daemon progress and recent execution evidence")
  .option("--json", "Output JSON")
  .action(opts => {
    const store = new SchedulerStore(join(findProjectRoot(), ".inkos", "harness.sqlite"));
    try { const events = store.events(100); log(opts.json ? JSON.stringify({ events }, null, 2) : events.map(event => `${new Date(event.at).toISOString()} ${event.type} ${JSON.stringify(event.data)}`).join("\n")); }
    finally { store.close(); }
  });
