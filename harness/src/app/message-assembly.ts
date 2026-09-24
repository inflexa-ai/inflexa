/**
 * Chat-turn message assembly: the view of the latest compaction marker, the user message, and then the
 * context records. A kind gets a new record only when the view holds none of that kind, or when the hash
 * of its text differs. The root loop compacts the view past its budget.
 *
 * The view of a `report` thread keeps the first turn, because that turn is the seed: the one record of
 * the brief and of the copied working memory.
 */

import type { ModelMessage } from "ai";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import type { LoopMessage } from "../loop/types.js";
import { contextRecordMessage, contextRecordOf, type ContextKind } from "../memory/ai-sdk-message-storage.js";
import type { ThreadHistory } from "../memory/thread-history.js";
import type { ThreadType } from "../memory/thread-store.js";
import { answerUnansweredToolCalls } from "../memory/tool-call-integrity.js";
import type { WorkingMemoryStore } from "../memory/working-memory.js";
import { normalizeUnicode, redactSecrets } from "../input-sanitization.js";

export interface AssembleMessagesArgs {
    /** The conversation thread — a UI-generated UUID, never the analysisId. */
    readonly threadId: string;
    /** The type of the thread. A `report` thread gets no working-memory record, and its view keeps the seed. */
    readonly threadType: ThreadType;
    /** The analysis scope — keys working memory and (separately) the context. */
    readonly analysisId: string;
    /** The raw, untrusted user input for this turn. */
    readonly userInput: string;
    /** `cortex_analysis_state.context`, already read by the route. `null` when absent. */
    readonly analysisContext: string | null;
    /** The analysis-wide run activity that chat-turn preparation rendered for this turn. */
    readonly runActivityContext: string;
    /** The conversation message store — supplies the view of the thread. */
    readonly history: ThreadHistory;
    /** The working-memory store — rendered into a context record. */
    readonly workingMemory: WorkingMemoryStore;
    /** Diagnostic seam for the history repair record; omitted falls back to no-op. */
    readonly logger?: Logger;
}

export interface AssembledMessages {
    /** The full message array for `runAgent`. */
    readonly messages: LoopMessage[];
    /** The sanitized user input as its own message — the genuine turn start. */
    readonly userMessage: ModelMessage;
    /** The context records after the user message. The turn stores them with the user message. */
    readonly contextRecords: readonly ModelMessage[];
}

/**
 * Assemble the message array for one chat turn. Async — it reads the view of
 * the thread and renders working memory.
 */
export async function assembleMessages(args: AssembleMessagesArgs): Promise<AssembledMessages> {
    const history = unwrapOrThrow(await args.history.loadRecent(args.threadId, { keepFirstTurn: args.threadType === "report" }));

    // Read-side safety net for the wire contract: every tool call carries a
    // result. The loop upholds it at every exit, but the store outlives any one
    // writer — a row an older build wrote, or a hand-edited database, can carry
    // an unanswered call, and the provider boundary then refuses the WHOLE
    // transcript on every turn: the thread is wedged forever. The fix inserts the
    // same not-run result the loop gives, in place, so no stored message changes
    // and the prefix stays identical across turns. The warning is the only
    // account a reader gets that the stored thread and the assembled one differ.
    const repaired = answerUnansweredToolCalls(history);
    if (repaired.length > 0) {
        (args.logger ?? createNoopLogger()).named("assembly").warn("unanswered tool calls answered in thread history", {
            threadId: args.threadId,
            toolCallIds: repaired.map((d) => d.toolCallId),
            tools: repaired.map((d) => d.toolName),
        });
    }

    // Sanitization — applied once, here, to the new user input only.
    const userMessage: ModelMessage = {
        role: "user",
        content: normalizeUnicode(redactSecrets(args.userInput)),
    };

    const contextRecords = await contextRecordsFor(args, history);
    return { messages: [...history, userMessage, ...contextRecords], userMessage, contextRecords };
}

/** The context records of one turn, in the order analysis context, run activity, working memory. */
export async function contextRecordsFor(
    args: Pick<AssembleMessagesArgs, "threadType" | "analysisId" | "analysisContext" | "runActivityContext" | "workingMemory">,
    history: readonly ModelMessage[],
): Promise<ModelMessage[]> {
    const texts: [ContextKind, string][] = [];
    if (args.analysisContext && args.analysisContext.trim().length > 0) {
        texts.push(["analysis-context", `[Analysis Context]\n${args.analysisContext}`]);
    }
    texts.push(["run-activity", args.runActivityContext]);
    // A `report` thread reads the frozen copy in its seed, because a live render sees state past its anchor.
    if (args.threadType !== "report") {
        const render = unwrapOrThrow(await args.workingMemory.render(args.analysisId));
        // An emptied memory needs a record of its own, or the last full copy would read as the current state.
        texts.push(["working-memory", `[Working Memory]\n${render.length > 0 ? render : "The working memory is empty."}`]);
    }

    const latestHash = new Map<ContextKind, string>();
    for (const message of history) {
        const record = contextRecordOf(message);
        if (record !== undefined) latestHash.set(record.kind, record.hash);
    }
    const records: ModelMessage[] = [];
    for (const [kind, text] of texts) {
        const record = contextRecordMessage(kind, text);
        if (contextRecordOf(record)?.hash !== latestHash.get(kind)) records.push(record);
    }
    return records;
}
