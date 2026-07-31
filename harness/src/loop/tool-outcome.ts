/**
 * One classification of how a tool call ended, shared by every surface that
 * reports it.
 *
 * The live loop reads it off the `ToolResultPart` it just built; the reload
 * converter reads it off the same part after a round trip through storage. They
 * resolve through this function so a reloaded call cannot report an outcome the
 * live call never had — the defect this replaces was exactly that, with reload
 * reporting success for every call because it never looked at the result at all.
 */

import type { ToolOutcome } from "../contracts/chat-events.js";

export type { ToolOutcome };

/**
 * Classify a tool result's output type.
 *
 * `execution-denied` is the user's own decision and stays distinct from a fault.
 * `error-text` / `error-json` are the model-visible error results the loop
 * builds from a thrown failure, an `err(ToolError)`, or rejected input.
 * Everything else — including an expected "not found" data variant — is `ok`.
 */
export function toolOutcomeForOutputType(outputType: string): ToolOutcome {
    if (outputType === "execution-denied") return "denied";
    if (outputType === "error-text" || outputType === "error-json") return "error";
    return "ok";
}
