/**
 * Seeding contract for the step's lineage collector — the one link between a
 * step's durable input and what its provenance classifier will admit.
 *
 * The collector's own tests construct it directly and the parent's tests assert
 * the projection into the child input; neither crosses the join, so the join is
 * tested here.
 */

import { describe, expect, test } from "bun:test";

import { classifyReadPath } from "../provenance/collector.js";
import { createLineageCollector } from "./sandbox-step.js";

const RUN = "run-9";

describe("createLineageCollector", () => {
    test("the step's declared dependencies reach the collector", () => {
        const collector = createLineageCollector({ stepId: "T2S2", runId: RUN, dependsOn: ["T1S1", "T1S2"] });

        expect(collector.stepId).toBe("T2S2");
        expect(collector.runId).toBe(RUN);
        expect(collector.dependsOn).toEqual(["T1S1", "T1S2"]);
    });

    test("an input predating the field fails closed to an empty declaration list", () => {
        // `dependsOn` is optional because this is durable workflow input: a
        // workflow recovered under the older shape arrives without it. Absence
        // must under-capture, never admit.
        expect(createLineageCollector({ stepId: "T2S2", runId: RUN }).dependsOn).toEqual([]);
    });

    test("the seeded declarations are what classification actually reads", () => {
        // The end of the chain the projection exists to serve: a declared
        // dependency's read is admissible and an undeclared sibling's is not,
        // decided from the collector the step input produced. Drop the seeding
        // and this is the assertion that notices.
        const collector = createLineageCollector({ stepId: "T2S2", runId: RUN, dependsOn: ["T1S1"] });

        const declared = classifyReadPath(`runs/${RUN}/T1S1/output/counts.csv`, collector.stepId, collector.runId, collector.dependsOn);
        const sibling = classifyReadPath(`runs/${RUN}/T5S1/output/scratch.csv`, collector.stepId, collector.runId, collector.dependsOn);

        expect(declared.admissible).toBe(true);
        if (!declared.admissible) throw new Error("unreachable");
        expect(declared.context).toEqual({ source: "upstream", stepId: "T1S1", runId: RUN });
        expect(sibling.admissible).toBe(false);
    });
});
