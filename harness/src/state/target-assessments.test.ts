/**
 * Unit tests for harness-side `cortex_target_assessments` helpers (§2.8).
 *
 * Postgres testcontainer scoped per test — `withSchema` hands out an isolated
 * schema so concurrent test files cannot collide on the table state.
 *
 * Coverage:
 *  - `markAssessmentSuspended` is idempotent (second call against an already-
 *    suspended row is a no-op, the row stays suspended).
 *  - `markAssessmentRunning` lifts a suspended row back to running and clears
 *    `error`.
 *  - Soft-deleted rows are NOT resurrected by any of the mutating helpers
 *    (`updateProgress`, `setDossier`, `markFailed`, `markAssessmentSuspended`,
 *    `markAssessmentRunning`).
 *  - `insertAssessment` populates `workflow_id` (defaults to id when omitted,
 *    honors an explicit value).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";

import {
    getAssessment,
    insertAssessment,
    markAssessmentRunning,
    markAssessmentSuspended,
    markFailed,
    setDossier,
    softDeleteAssessment,
    updateProgress,
} from "./target-assessments.js";

describe("harness/state/target-assessments", () => {
    let pool: Pool;
    let drop: () => Promise<void>;
    const orgId = "org_test";

    beforeAll(async () => {
        const ctx = await withSchema("harness_ta_state");
        pool = ctx.pool;
        drop = ctx.drop;
    });

    afterAll(async () => {
        await drop();
    });

    async function insertRow(opts: { workflowId?: string } = {}): Promise<string> {
        return (
            await insertAssessment(pool, {
                organizationId: orgId,
                targetId: "ENSG00000146648",
                targetLabel: "EGFR",
                billingContextId: "bc_test",
                requestedBy: "user_test",
                ...opts,
            })
        )._unsafeUnwrap();
    }

    const readRow = async (id: string) => (await getAssessment(pool, id, orgId))._unsafeUnwrap();

    describe("insertAssessment", () => {
        it("defaults workflowId to id when omitted", async () => {
            const id = await insertRow();
            const row = await readRow(id);
            expect(row).not.toBeNull();
            expect(row!.workflowId).toBe(id);
        });

        it("honors an explicit workflowId", async () => {
            const customWorkflowId = randomUUID();
            const id = await insertRow({ workflowId: customWorkflowId });
            const row = await readRow(id);
            expect(row!.workflowId).toBe(customWorkflowId);
        });
    });

    describe("markAssessmentSuspended", () => {
        it("flips status to suspended_insufficient_funds", async () => {
            const id = await insertRow();
            (await markAssessmentSuspended(pool, id))._unsafeUnwrap();
            const row = await readRow(id);
            expect(row!.status).toBe("suspended_insufficient_funds");
            expect(row!.progress).toContain("Suspended");
        });

        it("is idempotent on replay", async () => {
            const id = await insertRow();
            (await markAssessmentSuspended(pool, id))._unsafeUnwrap();
            const firstRow = await readRow(id);
            const firstUpdatedAt = firstRow!.updatedAt;

            // Brief wait so updated_at would tick on a second touch.
            await new Promise((r) => setTimeout(r, 5));
            (await markAssessmentSuspended(pool, id))._unsafeUnwrap();
            const secondRow = await readRow(id);
            expect(secondRow!.status).toBe("suspended_insufficient_funds");
            // updated_at advances (the UPDATE matched), but status stays consistent.
            expect(secondRow!.updatedAt >= firstUpdatedAt).toBe(true);
        });

        it("does not resurrect a soft-deleted row", async () => {
            const id = await insertRow();
            (await softDeleteAssessment(pool, id, orgId))._unsafeUnwrap();
            (await markAssessmentSuspended(pool, id))._unsafeUnwrap();
            const row = await readRow(id);
            expect(row!.status).toBe("deleted");
        });
    });

    describe("markAssessmentRunning", () => {
        it("lifts a suspended row back to running", async () => {
            const id = await insertRow();
            (await markAssessmentSuspended(pool, id))._unsafeUnwrap();
            (await markAssessmentRunning(pool, id))._unsafeUnwrap();
            const row = await readRow(id);
            expect(row!.status).toBe("running");
            expect(row!.error).toBeNull();
        });

        it("does not resurrect a soft-deleted row", async () => {
            const id = await insertRow();
            (await softDeleteAssessment(pool, id, orgId))._unsafeUnwrap();
            (await markAssessmentRunning(pool, id))._unsafeUnwrap();
            const row = await readRow(id);
            expect(row!.status).toBe("deleted");
        });
    });

    describe("soft-delete guards", () => {
        it("updateProgress is a no-op on deleted rows", async () => {
            const id = await insertRow();
            (await softDeleteAssessment(pool, id, orgId))._unsafeUnwrap();
            (await updateProgress(pool, id, "should not stick", "running"))._unsafeUnwrap();
            const row = await readRow(id);
            expect(row!.status).toBe("deleted");
            expect(row!.progress).not.toBe("should not stick");
        });

        it("setDossier is a no-op on deleted rows", async () => {
            const id = await insertRow();
            (await softDeleteAssessment(pool, id, orgId))._unsafeUnwrap();
            (await setDossier(pool, id, { schema_version: "3" }))._unsafeUnwrap();
            const row = await readRow(id);
            expect(row!.status).toBe("deleted");
            expect(row!.dossier).toBeNull();
        });

        it("markFailed is a no-op on deleted rows", async () => {
            const id = await insertRow();
            (await softDeleteAssessment(pool, id, orgId))._unsafeUnwrap();
            (
                await markFailed(pool, id, {
                    kind: "target-unresolved",
                    message: "test",
                })
            )._unsafeUnwrap();
            const row = await readRow(id);
            expect(row!.status).toBe("deleted");
            expect(row!.error).toBeNull();
        });
    });
});
