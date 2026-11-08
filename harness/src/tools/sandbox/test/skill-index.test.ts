import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillIndex } from "../skills.js";

const dir = mkdtempSync(join(tmpdir(), "skill-index-"));

function skill(name: string, text: string): void {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), text);
}

skill("enrichment", "---\nname: enrichment\ndescription: Functional enrichment with GSEA and ORA\nversion: 1.0.0\n---\n\n# Enrichment\n");
skill("no-description", "---\nname: no-description\n---\n\n# Body\n");
skill("no-frontmatter", "# Body only\n\ndescription: not a field\n");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("skillIndex", () => {
    it("gives one entry for each declared skill, with the description of its frontmatter", () => {
        const index = skillIndex(dir, ["enrichment", "no-description", "no-frontmatter", "absent"]);

        expect(index).toContain("## Your Skills");
        expect(index).toContain("- `enrichment`: Functional enrichment with GSEA and ORA");
        expect(index).toContain("- `no-description`\n");
        expect(index).toContain("- `no-frontmatter`\n");
        expect(index?.endsWith("- `absent`")).toBe(true);
    });

    it("gives no section for an agent with no skills", () => {
        expect(skillIndex(dir, [])).toBeUndefined();
    });

    it("gives the same text for the same skills", () => {
        expect(skillIndex(dir, ["enrichment"])).toBe(skillIndex(dir, ["enrichment"]));
    });
});
