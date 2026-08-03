import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { DbError } from "../lib/db-result.js";
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

// --- storage probes ---------------------------------------------------------
// The lifecycle verbs differ only in what they leave on disk, so every one of
// them is asserted against the raw rows rather than through the store's own
// filtered reads.

/** Persist one two-message turn, giving a thread messages a verb must keep or take. */
function appendTwoMessageTurn(threadId: string): ResultAsync<void, DbError> {
    return createThreadHistory(pool).appendTurn(threadId, {
        modelMessages: [
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "assistant", content: [{ type: "text", text: "hello" }] },
        ],
        displayMessages: [],
    });
}

async function messageCount(threadId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM messages WHERE thread_id = $1", [threadId]);
    return Number(rows[0]!.count);
}

async function threadRowCount(threadId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM cortex_analysis_threads WHERE thread_id = $1", [threadId]);
    return Number(rows[0]!.count);
}

/**
 * The tombstone as text, or `null` for a live/absent row. Text, not a `Date`:
 * the driver parses `timestamptz` at millisecond resolution, where two stamps
 * taken this close together compare equal and a re-stamp would go unnoticed.
 */
async function readTombstone(threadId: string): Promise<string | null> {
    const { rows } = await pool.query<{ deleted_at: string | null }>(
        "SELECT deleted_at::text AS deleted_at FROM cortex_analysis_threads WHERE thread_id = $1",
        [threadId],
    );
    return rows[0]?.deleted_at ?? null;
}

/**
 * A thread's timestamps, read twice over for two different jobs. The text
 * copies detect a write at all — the driver parses `timestamptz` at millisecond
 * resolution, so a stamp rewritten within the same tick reads back as the value
 * it replaced. The `Date` copy of `updated_at` is what the store's own parsed
 * `updatedAt` can be compared against, both truncated from the same underlying
 * value.
 */
async function readStamps(threadId: string): Promise<{ createdAt: string; updatedAt: string; updatedAtDate: Date; deletedAt: string | null }> {
    const { rows } = await pool.query<{ created_at: string; updated_at: string; updated_at_date: Date; deleted_at: string | null }>(
        `SELECT created_at::text AS created_at, updated_at::text AS updated_at, updated_at AS updated_at_date, deleted_at::text AS deleted_at
     FROM cortex_analysis_threads WHERE thread_id = $1`,
        [threadId],
    );
    const row = rows[0]!;
    return { createdAt: row.created_at, updatedAt: row.updated_at, updatedAtDate: row.updated_at_date, deletedAt: row.deleted_at };
}

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
        const before = await readStamps("t1");
        expect(before.deletedAt).toBeNull();

        const updated = (await store.updateTitle("t1", "New title"))._unsafeUnwrap();
        expect(updated).not.toBeNull();
        expect(updated!.title).toBe("New title");
        expect(updated!.analysisId).toBe(ANALYSIS_A);

        const read = (await store.getThread("t1"))._unsafeUnwrap();
        expect(read!.title).toBe("New title");

        // Read the row raw so the claim covers every column, not just the two the
        // store projects: the activity clock has to have moved, and nothing else
        // the row holds may have been rewritten alongside the title.
        const after = await readStamps("t1");
        expect(after.updatedAt).not.toBe(before.updatedAt);
        expect(after.createdAt).toBe(before.createdAt);
        expect(after.deletedAt).toBeNull();
        // The returned row is the post-update row, not the one that was read to
        // find it — its stamp is the one now on disk.
        expect(updated!.updatedAt.getTime()).toBe(after.updatedAtDate.getTime());
    });

    it("leaves a stamp fresher than its own clock unmoved while still renaming", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Old" }))._unsafeUnwrap();
        // Put the row's activity clock an hour past anything this statement can
        // read, standing in for the fresher stamp a turn append leaves behind when
        // it commits between this rename's start and its write. A bump that
        // assigns the current time rewinds the row by that hour.
        await pool.query("UPDATE cortex_analysis_threads SET updated_at = NOW() + interval '1 hour' WHERE thread_id = $1", ["t1"]);
        const before = await readStamps("t1");

        const updated = (await store.updateTitle("t1", "Renamed"))._unsafeUnwrap();

        // The rename lands...
        expect(updated).not.toBeNull();
        expect(updated!.title).toBe("Renamed");
        expect((await store.getThread("t1"))._unsafeUnwrap()!.title).toBe("Renamed");
        // ...and the fresher stamp survives it, byte-identical on disk and in the
        // row the call hands back.
        const after = await readStamps("t1");
        expect(after.updatedAt).toBe(before.updatedAt);
        expect(updated!.updatedAt.getTime()).toBe(before.updatedAtDate.getTime());
    });

    it("is a no-op on a missing thread", async () => {
        expect((await store.updateTitle("missing", "x"))._unsafeUnwrap()).toBeNull();
    });
});

describe("archiveThread (soft delete)", () => {
    it("excludes the thread from get/list while the row and messages persist (2.2, 2.3)", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Archived" }))._unsafeUnwrap();
        (await appendTwoMessageTurn("t1"))._unsafeUnwrap();

        (await store.archiveThread("t1"))._unsafeUnwrap();

        // Absent from get + list.
        expect((await store.getThread("t1"))._unsafeUnwrap()).toBeNull();
        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(page.threads.find((t) => t.threadId === "t1")).toBeUndefined();

        // Row still exists (with deleted_at set).
        const rowResult = await pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM cortex_analysis_threads WHERE thread_id = $1", ["t1"]);
        expect(rowResult.rows).toHaveLength(1);
        expect(rowResult.rows[0]!.deleted_at).not.toBeNull();

        expect(await messageCount("t1")).toBe(2);
    });

    it("preserves the original tombstone when archived twice", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Archived" }))._unsafeUnwrap();
        (await store.archiveThread("t1"))._unsafeUnwrap();
        const first = await readTombstone("t1");
        expect(first).not.toBeNull();

        (await store.archiveThread("t1"))._unsafeUnwrap();

        expect(await readTombstone("t1")).toBe(first);
    });

    it("is a no-op on an absent thread", async () => {
        (await store.archiveThread("missing"))._unsafeUnwrap();
        expect(await threadRowCount("missing")).toBe(0);
    });
});

describe("unarchiveThread", () => {
    it("returns the thread to get/list with its messages readable", async () => {
        const history = createThreadHistory(pool);
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Back" }))._unsafeUnwrap();
        (await appendTwoMessageTurn("t1"))._unsafeUnwrap();
        const before = (await history.loadRecent("t1", 1_000_000))._unsafeUnwrap();
        (await store.archiveThread("t1"))._unsafeUnwrap();

        (await store.unarchiveThread("t1"))._unsafeUnwrap();

        const read = (await store.getThread("t1"))._unsafeUnwrap();
        expect(read).not.toBeNull();
        expect(read!.title).toBe("Back");
        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(page.threads.map((t) => t.threadId)).toContain("t1");
        expect(await readTombstone("t1")).toBeNull();
        expect((await history.loadRecent("t1", 1_000_000))._unsafeUnwrap()).toEqual(before);
    });

    it("is a no-op on a live thread", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Live" }))._unsafeUnwrap();
        const before = (await store.getThread("t1"))._unsafeUnwrap();

        (await store.unarchiveThread("t1"))._unsafeUnwrap();

        const after = (await store.getThread("t1"))._unsafeUnwrap();
        expect(after).toEqual(before);
    });

    it("is a no-op on an absent thread", async () => {
        (await store.unarchiveThread("missing"))._unsafeUnwrap();
        expect(await threadRowCount("missing")).toBe(0);
    });
});

describe("purgeThread (hard delete)", () => {
    it("removes the thread row and every one of its messages", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Doomed" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "t2", analysisId: ANALYSIS_A, title: "Spared" }))._unsafeUnwrap();
        (await appendTwoMessageTurn("t1"))._unsafeUnwrap();
        (await appendTwoMessageTurn("t2"))._unsafeUnwrap();

        (await store.purgeThread("t1"))._unsafeUnwrap();

        expect((await store.getThread("t1"))._unsafeUnwrap()).toBeNull();
        expect(await threadRowCount("t1")).toBe(0);
        expect(await messageCount("t1")).toBe(0);
        // The purge is thread-scoped: a sibling thread keeps its row and messages.
        expect(await threadRowCount("t2")).toBe(1);
        expect(await messageCount("t2")).toBe(2);
    });

    it("succeeds on an absent thread", async () => {
        const purged = await store.purgeThread("missing");
        expect(purged.isOk()).toBe(true);
    });

    it("makes no claim on a turn that commits after it", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Raced" }))._unsafeUnwrap();
        (await appendTwoMessageTurn("t1"))._unsafeUnwrap();

        (await store.purgeThread("t1"))._unsafeUnwrap();
        // A writer the store cannot observe lands its turn after the purge. It
        // neither errors nor is prevented, and what it writes is past the reach of
        // any later thread- or analysis-scoped reclamation — which is why a host
        // stops writes to a thread before purging it.
        (await appendTwoMessageTurn("t1"))._unsafeUnwrap();

        expect(await messageCount("t1")).toBe(2);
        expect(await threadRowCount("t1")).toBe(0);
    });

    it("leaves the row and its messages intact when the purge fails partway", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Survivor" }))._unsafeUnwrap();
        (await appendTwoMessageTurn("t1"))._unsafeUnwrap();

        // Fail the metadata-row delete only, so the messages delete has already
        // succeeded inside the transaction when the failure lands — the partway
        // state the shared transaction exists to undo.
        await pool.query(`CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated delete failure'; END; $$ LANGUAGE plpgsql`);
        await pool.query("CREATE TRIGGER boom_trg BEFORE DELETE ON cortex_analysis_threads FOR EACH ROW EXECUTE FUNCTION boom()");

        // The failing statement names which half broke, so the surviving messages
        // below are the rollback's work and not a messages delete that never ran.
        expect((await store.purgeThread("t1"))._unsafeUnwrapErr()).toMatchObject({ op: "thread-store.purgeThread.thread" });

        expect(await threadRowCount("t1")).toBe(1);
        expect(await messageCount("t1")).toBe(2);
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

    it("reorders on an appended turn, listing the freshly-active thread first", async () => {
        const history = createThreadHistory(pool);
        (await store.createThread({ threadId: "a1", analysisId: ANALYSIS_A, title: "A1" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "a2", analysisId: ANALYSIS_A, title: "A2" }))._unsafeUnwrap();

        // Creation order puts a2 on top; only activity on a1 can flip that.
        const before = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(before.threads.map((t) => t.threadId)).toEqual(["a2", "a1"]);

        (
            await history.appendTurn("a1", {
                modelMessages: [
                    { role: "user", content: [{ type: "text", text: "hi" }] },
                    { role: "assistant", content: [{ type: "text", text: "hello" }] },
                ],
                displayMessages: [],
            })
        )._unsafeUnwrap();

        const after = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(after.threads.map((t) => t.threadId)).toEqual(["a1", "a2"]);
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

describe("listThreads includeArchived", () => {
    /** One live thread and one archived thread under the same analysis. */
    async function seedLiveAndArchived(): Promise<void> {
        (await store.createThread({ threadId: "live", analysisId: ANALYSIS_A, title: "Live" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "archived", analysisId: ANALYSIS_A, title: "Archived" }))._unsafeUnwrap();
        (await store.archiveThread("archived"))._unsafeUnwrap();
    }

    it("omits the archived thread and counts only the live one when the flag is absent", async () => {
        await seedLiveAndArchived();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();

        expect(page.threads.map((t) => t.threadId)).toEqual(["live"]);
        expect(page.total).toBe(1);
        expect(page.threads[0]!.deletedAt).toBeNull();
    });

    it("returns live and archived together when asked", async () => {
        await seedLiveAndArchived();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A, includeArchived: true }))._unsafeUnwrap();

        expect(page.threads.map((t) => t.threadId).sort()).toEqual(["archived", "live"]);
        expect(page.total).toBe(2);
        // Once both states share one result set, the tombstone is the only thing
        // that tells them apart — a caller has nothing else to render or filter on.
        expect(page.threads.find((t) => t.threadId === "archived")!.deletedAt).toBeInstanceOf(Date);
        expect(page.threads.find((t) => t.threadId === "live")!.deletedAt).toBeNull();
    });

    it("counts and pages the whole widened set", async () => {
        for (let i = 0; i < 3; i++) {
            (await store.createThread({ threadId: `live-${i}`, analysisId: ANALYSIS_A, title: `Live ${i}` }))._unsafeUnwrap();
        }
        for (let i = 0; i < 2; i++) {
            (await store.createThread({ threadId: `arch-${i}`, analysisId: ANALYSIS_A, title: `Archived ${i}` }))._unsafeUnwrap();
            (await store.archiveThread(`arch-${i}`))._unsafeUnwrap();
        }

        // A `perPage` below the five-row set forces both statements to answer for
        // the same rows: a count still excluding the archived pair would report
        // three, and a page still excluding them would run dry before this offset.
        const first = (await store.listThreads({ analysisId: ANALYSIS_A, includeArchived: true, page: 0, perPage: 2 }))._unsafeUnwrap();
        expect(first.total).toBe(5);
        expect(first.threads).toHaveLength(2);
        expect(first.hasMore).toBe(true);

        const middle = (await store.listThreads({ analysisId: ANALYSIS_A, includeArchived: true, page: 1, perPage: 2 }))._unsafeUnwrap();
        const last = (await store.listThreads({ analysisId: ANALYSIS_A, includeArchived: true, page: 2, perPage: 2 }))._unsafeUnwrap();
        expect(last.total).toBe(5);
        expect(last.threads).toHaveLength(1);
        expect(last.hasMore).toBe(false);

        // Paging to exhaustion yields exactly what the total promised, archived
        // rows included and none of them visited twice.
        const paged = [...first.threads, ...middle.threads, ...last.threads].map((t) => t.threadId).sort();
        expect(paged).toEqual(["arch-0", "arch-1", "live-0", "live-1", "live-2"]);
    });

    it("restores a thread reached through the widened listing", async () => {
        (await store.createThread({ threadId: "kept", analysisId: ANALYSIS_A, title: "Kept" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "restore-me", analysisId: ANALYSIS_A, title: "Restore me" }))._unsafeUnwrap();
        (await store.archiveThread("restore-me"))._unsafeUnwrap();

        // The id handed to the restore comes out of the listing rather than from
        // the test's own knowledge of it: a host has no other way to obtain one,
        // which is what makes the archive recoverable in practice and not just in
        // the API's own terms.
        const widened = (await store.listThreads({ analysisId: ANALYSIS_A, includeArchived: true }))._unsafeUnwrap();
        const archived = widened.threads.filter((t) => t.deletedAt !== null);
        expect(archived).toHaveLength(1);

        (await store.unarchiveThread(archived[0]!.threadId))._unsafeUnwrap();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(page.total).toBe(2);
        const restored = page.threads.find((t) => t.threadId === "restore-me");
        expect(restored).toBeDefined();
        expect(restored!.deletedAt).toBeNull();
    });
});
