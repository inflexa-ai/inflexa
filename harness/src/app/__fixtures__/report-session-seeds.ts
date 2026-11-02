import type { ResultAsync } from "neverthrow";
import type { Pool } from "pg";

import type { DbError } from "../../lib/db-result.js";
import { conversationRecordTurn, createThreadHistory } from "../../memory/thread-history.js";
import type { ThreadStore } from "../../memory/thread-store.js";

type ReportSessionSeeds = {
    appendTurn: (threadId: string) => ResultAsync<void, DbError>;
    appendRecord: (threadId: string, text: string) => ResultAsync<void, DbError>;
    seedConversation: (threadId: string, analysisId: string, title: string | null) => Promise<void>;
};

/** Seed helpers for the report-session tests: the live conversation parent that a legal report child anchors into. */
export function reportSessionSeeds(pool: Pool, store: ThreadStore): ReportSessionSeeds {
    /** Persist one two-message turn on a thread, giving it a transcript to anchor into. */
    function appendTurn(threadId: string): ResultAsync<void, DbError> {
        return createThreadHistory(pool).appendTurn(threadId, {
            modelMessages: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
                { role: "assistant", content: [{ type: "text", text: "hello" }] },
            ],
            displayMessages: [],
        });
    }

    /** Append one record of out-of-band work — a synthetic message that opens no turn. */
    function appendRecord(threadId: string, text: string): ResultAsync<void, DbError> {
        return createThreadHistory(pool).appendTurn(threadId, conversationRecordTurn(text));
    }

    /** A live conversation parent with a first turn — the shape a legal spawn needs. */
    async function seedConversation(threadId: string, analysisId: string, title: string | null): Promise<void> {
        (await store.createThread({ threadId, analysisId, title }))._unsafeUnwrap();
        (await appendTurn(threadId))._unsafeUnwrap();
    }

    return { appendTurn, appendRecord, seedConversation };
}
