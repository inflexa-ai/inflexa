/**
 * The runtime transcript read: stored display projections → `CortexMessage[]`.
 *
 * `ThreadHistory.loadAll` returns a thread's rows in `seq` order, and every
 * append's first row carries the display projection for that append. Replay is
 * therefore a concatenation: walk the rows, emit each envelope's messages in
 * order, done. No turn grouping, no tool-name recognition, no card rebuilding,
 * no filesystem or database lookup — nothing that could render a reloaded
 * conversation differently from the one the user was shown.
 *
 * A row with no envelope predates the display projection and is skipped — the
 * only handling there is or will be. Reconstructing one from the model
 * transcript instead is what the deleted migration renderer did, and rebuilding
 * a display from a transcript that never carried one makes every later change to
 * a tool or a card silently rewrite history. Skipping keeps the gap observable
 * and the read total in what it consults: the stored projection, nothing else.
 */

import type { CortexMessage } from "../contracts/message.js";
import { conversationUIToCortexMessages } from "./conversation-display-storage.js";
import type { StoredMessage } from "./thread-history.js";

export function storedMessagesToCortex(messages: readonly StoredMessage[]): CortexMessage[] {
    const out: CortexMessage[] = [];
    // The messages the append currently being walked produced. A row bearing an
    // envelope opens one; every row after it belongs to it until the next does.
    let append: CortexMessage[] | null = null;
    for (const row of messages) {
        if (row.displayEnvelope) {
            append = conversationUIToCortexMessages(row.displayEnvelope.messages);
            out.push(...append);
        }
        // The reported rollup of the turn and its duration both ride the model row that
        // ENDED the turn, and not the display projection. Each one is a fact about what the
        // turn cost, and not about what the turn showed. A write in both places would let
        // the two disagree. Thus the replay folds them onto the assistant reply that a
        // reader ties to the figures. The duration reads against `undefined`, and never
        // against falsiness: a measured zero is a figure, and an absent value alone means
        // that nobody measured the turn.
        if (append && (row.usage || row.durationMs !== undefined)) {
            const last = append.at(-1);
            if (last?.role === "assistant") {
                if (row.usage) last.usage = row.usage;
                if (row.durationMs !== undefined) last.durationMs = row.durationMs;
            }
        }
    }
    return out;
}
