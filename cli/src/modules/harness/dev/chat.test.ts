import { describe, expect, test } from "bun:test";
import { okAsync, errAsync, type ResultAsync } from "neverthrow";

import type { ThreadSummary } from "../../../api/conversation.ts";
import type { ClientError } from "../../../client/api.ts";
import { selectThread } from "./chat.ts";

/** A `ThreadSummary` fixture — override the fields a test cares about. */
function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
    return {
        id: "t-1",
        resourceId: "an-1",
        threadType: "conversation",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        ...overrides,
    };
}

/** A `getThread` read that resolves to `value` (a row, or null for an absent or foreign thread). */
function getThreadOk(value: ThreadSummary | null): (id: string) => ResultAsync<ThreadSummary | null, ClientError> {
    return () => okAsync(value);
}

const SERVER_GONE: ClientError = { type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:1", cause: new Error("refused") };

describe("selectThread", () => {
    test("no --thread mints a fresh id and never reads the server", async () => {
        let called = false;
        const getThread = (): ResultAsync<ThreadSummary | null, ClientError> => {
            called = true;
            return okAsync(null);
        };
        const selection = await selectThread(undefined, getThread, () => "fresh-id");
        expect(selection).toEqual({ kind: "new", threadId: "fresh-id" });
        expect(called).toBe(false);
    });

    test("resume: an owned thread is continued", async () => {
        const selection = await selectThread("t-1", getThreadOk(thread({ id: "t-1" })), () => "unused");
        expect(selection).toEqual({ kind: "resume", threadId: "t-1" });
    });

    test("resume: an absent or foreign thread (the server gives null for both) is refused as not-found", async () => {
        const selection = await selectThread("t-missing", getThreadOk(null), () => "unused");
        expect(selection).toEqual({ kind: "not_found" });
    });

    test("resume: a fault is surfaced distinctly, not as not-found", async () => {
        const selection = await selectThread(
            "t-1",
            () => errAsync(SERVER_GONE),
            () => "unused",
        );
        expect(selection).toEqual({ kind: "lookup_failed", cause: SERVER_GONE });
    });
});
