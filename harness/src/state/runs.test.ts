import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { insertRun, queryRun, setRunSynthesisOutcome } from "./runs.js";

describe("runs: synthesis outcome", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeAll(async () => {
        const ctx = await withSchema("runs_synthesis_outcome");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    it("round-trips a synthesis status + reason through queryRun", async () => {
        (await insertRun(pool, { runId: "run-synth", analysisId: "analysis-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();
        (await setRunSynthesisOutcome(pool, "run-synth", "skipped_blocker", "some reason"))._unsafeUnwrap();

        const row = (await queryRun(pool, "run-synth"))._unsafeUnwrap();
        expect(row?.synthesisStatus).toBe("skipped_blocker");
        expect(row?.synthesisReason).toBe("some reason");
    });

    it("reads null status + reason on a freshly inserted run", async () => {
        (await insertRun(pool, { runId: "run-fresh", analysisId: "analysis-1", workflowName: "executeAnalysis" }))._unsafeUnwrap();

        const row = (await queryRun(pool, "run-fresh"))._unsafeUnwrap();
        expect(row?.synthesisStatus).toBeNull();
        expect(row?.synthesisReason).toBeNull();
    });
});
