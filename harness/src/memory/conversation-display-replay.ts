/**
 * The runtime transcript read: stored display projections → `CortexMessage[]`. It walks the rows in
 * `seq` order, merges the rounds of a turn into one assistant message, and folds the turn record onto
 * that message. It consults no tool name, no card builder, and no workspace or database.
 *
 * A row with no envelope predates the display projection and is skipped. A display rebuilt from the
 * model transcript would let each later change of a tool or a card rewrite history.
 */

import type { CortexMessage, CortexPart } from "../contracts/message.js";
import { isReconciling } from "../contracts/part-registry.js";
import { isSyntheticUserMessage } from "./ai-sdk-message-storage.js";
import { conversationUIToCortexMessages } from "./conversation-display-storage.js";
import type { StoredMessage, StoredTurnRecord } from "./thread-history.js";

/** The key that a part reconciles on, or `undefined` for a part that each round adds again. */
function reconcileKey(part: CortexPart): string | undefined {
    if (part.type === "tool-call") return `tool-call:${part.toolCallId}`;
    if (part.type === "text" || !isReconciling(part.type)) return undefined;
    return "id" in part && typeof part.id === "string" ? `${part.type}:${part.id}` : undefined;
}

/** Add the parts of a later round to the assistant message of its turn. */
function mergeRound(target: CortexMessage, round: CortexMessage): void {
    for (const part of round.parts) {
        const key = reconcileKey(part);
        const earlier = key === undefined ? -1 : target.parts.findIndex((candidate) => reconcileKey(candidate) === key);
        if (earlier >= 0) target.parts[earlier] = part;
        else target.parts.push(part);
    }
}

function foldTurnRecord(message: CortexMessage | undefined, record: StoredTurnRecord | undefined): void {
    if (message === undefined || record === undefined) return;
    if (record.usage) message.usage = record.usage;
    if (record.durationMs !== undefined) message.durationMs = record.durationMs;
    if (record.status === "aborted") message.interrupted = true;
}

export function storedMessagesToCortex(messages: readonly StoredMessage[]): CortexMessage[] {
    const out: CortexMessage[] = [];
    // The last message of the group being walked, as `out` holds it.
    let groupLast: CortexMessage | undefined;
    // The record of the turn being walked, and the last assistant message of that turn.
    let turnRecord: StoredTurnRecord | undefined;
    let turnAssistant: CortexMessage | undefined;
    for (const row of messages) {
        if (row.message.role === "user" && !isSyntheticUserMessage(row.message)) {
            foldTurnRecord(turnAssistant, turnRecord);
            turnRecord = row.turn;
            turnAssistant = undefined;
        }
        if (row.displayEnvelope) {
            // The author and the creation time are facts about the ROW, the same as
            // the rollup below, and the projection holds neither. Both ride the row
            // that opens the append, and the author reaches the `user` messages
            // alone, because `role` already names the sender of a reply. Spread
            // conditionally: an absent value must leave no key, or a consumer that
            // spreads the message acquires one that overwrites a real value. `Date`
            // does not survive the JSON crossing typed, hence the ISO string here.
            const createdAt = row.createdAt === undefined ? {} : { createdAt: row.createdAt.toISOString() };
            const author = row.author === undefined ? {} : { author: row.author };
            groupLast = undefined;
            for (const message of conversationUIToCortexMessages(row.displayEnvelope.messages)) {
                const stamped: CortexMessage = { ...message, ...createdAt, ...(message.role === "user" ? author : {}) };
                const previous = out.at(-1);
                // The merged message keeps the creation time of its first round.
                if (stamped.role === "assistant" && previous?.role === "assistant" && previous.id === stamped.id) mergeRound(previous, stamped);
                else out.push(stamped);
                groupLast = out.at(-1);
                if (groupLast?.role === "assistant") turnAssistant = groupLast;
            }
        }
        // The reported rollup of an older turn and its duration both ride the model row that
        // ENDED the turn, and not the display projection. Each one is a fact about what the
        // turn cost, and not about what the turn showed. A write in both places would let
        // the two disagree. Thus the replay folds them onto the assistant reply that a
        // reader ties to the figures. The duration reads against `undefined`, and never
        // against falsiness: a measured zero is a figure, and an absent value alone means
        // that nobody measured the turn.
        if (groupLast?.role === "assistant" && (row.usage || row.durationMs !== undefined)) {
            if (row.usage) groupLast.usage = row.usage;
            if (row.durationMs !== undefined) groupLast.durationMs = row.durationMs;
        }
    }
    foldTurnRecord(turnAssistant, turnRecord);
    return out;
}
