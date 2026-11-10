import { describe, expect, it } from "bun:test";

import { SANDBOX_AGENT_META } from "../sandbox/index.js";
import { KNOWN_AGENT_IDS, PLANNABLE_AGENT_CATALOG, PLANNABLE_AGENT_IDS, formatAgentCatalog } from "../sandbox-catalog.js";

/**
 * Shape assertions against the harness sandbox catalog. With the catalog
 * derived from `SANDBOX_AGENT_META`, drift between two sources of truth
 * is no longer possible — these tests pin the projection itself.
 */
describe("sandbox-catalog (derived from SANDBOX_AGENT_META)", () => {
    it("plans on the analyst and the drug analyst, and never on the profiler", () => {
        expect([...PLANNABLE_AGENT_IDS].sort()).toEqual(["analyst", "drug-analyst"]);
        expect([...KNOWN_AGENT_IDS].sort()).toEqual(["analyst", "data-profiler", "drug-analyst"]);
    });

    it("KNOWN_AGENT_IDS covers every meta entry", () => {
        expect([...KNOWN_AGENT_IDS].sort()).toEqual(Object.keys(SANDBOX_AGENT_META).sort());
    });

    it("formatAgentCatalog renders one line per plannable agent with its description", () => {
        const rendered = formatAgentCatalog();
        expect(rendered.split("\n")).toHaveLength(PLANNABLE_AGENT_CATALOG.length);
        for (const meta of PLANNABLE_AGENT_CATALOG) {
            expect(rendered).toContain(`- **${meta.id}**: ${meta.description}`);
        }
        expect(formatAgentCatalog([{ id: "a", description: "Does a.", liveSources: [] }])).toBe("- **a**: Does a.");
    });

    it("names the databases that an agent queries at run time, thus the planner asks no staged copy of them", () => {
        const lineOf = (id: string) =>
            formatAgentCatalog()
                .split("\n")
                .find((line) => line.startsWith(`- **${id}**`));

        expect(lineOf("drug-analyst")).toContain("ChEMBL");
        expect(lineOf("drug-analyst")).toContain("DGIdb, DrugBank, and PharmGKB");
        expect(lineOf("analyst")).toContain("gnomAD");
        expect(lineOf("analyst")).toContain("InterPro");
        expect(lineOf("analyst")).toContain("HumanBase tissue networks");
    });

    it("keeps the drug, safety, and trial lookups off the analyst", () => {
        const analystTools = new Set(SANDBOX_AGENT_META.analyst?.tools);
        for (const tool of [
            "chembl",
            "pubchem",
            "opentargets",
            "searchFaers",
            "searchClinicalTrials",
            "searchRegulatoryApprovals",
            "targetSafety",
            "comptox",
        ] as const) {
            expect(analystTools.has(tool), tool).toBe(false);
            expect(SANDBOX_AGENT_META["drug-analyst"]?.tools, tool).toContain(tool);
        }
    });
});
