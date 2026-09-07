/**
 * Deterministic scores over one run record: the outcome, the plan text
 * expectations of the task, the grounding, the references, the tool calls,
 * and the cost. The judge adds the rubric; this file adds the facts that need
 * no judgment.
 *
 * The grounding is scored per method step against the exact snapshot of the
 * run and against the claims the service returned for the situation of the
 * run. A claim of a plan is `applicable` when a recorded recommend response of
 * the run, on the digest of the run, lists it. A claim that no recorded
 * response returned is `unresolved` until the service is asked on the same
 * digest: then it is `inapplicable` when the snapshot holds it, and
 * `fabricated` when the snapshot answers 404. A record with no recorded
 * response, a service that is absent, or a service that serves another digest
 * leaves such a claim `unresolved`, never `fabricated`.
 */

import type { KnowledgeCall, RunRecord } from "./record.js";
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

/** The evidence state of one claim id of the plan. */
export type ClaimState = "applicable" | "inapplicable" | "unresolved" | "fabricated";

/** The class of one method step, from the states of its claims, its snapshot, and its flag. */
export type StepClass = "grounded_applicable" | "flagged_applicable" | "inapplicable" | "unresolved" | "fabricated" | "ungrounded";

/** What the scorer keeps of one method step, so the step can be classed again after a resolution. */
export interface StepEvidence {
    /** The grounding status the plan states: grounded, flagged, ungrounded, or absent. */
    readonly status: string;
    /** True when the step pins the snapshot digest of the record. */
    readonly pinned: boolean;
    readonly claims: readonly string[];
    /** True when one claim of the step is a flag rule of a recorded response on the digest of the record. */
    readonly flag_rule: boolean;
}

export interface DeterministicScore {
    readonly outcome: string;
    readonly planned: boolean;
    readonly steps: number;
    readonly method_steps: number;
    readonly expectations_met: number;
    readonly expectations_total: number;
    readonly failed_expectations: readonly string[];
    /** Method steps whose stated status is grounded, before any check of the evidence. */
    readonly grounded_steps: number;
    /** Method steps whose stated status is flagged, before any check of the evidence. */
    readonly flagged_steps: number;
    readonly grounded_applicable_steps: number;
    readonly flagged_applicable_steps: number;
    readonly inapplicable_steps: number;
    readonly unresolved_steps: number;
    readonly fabricated_steps: number;
    readonly ungrounded_steps: number;
    /** Applicable method steps over method steps; 0 when the plan has no method step. */
    readonly grounding_share: number;
    /** The snapshot digest of the record; absent in the without arm. */
    readonly snapshot_digest?: string;
    readonly snapshot_pinned_steps: number;
    /** True when the record has a digest and every method step pins it. */
    readonly snapshot_pinned: boolean;
    /** Recorded recommend responses of the run on the digest of the record: the evidence of applicability. */
    readonly evidence_responses: number;
    readonly claims: readonly string[];
    readonly claim_states: Readonly<Record<string, ClaimState>>;
    readonly claims_applicable: number;
    readonly claims_inapplicable: number;
    readonly claims_unresolved: number;
    readonly claims_fabricated: number;
    /** Claims the snapshot holds, applicable or not. Set by a resolution; the report reads it. */
    readonly claims_resolving?: number;
    /** True when the resolution found a service that serves another digest than the record, thus resolved nothing. */
    readonly resolution_snapshot_mismatch: boolean;
    readonly dois_in_plan: readonly string[];
    readonly dois_in_snapshot?: number;
    /** DOIs of the plan that the sources of the snapshot do not hold. Set by a resolution. */
    readonly fabricated_references?: readonly string[];
    readonly step_evidence: readonly StepEvidence[];
    readonly knowledge_recommend_calls: number;
    readonly knowledge_check_calls: number;
    readonly tool_calls: number;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_tokens: number;
    readonly elapsed_s: number;
}

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ruleIds(flags: unknown): string[] {
    if (!Array.isArray(flags)) return [];
    return flags.map((flag) => (isObject(flag) && typeof flag.rule === "string" ? flag.rule : undefined)).filter((rule): rule is string => rule !== undefined);
}

/**
 * The evidence of the run: every recorded recommend response whose snapshot
 * digest is the digest of the record, reduced to the claim ids it returned
 * and the rules of its flags (the top-level flags and the flags of each
 * procedure step). An unavailable or a rejected answer carries no snapshot
 * and adds nothing.
 */
function collectEvidence(calls: readonly KnowledgeCall[], digest: string | undefined): { responses: number; returned: Set<string>; flagRules: Set<string> } {
    const returned = new Set<string>();
    const flagRules = new Set<string>();
    let responses = 0;
    if (digest === undefined) return { responses, returned, flagRules };
    for (const call of calls) {
        if (call.op !== "recommend" || !isObject(call.response)) continue;
        const snapshot = call.response.snapshot;
        if (!isObject(snapshot) || snapshot.digest !== digest) continue;
        responses += 1;
        if (Array.isArray(call.response.claims)) {
            for (const claim of call.response.claims) if (isObject(claim) && typeof claim.id === "string") returned.add(claim.id);
        }
        for (const rule of ruleIds(call.response.flags)) flagRules.add(rule);
        if (Array.isArray(call.response.procedure)) {
            for (const step of call.response.procedure) if (isObject(step)) for (const rule of ruleIds(step.flags)) flagRules.add(rule);
        }
    }
    return { responses, returned, flagRules };
}

/**
 * The class of one method step. The worst claim state decides first: one
 * fabricated claim makes the step fabricated, then one unresolved claim makes
 * it unresolved, then one inapplicable claim makes it inapplicable. A step
 * whose claims are all applicable is applicable only when it pins the digest
 * of the record, and a flagged step only when one of its claims is a flag
 * rule of the evidence. A step with no claim, or with a status that is
 * neither grounded nor flagged, is ungrounded.
 */
export function classifyStep(step: StepEvidence, states: Readonly<Record<string, ClaimState>>): StepClass {
    if ((step.status !== "grounded" && step.status !== "flagged") || step.claims.length === 0) return "ungrounded";
    const claimStates = step.claims.map((claim) => states[claim] ?? "unresolved");
    if (claimStates.includes("fabricated")) return "fabricated";
    if (claimStates.includes("unresolved")) return "unresolved";
    if (claimStates.includes("inapplicable")) return "inapplicable";
    if (!step.pinned) return "inapplicable";
    if (step.status === "flagged" && !step.flag_rule) return "inapplicable";
    return step.status === "grounded" ? "grounded_applicable" : "flagged_applicable";
}

type Counts = Pick<
    DeterministicScore,
    | "grounded_applicable_steps"
    | "flagged_applicable_steps"
    | "inapplicable_steps"
    | "unresolved_steps"
    | "fabricated_steps"
    | "ungrounded_steps"
    | "grounding_share"
    | "claims_applicable"
    | "claims_inapplicable"
    | "claims_unresolved"
    | "claims_fabricated"
>;

/** The step classes and the claim counts from the evidence and the claim states. */
function countEvidence(evidence: readonly StepEvidence[], states: Readonly<Record<string, ClaimState>>): Counts {
    const classes = evidence.map((step) => classifyStep(step, states));
    const count = (target: StepClass): number => classes.filter((value) => value === target).length;
    const claimStates = Object.values(states);
    const claimCount = (target: ClaimState): number => claimStates.filter((value) => value === target).length;
    const applicable = count("grounded_applicable") + count("flagged_applicable");
    return {
        grounded_applicable_steps: count("grounded_applicable"),
        flagged_applicable_steps: count("flagged_applicable"),
        inapplicable_steps: count("inapplicable"),
        unresolved_steps: count("unresolved"),
        fabricated_steps: count("fabricated"),
        ungrounded_steps: count("ungrounded"),
        grounding_share: evidence.length === 0 ? 0 : applicable / evidence.length,
        claims_applicable: claimCount("applicable"),
        claims_inapplicable: claimCount("inapplicable"),
        claims_unresolved: claimCount("unresolved"),
        claims_fabricated: claimCount("fabricated"),
    };
}

export function scoreRun(record: RunRecord, task: Task): DeterministicScore {
    const plan = record.plan as PlanLike | undefined;
    // A clarification request has no plan; its question is the text the task judges.
    const text = plan ? planText(plan) : (record.question ?? "");
    const checks: { readonly label: string; readonly ok: boolean }[] = [
        ...task.must_match.map((pattern) => ({ label: `must match /${pattern}/`, ok: new RegExp(pattern, "i").test(text) })),
        ...task.must_not_match.map((pattern) => ({ label: `must not match /${pattern}/`, ok: !new RegExp(pattern, "i").test(text) })),
    ];
    const steps = plan?.steps ?? [];
    const methodSteps = steps.filter((step) => METHOD_AGENTS.has(step.agent ?? ""));
    const digest = record.snapshot?.digest;
    // An old record has no knowledgeCalls field; it has no evidence, thus every claim stays unresolved.
    const evidence = collectEvidence(record.knowledgeCalls ?? [], digest);
    const claims = [...new Set(steps.flatMap((step) => step.grounding?.claims ?? []))];
    const states: Record<string, ClaimState> = Object.fromEntries(claims.map((claim) => [claim, evidence.returned.has(claim) ? "applicable" : "unresolved"]));
    const stepEvidence: StepEvidence[] = methodSteps.map((step) => {
        const stepClaims = step.grounding?.claims ?? [];
        return {
            status: step.grounding?.status ?? "absent",
            pinned: digest !== undefined && step.grounding?.snapshot === digest,
            claims: stepClaims,
            flag_rule: stepClaims.some((claim) => evidence.flagRules.has(claim)),
        };
    });
    const pinnedSteps = stepEvidence.filter((step) => step.pinned).length;
    const dois = [...new Set(text.match(/10\.\d{4,9}\/[^\s,;)\]"']+/g) ?? [])].map((doi) => doi.replace(/[.]+$/, ""));
    return {
        outcome: record.outcome,
        planned: record.outcome === task.expected_outcome,
        steps: steps.length,
        method_steps: methodSteps.length,
        expectations_met: checks.filter((check) => check.ok).length,
        expectations_total: checks.length,
        failed_expectations: checks.filter((check) => !check.ok).map((check) => check.label),
        grounded_steps: stepEvidence.filter((step) => step.status === "grounded").length,
        flagged_steps: stepEvidence.filter((step) => step.status === "flagged").length,
        ...countEvidence(stepEvidence, states),
        ...(digest !== undefined ? { snapshot_digest: digest } : {}),
        snapshot_pinned_steps: pinnedSteps,
        snapshot_pinned: digest !== undefined && methodSteps.length > 0 && pinnedSteps === methodSteps.length,
        evidence_responses: evidence.responses,
        claims,
        claim_states: states,
        resolution_snapshot_mismatch: false,
        dois_in_plan: dois,
        step_evidence: stepEvidence,
        knowledge_recommend_calls: record.toolCalls.filter((call) => call.name === "knowledge_recommend").length,
        knowledge_check_calls: record.toolCalls.filter((call) => call.name === "knowledge_check").length,
        tool_calls: record.toolCalls.length,
        input_tokens: record.usage.inputTokens ?? 0,
        output_tokens: record.usage.outputTokens ?? 0,
        cache_read_tokens: record.usage.cacheReadInputTokens ?? 0,
        elapsed_s: Math.round(record.elapsedMs / 100) / 10,
    };
}

/**
 * Resolve the unrecorded claims and the DOIs of a score against the served
 * snapshot. Network to the service only.
 *
 * The served digest is read first. When the record has a digest and the
 * service serves another one, nothing is resolved and
 * `resolution_snapshot_mismatch` is set. When the digests agree, each
 * unresolved claim is asked on the service: 200 makes it inapplicable (the
 * snapshot holds it, but no recorded response returned it), 404 makes it
 * fabricated, and a failed fetch leaves it unresolved. A run with no recorded
 * response on its digest has no evidence set, thus its claims stay unresolved.
 * The DOIs of the plan are compared with the sources of the served snapshot
 * when the digests agree, and also when the record has no digest (the without
 * arm), because a DOI is not versioned by a snapshot.
 */
export async function resolveAgainstSnapshot(score: DeterministicScore, serviceUrl: string, serviceKey: string): Promise<DeterministicScore> {
    const headers: Record<string, string> = serviceKey ? { authorization: `Bearer ${serviceKey}` } : {};
    const served = await fetch(`${serviceUrl}/v1/snapshot`)
        .then((response) => (response.ok ? (response.json() as Promise<{ digest?: string }>) : undefined))
        .catch(() => undefined);
    if (typeof served?.digest !== "string") return score;
    if (score.snapshot_digest !== undefined && served.digest !== score.snapshot_digest) {
        return { ...score, resolution_snapshot_mismatch: true };
    }

    const states: Record<string, ClaimState> = { ...score.claim_states };
    if (score.snapshot_digest !== undefined && score.evidence_responses > 0) {
        for (const claim of score.claims) {
            if (states[claim] !== "unresolved") continue;
            const response = await fetch(`${serviceUrl}/v1/claims/${encodeURIComponent(claim)}`, { headers }).catch(() => undefined);
            if (response?.ok) states[claim] = "inapplicable";
            else if (response?.status === 404) states[claim] = "fabricated";
        }
    }
    const counts = countEvidence(score.step_evidence, states);

    const sources = await fetch(`${serviceUrl}/v1/sources`, { headers })
        .then((response) => (response.ok ? (response.json() as Promise<{ doi?: string }[]>) : undefined))
        .catch(() => undefined);
    const known = new Set((sources ?? []).map((source) => source.doi?.toLowerCase()).filter((doi): doi is string => doi !== undefined));
    const fabricated = score.dois_in_plan.filter((doi) => !known.has(doi.toLowerCase()));

    return {
        ...score,
        ...counts,
        claim_states: states,
        claims_resolving: counts.claims_applicable + counts.claims_inapplicable,
        ...(sources ? { dois_in_snapshot: score.dois_in_plan.length - fabricated.length, fabricated_references: fabricated } : {}),
    };
}
