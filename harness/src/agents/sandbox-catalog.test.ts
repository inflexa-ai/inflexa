import { describe, expect, it } from "bun:test";

import { REFERENCE_DATA_CATALOG } from "../reference-data/catalog.js";
import { SANDBOX_AGENT_META } from "./sandbox/index.js";
import {
    KNOWN_AGENT_IDS,
    PLANNABLE_AGENT_CATALOG,
    PLANNABLE_AGENT_IDS,
    capabilityDataRequirement,
    declaredDataRequirements,
    formatAgentCatalog,
} from "./sandbox-catalog.js";

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
        expect(KNOWN_AGENT_IDS.length).toBe(PLANNABLE_AGENT_IDS.length + 2);
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

/**
 * The data requirement of a capability is content that no typechecker reads: an id is a string and
 * a capability phrase is a string. These pin both against their own sources, so a renamed dataset
 * or a reworded phrase breaks the build instead of a run that already paid for its sandbox.
 */
describe("capability data requirements", () => {
    const declared = declaredDataRequirements();

    it("names a dataset the reference catalog holds", () => {
        const ids = new Set(REFERENCE_DATA_CATALOG.datasets.map((dataset) => dataset.id));
        for (const requirement of declared) {
            for (const dataset of requirement.datasets) {
                expect(ids.has(dataset), `${requirement.agentId} declares the unknown dataset ${dataset}`).toBe(true);
            }
        }
    });

    it("names a capability its own agent advertises", () => {
        for (const requirement of declared) {
            const capabilities = SANDBOX_AGENT_META[requirement.agentId]?.capabilities ?? [];
            expect(capabilities, `${requirement.agentId} declares a requirement for a phrase it does not advertise`).toContain(requirement.capability);
        }
    });

    it("declares only an opt-in dataset, because a default store already holds a recommended one", () => {
        const recommended = new Set(REFERENCE_DATA_CATALOG.datasets.filter((dataset) => dataset.recommendation.recommended).map((dataset) => dataset.id));
        for (const requirement of declared) {
            for (const dataset of requirement.datasets) {
                expect(recommended.has(dataset), `${dataset} is recommended, so declaring it would refuse a provisioned launch`).toBe(false);
            }
        }
    });

    it("resolves a declared phrase, and answers empty for anything else", () => {
        const first = declared[0];
        expect(first).toBeDefined();
        if (!first) return;
        expect([...capabilityDataRequirement(first.agentId, first.capability)]).toEqual([...first.datasets]);
        expect(capabilityDataRequirement(first.agentId, "a phrase no agent advertises")).toEqual([]);
        expect(capabilityDataRequirement("no-such-agent", first.capability)).toEqual([]);
    });

    it("keeps every dataset id out of the planner-facing rendering", () => {
        const rendered = formatAgentCatalog();
        for (const requirement of declared) {
            for (const dataset of requirement.datasets) {
                expect(rendered, `the rendered catalog leaks the dataset id ${dataset} into a prompt`).not.toContain(dataset);
            }
        }
    });

    it("carries the six datasets of the matched negative capability", () => {
        const requirement = declared.find((entry) => entry.agentId === "translational-safety-agent" && entry.capability.includes("matched negative gene set"));
        expect(requirement).toBeDefined();
        expect([...(requirement?.datasets ?? [])].sort()).toEqual([
            "hpo-annotations",
            "impc-phenotyping",
            "mgi-mouse-human-homology",
            "opentargets-mouse-phenotype",
            "opentargets-target-safety-event",
            "string-aliases-human",
        ]);
    });
});
