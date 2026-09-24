import type { AgentChat } from "../providers/types.js";
import type { ToolMask } from "./tool-mask.js";
import type { LoopMessage } from "./types.js";

/** The cap of requests of one compaction exchange: up to 3 rounds of memory edits, and then the summary. */
export const COMPACTION_MAX_REQUESTS = 4;

/** How the loop compacts its conversation when the view passes the budget. */
export interface CompactionPolicy {
    /** The budget of the view, in estimated tokens. */
    readonly budget: number;
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
