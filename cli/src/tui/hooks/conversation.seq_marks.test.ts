import { afterEach, describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import type { MessagePage } from "@inflexa-ai/harness";

import { type CortexMsg, loadMessages, type LoadSeams, messages, messageSeqMarks, resetHotState } from "./conversation.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// A spawned report session records its spawn point as a stored `messages.seq`, but a mounted message
// carries no such number. The marks are the join between the two, and the report entry of the chat is
// their one reader. Thus what these cases pin is the pairing itself: which stored row owns which
// mounted position, once a row that displays nothing and the trailing message cap have both had their
// say.

const SID = "s1";
const AID = "a1";

// A stub runtime whose pool is never dereferenced, because the fake page reads ignore it.
const stubRuntime = { pool: {} } as unknown as HarnessRuntime;

afterEach(() => {
    resetHotState();
});

describe("the seq marks of a loaded transcript", () => {
    /**
     * One stored row: the `seq` that the store gave it, and how many display messages it replays into.
     * A row can replay into none, because the harness records a usage figure on a row of its own.
     */
    type Row = { seq: number; produces: number };

    /**
     * Page reads and a replay that model the store: `loadPage` slices whole TURNS exactly as the harness
     * does, and `toCortex` is a concatenation in row order. One turn holds one row here, thus a fixture
     * of N turns is N rows.
     */
    function loadSeams(fixture: Row[]): LoadSeams {
        return {
            runtime: () => stubRuntime,
            loadPage: (_pool, _threadId, page, perPage) => {
                const safePerPage = Math.min(Math.max(perPage, 1), 200);
                const safePage = Math.max(page, 0);
                const offset = safePage * safePerPage;
                const rows = fixture.slice(offset, offset + safePerPage);
                const result: MessagePage = {
                    messages: rows as unknown as MessagePage["messages"],
                    total: fixture.length,
                    page: safePage,
                    perPage: safePerPage,
                    hasMore: offset + rows.length < fixture.length,
                };
                return okAsync(result);
            },
            toCortex: (rows) =>
                (rows as unknown as Row[]).flatMap((r) =>
                    Array.from({ length: r.produces }, (_unused, i) => ({
                        id: `id-${r.seq}-${i}`,
                        role: "assistant",
                        parts: [{ type: "text", text: `m${r.seq}-${i}` }],
                    })),
                ) as unknown as CortexMsg[],
        };
    }

    /** N turns of one row each, `produces` messages per row, numbered as a store numbers them. */
    function turns(n: number, produces: number): Row[] {
        return Array.from({ length: n }, (_unused, t) => ({ seq: t, produces }));
    }

    test("each contributing row takes one mark, at the position one past its last message", async () => {
        // The seq numbers start high on purpose: the window mounts the newest turns alone, thus the first
        // loaded row is rarely the first row of the thread.
        await loadMessages(
            SID,
            AID,
            loadSeams([
                { seq: 10, produces: 1 },
                { seq: 11, produces: 2 },
                { seq: 12, produces: 1 },
            ]),
        );

        expect(messages.length).toBe(4);
        expect(messageSeqMarks()).toEqual([
            { seq: 10, end: 1 },
            { seq: 11, end: 3 },
            { seq: 12, end: 4 },
        ]);
    });

    test("a row that displays nothing takes NO mark, thus its seq resolves to the append it belongs to", async () => {
        // The bulk replay folds such a row onto the append before it, thus the row names no position of
        // its own. A mark for it would put an entry between two messages that no row separates.
        await loadMessages(
            SID,
            AID,
            loadSeams([
                { seq: 10, produces: 1 },
                { seq: 11, produces: 0 },
                { seq: 12, produces: 1 },
            ]),
        );

        expect(messages.length).toBe(2);
        expect(messageSeqMarks()).toEqual([
            { seq: 10, end: 1 },
            { seq: 12, end: 2 },
        ]);
    });

    test("the trailing message cap shifts each mark, thus a mark names a mounted position", async () => {
        // 201 turns replay into 201 messages and the cap mounts 200 of them, thus the window drops one
        // from the front and every mark moves back by that one.
        await loadMessages(SID, AID, loadSeams(turns(201, 1)));

        const marks = messageSeqMarks();
        expect(messages.length).toBe(200);
        expect(marks).toHaveLength(201);
        // The dropped row keeps its mark, and the mark now names the top of the mounted window.
        expect(marks[0]).toEqual({ seq: 0, end: 0 });
        expect(marks[1]).toEqual({ seq: 1, end: 1 });
        // The last mark names the end of the mounted transcript, never a position past it.
        expect(marks.at(-1)).toEqual({ seq: 200, end: 200 });
    });

    test("a deeper trim carries a mark below zero, which is what names a row under the mounted window", async () => {
        // Two messages for each row and 201 turns replay into 402 messages, thus the cap drops 202 of
        // them. A negative `end` is the honest answer: that row ends before the window starts.
        await loadMessages(SID, AID, loadSeams(turns(201, 2)));

        const marks = messageSeqMarks();
        expect(messages.length).toBe(200);
        expect(marks[0]).toEqual({ seq: 0, end: -200 });
        expect(marks.at(-1)).toEqual({ seq: 200, end: 200 });
    });
});
