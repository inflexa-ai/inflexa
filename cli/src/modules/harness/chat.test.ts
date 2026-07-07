import { describe, expect, test } from "bun:test";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";
import type { DbError, Thread } from "@inflexa-ai/harness";

import { selectThread } from "./chat.ts";

/** A `Thread` row fixture — override the fields a test cares about. */
function thread(overrides: Partial<Thread> = {}): Thread {
    return { threadId: "t-1", analysisId: "an-1", title: null, createdAt: new Date(0), updatedAt: new Date(0), ...overrides };
}

/** A `getThread` seam that resolves to `value` (a row or null). */
function getThreadOk(value: Thread | null): (id: string) => ResultAsync<Thread | null, DbError> {
    return () => okAsync(value);
}

const DB_ERROR: DbError = { type: "query_failed", op: "thread-store.getThread", cause: new Error("db down") } as const;

describe("selectThread", () => {
    test("no --thread mints a fresh id and never touches the store", async () => {
        let called = false;
        const getThread = (): ResultAsync<Thread | null, DbError> => {
            called = true;
            return okAsync(null);
        };
        const selection = await selectThread("an-1", undefined, getThread, () => "fresh-id");
        expect(selection).toEqual({ kind: "new", threadId: "fresh-id" });
        expect(called).toBe(false);
    });

    test("resume: an owned thread is continued", async () => {
        const selection = await selectThread("an-1", "t-1", getThreadOk(thread({ threadId: "t-1", analysisId: "an-1" })), () => "unused");
        expect(selection).toEqual({ kind: "resume", threadId: "t-1" });
    });

    test("resume: an absent thread is refused as not-found", async () => {
        const selection = await selectThread("an-1", "t-missing", getThreadOk(null), () => "unused");
        expect(selection).toEqual({ kind: "not_found" });
    });

    test("resume: a foreign thread is refused as not-found (indistinguishable from absent)", async () => {
        const selection = await selectThread("an-1", "t-1", getThreadOk(thread({ threadId: "t-1", analysisId: "another-analysis" })), () => "unused");
        expect(selection).toEqual({ kind: "not_found" });
    });

    test("resume: a storage fault is surfaced distinctly, not as not-found", async () => {
        const selection = await selectThread(
            "an-1",
            "t-1",
            () => errAsync(DB_ERROR),
            () => "unused",
        );
        expect(selection).toEqual({ kind: "lookup_failed", cause: DB_ERROR });
    });
});
