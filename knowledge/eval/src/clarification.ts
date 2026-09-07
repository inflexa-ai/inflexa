/**
 * The shared clarification policy of the headless runner: what the runner
 * answers when the planner asks a question, and when it stops.
 *
 * The evaluation contract asks for one policy across the arms, logged with
 * its cost, and never an answer from the reference analysis. The policy here
 * is one round with one fixed answer: the sample table the candidate holds is
 * every known fact, and the planner must state its assumption and continue.
 * The answer rides back into the planner as `analystNotes`, the field the
 * tool reserves for facts the user tells it. A second clarification is the
 * terminal outcome of the attempt, `clarification_needed`, because a planner
 * that asks again after that answer has no more facts to receive.
 *
 * The driver is pure over an `invoke` function, thus a test drives it with a
 * fake planner and no harness.
 */

import type { TokenUsageRollup } from "@inflexa-ai/harness";

/** The one answer of the policy. A task cannot change it in Phase 0. */
export const DEFAULT_CLARIFICATION_ANSWER = "The sample table holds every known fact; state your assumption and continue";

/** The rounds the policy answers before a clarification is terminal. */
export const DEFAULT_CLARIFICATION_ROUNDS = 1;

/** The part of the planner output the driver reads. */
export interface PlannerOutputLike {
    readonly event: "plan_complete" | "clarification_needed" | "error";
    readonly question?: string;
    readonly questionContext?: string;
}

/** One invocation of the planner: its output and the usage it consumed. */
export interface PlannerInvocation<T extends PlannerOutputLike> {
    readonly output: T;
    readonly usage: TokenUsageRollup;
}

/** One answered clarification, as the record keeps it: the question, the answer, and the cost of the round that took the answer. */
export interface ClarificationRecord {
    readonly question: string;
    readonly answer: string;
    /** The usage of the invocation that ran with the answer. Absent when no invocation followed. */
    readonly usage?: TokenUsageRollup;
}

export interface ClarificationOptions {
    readonly rounds?: number;
    readonly answer?: string;
}

export interface ClarificationResult<T extends PlannerOutputLike> {
    /** The output of the last invocation. A clarification here is terminal. */
    readonly output: T;
    readonly clarifications: readonly ClarificationRecord[];
    readonly invocations: number;
    /** The usage of every invocation, in order. */
    readonly usages: readonly TokenUsageRollup[];
}

/** The `analystNotes` text of the answered questions, one block per question. */
export function analystNotesFor(answered: readonly ClarificationRecord[]): string {
    return answered.map((entry) => `The planner asked: ${entry.question}\nThe analyst answered: ${entry.answer}`).join("\n\n");
}

/**
 * Drive the planner under the policy. The first invocation runs with no
 * notes. While the output is a clarification and a round remains, the policy
 * answers, and the planner runs again with the answer in `analystNotes`. The
 * loop ends on a plan, on an error, or on a clarification past the rounds.
 */
export async function runWithClarifications<T extends PlannerOutputLike>(
    invoke: (analystNotes: string | undefined) => Promise<PlannerInvocation<T>>,
    options: ClarificationOptions = {},
): Promise<ClarificationResult<T>> {
    const rounds = options.rounds ?? DEFAULT_CLARIFICATION_ROUNDS;
    const answer = options.answer ?? DEFAULT_CLARIFICATION_ANSWER;
    const answered: ClarificationRecord[] = [];
    const usages: TokenUsageRollup[] = [];
    let current = await invoke(undefined);
    usages.push(current.usage);
    while (current.output.event === "clarification_needed" && answered.length < rounds) {
        answered.push({ question: current.output.question ?? "", answer });
        current = await invoke(analystNotesFor(answered));
        usages.push(current.usage);
        // The cost of the answer is the round that consumed it.
        const last = answered.length - 1;
        answered[last] = { ...answered[last]!, usage: current.usage };
    }
    return { output: current.output, clarifications: answered, invocations: usages.length, usages };
}
