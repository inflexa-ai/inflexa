import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadStore, type ThreadStore } from "./thread-store.js";
import { createThreadHistory } from "./thread-history.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

let pool: Pool;
let drop: () => Promise<void>;
let store: ThreadStore;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("thread-store"));
    store = createThreadStore(pool);
});

afterEach(async () => {
    await drop();
});

describe("createThread + getThread", () => {
    it("round-trips a thread by id (2.1)", async () => {
        const created = (
            await store.createThread({
                threadId: "t1",
                analysisId: ANALYSIS_A,
                title: "Run PCA",
            })
        )._unsafeUnwrap();
        expect(created.threadId).toBe("t1");
        expect(created.analysisId).toBe(ANALYSIS_A);
        expect(created.title).toBe("Run PCA");

        const read = (await store.getThread("t1"))._unsafeUnwrap();
        expect(read).not.toBeNull();
        expect(read!.analysisId).toBe(ANALYSIS_A);
        expect(read!.title).toBe("Run PCA");
        expect(read!.createdAt).toBeInstanceOf(Date);
        expect(read!.updatedAt).toBeInstanceOf(Date);
    });

    it("returns null for an absent thread", async () => {
        expect((await store.getThread("missing"))._unsafeUnwrap()).toBeNull();
    });

    it("is idempotent on thread_id and preserves created_at (2.2)", async () => {
        const first = (
            await store.createThread({
                threadId: "t1",
                analysisId: ANALYSIS_A,
                title: "Original",
            })
        )._unsafeUnwrap();

        const second = (
            await store.createThread({
                threadId: "t1",
                analysisId: ANALYSIS_A,
                title: "Different title",
            })
        )._unsafeUnwrap();

        // No duplicate, no overwrite — original row preserved.
        expect(second.title).toBe("Original");
        expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());

        const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM cortex_analysis_threads WHERE thread_id = $1", ["t1"]);
        expect(Number(rows[0]!.count)).toBe(1);
    });
});

describe("updateTitle", () => {
    it("changes only the title and bumps updated_at (2.2)", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Old" }))._unsafeUnwrap();

        const updated = (await store.updateTitle("t1", "New title"))._unsafeUnwrap();
        expect(updated).not.toBeNull();
        expect(updated!.title).toBe("New title");
        expect(updated!.analysisId).toBe(ANALYSIS_A);

        const read = (await store.getThread("t1"))._unsafeUnwrap();
        expect(read!.title).toBe("New title");
    });

    it("is a no-op on a missing thread", async () => {
        expect((await store.updateTitle("missing", "x"))._unsafeUnwrap()).toBeNull();
    });
});

describe("deleteThread (soft delete)", () => {
    it("excludes the thread from get/list while the row and messages persist (2.2, 2.3)", async () => {
        const history = createThreadHistory(pool);
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Doomed" }))._unsafeUnwrap();
        (
            await history.appendTurn("t1", [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                { role: "assistant", content: [{ type: "text", text: "hello" }] },
            ])
        )._unsafeUnwrap();

        (await store.deleteThread("t1"))._unsafeUnwrap();

        // Absent from get + list.
        expect((await store.getThread("t1"))._unsafeUnwrap()).toBeNull();
        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(page.threads.find((t) => t.threadId === "t1")).toBeUndefined();

        // Row still exists (with deleted_at set).
        const rowResult = await pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM cortex_analysis_threads WHERE thread_id = $1", ["t1"]);
        expect(rowResult.rows).toHaveLength(1);
        expect(rowResult.rows[0]!.deleted_at).not.toBeNull();

        // Messages still exist.
        const msgResult = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM messages WHERE thread_id = $1", ["t1"]);
        expect(Number(msgResult.rows[0]!.count)).toBe(2);
    });
});

describe("listThreads", () => {
    it("is scoped to one analysis, newest-updated first (2.3)", async () => {
        (await store.createThread({ threadId: "a1", analysisId: ANALYSIS_A, title: "A1" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "a2", analysisId: ANALYSIS_A, title: "A2" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "b1", analysisId: ANALYSIS_B, title: "B1" }))._unsafeUnwrap();

        // Touch a1 last so it sorts first.
        (await store.updateTitle("a1", "A1 updated"))._unsafeUnwrap();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(page.total).toBe(2);
        expect(page.threads.map((t) => t.threadId)).toEqual(["a1", "a2"]);
        // No analysis B thread leaks in.
        expect(page.threads.every((t) => t.analysisId === ANALYSIS_A)).toBe(true);
    });

    it("paginates with total and hasMore (2.3)", async () => {
        for (let i = 0; i < 5; i++) {
            (
                await store.createThread({
                    threadId: `t${i}`,
                    analysisId: ANALYSIS_A,
                    title: `T${i}`,
                })
            )._unsafeUnwrap();
        }

        const first = (await store.listThreads({ analysisId: ANALYSIS_A, page: 0, perPage: 2 }))._unsafeUnwrap();
        expect(first.total).toBe(5);
        expect(first.threads).toHaveLength(2);
        expect(first.hasMore).toBe(true);

        const last = (await store.listThreads({ analysisId: ANALYSIS_A, page: 2, perPage: 2 }))._unsafeUnwrap();
        expect(last.threads).toHaveLength(1);
        expect(last.hasMore).toBe(false);
    });
});
