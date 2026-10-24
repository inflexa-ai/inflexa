import type { AgentChat } from "../providers/types.js";
import type { ToolMask } from "./tool-mask.js";
import type { LoopMessage } from "./types.js";

/** The cap of requests of one compaction exchange: up to 3 rounds of memory edits, and then the summary. */
export const COMPACTION_MAX_REQUESTS = 4;

/** When an agent compacts its conversation, in the input tokens that the provider reported for the last request. */
export interface CompactionRules {
    /** The budget before each request of a turn. */
    readonly budget: number;
    /** The budget before the user message of a turn joins the conversation. Absent: no compaction before the user message. */
    readonly turnStartBudget?: number;
}

/** The share of a context window that a request can fill before the loop compacts. */
const CONTEXT_WINDOW_SHARE = 0.8;

/**
 * The rules of an agent for a model with `contextWindow`. The budget is the smaller of the declared budget and 80% of
 * the window. The turn-start budget keeps its ratio to the budget. An absent window keeps the declared rules.
 */
export function rulesForContextWindow(rules: CompactionRules, contextWindow: number | undefined): CompactionRules {
    if (contextWindow === undefined) return rules;
    const budget = Math.min(rules.budget, Math.floor(contextWindow * CONTEXT_WINDOW_SHARE));
    if (budget === rules.budget) return rules;
    return {
        budget,
        turnStartBudget: rules.turnStartBudget === undefined ? undefined : Math.floor((rules.turnStartBudget * budget) / rules.budget),
    };
}

/** How the loop compacts its conversation when the last request passed a budget. */
export interface CompactionPolicy extends CompactionRules {
    /** The provider of the conversation, with no text stream to the surface: the summary is no reply. */
    readonly provider: AgentChat;
    /** The text of the compaction request. */
    readonly request: string;
    /** The tools that can run in the exchange. */
    readonly mask: ToolMask;
    /** Keep the first turn, the seed of a report thread, in front of each view. */
    readonly keepFirstTurn: boolean;
    /** The context records that come after a new marker, for the view that starts at the marker. */
    readonly recordsAfter: (view: readonly LoopMessage[]) => Promise<readonly LoopMessage[]>;
}
