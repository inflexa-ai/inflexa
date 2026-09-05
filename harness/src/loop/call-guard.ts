/**
 * The call guard: a bound on repeated tool calls inside one agent run.
 *
 * A model that treats a tool answer as a state to poll calls the same tool
 * with the same input again and again, or drifts through one query after
 * another, until the iteration cap or the wall clock ends the run. A frontier
 * model reads an "unavailable" answer once and continues; a smaller model
 * does not. The guard makes that difference a host decision: the third call
 * with an input the run already sent, or the call past the budget of one
 * tool, answers a tool error that tells the model to continue with what it
 * has. The service behind the tool never sees the refused call.
 *
 * The guard wraps a list of tools for ONE run. Build it where the tools of
 * the run are built, never at construction of the host, thus the counters
 * start at zero for every run. A terminal tool (one that ends the run) must
 * not be wrapped: a refusal there would strand the run.
 */

import { err, type Result } from "neverthrow";

import type { Tool, ToolContext, ToolError } from "../tools/define-tool.js";

export interface CallGuardPolicy {
    /** The calls with one identical input that a run may make to one tool. The next one is refused. */
    readonly identicalLimit: number;
    /** The calls, with any input, that a run may make to one tool. The next one is refused. */
    readonly perToolLimit: number;
}

/**
 * Two identical calls let a model confirm an answer once. Twelve calls of one
 * tool is above the largest count a frontier planner made in the Phase 0
 * campaign (six and a half calls per plan across ALL tools) and far below the
 * two hundred that a looping planner reached.
 */
export const DEFAULT_CALL_GUARD: CallGuardPolicy = { identicalLimit: 2, perToolLimit: 12 };

/** A stable key for one input: the JSON text with the object keys sorted at every depth. */
export function canonicalInputKey(input: unknown): string {
    return JSON.stringify(sortKeys(input));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
        return out;
    }
    return value;
}

export interface GuardedCallRefusal {
    readonly tool: string;
    readonly kind: "identical" | "budget";
    readonly calls: number;
}

export interface CallGuardOptions {
    readonly policy?: CallGuardPolicy;
    /** Called on each refusal, for the log of the host. */
    readonly onRefusal?: (refusal: GuardedCallRefusal) => void;
}

/** Wrap each tool so its `execute` obeys the policy for the life of the returned list. */
export function guardRepeatedCalls(tools: readonly Tool[], options: CallGuardOptions = {}): Tool[] {
    const policy = options.policy ?? DEFAULT_CALL_GUARD;
    return tools.map((tool) => {
        let calls = 0;
        const byInput = new Map<string, number>();
        const guarded: Tool = {
            ...tool,
            ...(tool.describeCall ? { describeCall: tool.describeCall.bind(tool) } : {}),
            ...(tool.describeResult ? { describeResult: tool.describeResult.bind(tool) } : {}),
            async execute(input: unknown, ctx: ToolContext): Promise<Result<unknown, ToolError>> {
                calls += 1;
                const key = canonicalInputKey(input);
                const identical = (byInput.get(key) ?? 0) + 1;
                byInput.set(key, identical);
                if (identical > policy.identicalLimit) {
                    options.onRefusal?.({ tool: tool.id, kind: "identical", calls: identical });
                    return err({
                        error:
                            `This run already called ${tool.id} with this exact input ${identical - 1} times, and the answer does not change within a run. ` +
                            "Use the answer you have and continue. If the answer was that a resource is absent, plan without it or ask for it; do not search again.",
                        retryable: false,
                    });
                }
                if (calls > policy.perToolLimit) {
                    options.onRefusal?.({ tool: tool.id, kind: "budget", calls });
                    return err({
                        error:
                            `This run made ${policy.perToolLimit} calls of ${tool.id}, which is the budget of one run for one tool. ` +
                            "Continue with what you have. If a required resource is absent, ask for it; do not search again.",
                        retryable: false,
                    });
                }
                return tool.execute(input, ctx);
            },
        };
        return guarded;
    });
}
