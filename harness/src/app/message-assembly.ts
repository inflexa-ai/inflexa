/**
 * Chat-turn message assembly.
 *
 * Builds the `messages` array `runAgent` receives for one conversation turn:
 *
 *   [ ...loadRecent(threadId, budget)            ← stable, cacheable prefix
 *     {user: cortex_analysis_state.context},     ← tail
 *     {user: render(workingMemory)},             ← tail
 *     {user: normalizeUnicode(redactSecrets(input))} ]  ← tail
 *
 * `system + tools + history` is the cacheable prefix — it only extends
 * turn-to-turn. Working memory and analysis context go in the **tail** as
 * `user` messages: working memory changes every turn, so a system-message
 * placement would bust the Anthropic cache prefix.
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

import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

import { unwrapOrThrow } from "../lib/result.js";
import type { LoopMessage } from "../loop/types.js";
import type { ThreadHistory } from "../memory/thread-history.js";
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
    /** The analysis scope — keys working memory and (separately) the context. */
    readonly analysisId: string;
    /** The raw, untrusted user input for this turn. */
    readonly userInput: string;
    /** `cortex_analysis_state.context`, already read by the route. `null` when absent. */
    readonly analysisContext: string | null;
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
    readonly userMessage: MessageParam;
}

/**
 * Assemble the message array for one chat turn. Async — it reads the history
 * window and renders working memory.
 */
export async function assembleMessages(args: AssembleMessagesArgs): Promise<AssembledMessages> {
    const budget = args.tokenBudget ?? DEFAULT_HISTORY_TOKEN_BUDGET;

    const history = unwrapOrThrow(await args.history.loadRecent(args.threadId, budget));

    // Sanitization — applied once, here, to the new user input only.
    const userMessage: MessageParam = {
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

    // Working memory — agent-authored, trusted. Always injected (its rendered
    // form names the sections even when empty).
    tail.push({
        role: "user",
        content: unwrapOrThrow(await args.workingMemory.render(args.analysisId)),
    });

    tail.push(userMessage);

    return { messages: [...history, ...tail], userMessage };
}
