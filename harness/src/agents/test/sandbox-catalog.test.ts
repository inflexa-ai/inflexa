import { describe, expect, it } from "bun:test";

import { builtinAgent } from "../../catalog/builtins.js";
import { createInMemoryCatalog } from "../../catalog/memory.js";
import { resolveCatalog } from "../../catalog/resolve.js";
import type { AgentCatalog } from "../../catalog/types.js";
import { formatAgentCatalog, plannerCatalogOf } from "../sandbox-catalog.js";

async function plannerCatalog(catalog: AgentCatalog = createInMemoryCatalog()) {
    return plannerCatalogOf(await resolveCatalog(catalog));
}

/** Shape assertions against the planner catalog, which the resolved agent catalog derives. */
describe("plannerCatalogOf", () => {
    it("plans on the analyst and the drug analyst, and never on the profiler", async () => {
        expect((await plannerCatalog()).map((meta) => meta.id).sort()).toEqual(["analyst", "drug-analyst"]);
    });

    it("lists each enabled executor: a custom executor joins, and a disabled built-in leaves", async () => {
        const catalog = createInMemoryCatalog({
            agents: [
                { kind: "builtin", id: "drug-analyst", enabled: false, add: {}, remove: {} },
                {
                    kind: "custom",
                    enabled: true,
                    definition: {
                        id: "lipid-analyst",
                        name: "Lipid analyst",
                        role: "executor",
                        description: "Lipidomics.",
                        prompt: "You analyze lipids.",
                        connectors: ["pubmed"],
                        mcp: [],
                        skills: [],
                    },
                },
            ],
        });

        const planned = await plannerCatalog(catalog);
        expect(planned.map((meta) => meta.id)).toEqual(["analyst", "lipid-analyst"]);
        expect(planned.at(-1)).toEqual({ id: "lipid-analyst", description: "Lipidomics.", liveSources: ["PubMed"] });
    });

    it("formatAgentCatalog renders one line per plannable agent with its description", async () => {
        const catalog = await plannerCatalog();
        const rendered = formatAgentCatalog(catalog);
        expect(rendered.split("\n")).toHaveLength(catalog.length);
        for (const meta of catalog) {
            expect(rendered).toContain(`- **${meta.id}**: ${meta.description}`);
        }
        expect(formatAgentCatalog([{ id: "a", description: "Does a.", liveSources: [] }])).toBe("- **a**: Does a.");
    });

    it("names the databases that an agent queries at run time, thus the planner asks no staged copy of them", async () => {
        const rendered = formatAgentCatalog(await plannerCatalog());
        const lineOf = (id: string) => rendered.split("\n").find((line) => line.startsWith(`- **${id}**`));

        expect(lineOf("drug-analyst")).toContain("ChEMBL");
        expect(lineOf("drug-analyst")).toContain("DGIdb, DrugBank, and PharmGKB");
        expect(lineOf("analyst")).toContain("gnomAD");
        expect(lineOf("analyst")).toContain("InterPro");
        expect(lineOf("analyst")).toContain("HumanBase tissue networks");
    });

    it("keeps the drug, safety, and trial connectors off the analyst", () => {
        const analyst = new Set(builtinAgent("analyst").defaults.connectors);
        for (const connector of ["chembl", "pubchem", "opentargets", "faers", "clinical-trials", "regulatory-approvals", "target-safety", "comptox"]) {
            expect(analyst.has(connector), connector).toBe(false);
            expect(builtinAgent("drug-analyst").defaults.connectors, connector).toContain(connector);
        }
    });
});
