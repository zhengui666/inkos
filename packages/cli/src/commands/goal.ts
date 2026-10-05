import { Command } from "commander";
import { ChapterGoalService, chapterGoalView as report, PipelineRunner, type GoalEvent } from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError } from "../utils.js";

type Options = { readonly json?: boolean; readonly work?: string };
type VersionOptions = Options & { readonly version: string };
type CreateOptions = Options & {
  readonly work: string; readonly from: string; readonly to: string; readonly intent: string;
  readonly deadline: string; readonly words?: string; readonly attempts: string; readonly run?: boolean;
};

function integer(value: string, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw Object.assign(new Error(`${flag} must be a safe integer of at least ${minimum}.`), { code: "GOAL_INVALID_ARGUMENT" });
  }
  return parsed;
}

function deadline(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const parsed = Date.parse(value);
  // Date.parse normalizes dates such as February 30; reject those typos too.
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!match || !Number.isFinite(parsed) || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3]) || Number(match[4]) > 23
    || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) {
    throw Object.assign(new Error("--deadline must be an absolute ISO date and time with a timezone, e.g. 2026-10-04T18:00:00+08:00."), {
      code: "GOAL_INVALID_ARGUMENT",
    });
  }
  return parsed;
}

function reportEvent(event: GoalEvent) {
  const { token: _token, ...payload } = event.payload;
  return { ...event, payload };
}

async function execute(options: Options, task: (service: ChapterGoalService) => Promise<unknown> | unknown): Promise<void> {
  let service: ChapterGoalService | undefined;
  try {
    const projectRoot = findProjectRoot();
    service = new ChapterGoalService({
      projectRoot,
      createPipeline: async () => {
        const config = await loadConfig({ requireApiKey: false, projectRoot });
        return new PipelineRunner(buildPipelineConfig(config, projectRoot, { quiet: Boolean(options.json) }));
      },
    });
    const result = await task(service);
    log(JSON.stringify(result, null, options.json ? undefined : 2));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const failure = { error: error instanceof Error ? error.message : String(error),
      code: typeof code === "string" ? code : "GOAL_COMMAND_FAILED" };
    if (options.json) log(JSON.stringify(failure)); else logError(failure.error);
    process.exitCode ||= 1;
  } finally {
    service?.close();
  }
}

async function runForeground(service: ChapterGoalService, id: string, version: number, workId?: string) {
  const controller = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    if (controller.signal.aborted) return;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(Object.assign(new Error(`Goal run interrupted by ${signal}.`), { code: "GOAL_INTERRUPTED" }));
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const goal = await service.run(id, version, { signal: controller.signal, workId });
    if (["ready", "failed", "interrupted", "reconciliation_required", "waiting_user"].includes(goal.status)) process.exitCode ||= 1;
    return report(goal);
  } finally {
    // The service drains adapter work before returning; never exit or close its
    // store while a writer is still cleaning up after an interrupt.
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

export function createGoalCommand(): Command {
  const command = new Command("goal").description("Manage persistent chapter goals; run executes in the foreground until it stops");

  command.command("create").description("Save a bounded chapter goal; --run also starts its foreground execution")
    .argument("<goal-id>")
    .requiredOption("--work <id>", "Work ID")
    .requiredOption("--from <n>", "First chapter number")
    .requiredOption("--to <n>", "Last chapter number")
    .requiredOption("--intent <text>", "Writing goal and creative direction")
    .requiredOption("--deadline <iso>", "Absolute ISO date and time with timezone")
    .option("--words <n>", "Target words per chapter")
    .option("--attempts <n>", "Maximum attempts per chapter", "3")
    .option("--run", "Start the saved goal and wait for it to stop")
    .option("--json", "Output JSON")
    .action((id: string, options: CreateOptions) => execute(options, async service => {
      const goal = await service.create({
        id, workId: options.work, intent: options.intent,
        startChapter: integer(options.from, "--from", 1), endChapter: integer(options.to, "--to", 1),
        expiresAt: deadline(options.deadline), maxAttemptsPerChapter: integer(options.attempts, "--attempts", 1),
        ...(options.words === undefined ? {} : { wordCount: integer(options.words, "--words", 1) }),
      });
      return options.run ? runForeground(service, goal.id, goal.version, options.work) : report(goal);
    }));

  command.command("show").argument("<goal-id>")
    .option("--work <id>", "Require this Work ID").option("--json", "Output JSON")
    .action((id: string, options: Options) => execute(options, service => report(service.get(id, options.work))));

  command.command("list").option("--work <id>", "Filter by Work ID").option("--json", "Output JSON")
    .action((options: Options) => execute(options, service => service.list(options.work).map(report)));

  command.command("events").argument("<goal-id>")
    .option("--work <id>", "Require this Work ID")
    .option("--after <seq>", "Return events after this sequence number", "-1")
    .option("--limit <n>", "Maximum number of events to return", "100")
    .option("--json", "Output JSON")
    .action((id: string, options: Options & { after: string; limit: string }) => execute(options, service => {
      const result = service.events(id, { workId: options.work,
        afterSeq: integer(options.after, "--after", -1), limit: integer(options.limit, "--limit", 1) });
      return { ...result, events: result.events.map(reportEvent) };
    }));

  command.command("run").description("Run a goal in this process; Ctrl-C interrupts after cleanup")
    .argument("<goal-id>").requiredOption("--version <n>", "Current goal version from show")
    .option("--work <id>", "Require this Work ID").option("--json", "Output JSON")
    .action((id: string, options: VersionOptions) => execute(options, service =>
      runForeground(service, id, integer(options.version, "--version", 0), options.work)));

  for (const [name, desired] of [["pause", "paused"], ["cancel", "cancelled"]] as const) {
    command.command(name).description(`Request ${desired}; an active writer stops after cleanup`)
      .argument("<goal-id>").requiredOption("--version <n>", "Current goal version from show")
      .option("--work <id>", "Require this Work ID").option("--json", "Output JSON")
      .action((id: string, options: VersionOptions) => execute(options, service =>
        report(service.stop(id, desired, integer(options.version, "--version", 0), options.work))));
  }

  command.command("recover").description("Reconcile an exited executor's ownership; does not start writing")
    .argument("<goal-id>").requiredOption("--version <n>", "Current goal version from show")
    .option("--work <id>", "Require this Work ID").option("--json", "Output JSON")
    .action((id: string, options: VersionOptions) => execute(options, service =>
      report(service.recover(id, integer(options.version, "--version", 0), options.work))));

  return command;
}
