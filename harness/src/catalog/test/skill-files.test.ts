import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDirectorySkillStore, parseSkillFrontmatter, scanSkillRoots } from "../skill-files.js";

describe("parseSkillFrontmatter", () => {
    it("reads a plain name and description", () => {
        expect(parseSkillFrontmatter("---\nname: enrichment\ndescription: Functional enrichment\nversion: 1.0.0\n---\n\n# Enrichment\n")).toEqual({
            ok: true,
            skill: { name: "enrichment", description: "Functional enrichment" },
        });
    });

    it("reads a quoted value whole, a colon included", () => {
        expect(parseSkillFrontmatter('---\nname: "enrichment"\ndescription: "GSEA: ranked lists, and ORA: sets"\n---\n')).toEqual({
            ok: true,
            skill: { name: "enrichment", description: "GSEA: ranked lists, and ORA: sets" },
        });
    });

    it("reads a block value and a folded multi-line value, and trims the description", () => {
        const block = parseSkillFrontmatter("---\nname: enrichment\ndescription: |\n  First line.\n  Second line.\n---\n");
        const folded = parseSkillFrontmatter("---\nname: enrichment\ndescription: >\n  First line\n  continues.\n---\n");
        const plain = parseSkillFrontmatter("---\nname: enrichment\ndescription: First line\n  continues.\n---\n");

        expect(block).toEqual({ ok: true, skill: { name: "enrichment", description: "First line.\nSecond line." } });
        expect(folded).toEqual({ ok: true, skill: { name: "enrichment", description: "First line continues." } });
        expect(plain).toEqual({ ok: true, skill: { name: "enrichment", description: "First line continues." } });
    });

    it("reads a file with Windows line ends", () => {
        expect(parseSkillFrontmatter("---\r\nname: enrichment\r\ndescription: GSEA\r\n---\r\n")).toEqual({
            ok: true,
            skill: { name: "enrichment", description: "GSEA" },
        });
    });

    it("refuses a missing name or description, and an empty one", () => {
        for (const text of ["---\nname: enrichment\n---\n", "---\ndescription: GSEA\n---\n", '---\nname: enrichment\ndescription: ""\n---\n']) {
            expect(parseSkillFrontmatter(text)).toEqual({ ok: false, problem: "missing_name_or_description" });
        }
    });

    it("refuses a file with no frontmatter, and a frontmatter with no end", () => {
        expect(parseSkillFrontmatter("# Body only\n\ndescription: not a field\n")).toEqual({ ok: false, problem: "no_frontmatter" });
        expect(parseSkillFrontmatter("---\nname: enrichment\ndescription: GSEA\n")).toEqual({ ok: false, problem: "no_frontmatter" });
    });

    it("refuses a frontmatter that is not valid YAML", () => {
        expect(parseSkillFrontmatter("---\nname: [enrichment\ndescription: GSEA\n---\n")).toEqual({ ok: false, problem: "invalid_yaml" });
    });
});

describe("createDirectorySkillStore", () => {
    const base = mkdtempSync(join(tmpdir(), "skill-files-"));
    const builtin = join(base, "builtin");
    const user = join(base, "user");
    afterAll(() => rmSync(base, { recursive: true, force: true }));

    function skill(root: string, directory: string, frontmatter: string, files: Record<string, string> = {}): void {
        mkdirSync(join(root, directory), { recursive: true });
        writeFileSync(join(root, directory, "SKILL.md"), frontmatter);
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(join(root, directory, path, ".."), { recursive: true });
            writeFileSync(join(root, directory, path), text);
        }
    }

    skill(builtin, "enrichment", "---\nname: enrichment\ndescription: The built-in enrichment.\n---\n", { "references/api.md": "# API\n", "data.bin": "x" });
    skill(user, "enrichment", "---\nname: enrichment\ndescription: The user enrichment.\n---\n");
    skill(user, "lab-protocols", "---\nname: lab-protocols\ndescription: The protocols of the lab.\n---\n");
    skill(user, "renamed", "---\nname: other-name\ndescription: A skill whose name differs from its directory.\n---\n");
    skill(user, "broken", "# No frontmatter\n");

    const store = createDirectorySkillStore([builtin, user, join(base, "absent")]);

    it("lists only a skill whose name equals its directory, and the earlier root wins on a name collision", async () => {
        expect(await store.list()).toEqual([
            { name: "enrichment", description: "The built-in enrichment." },
            { name: "lab-protocols", description: "The protocols of the lab." },
        ]);
    });

    it("names each problem of a root", async () => {
        const { problems } = await scanSkillRoots([builtin, user]);

        expect(problems).toEqual([
            { kind: "frontmatter", directory: join(user, "broken"), problem: "no_frontmatter" },
            { kind: "name_taken", directory: join(user, "enrichment"), name: "enrichment", by: join(builtin, "enrichment") },
            { kind: "name_mismatch", directory: join(user, "renamed"), name: "other-name" },
        ]);
    });

    it("reads the text files of a skill from the directory of the root that won", async () => {
        expect(await store.files("enrichment")).toEqual(["SKILL.md", "references/api.md"]);
        expect(await store.read("enrichment", "references/api.md")).toBe("# API\n");
        expect(await store.size("enrichment", "references/api.md")).toBe(6);
    });

    it("gives nothing for an unknown skill, a skill that is not listed, a missing file, and a path that leaves the skill", async () => {
        expect(await store.files("absent")).toEqual([]);
        expect(await store.read("other-name", "SKILL.md")).toBeUndefined();
        expect(await store.read("enrichment", "references/missing.md")).toBeUndefined();
        expect(await store.read("enrichment", "../../user/lab-protocols/SKILL.md")).toBeUndefined();
        expect(await store.size("enrichment", "../lab-protocols/SKILL.md")).toBeUndefined();
    });
});
