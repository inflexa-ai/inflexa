import { afterEach, describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import type { MessagePage } from "@inflexa-ai/harness";

import { type CortexMsg, loadMessages, type LoadSeams, messages, messageSeqMarks, resetHotState } from "./conversation.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";

// A spawned report session records its spawn point as a stored `messages.seq`, but a mounted message
// carries no such number. The marks are the join between the two, and the report entry of the chat is
// their one reader. Thus what these cases pin is the pairing itself: which stored row ends on which
// mounted message, once a row that displays nothing and the trailing message cap have both had their
// say.
//
// A mark names a message by ID and never by index. The mounted array moves under the marks, because a
// live append drops a message off the front once the transcript is at the cap.

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
            { seq: 10, afterMessageId: "id-10-0" },
            { seq: 11, afterMessageId: "id-11-1" },
            { seq: 12, afterMessageId: "id-12-0" },
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
            { seq: 10, afterMessageId: "id-10-0" },
            { seq: 12, afterMessageId: "id-12-0" },
        ]);
    });

    test("a row the cap dropped keeps a mark that no mounted message answers", async () => {
        // 201 turns replay into 201 messages and the cap mounts 200 of them, thus the window drops the
        // first. Its mark stays, and the id it names is the one the reader cannot resolve. That miss is
        // what tells the reader the row sits below the window.
        await loadMessages(SID, AID, loadSeams(turns(201, 1)));

        const marks = messageSeqMarks();
        const mounted = new Set(messages.map((m) => m.id));
        expect(messages.length).toBe(200);
        expect(marks).toHaveLength(201);
        expect(marks[0]).toEqual({ seq: 0, afterMessageId: "id-0-0" });
        expect(mounted.has("id-0-0")).toBe(false);
        // Every other mark names a message the window holds.
        expect(mounted.has(marks[1]!.afterMessageId)).toBe(true);
        expect(marks.at(-1)).toEqual({ seq: 200, afterMessageId: "id-200-0" });
        expect(mounted.has("id-200-0")).toBe(true);
    });

    test("a deeper trim leaves more marks unanswered, and never a position the reader must clamp", async () => {
        // Two messages for each row and 201 turns replay into 402 messages, thus the cap drops 202 of
        // them. The marks of the dropped rows resolve to nothing, which is the honest answer.
        await loadMessages(SID, AID, loadSeams(turns(201, 2)));

        const marks = messageSeqMarks();
        const mounted = new Set(messages.map((m) => m.id));
        expect(messages.length).toBe(200);
        expect(marks[0]).toEqual({ seq: 0, afterMessageId: "id-0-1" });
        expect(mounted.has("id-0-1")).toBe(false);
        expect(marks.at(-1)).toEqual({ seq: 200, afterMessageId: "id-200-1" });
        expect(mounted.has("id-200-1")).toBe(true);
    });
});
