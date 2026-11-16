import { describe, expect, it } from "bun:test";

import { skillIndex } from "../skills.js";

const listed = [
    { name: "enrichment", description: "Functional enrichment with GSEA and ORA" },
    { name: "no-description", description: "" },
    { name: "padded", description: "  Spatial omics.\n" },
];

describe("skillIndex", () => {
    it("gives one entry for each attached skill, with the description that the store lists", () => {
        const index = skillIndex(listed, ["enrichment", "no-description", "padded", "absent"]);

        expect(index).toContain("## Your Skills");
        expect(index).toContain("- `enrichment`: Functional enrichment with GSEA and ORA");
        expect(index).toContain("- `no-description`\n");
        expect(index).toContain("- `padded`: Spatial omics.\n");
        expect(index?.endsWith("- `absent`")).toBe(true);
    });

    it("lists only the attached skills, in the order of the attachment", () => {
        const index = skillIndex(listed, ["padded", "enrichment"]) ?? "";

        expect(index).not.toContain("no-description");
        expect(index.indexOf("`padded`")).toBeLessThan(index.indexOf("`enrichment`"));
    });

    it("gives no section for an agent with no skills", () => {
        expect(skillIndex(listed, [])).toBeUndefined();
    });

    it("gives the same text for the same skills", () => {
        expect(skillIndex(listed, ["enrichment"])).toBe(skillIndex(listed, ["enrichment"]));
    });
});
