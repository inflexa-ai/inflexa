/**
 * The runtime transcript read: stored display projections → `CortexMessage[]`.
 *
 * `ThreadHistory.loadPage` returns a thread's rows in `seq` order, and every
 * append's first row carries the display projection for that append. Replay is
 * therefore a concatenation: walk the rows, emit each envelope's messages in
 * order, done. No turn grouping, no tool-name recognition, no card rebuilding,
 * no filesystem or database lookup — nothing that could render a reloaded
 * conversation differently from the one the user was shown.
 *
 * A row with no envelope predates the display projection and is skipped. The
 * startup backfill (`conversation-display-backfill.ts`) writes one for every such
 * row before the runtime serves traffic, so in a booted harness there are none;
 * skipping rather than falling back to the migration renderer is what keeps the
 * reconstruction path out of the runtime entirely.
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
        // The turn's reported rollup rides the model row that ENDED the turn, not the
        // display projection — it is a fact about what the turn cost, not about what it
        // showed, and persisting it in both places would let the two disagree. Fold it
        // onto the assistant reply a reader associates with the figure.
        if (row.usage && append) {
            const last = append.at(-1);
            if (last?.role === "assistant") last.usage = row.usage;
        }
    }
    return out;
}
