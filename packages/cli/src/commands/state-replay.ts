import { Command } from "commander";
import { readFile, mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  prepareStateReplay, commitStateReplay, stateReplayPlanId,
  PipelineRunner, WriterAgent, StateValidatorAgent,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, log, logError, resolveBookId, resolveCliProfileSkills } from "../utils.js";

export const stateReplayCommand = new Command("replay-state")
  .description("Replay unchanged existing prose into state in isolation, then explicitly commit the reviewed plan")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--baseline <n>", "Explicitly verified canonical/snapshot baseline chapter (dry-run only)")
  .option("--dry-run", "Settle and validate in temporary storage; write no live state (uses configured models)")
  .option("--commit", "Commit a previously verified dry-run plan without model calls")
  .requiredOption("--plan <path>", "Plan JSON path; dry-run creates a new file")
  .option("--expect-plan <id>", "Optional selected plan ID (commit only)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      if (Boolean(opts.dryRun) === Boolean(opts.commit)) throw new Error("Choose exactly one of --dry-run or --commit.");
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const planPath = resolve(opts.plan);
      if (opts.commit) {
        if (opts.baseline !== undefined) throw new Error("Commit uses the baseline and actual source text retained in the plan.");
        const plan = JSON.parse(await readFile(planPath, "utf8"));
        if (plan.bookId !== bookId) throw new Error("The selected book does not match the plan.");
        const result = await commitStateReplay({ projectRoot: root, plan, expectedPlanId: opts.expectPlan });
        log(opts.json ? JSON.stringify(result, null, 2) : `Committed derived state for ${bookId}: ${result.baselineChapter} → ${result.targetChapter}. Chapter prose unchanged.`);
        return;
      }
      if (!/^\d+$/.test(opts.baseline ?? "") || opts.expectPlan !== undefined) throw new Error("Dry-run requires --baseline <n>; --expect-plan is only for commit.");
      // Check output availability before making model calls. Never truncate an existing file.
      await mkdir(dirname(planPath), { recursive: true });
      const output = await open(planPath, "wx", 0o600);
      let written = false;
      try {
        const config = await loadConfig({ requireApiKey: false });
        const activatedSkills = await resolveCliProfileSkills(root, "longform-novel", { includeRecommended: true });
        const pipeline = new PipelineRunner(buildPipelineConfig(config, root));
        const plan = await prepareStateReplay({ projectRoot: root, bookId, baselineChapter: Number(opts.baseline), 
          createWorkers: isolatedRoot => {
            return {
              writer: new WriterAgent({ ...pipeline.createAgentContext("writer", bookId), projectRoot: isolatedRoot, runtimeProjectRoot: root, activatedSkills }),
              validator: new StateValidatorAgent({ ...pipeline.createAgentContext("state-validator", bookId), projectRoot: isolatedRoot, runtimeProjectRoot: root, activatedSkills }),
            };
          },
        });
        await output.writeFile(`${JSON.stringify(plan, null, 2)}\n`);
        await output.sync();
        written = true;
        const result = { committed: false, bookId, baselineChapter: plan.baselineChapter, targetChapter: plan.targetChapter,
          planId: stateReplayPlanId(plan), planPath };
        log(opts.json ? JSON.stringify(result, null, 2) : `Dry-run validated ${bookId}: ${plan.baselineChapter} → ${plan.targetChapter}. No live state changed.\nPlan: ${planPath}\nPlan ID: ${result.planId}`);
      } finally {
        await output.close();
        if (!written) await rm(planPath, { force: true });
      }
    } catch (error) {
      const failure = { code: (error as { code?: string }).code ?? "STATE_REPLAY_ERROR", error: String(error), details: (error as { details?: unknown }).details };
      if (opts.json) log(JSON.stringify(failure)); else logError(failure.error);
      process.exitCode = 1;
    }
  });
