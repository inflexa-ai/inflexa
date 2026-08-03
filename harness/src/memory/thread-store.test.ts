import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { DbError } from "../lib/db-result.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import { createThreadStore, type ThreadStore, type ThreadType } from "./thread-store.js";
import { createThreadHistory } from "./thread-history.js";

const ANALYSIS_A = "analysis-a";
const ANALYSIS_B = "analysis-b";

/**
 * A local mirror of the store's closed type set, which the store keeps private.
 * The conditional below is what keeps the mirror honest: a member added to
 * `ThreadType` and not listed here resolves the alias to `never`, and the
 * declaration under it stops compiling — so "every type round-trips" cannot
 * quietly come to mean "every type this file happens to remember".
 */
const THREAD_TYPES = ["conversation", "report"] as const satisfies readonly ThreadType[];
type _AllThreadTypesCovered = ThreadType extends (typeof THREAD_TYPES)[number] ? true : never;
const _allThreadTypesCovered: _AllThreadTypesCovered = true;

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
 * The type and parent edge straight off the row, or `null` for an absent one.
 * Read raw because the store's own projection sits between a caller and these
 * three columns: a value the insert never wrote and a value `toThread` invented
 * are indistinguishable through `getThread`. `parent_seq` stays text here for
 * the reason the store projects it that way — it is a bigint, and the driver's
 * number parsing is not what this assertion is about.
 */
async function readRow(threadId: string): Promise<{ threadType: string; parentThreadId: string | null; parentSeq: string | null } | null> {
    const { rows } = await pool.query<{ thread_type: string; parent_thread_id: string | null; parent_seq: string | null }>(
        "SELECT thread_type, parent_thread_id, parent_seq::text AS parent_seq FROM cortex_analysis_threads WHERE thread_id = $1",
        [threadId],
    );
    const row = rows[0];
    return row ? { threadType: row.thread_type, parentThreadId: row.parent_thread_id, parentSeq: row.parent_seq } : null;
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

// --- subtree fixture --------------------------------------------------------
// Three generations plus an unrelated thread, shared by the archive and purge
// suites because both verbs walk the same recursive definition. The third
// generation is the load-bearing part: a one-level sweep is indistinguishable
// from a subtree walk in a tree that stops at a child, and the unrelated thread
// is what says the walk stops.

const GENERATIONS = ["root", "child", "grandchild"] as const;

async function seedGenerations(): Promise<void> {
    (await store.createThread({ threadId: "root", analysisId: ANALYSIS_A, title: "Root" }))._unsafeUnwrap();
    (await store.createThread({ threadId: "child", analysisId: ANALYSIS_A, title: "Child", parentThreadId: "root", parentSeq: 2 }))._unsafeUnwrap();
    (await store.createThread({ threadId: "grandchild", analysisId: ANALYSIS_A, title: "Grandchild", parentThreadId: "child", parentSeq: 4 }))._unsafeUnwrap();
    (await store.createThread({ threadId: "unrelated", analysisId: ANALYSIS_A, title: "Unrelated" }))._unsafeUnwrap();
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

describe("createThread type and parent edge", () => {
    it("defaults an unqualified create to a conversation standing on its own", async () => {
        const created = (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Plain" }))._unsafeUnwrap();

        expect(created.threadType).toBe("conversation");
        expect(created.parentThreadId).toBeNull();
        expect(created.parentSeq).toBeNull();

        const read = (await store.getThread("t1"))._unsafeUnwrap();
        expect(read!.threadType).toBe("conversation");
        expect(read!.parentThreadId).toBeNull();
        expect(read!.parentSeq).toBeNull();
    });

    it("round-trips a type, a parent and its anchor", async () => {
        (await store.createThread({ threadId: "root", analysisId: ANALYSIS_A, title: "Root" }))._unsafeUnwrap();

        const created = (
            await store.createThread({
                threadId: "spawned",
                analysisId: ANALYSIS_A,
                title: "Spawned report",
                type: "report",
                parentThreadId: "root",
                parentSeq: 12,
            })
        )._unsafeUnwrap();

        expect(created.threadType).toBe("report");
        expect(created.parentThreadId).toBe("root");
        expect(created.parentSeq).toBe(12);

        const read = (await store.getThread("spawned"))._unsafeUnwrap();
        expect(read!.threadType).toBe("report");
        expect(read!.parentThreadId).toBe("root");
        // The column is a bigint the driver hands back as text, and the store is
        // the single place it becomes a number — a caller comparing the anchor
        // against a `messages.seq` needs it to have made that crossing.
        expect(read!.parentSeq).toBe(12);
        expect(typeof read!.parentSeq).toBe("number");
    });

    it("round-trips every member of the closed type set", async () => {
        for (const threadType of THREAD_TYPES) {
            (await store.createThread({ threadId: `t-${threadType}`, analysisId: ANALYSIS_A, type: threadType }))._unsafeUnwrap();

            expect((await store.getThread(`t-${threadType}`))._unsafeUnwrap()!.threadType).toBe(threadType);
            expect((await readRow(`t-${threadType}`))!.threadType).toBe(threadType);
        }
    });
});

describe("createThread integrity rules", () => {
    it("refuses a parent belonging to another analysis", async () => {
        (await store.createThread({ threadId: "b-root", analysisId: ANALYSIS_B, title: "Other analysis" }))._unsafeUnwrap();

        const failed = (await store.createThread({ threadId: "child", analysisId: ANALYSIS_A, parentThreadId: "b-root", parentSeq: 1 }))._unsafeUnwrapErr();

        expect(failed).toEqual({
            type: "parent_analysis_mismatch",
            op: "thread-store.createThread",
            threadId: "child",
            analysisId: ANALYSIS_A,
            parentThreadId: "b-root",
            parentAnalysisId: ANALYSIS_B,
        });
        // Refused before the insert, not rolled back after it — a subtree walk
        // that could cross analyses is the thing the rule exists to prevent.
        expect(await threadRowCount("child")).toBe(0);
    });

    it("refuses a parent supplied without its anchor", async () => {
        (await store.createThread({ threadId: "root", analysisId: ANALYSIS_A, title: "Root" }))._unsafeUnwrap();

        const failed = (await store.createThread({ threadId: "child", analysisId: ANALYSIS_A, parentThreadId: "root" }))._unsafeUnwrapErr();

        expect(failed).toEqual({
            type: "parent_anchor_unpaired",
            op: "thread-store.createThread",
            threadId: "child",
            parentThreadId: "root",
            parentSeq: null,
        });
        expect(await threadRowCount("child")).toBe(0);
    });

    it("refuses an anchor supplied without its parent", async () => {
        const failed = (await store.createThread({ threadId: "child", analysisId: ANALYSIS_A, parentSeq: 7 }))._unsafeUnwrapErr();

        expect(failed).toEqual({
            type: "parent_anchor_unpaired",
            op: "thread-store.createThread",
            threadId: "child",
            parentThreadId: null,
            parentSeq: 7,
        });
        expect(await threadRowCount("child")).toBe(0);
    });

    it("refuses a type outside the closed set", async () => {
        // The check under test is for a value that reached the store from
        // outside this package's type graph — across a package boundary, out of
        // a JSON body — where the compile-time union never applied. Widening to
        // `string` first is what reproduces that from inside the graph, and it
        // is sound for the same reason the store's own widening is: the value
        // is exactly what an untyped caller could hand in.
        const outOfSet: string = "chronicle";

        const failed = (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, type: outOfSet as ThreadType }))._unsafeUnwrapErr();

        expect(failed).toEqual({
            type: "unknown_thread_type",
            op: "thread-store.createThread",
            threadId: "t1",
            threadType: "chronicle",
        });
        expect(await threadRowCount("t1")).toBe(0);
    });

    it("surfaces a parent that names no row as a constraint violation", async () => {
        const failed = (await store.createThread({ threadId: "child", analysisId: ANALYSIS_A, parentThreadId: "ghost", parentSeq: 1 }))._unsafeUnwrapErr();

        // Absence is the foreign key's verdict, not a rule the store pre-empts
        // with a read — so the refusal arrives from the insert, naming the edge
        // that refused it rather than the primary key.
        expect(failed).toMatchObject({
            type: "constraint_violation",
            op: "thread-store.createThread.insert",
            constraint: expect.stringContaining("parent_thread_id"),
        });
        expect(await threadRowCount("child")).toBe(0);
    });

    it("accepts an archived parent in the same analysis", async () => {
        (await store.createThread({ threadId: "root", analysisId: ANALYSIS_A, title: "Root" }))._unsafeUnwrap();
        (await store.archiveThread("root"))._unsafeUnwrap();

        const created = (await store.createThread({ threadId: "spawned", analysisId: ANALYSIS_A, parentThreadId: "root", parentSeq: 3 }))._unsafeUnwrap();

        // An archived parent is a real row holding a real transcript, so the
        // anchor still describes a place — the scope lookup must not filter on
        // the tombstone.
        expect(created.parentThreadId).toBe("root");
        expect(await readRow("spawned")).toEqual({ threadType: "conversation", parentThreadId: "root", parentSeq: "3" });
    });

    it("writes a create naming neither a parent nor an anchor untouched", async () => {
        (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Plain" }))._unsafeUnwrap();

        // Every rule this suite covers is gated on a value being supplied, so a
        // create naming neither half of the edge reaches none of them and lands
        // the row a thread with no lineage carries.
        expect(await readRow("t1")).toEqual({ threadType: "conversation", parentThreadId: null, parentSeq: null });
        expect(await threadRowCount("t1")).toBe(1);
    });
});

describe("createThread idempotency over the parent edge", () => {
    it("returns the existing row when a repeat create names a parent that does not exist", async () => {
        const first = (await store.createThread({ threadId: "t1", analysisId: ANALYSIS_A, title: "Original" }))._unsafeUnwrap();

        // `ON CONFLICT DO NOTHING` short-circuits before any constraint is
        // evaluated and reads none of what was supplied, so the foreign key
        // never sees the parent that would have refused a first create.
        // Idempotency outranks every rule the insert would otherwise face.
        const second = (
            await store.createThread({
                threadId: "t1",
                analysisId: ANALYSIS_A,
                title: "Ignored",
                type: "report",
                parentThreadId: "ghost",
                parentSeq: 7,
            })
        )._unsafeUnwrap();

        expect(second).toEqual(first);
        expect(await readRow("t1")).toEqual({ threadType: "conversation", parentThreadId: null, parentSeq: null });
        expect(await threadRowCount("t1")).toBe(1);
        expect(await threadRowCount("ghost")).toBe(0);
    });
});

describe("listThreads type and parent filters", () => {
    /**
     * Both types at both depths under one analysis. The grandchild is what makes
     * the parent filter's exactness observable — a filter that walked the
     * subtree would return it too.
     */
    async function seedMixedTypes(): Promise<void> {
        (await store.createThread({ threadId: "root", analysisId: ANALYSIS_A, title: "Root" }))._unsafeUnwrap();
        (await store.createThread({ threadId: "root-report", analysisId: ANALYSIS_A, title: "Standalone report", type: "report" }))._unsafeUnwrap();
        (
            await store.createThread({
                threadId: "child-report",
                analysisId: ANALYSIS_A,
                title: "Spawned report",
                type: "report",
                parentThreadId: "root",
                parentSeq: 2,
            })
        )._unsafeUnwrap();
        (
            await store.createThread({
                threadId: "child-convo",
                analysisId: ANALYSIS_A,
                title: "Spawned conversation",
                parentThreadId: "root",
                parentSeq: 4,
            })
        )._unsafeUnwrap();
        (
            await store.createThread({
                threadId: "grandchild",
                analysisId: ANALYSIS_A,
                title: "Grandchild",
                parentThreadId: "child-convo",
                parentSeq: 6,
            })
        )._unsafeUnwrap();
    }

    it("returns every type when nothing narrows it", async () => {
        await seedMixedTypes();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();

        // A session picker asks for no type and expects to reach a report
        // session directly: omitting the filter narrows nothing.
        expect(page.total).toBe(5);
        expect(page.threads.map((t) => t.threadId).sort()).toEqual(["child-convo", "child-report", "grandchild", "root", "root-report"]);
    });

    it("narrows to one type, counting only that type", async () => {
        await seedMixedTypes();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A, type: "report" }))._unsafeUnwrap();

        expect(page.total).toBe(2);
        expect(page.threads.map((t) => t.threadId).sort()).toEqual(["child-report", "root-report"]);
        expect(page.threads.every((t) => t.threadType === "report")).toBe(true);

        // A page past the first is what proves the count and the page were drawn
        // from one scope: a filter pushes LIMIT/OFFSET onto later placeholders,
        // and a page bound to the wrong ones runs dry or reports a size nothing
        // can page to.
        const second = (await store.listThreads({ analysisId: ANALYSIS_A, type: "report", page: 1, perPage: 1 }))._unsafeUnwrap();
        expect(second.total).toBe(2);
        expect(second.threads).toHaveLength(1);
        expect(second.threads[0]!.threadType).toBe("report");
        expect(second.hasMore).toBe(false);
    });

    it("narrows to one thread's direct children", async () => {
        await seedMixedTypes();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A, parentThreadId: "root" }))._unsafeUnwrap();

        expect(page.total).toBe(2);
        expect(page.threads.map((t) => t.threadId).sort()).toEqual(["child-convo", "child-report"]);
    });

    it("narrows to one row when both filters apply", async () => {
        await seedMixedTypes();

        const page = (await store.listThreads({ analysisId: ANALYSIS_A, type: "report", parentThreadId: "root" }))._unsafeUnwrap();

        expect(page.total).toBe(1);
        expect(page.threads.map((t) => t.threadId)).toEqual(["child-report"]);
    });
});

describe("archiveThread across a subtree", () => {
    it("hides every generation while leaving an unrelated thread live", async () => {
        await seedGenerations();

        (await store.archiveThread("root"))._unsafeUnwrap();

        for (const threadId of GENERATIONS) {
            expect((await store.getThread(threadId))._unsafeUnwrap()).toBeNull();
            expect(await readTombstone(threadId)).not.toBeNull();
            // Recoverable, so every row stays exactly where it was.
            expect(await threadRowCount(threadId)).toBe(1);
        }
        const page = (await store.listThreads({ analysisId: ANALYSIS_A }))._unsafeUnwrap();
        expect(page.threads.map((t) => t.threadId)).toEqual(["unrelated"]);
        expect(await readTombstone("unrelated")).toBeNull();
    });

    it("preserves the stamp on a descendant archived before its ancestor", async () => {
        await seedGenerations();
        (await store.archiveThread("child"))._unsafeUnwrap();
        const childStamp = await readTombstone("child");
        const grandchildStamp = await readTombstone("grandchild");
        expect(childStamp).not.toBeNull();

        (await store.archiveThread("root"))._unsafeUnwrap();

        // Re-stamping would push forward the one fact a tombstone carries — the
        // moment the thread left view. The sweep still has to descend past the
        // already-archived child to reach anything live beneath it, which is why
        // the guard sits on the write and not on the walk.
        expect(await readTombstone("child")).toBe(childStamp);
        expect(await readTombstone("grandchild")).toBe(grandchildStamp);
        expect(await readTombstone("root")).not.toBeNull();
    });

    it("moves no activity clock, on the way out or back", async () => {
        await seedGenerations();
        const before = new Map<string, string>();
        for (const threadId of GENERATIONS) {
            before.set(threadId, (await readStamps(threadId)).updatedAt);
        }

        (await store.archiveThread("root"))._unsafeUnwrap();

        // `updated_at` orders the listing by conversation activity, and neither
        // leaving view nor returning to it is activity — a restored thread lands
        // back where its last turn left it.
        for (const threadId of GENERATIONS) {
            expect((await readStamps(threadId)).updatedAt).toBe(before.get(threadId));
        }

        (await store.unarchiveThread("root"))._unsafeUnwrap();

        for (const threadId of GENERATIONS) {
            expect((await readStamps(threadId)).updatedAt).toBe(before.get(threadId));
        }
    });
});

describe("unarchiveThread across a subtree", () => {
    it("restores the named ancestor alone, leaving its descendants hidden", async () => {
        await seedGenerations();
        (await store.archiveThread("root"))._unsafeUnwrap();

        (await store.unarchiveThread("root"))._unsafeUnwrap();

        expect((await store.getThread("root"))._unsafeUnwrap()).not.toBeNull();
        // The asymmetry against the archive is the point: a cascade here would
        // restore a child the user had archived deliberately beforehand, and no
        // column records which of the two set a tombstone.
        expect((await store.getThread("child"))._unsafeUnwrap()).toBeNull();
        expect((await store.getThread("grandchild"))._unsafeUnwrap()).toBeNull();
    });

    it("restores a descendant named on its own", async () => {
        await seedGenerations();
        (await store.archiveThread("root"))._unsafeUnwrap();

        (await store.unarchiveThread("child"))._unsafeUnwrap();

        const restored = (await store.getThread("child"))._unsafeUnwrap();
        expect(restored).not.toBeNull();
        expect(restored!.title).toBe("Child");
        expect(await readTombstone("root")).not.toBeNull();
        expect(await readTombstone("grandchild")).not.toBeNull();
    });
});

describe("purgeThread across a subtree", () => {
    /** A turn on every seeded thread, so a stranded transcript has something to strand. */
    async function appendTurnsToEveryThread(): Promise<void> {
        for (const threadId of [...GENERATIONS, "unrelated"]) {
            (await appendTwoMessageTurn(threadId))._unsafeUnwrap();
        }
    }

    it("takes the rows and messages of every generation, leaving an unrelated thread whole", async () => {
        await seedGenerations();
        await appendTurnsToEveryThread();

        (await store.purgeThread("root"))._unsafeUnwrap();

        for (const threadId of GENERATIONS) {
            expect(await threadRowCount(threadId)).toBe(0);
            // No foreign key ties `messages` to a thread, so a cascade alone
            // would leave a descendant's transcript behind with nothing naming
            // it — the explicit delete has to reach the same depth.
            expect(await messageCount(threadId)).toBe(0);
        }
        expect(await threadRowCount("unrelated")).toBe(1);
        expect(await messageCount("unrelated")).toBe(2);
    });

    it("takes only the named descendant's own subtree", async () => {
        await seedGenerations();
        await appendTurnsToEveryThread();

        (await store.purgeThread("child"))._unsafeUnwrap();

        expect(await threadRowCount("child")).toBe(0);
        expect(await messageCount("child")).toBe(0);
        expect(await threadRowCount("grandchild")).toBe(0);
        expect(await messageCount("grandchild")).toBe(0);
        // The walk descends and never climbs: the ancestor keeps its row, its
        // transcript and its parent edge, and so does the thread beside it.
        expect(await threadRowCount("root")).toBe(1);
        expect(await messageCount("root")).toBe(2);
        expect((await store.getThread("root"))._unsafeUnwrap()!.title).toBe("Root");
        expect(await threadRowCount("unrelated")).toBe(1);
        expect(await messageCount("unrelated")).toBe(2);
    });

    it("leaves every generation whole when the subtree delete fails partway", async () => {
        await seedGenerations();
        await appendTurnsToEveryThread();

        // The messages statement sweeps the whole subtree before the rows statement
        // runs, so a failure on the second one is the widest partway state the shared
        // transaction has to undo: three generations of transcript already deleted.
        // A rollback that recovered only the named thread would leave the descendants
        // stripped of their messages while their rows still stood.
        await pool.query(`CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'simulated delete failure'; END; $$ LANGUAGE plpgsql`);
        await pool.query("CREATE TRIGGER boom_trg BEFORE DELETE ON cortex_analysis_threads FOR EACH ROW EXECUTE FUNCTION boom()");

        expect((await store.purgeThread("root"))._unsafeUnwrapErr()).toMatchObject({ op: "thread-store.purgeThread.thread" });

        for (const threadId of GENERATIONS) {
            expect(await threadRowCount(threadId)).toBe(1);
            expect(await messageCount(threadId)).toBe(2);
        }
    });
});
