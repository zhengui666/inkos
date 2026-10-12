import { rm } from "node:fs/promises";
import { resolve } from "node:path";

await rm(resolve(process.cwd(), "dist", process.argv[2] ?? "."), { recursive: true, force: true });
