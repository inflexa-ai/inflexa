/**
 * The policy that refuses a tool call before it runs: the mask of a request,
 * the budget of a run, and the guard against repeated calls.
 *
 * A signed thinking block is bound to the exact prefix of its request, so a
 * request always declares the full tool set of its agent. The policy acts at
 * the approval of each call instead. A refused call gets a result that gives
 * the reason, and the run continues.
 *
 * The policy reads only the calls of the run, in the order that they arrive.
 * A replay sees the same calls in the same order, thus it refuses the same calls.
 */

import { parseUnknownRecord } from "../lib/unknown-containers.js";

/** An absent mask lets each declared tool run. */
export type ToolMask = "none" | { readonly allow: readonly string[] };

/** A tool with no entry has no limit. */
export type ToolBudget = Readonly<Record<string, number>>;

export type CallGuardPolicy = {
    /** The calls with one identical input that a run may make to one tool. The next one is refused. */
    readonly identicalLimit: number;
    /** The calls, with any input, that a run may make to one tool. The next one is refused. */
    readonly perToolLimit: number;
    /** The calls, with any input, that a run may make across every guarded tool. The next one is refused by every tool. */
    readonly totalLimit: number;
};

/**
 * Two identical calls let a model confirm an answer once. Twelve calls of one
 * tool is above the largest count a frontier planner made in the Phase 0
 * campaign (six and a half calls per plan across ALL tools) and far below the
 * two hundred that a looping planner reached. Forty calls across every tool
 * bounds the round over the tools that stays under each per-tool budget: in
 * the 32-task campaign every submitted Sonnet plan but two needed fewer, and
 * the one plan that ran to the wall clock made 62.
 */
export const DEFAULT_CALL_GUARD: CallGuardPolicy = { identicalLimit: 2, perToolLimit: 12, totalLimit: 40 };

export type GuardedCallRefusal = {
    readonly tool: string;
    readonly kind: "identical" | "budget" | "total";
    readonly calls: number;
};

/**
 * The guard against repeated calls of a set of tools. A model that treats a
 * tool answer as a state to poll calls the same tool with the same input again
 * and again, or drifts through one query after another, until the step cap or
 * the wall clock ends the run. A frontier model reads an "unavailable" answer
 * once and continues; a smaller model does not.
 */
export type CallGuard = {
    readonly tools: readonly string[];
    readonly policy?: CallGuardPolicy;
    /** Called on each refusal of the guard, for the log of the host and for a cap of the run. */
    readonly onRefusal?: (refusal: GuardedCallRefusal) => void;
};

export type CallPolicy = {
    /** The tools that can run for each request of the task. A follow-up request gives its own mask. */
    readonly mask?: ToolMask;
    readonly budget?: ToolBudget;
    readonly guard?: CallGuard;
};

/** The counters of one conversation. */
export type CallPolicyState = {
    /** The refusal text of a call, or `undefined` for a call that runs. A call that runs counts against each limit. */
    refusalOf(call: { readonly toolName: string; readonly input: unknown }, mask: ToolMask | undefined): string | undefined;
};

/** A stable key for one input: the JSON text with the object keys sorted at every depth. */
export function canonicalInputKey(input: unknown): string {
    return JSON.stringify(sortKeys(input));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    const record = parseUnknownRecord(value);
    if (record !== undefined) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) out[key] = sortKeys(record[key]);
        return out;
    }
    return value;
}

/** Matches the `{ error, retryable }` shape of every other tool error. */
function refusal(error: string): string {
    return JSON.stringify({ error, retryable: false });
}

function maskRefusal(mask: ToolMask, toolName: string): string | undefined {
    if (mask === "none") return refusal(`No tool can run for this request, thus ${toolName} did not run. Answer in text.`);
    if (mask.allow.includes(toolName)) return undefined;
    const available = mask.allow.length === 0 ? "none" : mask.allow.join(", ");
    return refusal(`The tool ${toolName} is not available for this request, thus it did not run. The tools that can run now: ${available}.`);
}

/** The mask that lets each tool run except the named ones. */
export function maskExcept(toolIds: readonly string[], ids: readonly string[]): ToolMask {
    return { allow: toolIds.filter((id) => !ids.includes(id)) };
}

export function createCallPolicy(policy: CallPolicy): CallPolicyState {
    const used = new Map<string, number>();
    const guard = policy.guard;
    const limits = guard?.policy ?? DEFAULT_CALL_GUARD;
    const guarded = new Set(guard?.tools ?? []);
    const guardCalls = new Map<string, number>();
    const byInput = new Map<string, number>();
    let guardTotal = 0;

    const guardRefusal = (toolName: string, input: unknown): string | undefined => {
        if (!guarded.has(toolName)) return undefined;
        const calls = (guardCalls.get(toolName) ?? 0) + 1;
        guardCalls.set(toolName, calls);
        const key = `${toolName}:${canonicalInputKey(input)}`;
        const identical = (byInput.get(key) ?? 0) + 1;
        byInput.set(key, identical);
        if (identical > limits.identicalLimit) {
            guard?.onRefusal?.({ tool: toolName, kind: "identical", calls: identical });
            return refusal(
                `This run already called ${toolName} with this exact input ${identical - 1} times, and the answer does not change within a run. ` +
                    "Use the answer you have and continue. If the answer was that a resource is absent, plan without it or ask for it; do not search again.",
            );
        }
        guardTotal += 1;
        if (guardTotal > limits.totalLimit) {
            guard?.onRefusal?.({ tool: toolName, kind: "total", calls: guardTotal });
            return refusal(
                `This run made ${limits.totalLimit} calls across its search tools, which is the search budget of one run. ` +
                    "Submit the plan you have now. If a required resource is absent, ask for it; do not search again.",
            );
        }
        if (calls > limits.perToolLimit) {
            guard?.onRefusal?.({ tool: toolName, kind: "budget", calls });
            return refusal(
                `This run made ${limits.perToolLimit} calls of ${toolName}, which is the budget of one run for one tool. ` +
                    "Continue with what you have. If a required resource is absent, ask for it; do not search again.",
            );
        }
        return undefined;
    };

    return {
        refusalOf(call, mask) {
            if (mask !== undefined) {
                const refused = maskRefusal(mask, call.toolName);
                if (refused !== undefined) return refused;
            }
            const limit = policy.budget?.[call.toolName];
            const count = used.get(call.toolName) ?? 0;
            if (limit !== undefined && count >= limit) {
                return refusal(`The tool ${call.toolName} reached its limit of ${limit} calls in this run, thus this call did not run.`);
            }
            const guardRefused = guardRefusal(call.toolName, call.input);
            if (guardRefused !== undefined) return guardRefused;
            used.set(call.toolName, count + 1);
            return undefined;
        },
    };
}
