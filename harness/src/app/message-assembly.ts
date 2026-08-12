/**
 * Chat-turn message assembly.
 *
 * Builds the `messages` array `runAgent` receives for one conversation turn:
 *
 *   [ ...loadRecent(threadId, budget)            ← stable, cacheable prefix
 *     {user: cortex_analysis_state.context},     ← tail
 *     {user: runActivityContext},                 ← tail
 *     {user: render(workingMemory)},             ← tail, `conversation` thread only
 *     {user: normalizeUnicode(redactSecrets(input))} ]  ← tail
 *
 * `system + tools + history` is the cacheable prefix — it only extends
 * turn-to-turn. Run activity, working memory, and analysis context go in the
 * **tail** as `user` messages: they change every turn, so a system-message
 * placement would bust the Anthropic cache prefix.
 *
 * A `report` thread does not get the working-memory tail. The spawn copies the
 * working-memory render into the child transcript at the anchor. A live render
 * sees state past that anchor, and that breaks the knowledge cap of a report
 * session. The analysis context and the run activity stay on both thread types.
 *
 * The history window of a `report` thread also keeps the first turn. That turn
 * is the seed, and it is the one record of the brief and of the copied render.
 * The window evicts the oldest turn first, thus a long session would drop its
 * own charter and keep only its tools. A `conversation` thread evicts as before,
 * because its live tail carries the working memory on each turn.
 *
 * Sanitization (`redactSecrets`, `normalizeUnicode`) is applied **once**, to
 * the new user input only — never to history, assistant messages, tool
 * results, the analysis context, or the rendered working memory.
 *
 * The returned `userMessage` is the sanitized user input on its own — the
 * route persists `[userMessage, ...loop output]` via `appendTurn`, so the
 * tail injections (ephemeral, re-derived each turn) are never written to the
 * thread store.
 */

import type { ModelMessage } from "ai";

import { unwrapOrThrow } from "../lib/result.js";
import type { LoopMessage } from "../loop/types.js";
import type { ThreadHistory } from "../memory/thread-history.js";
import type { ThreadType } from "../memory/thread-store.js";
import type { WorkingMemoryStore } from "../memory/working-memory.js";
import { normalizeUnicode, redactSecrets } from "../input-sanitization.js";

/**
 * Token budget for the `loadRecent` history window. Sized to leave headroom
 * under the model context window for the system prompt, tool definitions,
 * the three tail messages, and the output budget.
 */
export const DEFAULT_HISTORY_TOKEN_BUDGET = 120_000;

export interface AssembleMessagesArgs {
    /** The conversation thread — a UI-generated UUID, never the analysisId. */
    readonly threadId: string;
    /** The type of the thread. A `report` thread drops the working-memory tail, and its window keeps the seed. */
    readonly threadType: ThreadType;
    /** The analysis scope — keys working memory and (separately) the context. */
    readonly analysisId: string;
    /** The raw, untrusted user input for this turn. */
    readonly userInput: string;
    /** `cortex_analysis_state.context`, already read by the route. `null` when absent. */
    readonly analysisContext: string | null;
    /** Fresh, non-persisted analysis-wide run activity rendered by chat-turn preparation. */
    readonly runActivityContext: string;
    /** The conversation message store — supplies the history window. */
    readonly history: ThreadHistory;
    /** The working-memory store — rendered into the tail. */
    readonly workingMemory: WorkingMemoryStore;
    /** History-window token budget. Defaults to {@link DEFAULT_HISTORY_TOKEN_BUDGET}. */
    readonly tokenBudget?: number;
}

export interface AssembledMessages {
    /** The full message array for `runAgent`. */
    readonly messages: LoopMessage[];
    /**
     * The sanitized user input as its own message — the genuine turn start.
     * The route persists this plus the loop's output; the tail injections are
     * not persisted.
     */
    readonly userMessage: ModelMessage;
}

/**
 * Assemble the message array for one chat turn. Async — it reads the history
 * window and renders working memory.
 */
export async function assembleMessages(args: AssembleMessagesArgs): Promise<AssembledMessages> {
    const budget = args.tokenBudget ?? DEFAULT_HISTORY_TOKEN_BUDGET;

    const history = unwrapOrThrow(await args.history.loadRecent(args.threadId, budget, { keepFirstTurn: args.threadType === "report" }));

    // Sanitization — applied once, here, to the new user input only.
    const userMessage: ModelMessage = {
        role: "user",
        content: normalizeUnicode(redactSecrets(args.userInput)),
    };

    const tail: LoopMessage[] = [];

    // Analysis context — platform-supplied, trusted. Injected only when present.
    if (args.analysisContext && args.analysisContext.trim().length > 0) {
        tail.push({
            role: "user",
            content: `[Analysis Context]\n${args.analysisContext}`,
        });
    }

    tail.push({
        role: "user",
        content: args.runActivityContext,
    });

    // Working memory — agent-authored and trusted. A `conversation` thread
    // always gets it, because the render names each section even when it is
    // empty. A `report` thread reads the frozen copy in its seed message.
    if (args.threadType !== "report") {
        tail.push({
            role: "user",
            content: unwrapOrThrow(await args.workingMemory.render(args.analysisId)),
        });
    }

    tail.push(userMessage);

    return { messages: [...history, ...tail], userMessage };
}
