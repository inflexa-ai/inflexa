/**
 * The tool mask and the tool budget of the agent loop.
 *
 * A request always declares the full tool set of its agent, with the same tool
 * choice. Claude Opus 5.5 and Claude Fable 5.1 bind each signed thinking block to
 * the exact prefix of its request, and the tool set is part of that prefix. A
 * change of the tool set makes each later block invalid, and the prompt cache
 * misses. Thus the loop never changes the tools inside a conversation.
 *
 * A mask limits which calls run, and a budget limits how many calls of one tool
 * run in one run. Both act at dispatch: a refused call gets an error result that
 * gives the reason, and its tool does not run. Provider-native masking is out of
 * scope, because the vendors do it differently and an OpenAI-compatible
 * endpoint has neither form.
 */

import type { ToolCallPart } from "ai";

import type { Tool } from "../tools/define-tool.js";

/**
 * The tools that can run for a request: `"none"`, or the ids of the tools that
 * can run. An absent mask lets each declared tool run.
 */
export type ToolMask = "none" | { readonly allow: readonly string[] };

/** The maximum count of calls of each tool id in one run. A tool with no entry has no limit. */
export type ToolBudget = Readonly<Record<string, number>>;

/** A mask of each tool of `tools` except the ids in `ids`. */
export function maskExcept(tools: readonly Tool[], ids: readonly string[]): ToolMask {
    return { allow: tools.map((t) => t.id).filter((id) => !ids.includes(id)) };
}

function maskLets(mask: ToolMask | undefined, toolName: string): boolean {
    if (mask === undefined) return true;
    if (mask === "none") return false;
    return mask.allow.includes(toolName);
}

/** The error text of a refused call, in the `{ error, retryable }` shape of every other tool error. */
function refusal(error: string): string {
    return JSON.stringify({ error, retryable: false });
}

function maskRefusal(mask: ToolMask, toolName: string): string {
    if (mask === "none") return refusal(`No tool can run for this request, thus ${toolName} did not run. Answer in text.`);
    const available = mask.allow.length === 0 ? "none" : mask.allow.join(", ");
    return refusal(`The tool ${toolName} is not available for this request, thus it did not run. The tools that can run now: ${available}.`);
}

/**
 * The refusal of each call of one round, in call order: `undefined` for a call
 * that passes, or the model-visible text of the refusal.
 *
 * A call passes when the mask names its tool and the budget of its tool has a
 * unit left. A call that passes takes one unit from `used`, whatever its later
 * result, thus the count includes the earlier calls of the same round. The check
 * reads only the mask, the budget, and the calls of the run, thus a durable
 * replay refuses the same calls again.
 */
export function refusalsFor(
    calls: readonly ToolCallPart[],
    mask: ToolMask | undefined,
    budget: ToolBudget | undefined,
    used: Map<string, number>,
): (string | undefined)[] {
    return calls.map((call) => {
        if (mask !== undefined && !maskLets(mask, call.toolName)) return maskRefusal(mask, call.toolName);
        const limit = budget?.[call.toolName];
        const count = used.get(call.toolName) ?? 0;
        if (limit !== undefined && count >= limit) {
            return refusal(`The tool ${call.toolName} reached its limit of ${limit} calls in this run, thus this call did not run.`);
        }
        used.set(call.toolName, count + 1);
        return undefined;
    });
}
