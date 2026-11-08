import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertAnalysis } from "../../state/analyses.js";
import { insertPlan } from "../../state/plans.js";
import type { Querier } from "../../state/db.js";
import { readRunMethods } from "../run-methods.js";
import { stepDecisionRecordDir } from "../../workspace/paths.js";

const RUN_ID = "run-1";

let pool: Pool;
let drop: () => Promise<void>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("run-methods"));
    (await upsertAnalysis(pool, "an-1", null))._unsafeUnwrap();
});

afterEach(async () => {
    await drop();
});

/** Store one plan of the analysis and give its id. */
async function storePlan(plan: unknown): Promise<string> {
    return (await insertPlan(pool, { analysisId: "an-1", plan }))._unsafeUnwrap();
}

const PLAN = {
    steps: [
        { id: "T1S1" },
        { id: "T1S2", grounding: { status: "grounded", snapshot: "sha256:71ac", claims: ["R-0028@d560"], reason: "edgeR per R-0028" } },
        { id: "../escape", grounding: { status: "grounded", snapshot: "sha256:71ac", claims: ["R-0028@d560"], reason: "r" } },
    ],
    claims: [
        {
            id: "R-0028@d560",
            snapshot: "sha256:71ac",
            title: "Use the QL F-test",
            statement: "s",
            strength: "consensus",
            evidence: [{ doi: "10.1093/bioinformatics/btw014", title: "edgeR QL", year: 2016, direction: "supports" }],
        },
    ],
};

async function workspaceWithRecord(stepId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "run-methods-"));
    const dir = stepDecisionRecordDir({ workspaceRoot: root, runId: RUN_ID, stepId });
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "decision_record_tpl.json"),
        JSON.stringify({ template: { id: "tpl-qc-eda", version: "1.4.0", label: "QC", method: { id: "M-0001", label: "VST and PCA" } } }),
    );
    return root;
}

describe("readRunMethods", () => {
    it("gives the methods of each step of the plan from its grounding, the claim views, and its decision records", async () => {
        const root = await workspaceWithRecord("T1S1");

        const methods = (
            await readRunMethods({
                pool,
                analysisId: "an-1",
                runId: RUN_ID,
                planId: await storePlan(PLAN),
                workspaceRoot: root,
                logger: createCapturingLogger(),
            })
        )._unsafeUnwrap();

        // T1S1 has a record and no grounding, T1S2 has a grounding and no record, and the step with an unsafe id reads nothing.
        expect(methods.map((entry) => entry.stepId)).toEqual(["T1S1", "T1S2"]);
        expect(methods[0]?.methods.templates.map((template) => template.id)).toEqual(["tpl-qc-eda"]);
        expect(methods[1]?.methods.claims).toEqual([{ id: "R-0028@d560", title: "Use the QL F-test", strength: "consensus" }]);
        expect(methods[1]?.methods.sources.map((source) => source.doi)).toEqual(["10.1093/bioinformatics/btw014"]);
    });

    it("reads only the selected steps, and the records alone for a run with no plan", async () => {
        const root = await workspaceWithRecord("T1S1");
        const unusedPool: Querier = { query: () => Promise.reject(new Error("a run with no plan read a plan")) };

        const methods = (
            await readRunMethods({
                pool: unusedPool,
                analysisId: "an-1",
                runId: RUN_ID,
                planId: null,
                workspaceRoot: root,
                stepIds: ["T1S1", "T1S2"],
                logger: createCapturingLogger(),
            })
        )._unsafeUnwrap();

        expect(methods.map((entry) => [entry.stepId, entry.methods.grounding])).toEqual([["T1S1", undefined]]);
    });

    it("takes a stored plan that no schema of the methods admits as a plan with no grounding", async () => {
        const root = await workspaceWithRecord("T1S1");

        const methods = (
            await readRunMethods({
                pool,
                analysisId: "an-1",
                runId: RUN_ID,
                planId: await storePlan({ steps: "not a list", claims: 3 }),
                workspaceRoot: root,
                stepIds: ["T1S1"],
                logger: createCapturingLogger(),
            })
        )._unsafeUnwrap();

        expect(methods.map((entry) => entry.stepId)).toEqual(["T1S1"]);
    });

    it("gives an error when the plan read fails", async () => {
        const root = await workspaceWithRecord("T1S1");
        const failingPool: Querier = { query: () => Promise.reject(new Error("the store is down")) };

        const result = await readRunMethods({
            pool: failingPool,
            analysisId: "an-1",
            runId: RUN_ID,
            planId: "pln-1",
            workspaceRoot: root,
            logger: createCapturingLogger(),
        });

        expect(result.isErr()).toBe(true);
    });
});
