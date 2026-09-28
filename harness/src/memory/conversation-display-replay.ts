/**
 * The runtime transcript read: stored display projections → `ChatMessage[]`. It walks the rows in
 * `seq` order, merges the rounds of a turn into one assistant message, and folds the turn record onto
 * that message. It consults no tool name, no card builder, and no workspace or database.
 *
 * A row with no envelope predates the display projection and is skipped. A display rebuilt from the
 * model transcript would let each later change of a tool or a card rewrite history.
 */

import { upsertPart } from "../contracts/chat-frame.js";
import type { ChatMessage } from "../contracts/message.js";
import { isSyntheticUserMessage } from "./ai-sdk-message-storage.js";
import { conversationUIToChatMessages } from "./conversation-display-storage.js";
import type { StoredMessage, StoredTurnRecord } from "./thread-history.js";

/** Add the parts of a later round to the assistant message of its turn. */
function mergeRound(target: ChatMessage, round: ChatMessage): void {
    for (const part of round.parts) target.parts = upsertPart(target.parts, part);
}

function foldTurnRecord(message: ChatMessage | undefined, record: StoredTurnRecord | undefined): void {
    if (message === undefined || record === undefined) return;
    if (record.usage) message.usage = record.usage;
    if (record.durationMs !== undefined) message.durationMs = record.durationMs;
    if (record.status === "aborted") message.interrupted = true;
}

export function storedMessagesToChat(messages: readonly StoredMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    // The last message of the group being walked, as `out` holds it.
    let groupLast: ChatMessage | undefined;
    // The record of the turn being walked, and the last assistant message of that turn.
    let turnRecord: StoredTurnRecord | undefined;
    let turnAssistant: ChatMessage | undefined;
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
            for (const message of conversationUIToChatMessages(row.displayEnvelope.messages)) {
                const stamped: ChatMessage = { ...message, ...createdAt, ...(message.role === "user" ? author : {}) };
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

/** @deprecated Use {@link storedMessagesToChat}. */
export const storedMessagesToCortex = storedMessagesToChat;
