import type { Command } from "commander";
import { integer, jsonObject, nullableNumber, timestamp } from "./utils.js";

export function planOptions(command: Command): Command {
  return command.option("--plan <json>", "Partial WorkPlan JSON", jsonObject)
    .option("--brief <text>", "Creative brief")
    .option("--serial", "Serial work").option("--no-serial", "Standalone work")
    .option("--units <number|null>", "Planned unit count; null for unbounded", value => value === "null" ? "null" : nullableNumber(value))
    .option("--needs-planning", "Request planning").option("--no-needs-planning", "Skip planning")
    .option("--review <json>", "Review policy: id, enabled, maxRevisions, maxCost", jsonObject)
    .option("--production <json>", "Production policy: backlog, cron, nextAt", jsonObject)
    .option("--backlog <number>", "Desired production backlog", integer)
    .option("--cron <expression|null>", "Production cron; null to remove")
    .option("--next-at <time|null>", "Next production time (ISO or epoch ms)", value => value === "null" ? "null" : timestamp(value));
}

export function planFromOptions(options: Record<string, any>): Record<string, any> | undefined {
  const plan = { ...options.plan };
  for (const key of ["brief", "serial", "units", "needsPlanning"]) {
    if (options[key] !== undefined) plan[key] = key === "units" && options[key] === "null" ? null : options[key];
  }
  if (options.review !== undefined) plan.review = { ...plan.review, ...options.review };
  const production = { ...plan.production, ...options.production };
  for (const key of ["backlog", "cron", "nextAt"]) {
    if (options[key] !== undefined) production[key] = options[key] === "null" ? null : options[key];
  }
  if (Object.keys(production).length) plan.production = production;
  return Object.keys(plan).length ? plan : undefined;
}

export function mergePlan(current: Record<string, any>, changes: Record<string, any>): Record<string, any> {
  return { ...current, ...changes,
    ...(changes.review ? { review: { ...current.review, ...changes.review } } : {}),
    ...(changes.production ? { production: { ...current.production, ...changes.production } } : {}),
  };
}
