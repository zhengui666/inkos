import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLinkedSkillResources } from "../agent/skill-tool.js";
import { builtInWorkProfiles } from "../harness/builtin-profiles.js";
import { loadBuiltinAgentSkills } from "../skills/builtin-loader.js";

const sourceRoot = fileURLToPath(new URL("../../skills/", import.meta.url));

// Source-runtime probes are independent of the synthetic command fixtures and tarball verification.
describe("builtin skill resource contract", () => {
  it("loads the entire source catalog and satisfies every builtin profile", async () => {
    const catalog = await loadBuiltinAgentSkills();
    expect(catalog.diagnostics).toEqual([]);
    const ids = catalog.skills.map(skill => skill.id).sort();
    expect(ids).toHaveLength(20);
    expect(ids).toEqual((await readdir(sourceRoot)).sort());
    for (const profile of builtInWorkProfiles()) {
      for (const id of profile.requiredSkillIds) expect(ids, `Profile ${profile.id}`).toContain(id);
    }
    let referenceCount = 0;
    for (const skill of catalog.skills) {
      const paths = [...new Set([...skill.body.matchAll(/`((?:references|examples)\/[^`\n]+)`|\[[^\]\n]*\]\(((?:references|examples)\/[^)\n]+)\)/g)]
        .map(match => match[1] ?? match[2]!).filter(path => /\.(?:md|txt)$/i.test(path)))].sort();
      const resources = await loadLinkedSkillResources(skill);
      expect(resources.map(resource => resource.path).sort(), skill.id).toEqual(paths);
      for (const resource of resources) {
        const raw = await readFile(join(skill.baseDir!, resource.path), "utf8");
        expect(resource).toMatchObject({ body: raw, charStart: 0, charEnd: raw.length });
        referenceCount++;
      }
    }
    expect(referenceCount).toBe(14);
  });

  it("fails honestly when a linked resource is deleted from an isolated copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-packaged-skill-deletion-"));
    try {
      const skillsRoot = join(root, "skills");
      await cp(sourceRoot, skillsRoot, { recursive: true });
      const before = await loadBuiltinAgentSkills(skillsRoot);
      const skill = before.skills.find(item => item.id === "inkos-long-writing")!;
      expect(await loadLinkedSkillResources(skill)).toHaveLength(5);
      await rm(join(skill.baseDir!, "references", "foundation-design.md"));
      const after = await loadBuiltinAgentSkills(skillsRoot);
      expect(after.diagnostics).toEqual([]);
      const deleted = after.skills.find(item => item.id === skill.id)!;
      await expect(loadLinkedSkillResources(deleted)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
