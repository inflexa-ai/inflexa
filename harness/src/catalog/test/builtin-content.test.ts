/**
 * The CI check of the built-in content. A released install does not check its content at boot, thus a defect of a
 * built-in skill or of a default attachment must fail here.
 */

import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { CONNECTORS } from "../../connectors/registry.js";
import { BUILTIN_AGENTS } from "../builtins.js";
import { scanSkillRoots } from "../skill-files.js";

const SKILLS_ROOT = join(import.meta.dir, "..", "..", "..", "..", "skills");

describe("the built-in content", () => {
    it("gives each skill directory a SKILL.md whose name equals the directory", async () => {
        const { skills, problems } = await scanSkillRoots([SKILLS_ROOT]);
        expect(problems).toEqual([]);
        const directories = (await readdir(SKILLS_ROOT, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
        expect(skills.map((skill) => skill.name).sort()).toEqual(directories.sort());
    });

    it("attaches only built-in skills that exist", async () => {
        const { skills } = await scanSkillRoots([SKILLS_ROOT]);
        const names = new Set(skills.map((skill) => skill.name));
        const missing = BUILTIN_AGENTS.flatMap((agent) => agent.defaults.skills.filter((skill) => !names.has(skill)).map((skill) => `${agent.id}: ${skill}`));
        expect(missing).toEqual([]);
    });

    it("attaches only connectors that exist", () => {
        const missing = BUILTIN_AGENTS.flatMap((agent) => agent.defaults.connectors.filter((id) => !CONNECTORS.has(id)).map((id) => `${agent.id}: ${id}`));
        expect(missing).toEqual([]);
    });

    it("gives each built-in executor at least one default connector", () => {
        const empty = BUILTIN_AGENTS.filter((agent) => agent.role === "executor" && agent.defaults.connectors.length === 0).map((agent) => agent.id);
        expect(empty).toEqual([]);
    });
});
