/**
 * `knowledge_recommend` — one typed situation in, one plan skeleton out.
 *
 * The description is the whole contract with the planner: when to call, what
 * to send, and where the answer goes (the `grounding` field of each method
 * step). No prompt names this tool. Whether a model calls it from the
 * description alone is a Phase 0 measurement.
 *
 * The model receives one representation. The procedure of the service is
 * folded into `plan_skeleton` (the shape `submit_plan` accepts), and the
 * claims ride beside it, cited by id from the steps. The procedure itself
 * stays out of the tool result: the same fact would otherwise reach the
 * model three times, as a procedure step, as a claim view, and as a skeleton
 * step.
 */

import { ok, type Result } from "neverthrow";

import { defineTool, type ToolError } from "../define-tool.js";
import type { KnowledgeClient, KnowledgeRejected, KnowledgeUnavailable, RecommendResponse } from "./client.js";
import { joinEnvironment, type EnvironmentPaths, type RecommendWithEnvironment } from "./environment.js";
import { SITUATION_EXAMPLE, SituationFieldsSchema, toPreferences, toSituation } from "./situation.js";
import { buildPlanSkeleton, type SkeletonStep } from "./skeleton.js";

export interface KnowledgeRecommendDeps extends EnvironmentPaths {
    readonly client: KnowledgeClient;
    /**
     * Receives each answer the planner sees. The planner keeps the skeleton of
     * the invocation, thus `submit_plan` can restore a grounding field that the
     * model dropped when it copied a skeleton step.
     */
    readonly onAnswer?: (answer: KnowledgeRecommendAnswer) => void;
}

/**
 * The model-facing answer of the tool: the skeleton and the claims, with the
 * envelope of the service and the environment source. Never the procedure.
 */
export interface KnowledgeRecommendAnswer {
    readonly match: RecommendResponse["match"];
    readonly snapshot: RecommendResponse["snapshot"];
    /** The situation as the service normalized it. */
    readonly situation?: Readonly<Record<string, unknown>>;
    readonly flags: RecommendResponse["flags"];
    /** The step types a flag removed. Absent when none. */
    readonly dropped?: readonly string[];
    readonly uncovered: readonly string[];
    readonly environment_source?: RecommendWithEnvironment["environment_source"];
    readonly plan_skeleton: readonly SkeletonStep[];
    readonly claims: RecommendResponse["claims"];
    readonly nearest?: RecommendResponse["nearest"];
    readonly reason?: string;
}

export type KnowledgeRecommendOutput = KnowledgeRecommendAnswer | KnowledgeUnavailable | KnowledgeRejected;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** The one representation: the envelope, the skeleton, and the claims. The procedure stays host-side. */
export function toPlannerAnswer(joined: RecommendWithEnvironment): KnowledgeRecommendAnswer {
    const dropped = stringList(joined.dropped);
    return {
        match: joined.match,
        snapshot: joined.snapshot,
        ...(isRecord(joined.situation) ? { situation: joined.situation } : {}),
        flags: joined.flags,
        ...(dropped ? { dropped } : {}),
        uncovered: joined.uncovered,
        ...(joined.environment_source ? { environment_source: joined.environment_source } : {}),
        plan_skeleton: buildPlanSkeleton(joined),
        claims: joined.claims,
        ...(joined.nearest ? { nearest: joined.nearest } : {}),
        ...(joined.reason !== undefined ? { reason: joined.reason } : {}),
    };
}

export function createKnowledgeRecommendTool(deps: KnowledgeRecommendDeps) {
    return defineTool({
        id: "knowledge_recommend",
        description:
            "Get the cited, versioned procedure for a bulk RNA-seq analysis situation from the Inflexa knowledge service, folded into plan steps: " +
            "which method for each step (QC, filter, normalize, model, test, shrinkage, multiple testing, enrichment, report), " +
            "its settings with their sources, a tested script template per step, the rules that select them, and the evidence. " +
            "Call it BEFORE you draft a method step for bulk RNA-seq differential expression, enrichment, or QC. " +
            "Fill the situation from the Data Context (the design, the replicate counts, the batch structure, the data state, the quality concerns); never send a sample name or a file path. " +
            `Example input: ${SITUATION_EXAMPLE}. ` +
            "The answer holds one representation: `plan_skeleton`, the plan steps with the id, the name, the track, the agent, the packages, the dependencies, " +
            "the constraints, the caveats, the `alternatives`, the `forbids`, the `disputed` sides, the `environment`, and the `grounding` " +
            "(the status, the snapshot, the claim ids, the template, the `settings`, and the reason) filled. " +
            "`claims` holds one view per claim id the steps cite; cite a claim by its id, and never copy its text into the plan. " +
            "Read the answer this way. `match: applicable`: copy each skeleton step into `submit_plan` as it is, including `grounding.settings`, " +
            "then add the question, the acceptance criteria, the resources, and the step budget from the data profile. " +
            "`match: flag`: a rule changes the outcome (for example no replication, or a batch confounded with the condition); " +
            "the skeleton step carries `status: flagged`, the rule id in its reason, and the flag message as its first caveat; obey the flag `outcome`. " +
            "`dropped` lists the steps the procedure removed because a flag removed inference; do not plan them. " +
            "`match: none`: no rule covers the central step; plan that step from your own knowledge with `status: ungrounded` and the reason, and keep the skeleton steps the answer holds. " +
            "`match: unavailable`: the service did not answer; plan as usual and set `status: ungrounded`. " +
            "`match: rejected`: a field was invalid; the answer names the field and the permitted values, so correct the call once. " +
            "A step with `disputed` sides: choose one side and state the choice in the step. " +
            "The `alternatives` of a step are also permitted methods; `forbids` names the method ids the rules forbid for the step. " +
            "A caveat is one of: a warn flag; a parameter conflict between two rules (the step omits that parameter, so state the value you choose and both rule ids); " +
            "a substitution (the template runs a substitute of the method of record, and the step method, package, and template are the substitute; the plan states it); " +
            "a language limit (the requested language has no template that realizes the method for this design; the step keeps the named template, and the plan states the limit). " +
            "A step carries `environment` when the host bound the stores: `package.present` and its version from the farm, and `collection.present` with its path in the reference store. " +
            "That is the environment answer; do not call the listing tools for a package or a collection the answer already reports. " +
            "Call it once per situation; a second call with the same situation gives the same answer.",
        inputSchema: SituationFieldsSchema,
        describeCall: ({ question, n_per_group_min, n_per_group_max, batch }) => `${question}: ${n_per_group_min}-${n_per_group_max} per group, batch ${batch}`,
        describeResult: (_input, result: KnowledgeRecommendOutput) =>
            result.match === "applicable" ? `${result.plan_skeleton.length} steps, ${result.claims.length} claims` : result.match,
        execute: async (input): Promise<Result<KnowledgeRecommendOutput, ToolError>> => {
            const answer = await deps.client.recommend(toSituation(input), "concise", toPreferences(input));
            if (answer.match === "unavailable" || answer.match === "rejected") return ok(answer);
            const joined = await joinEnvironment(answer, {
                ...(deps.farmLockFile ? { farmLockFile: deps.farmLockFile } : {}),
                ...(deps.refStorePath ? { refStorePath: deps.refStorePath } : {}),
            });
            const planner = toPlannerAnswer(joined);
            deps.onAnswer?.(planner);
            return ok(planner);
        },
    });
}
