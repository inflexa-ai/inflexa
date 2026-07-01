import { describe, expect, it } from "bun:test";

import { SANDBOX_AGENT_META } from "./sandbox/index.js";
import { KNOWN_AGENT_IDS, PLANNABLE_AGENT_CATALOG, PLANNABLE_AGENT_IDS, formatAgentCatalog } from "./sandbox-catalog.js";

/**
 * Shape assertions against the harness sandbox catalog. With the catalog
 * derived from `SANDBOX_AGENT_META`, drift between two sources of truth
 * is no longer possible — these tests pin the projection itself.
 */
describe("sandbox-catalog (derived from SANDBOX_AGENT_META)", () => {
    it("PLANNABLE_AGENT_CATALOG omits non-plannable agents", () => {
        const ids = new Set(PLANNABLE_AGENT_CATALOG.map((m) => m.id));
        expect(ids.has("data-profiler")).toBe(false);
        expect(ids.has("scientific-executor")).toBe(false);
        expect(ids.has("ephemeral-executor")).toBe(false);
    });

    it("PLANNABLE_AGENT_CATALOG includes the expected omics specialists", () => {
        const ids = new Set(PLANNABLE_AGENT_CATALOG.map((m) => m.id));
        expect(ids.has("bulk-transcriptomics-agent")).toBe(true);
        expect(ids.has("single-cell-agent")).toBe(true);
        expect(ids.has("cheminformatics-agent")).toBe(true);
        expect(ids.has("drug-repurposing-agent")).toBe(true);
    });

    it("PLANNABLE_AGENT_IDS matches the catalog ids exactly", () => {
        expect([...PLANNABLE_AGENT_IDS].sort()).toEqual(PLANNABLE_AGENT_CATALOG.map((m) => m.id).sort());
    });

    it("KNOWN_AGENT_IDS covers every meta entry", () => {
        expect([...KNOWN_AGENT_IDS].sort()).toEqual(Object.keys(SANDBOX_AGENT_META).sort());
    });

    it("KNOWN_AGENT_IDS is a superset of PLANNABLE_AGENT_IDS (by the non-plannable count)", () => {
        expect(KNOWN_AGENT_IDS.length).toBe(PLANNABLE_AGENT_IDS.length + 3);
    });

    it("formatAgentCatalog renders one line per plannable agent with capabilities + suitable-for", () => {
        const rendered = formatAgentCatalog();
        const lines = rendered.split("\n");
        expect(lines).toHaveLength(PLANNABLE_AGENT_CATALOG.length);
        for (const meta of PLANNABLE_AGENT_CATALOG) {
            expect(rendered).toContain(`**${meta.id}**`);
            expect(rendered).toContain(`capabilities: [${meta.capabilities.join(", ")}]`);
            expect(rendered).toContain(`suitable for: [${meta.suitableFor.join(", ")}]`);
        }
    });
});
