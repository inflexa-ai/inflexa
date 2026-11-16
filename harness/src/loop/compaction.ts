import type { ToolMask } from "./call-policy.js";
import type { LoopMessage } from "./types.js";

/** The cap of requests of one compaction exchange: up to 3 rounds of memory edits, and then the summary. */
export const COMPACTION_MAX_REQUESTS = 4;

/** When an agent compacts its conversation, in the input tokens that the provider reported for the last request. */
export type CompactionRules = {
    /** The budget before each request of a turn, when the host does not know the context window of the model. */
    readonly budget: number;
    /** The budget before the user message of a turn joins the conversation. Absent: no compaction before the user message. */
    readonly turnStartBudget?: number;
};

/**
 * The share of a known context window that a request can fill before the loop compacts during a turn. The compaction
 * during a turn is a fail-safe that interrupts the work, thus it fires late.
 */
const FAIL_SAFE_WINDOW_SHARE = 0.9;

/** The largest share of a known context window that the turn-start budget can take, thus a turn starts with room to work. */
const TURN_START_WINDOW_SHARE = 0.75;

/**
 * The rules of an agent for a model with `contextWindow`. With a known window, the budget is 90% of the window, and the
 * turn-start budget is the smaller of the declared turn-start budget and 75% of the window. An absent window keeps the
 * declared rules.
 */
export function rulesForContextWindow(rules: CompactionRules, contextWindow: number | undefined): CompactionRules {
    if (contextWindow === undefined) return rules;
    return {
        budget: Math.floor(contextWindow * FAIL_SAFE_WINDOW_SHARE),
        turnStartBudget: rules.turnStartBudget === undefined ? undefined : Math.min(rules.turnStartBudget, Math.floor(contextWindow * TURN_START_WINDOW_SHARE)),
    };
}

/**
 * How the loop compacts its conversation when the last request passed a budget. The exchange streams no
 * text to the surface, because the summary is no reply.
 */
export type CompactionPolicy = CompactionRules & {
    /** The text of the compaction request. */
    readonly request: string;
    /** The tools that can run in the exchange. */
    readonly mask: ToolMask;
    /** Keep the first turn, the seed of a report thread, in front of each view. */
    readonly keepFirstTurn: boolean;
    /** The context records that come after a new marker, for the view that starts at the marker. */
    readonly recordsAfter: (view: readonly LoopMessage[]) => Promise<readonly LoopMessage[]>;
};
