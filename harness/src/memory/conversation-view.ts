/**
 * The view of a conversation, which the loop sends and `loadRecent` gives: the head, then the latest
 * summary marker, then the body. An exchange message never joins it, and a drop marker keeps the last
 * turns of the body without their reasoning. The loop and the reader call this one function, thus the
 * next turn reads back the prefix that the last request sent.
 */

import type { ModelMessage } from "ai";

import { compactionExchangeOf, compactionMarkerOf, isSyntheticUserMessage } from "./ai-sdk-message-storage.js";
import { countTokens } from "./count-tokens.js";

/**
 * A turn starts on a `user` message that a human actually sent. Two kinds of
 * message carry the `user` role without opening a turn, and both are excluded
 * here:
 *
 * - a tool result, which in AI SDK terms is a `tool`-role message, so a mid-turn
 *   tool continuation never matches in the first place;
 * - a message the LOOP or the HOST synthesized (`syntheticUserMessage`) — the
 *   truncated-reply nudge the loop inserts mid-turn, and the record an embedder
 *   appends between turns for work that happened outside the conversation, such as
 *   an analysis run's outcome. Both carry the `user` role for the wire format and
 *   neither is user input. Reading one as a boundary would split one turn into
 *   two: a drop would keep half a turn, and `retractLastTurn` would cut
 *   its tail in the middle of a turn rather than at its head.
 *
 *   A host-appended record therefore belongs to the turn preceding it, so a tail
 *   retraction that removes that turn removes the record with it. That is the
 *   accepted consequence of the exclusion, not a defect — the alternative, letting
 *   it open a turn, is the exact failure the marker exists to prevent.
 *
 * `GENUINE_USER_START_SQL` in `thread-history.ts` is the twin of this predicate over stored
 * envelopes; the two are built from the same constants so they cannot drift.
 */
export function isGenuineUserStart(message: ModelMessage): boolean {
    return message.role === "user" && !isSyntheticUserMessage(message);
}

/**
 * Group rows (oldest-first) into turns at genuine-user-start boundaries.
 * Generic over the row shape so the view rule and the display read
 * (`loadAll`) share it, each supplying its own start predicate.
 */
export function groupTurns<T>(rows: readonly T[], isStart: (row: T) => boolean): T[][] {
    const turns: T[][] = [];
    for (const row of rows) {
        if (turns.length === 0 || isStart(row)) {
            turns.push([row]);
        } else {
            turns[turns.length - 1]!.push(row);
        }
    }
    return turns;
}

export interface ConversationViewOptions {
    /** Keep the first turn in front of the view: the seed of a report thread. */
    readonly keepFirstTurn?: boolean;
}

export interface ConversationView {
    readonly messages: ModelMessage[];
    /** `sources[i]` is the index of the input message that gives `messages[i]`. */
    readonly sources: number[];
}

interface ViewEntry {
    readonly message: ModelMessage;
    readonly source: number;
}

interface ViewParts {
    readonly head: readonly ViewEntry[];
    readonly front: ViewEntry | undefined;
    readonly body: readonly ViewEntry[];
}

function isCompactionMessage(message: ModelMessage): boolean {
    return compactionMarkerOf(message) !== undefined || compactionExchangeOf(message) !== undefined;
}

function startsTurn(entry: ViewEntry): boolean {
    return isGenuineUserStart(entry.message);
}

function withoutReasoningEntries(entries: readonly ViewEntry[]): ViewEntry[] {
    return entries.flatMap((entry) => {
        const message = withoutReasoning(entry.message);
        return message === undefined ? [] : [{ message, source: entry.source }];
    });
}

function viewParts(messages: readonly ModelMessage[], options: ConversationViewOptions): ViewParts {
    // The head ends at a marker or an exchange message too, thus the stored rows and a view that
    // starts with the seed and a summary give the same head.
    let headEnd = 0;
    if (options.keepFirstTurn === true) {
        while (headEnd < messages.length) {
            const message = messages[headEnd]!;
            if (isCompactionMessage(message) || (headEnd > 0 && isGenuineUserStart(message))) break;
            headEnd++;
        }
    }
    const head = messages.slice(0, headEnd).map((message, source) => ({ message, source }));
    let front: ViewEntry | undefined;
    let body: ViewEntry[] = [];
    for (let source = headEnd; source < messages.length; source++) {
        const message = messages[source]!;
        if (compactionExchangeOf(message) !== undefined) continue;
        const marker = compactionMarkerOf(message);
        if (marker?.kind === "summary") {
            front = { message, source };
            body = [];
        } else if (marker?.kind === "drop") {
            // The drop changes the prefix that the signature of each kept reasoning part binds.
            const turns = groupTurns(body, startsTurn);
            body = withoutReasoningEntries(turns.slice(Math.max(turns.length - marker.keptTurns, 0)).flat());
        } else {
            body.push({ message, source });
        }
    }
    return { head, front, body };
}

export function conversationView(messages: readonly ModelMessage[], options: ConversationViewOptions): ConversationView {
    const { head, front, body } = viewParts(messages, options);
    const entries = [...head, ...(front === undefined ? [] : [front]), ...body];
    return { messages: entries.map((entry) => entry.message), sources: entries.map((entry) => entry.source) };
}

/** The message with no reasoning part, or `undefined` for an assistant message with no part left. */
export function withoutReasoning(message: ModelMessage): ModelMessage | undefined {
    if (message.role !== "assistant" || typeof message.content === "string") return message;
    const content = message.content.filter((part) => part.type !== "reasoning" && part.type !== "reasoning-file");
    if (content.length === message.content.length) return message;
    return content.length === 0 ? undefined : { ...message, content };
}

/** The estimate of the messages, by the count that the store writes to the `tokens` column. */
export function viewTokens(messages: readonly ModelMessage[]): number {
    return messages.reduce((sum, message) => sum + countTokens(message.content), 0);
}

/** The count of the turns that a drop keeps: the newest turn, and each older turn while the view stays within `budget`. */
export function keptTurnsForDrop(messages: readonly ModelMessage[], options: ConversationViewOptions, budget: number): number {
    const { head, front, body } = viewParts(messages, options);
    const turnTokens = groupTurns(body, startsTurn).map((turn) => viewTokens(withoutReasoningEntries(turn).map((entry) => entry.message)));
    let total = viewTokens([...head, ...(front === undefined ? [] : [front])].map((entry) => entry.message));
    let kept = 0;
    for (let t = turnTokens.length - 1; t >= 0; t--) {
        if (kept > 0 && total + turnTokens[t]! > budget) break;
        total += turnTokens[t]!;
        kept++;
    }
    return kept;
}
