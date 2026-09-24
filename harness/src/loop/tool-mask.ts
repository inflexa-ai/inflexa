/**
 * Claude Opus 5.5 and Claude Fable 5.1 bind each signed thinking block to the
 * exact prefix of its request, so a request always declares the full tool set
 * of its agent; the mask and the budget act at dispatch instead. Provider-native
 * masking is out of scope, because the vendors do it differently and an
 * OpenAI-compatible endpoint has neither form.
 */

import type { ToolCallPart } from "ai";

import type { Tool } from "../tools/define-tool.js";

/** An absent mask lets each declared tool run. */
export type ToolMask = "none" | { readonly allow: readonly string[] };

/** A tool with no entry has no limit. */
export type ToolBudget = Readonly<Record<string, number>>;

export function maskExcept(tools: readonly Tool[], ids: readonly string[]): ToolMask {
    return { allow: tools.map((t) => t.id).filter((id) => !ids.includes(id)) };
}

function maskLets(mask: ToolMask | undefined, toolName: string): boolean {
    if (mask === undefined) return true;
    if (mask === "none") return false;
    return mask.allow.includes(toolName);
}

/** Matches the `{ error, retryable }` shape of every other tool error. */
function refusal(error: string): string {
    return JSON.stringify({ error, retryable: false });
}

function maskRefusal(mask: ToolMask, toolName: string): string {
    if (mask === "none") return refusal(`No tool can run for this request, thus ${toolName} did not run. Answer in text.`);
    const available = mask.allow.length === 0 ? "none" : mask.allow.join(", ");
    return refusal(`The tool ${toolName} is not available for this request, thus it did not run. The tools that can run now: ${available}.`);
}

/**
 * `undefined` for a call that passes, otherwise the model-visible refusal
 * text. A passing call takes one unit from `used` regardless of its later
 * result, because the check reads only the mask, the budget, and the run's
 * calls — so a durable replay refuses the same calls again.
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
