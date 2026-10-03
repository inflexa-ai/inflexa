/**
 * What one group of LLM calls consumed, from the usage ledger of the server.
 *
 * A token quantity is absent when no call of the group reported it, which is a different fact from a
 * reported `0`. The five quantities are never added together: the cache counts are parts of
 * `inputTokens`, and `reasoningTokens` is a detail of `outputTokens`. `calls` separates "no usage
 * recorded" from "calls recorded whose provider reported no figures".
 */
export type UsageTotals = {
    calls: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningTokens?: number;
};

/**
 * The grouping that `by` of `GET {A}/usage` asks for:
 *
 * - `model` — the served model id. A `null` key is a call whose endpoint reported no served model.
 * - `agent` — the agent id. A sub-agent groups under its own id.
 * - `thread` — the conversation of each chat turn. A run that a conversation started reports under `run`.
 * - `run` — the run. The data profile is not a run, thus it is never a group here.
 * - `step` — the step of the run that `runId` names. A `null` key is a call of the run outside each step.
 */
export type UsageGrouping = "model" | "agent" | "thread" | "run" | "step";

/** One group of a grouping. The `key` is the id of the model, agent, thread, run, or step. */
export type UsageGroup = {
    key: string | null;
    totals: UsageTotals;
};

/**
 * The calls that a usage read covers:
 *
 * - `analysis` — each call of the analysis.
 * - `thread` — one conversation, with each run that it started.
 * - `run` — one run. `runId` is the full id that the `runId` query value matched.
 */
export type UsageScope = { kind: "analysis" } | { kind: "thread"; threadId: string } | { kind: "run"; runId: string };

/** The body of `GET {A}/usage`. */
export type UsageView = {
    scope: UsageScope;
    totals: UsageTotals;
    /**
     * The analysis scope only: the two grains that no `thread` or `run` group holds. The data profile
     * stamps no thread and is not a run. The unattributed calls carry neither frame.
     */
    grains?: { dataProfile: UsageTotals; unattributed: UsageTotals };
    /** The groups of the grouping that `by` asks for, absent without `by`. A grain read orders them by consumption, biggest first. */
    groups?: UsageGroup[];
};

/** The query of `GET {A}/usage`. `threadId` and `runId` exclude each other. `by=step` needs `runId`. */
export type UsageQuery = {
    threadId?: string;
    /** A full run id, or a trailing part of one, matched against the runs with recorded usage. */
    runId?: string;
    by?: UsageGrouping;
};
