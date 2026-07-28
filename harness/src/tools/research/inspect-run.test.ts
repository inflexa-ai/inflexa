import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { insertRun, seedStepExecutions, updateRunStatus, updateStepExecution } from "../../state/index.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createInspectRunTool } from "./inspect-run.js";

describe("inspect_run: adhoc run", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("inspect_run_adhoc");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("reports the adhoc summary and never advertises synthesis", async () => {
        (await insertRun(pool, { runId: "adhoc-inspect", analysisId: "analysis-001", workflowName: "runAdhoc" }))._unsafeUnwrap();
        (
            await seedStepExecutions(pool, [
                {
                    runId: "adhoc-inspect",
                    stepId: "adhoc",
                    analysisId: "analysis-001",
                    wave: 0,
                    agentId: "adhoc-executor",
                },
            ])
        )._unsafeUnwrap();
        (await updateStepExecution(pool, "adhoc-inspect", "adhoc", { status: "completed", durationMs: 10 }))._unsafeUnwrap();
        (await updateRunStatus(pool, "adhoc-inspect", "completed"))._unsafeUnwrap();

        const { ctx } = makeToolContext();
        const output = (await createInspectRunTool(pool).execute({ runId: "adhoc-inspect" }, ctx))._unsafeUnwrap();

        expect(output).toMatchObject({
            run: {
                runId: "adhoc-inspect",
                workflowName: "runAdhoc",
                planId: null,
                synthesisPath: null,
                synthesisStatus: null,
            },
            steps: [
                {
                    stepId: "adhoc",
                    agentId: "adhoc-executor",
                    status: "completed",
                    summaryPath: "runs/adhoc-inspect/adhoc/output/summary.md",
                },
            ],
        });
    });
});
