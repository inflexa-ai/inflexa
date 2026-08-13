import type { Thread, ThreadPage } from "@inflexa-ai/harness";

// The thread rows that the report-session coverage drives through the injected seams. No CLI test
// reaches Postgres, and no local composition writes a report thread, thus a report child exists for a
// test only as a row that a fake seam hands back. One shape here keeps that row honest: a `report` row
// carries the parent link and the spawn point, and a `conversation` row carries neither.

/** The analysis that a fixture row belongs to, unless a caller names a different one. */
export const FIXTURE_ANALYSIS_ID = "a1";

/**
 * A live conversation row, most of whose fields a flow never reads.
 *
 * @param over the fields that the case is about.
 */
export function conversationThread(over: Partial<Thread> = {}): Thread {
    return {
        threadId: "thread-conversation",
        analysisId: FIXTURE_ANALYSIS_ID,
        title: "Cohort survival questions",
        threadType: "conversation",
        // A conversation is a root: the store pairs a parent link with a spawn point, and a root has
        // neither.
        parentThreadId: null,
        parentSeq: null,
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
        updatedAt: new Date("2026-07-08T01:00:00.000Z"),
        // Live by default. A tombstone is what an archived row carries, and the report surfaces read the
        // live rows alone.
        deletedAt: null,
        ...over,
    };
}

/**
 * A live report child, spawned from {@link conversationThread} at the spawn point that `parentSeq`
 * names.
 *
 * The two parent fields are the whole difference from a conversation, thus a case that omits one of
 * them tests a row that the store never writes. Keep both, and override the values instead.
 *
 * @param over the fields that the case is about.
 */
export function reportThread(over: Partial<Thread> = {}): Thread {
    return {
        threadId: "thread-report",
        analysisId: FIXTURE_ANALYSIS_ID,
        title: "Differential expression report",
        threadType: "report",
        parentThreadId: "thread-conversation",
        // The `messages.seq` of the parent row that the spawn came after.
        parentSeq: 2,
        createdAt: new Date("2026-07-08T02:00:00.000Z"),
        updatedAt: new Date("2026-07-08T03:00:00.000Z"),
        deletedAt: null,
        ...over,
    };
}

/** One full page over the given rows, which is what a single-page listing gives back. */
export function threadPageOf(threads: Thread[]): ThreadPage {
    return { threads, total: threads.length, page: 0, perPage: 20, hasMore: false };
}
