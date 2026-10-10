import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BookRulesSchema } from "../models/book-rules.js";
import { ReaderContractSchema, type ReaderContract } from "../models/reader-contract.js";
import type { ContextPackage } from "../models/input-governance.js";

export const READER_CONTRACT_SOURCE = "story/book_rules.json#readerContract";

/** Old books remain readable and are not retrofitted or rewritten. */
export async function readerContractContext(storyDir: string): Promise<ContextPackage["selectedContext"]> {
  let raw: string;
  try { raw = await readFile(join(storyDir, "book_rules.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return readerContractContextFromRaw(raw);
}

/** Parse captured authority without consulting the current filesystem. */
export function readerContractContextFromRaw(raw: string | null): ContextPackage["selectedContext"] {
  if (raw === null) return [];
  const contract = BookRulesSchema.parse(JSON.parse(raw)).readerContract;
  return contract ? [{ source: READER_CONTRACT_SOURCE, protection: "protected",
    reason: "Durable reader promise and causal rise route. Current author changes override generated plans; these plans are not proof of prose delivery.",
    excerpt: JSON.stringify(contract),
  }] : [];
}

export function contractFromContext(context: ContextPackage): ReaderContract | undefined {
  const entry = context.selectedContext.find(item => item.source === READER_CONTRACT_SOURCE);
  return entry?.excerpt ? ReaderContractSchema.parse(JSON.parse(entry.excerpt)) : undefined;
}
