import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import type { EditIntent, EditIntentStore } from "../../tools/workspace/edit-file.js";
import { createEditIntentStore } from "../edit-intents.js";
import { presentAt } from "../../lib/present.js";

function intent(overrides: Partial<EditIntent> & Pick<EditIntent, "key">): EditIntent {
    return {
        analysisId: "analysis-a",
        path: "/analysis-a/runs/r1/s1/scripts/run.R",
        hashBefore: "sha256:before",
        hashAfter: "sha256:after",
        result: { status: "ok", path: "/analysis-a/runs/r1/s1/scripts/run.R", replacements: 2, bytesWritten: 14, lines: [3, 9] },
        callRecord: [
            {
                analysisId: "analysis-a",
                path: "runs/r1/s1/scripts/run.R",
                hash: "sha256:after",
                size: 14,
                toolName: "edit_file",
                invocationId: "toolu_01",
            },
        ],
        ...overrides,
    };
}

describe("createEditIntentStore", () => {
    let pool: Pool;
    let drop: () => Promise<void>;
    let store: EditIntentStore;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("edit_intents"));
        store = createEditIntentStore(pool);
    });

    afterAll(async () => {
        await drop();
    });

    it("gives back the intent of a key as it was put, with the result and the call record", async () => {
        const record = intent({
            key: "wf-1:4",
            result: { status: "ok", path: "/analysis-a/scripts/run.R", replacements: 1, bytesWritten: 9, decision_record_noted: true },
            callRecord: [
                {
                    analysisId: "analysis-a",
                    threadId: "t-1",
                    path: "scripts/run.R",
                    hash: "sha256:after",
                    size: 9,
                    toolName: "edit_file",
                    invocationId: "toolu_02",
                },
                {
                    analysisId: "analysis-a",
                    threadId: "t-1",
                    path: "output/decision_record_run.json",
                    hash: "sha256:record",
                    size: 120,
                    toolName: "edit_file",
                    invocationId: "toolu_02",
                },
            ],
        });

        (await store.put(record))._unsafeUnwrap();

        expect((await store.get("wf-1:4"))._unsafeUnwrap()).toEqual(record);
    });

    it("replaces the intent on a second put of one key, and keeps the time of the first put", async () => {
        (await store.put(intent({ key: "wf-1:5" })))._unsafeUnwrap();
        await pool.query("UPDATE cortex_edit_intents SET created_at = '2020-01-01T00:00:00Z' WHERE step_key = 'wf-1:5'");
        const noted = intent({
            key: "wf-1:5",
            result: {
                status: "ok",
                path: "/analysis-a/runs/r1/s1/scripts/run.R",
                replacements: 2,
                bytesWritten: 14,
                lines: [3, 9],
                decision_record_noted: true,
            },
        });

        (await store.put(noted))._unsafeUnwrap();

        expect((await store.get("wf-1:5"))._unsafeUnwrap()).toEqual(noted);
        const { rows } = await pool.query<{ created_at: Date }>("SELECT created_at FROM cortex_edit_intents WHERE step_key = 'wf-1:5'");
        expect(presentAt(rows, 0).created_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("gives null for an unknown key", async () => {
        expect((await store.get("wf-unknown:1"))._unsafeUnwrap()).toBeNull();
    });

    it("gives a query error for a stored result that is not the result of an edit", async () => {
        (await store.put(intent({ key: "wf-1:6" })))._unsafeUnwrap();
        await pool.query(`UPDATE cortex_edit_intents SET result = '{"status":"not_found"}' WHERE step_key = 'wf-1:6'`);

        const read = await store.get("wf-1:6");

        expect(read._unsafeUnwrapErr()).toMatchObject({ type: "query_failed", op: "editIntents.get" });
    });
});
