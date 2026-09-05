/**
 * Deterministic scores over one run record: the outcome, the plan text
 * expectations of the task, the grounding, the references, the tool calls,
 * and the cost. The judge adds the rubric; this file adds the facts that need
 * no judgment.
 */

import type { RunRecord } from "./run.js";
import type { Task } from "./tasks.js";

export interface PlanStepLike {
    readonly id?: string;
    readonly name?: string;
    readonly agent?: string;
    readonly question?: string;
    readonly description?: string;
    readonly context?: string;
    readonly constraints?: readonly string[];
    readonly acceptance_criteria?: readonly string[];
    readonly caveats?: readonly string[];
    readonly packages?: readonly string[];
    readonly grounding?: { readonly status?: string; readonly snapshot?: string; readonly claims?: readonly string[]; readonly template?: string; readonly reason?: string };
}

export interface PlanLike {
    readonly title?: string;
    readonly analytical_narrative?: string;
    readonly steps?: readonly PlanStepLike[];
}

const METHOD_AGENTS = new Set(["bulk-transcriptomics-agent", "enrichment-agent", "statistical-modeling-agent"]);

export function planText(plan: PlanLike | undefined): string {
    if (!plan) return "";
    const parts: string[] = [plan.title ?? "", plan.analytical_narrative ?? ""];
    for (const step of plan.steps ?? []) {
        parts.push(
            step.name ?? "",
            step.question ?? "",
            step.description ?? "",
            step.context ?? "",
            ...(step.constraints ?? []),
            ...(step.acceptance_criteria ?? []),
            ...(step.caveats ?? []),
            ...(step.packages ?? []),
            step.grounding?.reason ?? "",
        );
    }
    return parts.join("\n");
}

export interface DeterministicScore {
    readonly outcome: string;
    readonly planned: boolean;
    readonly steps: number;
    readonly method_steps: number;
    readonly expectations_met: number;
    readonly expectations_total: number;
    readonly failed_expectations: readonly string[];
    readonly grounded_steps: number;
    readonly flagged_steps: number;
    readonly ungrounded_steps: number;
    readonly grounding_share: number;
    readonly claims: readonly string[];
    readonly claims_resolving?: number;
    readonly snapshot_pinned: boolean;
    readonly dois_in_plan: readonly string[];
    readonly dois_in_snapshot?: number;
    readonly knowledge_recommend_calls: number;
    readonly knowledge_check_calls: number;
    readonly tool_calls: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_tokens: number;
    readonly elapsed_s: number;
}

export function scoreRun(record: RunRecord, task: Task): DeterministicScore {
    const plan = record.plan as PlanLike | undefined;
    const text = planText(plan);
    const checks: { readonly label: string; readonly ok: boolean }[] = [
        ...task.must_match.map((pattern) => ({ label: `must match /${pattern}/`, ok: new RegExp(pattern, "i").test(text) })),
        ...task.must_not_match.map((pattern) => ({ label: `must not match /${pattern}/`, ok: !new RegExp(pattern, "i").test(text) })),
    ];
    const steps = plan?.steps ?? [];
    const methodSteps = steps.filter((step) => METHOD_AGENTS.has(step.agent ?? ""));
    const grounded = methodSteps.filter((step) => step.grounding?.status === "grounded" && (step.grounding.claims?.length ?? 0) > 0);
    const flagged = methodSteps.filter((step) => step.grounding?.status === "flagged");
    const claims = [...new Set(steps.flatMap((step) => step.grounding?.claims ?? []))];
    const dois = [...new Set(text.match(/10\.\d{4,9}\/[^\s,;)\]"']+/g) ?? [])].map((doi) => doi.replace(/[.]+$/, ""));
    const snapshotPinned = record.snapshot !== undefined && steps.some((step) => step.grounding?.snapshot === record.snapshot?.digest);
    return {
        outcome: record.outcome,
        planned: record.outcome === "plan_submitted",
        steps: steps.length,
        method_steps: methodSteps.length,
        expectations_met: checks.filter((check) => check.ok).length,
        expectations_total: checks.length,
        failed_expectations: checks.filter((check) => !check.ok).map((check) => check.label),
        grounded_steps: grounded.length,
        flagged_steps: flagged.length,
        ungrounded_steps: methodSteps.length - grounded.length - flagged.length,
        grounding_share: methodSteps.length === 0 ? 0 : (grounded.length + flagged.length) / methodSteps.length,
        claims,
        snapshot_pinned: snapshotPinned,
        dois_in_plan: dois,
        knowledge_recommend_calls: record.toolCalls.filter((call) => call.name === "knowledge_recommend").length,
        knowledge_check_calls: record.toolCalls.filter((call) => call.name === "knowledge_check").length,
        tool_calls: record.toolCalls.length,
        input_tokens: record.usage.inputTokens ?? 0,
        output_tokens: record.usage.outputTokens ?? 0,
        cache_read_tokens: record.usage.cacheReadInputTokens ?? 0,
        elapsed_s: Math.round(record.elapsedMs / 100) / 10,
    };
}

/** Resolve each claim and each DOI against the served snapshot. Network to the service only. */
export async function resolveAgainstSnapshot(score: DeterministicScore, serviceUrl: string, serviceKey: string): Promise<DeterministicScore> {
    const headers: Record<string, string> = serviceKey ? { authorization: `Bearer ${serviceKey}` } : {};
    let resolving = 0;
    for (const claim of score.claims) {
        const response = await fetch(`${serviceUrl}/v1/claims/${encodeURIComponent(claim)}`, { headers }).catch(() => undefined);
        if (response?.ok) resolving += 1;
    }
    const sources = await fetch(`${serviceUrl}/v1/sources`, { headers })
        .then((response) => (response.ok ? (response.json() as Promise<{ doi?: string }[]>) : []))
        .catch(() => [] as { doi?: string }[]);
    const known = new Set(sources.map((source) => source.doi?.toLowerCase()).filter((doi): doi is string => doi !== undefined));
    const inSnapshot = score.dois_in_plan.filter((doi) => known.has(doi.toLowerCase())).length;
    return { ...score, claims_resolving: resolving, dois_in_snapshot: inSnapshot };
}
