import { describe, expect, it } from "bun:test";

import { loadPlanRecord, planGraphOf, planPartOf, queryPlanPage, queryRunIdsByPlan } from "@inflexa-ai/harness";
import type { PlanGraphStep, PlanPage, PlanPageEntry, PlanRecord } from "@inflexa-ai/harness";

import * as cardBuilders from "../../memory/card-builders.js";
import * as graph from "../../workflows/plan/graph.js";
import * as stateBarrel from "../index.js";

describe("the exports of the plan reads", () => {
    it("reaches the reads from the package root, as the same functions of their modules", () => {
        expect(loadPlanRecord).toBe(stateBarrel.loadPlanRecord);
        expect(queryPlanPage).toBe(stateBarrel.queryPlanPage);
        expect(queryRunIdsByPlan).toBe(stateBarrel.queryRunIdsByPlan);
        expect(planGraphOf).toBe(graph.planGraphOf);
        expect(planPartOf).toBe(cardBuilders.planPartOf);
    });

    it("types the record and the graph step from the package root", () => {
        const step: PlanGraphStep = { id: "T1S1", name: "Normalize", agent: "unknown", dependsOn: [], level: 0 };
        const record: PlanRecord = { planId: "pln-0000000a", plan: {}, parentPlanId: null, supersededBy: null, createdAt: "2026-10-01T00:00:00.000Z" };

        expect(planGraphOf(record.plan)).toBeNull();
        expect(step.level).toBe(0);
    });

    it("types the page and its entry from the package root", () => {
        const entry: PlanPageEntry = {
            planId: "pln-0000000a",
            createdAt: "2026-10-01T00:00:00.000Z",
            title: null,
            parentPlanId: null,
            supersededBy: null,
            newestRunId: null,
        };
        const page: PlanPage = { entries: [entry], total: 1 };

        expect(page.entries[0]?.planId).toBe("pln-0000000a");
    });
});
