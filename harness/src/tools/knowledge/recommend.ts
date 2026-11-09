/**
 * `knowledge_recommend` — one typed situation in, one plan skeleton out.
 *
 * The description is the whole contract with the planner: when to call, what
 * to send, and where the answer goes (the `grounding` field of each method
 * step). No prompt names this tool. Whether a model calls it from the
 * description alone is a Phase 0 measurement.
 *
 * The model receives one representation. The procedure of the service is
 * folded into `plan_skeleton` (the shape `submit_plan` accepts), and a
 * heading of each claim rides beside it, cited by id from the steps. The
 * procedure itself stays out of the tool result: the same fact would
 * otherwise reach the model three times, as a procedure step, as a claim
 * view, and as a skeleton step.
 *
 * The statement and the evidence of a claim stay in the call record. The
 * full views of one answer hold about three quarters of its text, and a
 * result past the cut of the loop reaches the model as an excerpt only.
 * `knowledge_claims` gives a full view on demand.
 */

import { ok, type Result } from "neverthrow";
import type { z } from "zod";

import { parseUnknownRecord } from "../../lib/unknown-containers.js";

import type { EnvironmentStorePaths } from "../../config/environment-stores.js";
import { defineTool, withToolCallRecord, type Tool, type ToolError, type WithToolCallRecord } from "../define-tool.js";
import type { KnowledgeClient, KnowledgeRejected, KnowledgeSnapshotMismatch, KnowledgeUnavailable, RecommendResponse } from "./client.js";
import type { ClaimShelf, KeptClaim } from "./claims.js";
import type { SnapshotPin } from "./pin.js";
import { joinEnvironment, type EnvironmentPaths, type RecommendWithEnvironment } from "./environment.js";
import { SITUATION_EXAMPLE, SituationFieldsSchema, toPreferences, toSituation } from "./situation.js";
import { buildPlanSkeleton, type SkeletonStep } from "./skeleton.js";

export type KnowledgeRecommendDeps = Omit<EnvironmentPaths, "farmLockFile"> & {
    readonly client: KnowledgeClient;
    /** Host path of the farm `inflexa.lock`, or its resolver for each analysis. Absent, the packages read as unknown. */
    readonly farmLockFile?: EnvironmentStorePaths["farmLockFile"];
    /**
     * Receives each answer the planner saw, after the round of its call, on the
     * first run and on each replay alike. The planner keeps the skeleton of the
     * invocation, thus `submit_plan` can restore a grounding field that the
     * model dropped when it copied a skeleton step.
     */
    readonly onAnswer?: (answer: KnowledgeRecommendAnswer) => void;
    /** Keeps the full view of each claim of each answer, after the round of its call, for `knowledge_claims`. */
    readonly shelf: ClaimShelf;
    /**
     * The release of the plan. The first answer sets it after the round of its
     * call, and each later call of this tool and of `knowledge_check` sends it,
     * thus a service that moved to another release between two calls refuses
     * instead of mixing releases.
     */
    readonly pin?: SnapshotPin;
};

/**
 * The answer that the host keeps: the skeleton and the full view of each
 * claim, with the envelope of the service and the environment source. Never
 * the procedure. The model reads it as a `KnowledgeRecommendView`.
 */
export type KnowledgeRecommendAnswer = {
    readonly match: RecommendResponse["match"];
    readonly snapshot: RecommendResponse["snapshot"];
    /** The situation as the service normalized it. */
    readonly situation?: Readonly<Record<string, unknown>>;
    readonly flags: RecommendResponse["flags"];
    /** The step types a flag removed. Absent when none. */
    dropped?: readonly string[];
    readonly uncovered: readonly string[];
    /** The step types whose method has no eligible template: covered by the knowledge, not by a vetted script. Absent when none. */
    unrealized?: readonly string[];
    readonly environment_source?: RecommendWithEnvironment["environment_source"];
    readonly plan_skeleton: readonly SkeletonStep[];
    readonly claims: RecommendResponse["claims"];
    nearest?: RecommendResponse["nearest"];
    reason?: string;
};

/** The heading of a claim that the model reads. The statement and the evidence are on demand, through `knowledge_claims`. */
export type ClaimHeading = {
    readonly id: string;
    readonly title?: string;
    /** Present only when the claim has no title, thus each heading carries a text. */
    readonly statement?: string;
    readonly strength: string;
    readonly severity?: string;
};

/** The model-facing answer: the kept answer, with a heading of each claim in place of its view. */
export type KnowledgeRecommendView = Omit<KnowledgeRecommendAnswer, "claims"> & { readonly claims: readonly ClaimHeading[] };

export type KnowledgeRecommendOutput =
    | WithToolCallRecord<KnowledgeRecommendView, KnowledgeRecommendAnswer>
    | KnowledgeUnavailable
    | KnowledgeRejected
    | KnowledgeSnapshotMismatch;

function stringList(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? [item] : [])) : undefined;
}

/** The one representation: the envelope, the skeleton, and the claims. The procedure stays host-side. */
export function toPlannerAnswer(joined: RecommendWithEnvironment): KnowledgeRecommendAnswer {
    const answer: KnowledgeRecommendAnswer = {
        match: joined.match,
        snapshot: joined.snapshot,
        situation: parseUnknownRecord(joined.situation),
        flags: joined.flags,
        uncovered: joined.uncovered,
        environment_source: joined.environment_source,
        plan_skeleton: buildPlanSkeleton(joined),
        claims: joined.claims,
    };
    const dropped = stringList(joined.dropped);
    const unrealized = stringList(joined.unrealized);
    if (dropped) answer.dropped = dropped;
    if (unrealized && unrealized.length > 0) answer.unrealized = unrealized;
    if (joined.nearest) answer.nearest = joined.nearest;
    if (joined.reason !== undefined) answer.reason = joined.reason;
    return answer;
}

function headingOf(claim: KeptClaim): ClaimHeading {
    return {
        id: claim.id,
        title: claim.title,
        statement: claim.title === undefined ? claim.statement : undefined,
        strength: claim.strength,
        severity: claim.severity,
    };
}

/** The answer as the model reads it: a heading of each claim, and each other field as the host keeps it. */
export function toModelView(answer: KnowledgeRecommendAnswer): KnowledgeRecommendView {
    return { ...answer, claims: answer.claims.map(headingOf) };
}

export function createKnowledgeRecommendTool(deps: KnowledgeRecommendDeps): Tool<z.infer<typeof SituationFieldsSchema>, KnowledgeRecommendOutput> {
    return defineTool({
        id: "knowledge_recommend",
        description:
            "Get the cited, versioned procedure for an expression analysis situation (bulk RNA-seq, a microarray, or a TempO-Seq panel) from the Inflexa knowledge service, folded into plan steps: " +
            "which method for each step (for example QC, filter, normalize, model, test, shrinkage, multiple testing, enrichment, dose-response fit, point of departure, report), " +
            "its settings with their sources, a tested script template per step, and the rules that select them. " +
            "Call it BEFORE you draft a method step for a differential expression, an enrichment, a QC, a dose response, or any other question that `question` names. " +
            "Fill the situation from the Data Context (the design, the replicate counts, the batch structure, the data state, the quality concerns); never send a sample name or a file path. " +
            `Example input: ${SITUATION_EXAMPLE}. ` +
            "The answer holds one representation: `plan_skeleton`, the plan steps with the id, the name, the track, the agent, the packages, the dependencies, " +
            "the caveats, the `alternatives`, the `forbids`, the `disputed` sides, the `environment`, and the `grounding` " +
            "(the status, the snapshot, the claim ids, the template, the `settings`, and the reason) filled. " +
            "`claims` holds the id, the title, the strength, and the severity of each claim the steps cite; `knowledge_claims` gives the statement and the evidence of a claim on demand. " +
            "Cite a claim by its id, and never copy its text into the plan. " +
            "Read the answer this way. `match: applicable`: copy each skeleton step into `submit_plan` as it is, including `grounding.settings`, " +
            "then add the question, the acceptance criteria, the resources, and the step budget from the data profile. " +
            "A skeleton step is the vetted default, not the only permitted method. When the design or the question does not fit its method, plan the step with your method: " +
            "set `grounding.status: ungrounded`, keep the snapshot digest, cite no claim, and give the reason for the departure in `grounding.reason`. A departure the plan states is not a fault; a silent one is. " +
            "When the step keeps its method and a setting or a part of a cited rule does not fit the data, keep the step grounded and add one entry to `grounding.departures` " +
            "with the claim id, the setting, your value (or no value when the plan does not apply the setting), and the reason; the host binds your value in place of the value of the rule. " +
            "`match: flag`: a rule changes the outcome (for example no replication, or a batch confounded with the condition); " +
            "the skeleton step carries `status: flagged`, the rule id in its reason, and the flag message as its first caveat; obey the flag `outcome`. " +
            "`dropped` lists the steps the procedure removed, because a flag removed inference or because the script of the test runs no such step (the shrinkage of limma and edgeR); do not plan them. " +
            "`unrealized` lists the steps whose method has no vetted script template for this design; the skeleton step keeps the method and the claims, its caveat names the gap, " +
            "and the plan states that the step runs without a vetted template instead of an invented one. " +
            "`match: none`: no rule covers the central step; plan that step from your own knowledge with `status: ungrounded` and the reason, and keep the skeleton steps the answer holds. " +
            "`match: unavailable`: the service did not answer; plan as usual and set `status: ungrounded`. " +
            "`match: rejected`: a field was invalid; the answer names the field and the permitted values, so correct the call once. " +
            "A step with `disputed` sides: choose one side and state the choice in the step. " +
            "The `alternatives` of a step are also vetted methods; `forbids` names the method ids the rules forbid for the step, and a forbidden method stays forbidden. " +
            "A caveat is one of: a warn flag; a parameter conflict between two rules (the step omits that parameter, so state the value you choose and both rule ids); " +
            "a substitution (the template runs a substitute of the method of record, and the step method, package, and template are the substitute; the plan states it); " +
            "a language limit (the requested language has no template that realizes the method for this design, or its template refuses a value of the rules; the step keeps the named template, and the plan states the limit). " +
            "A step carries `environment` when the host bound the stores. `package.state` is `installed` (the sandbox loads it now, at `version`), " +
            "`in_store` (the package store holds it at `version`, and the launch links it when the step names it in `packages`), or `absent` (neither holds it); " +
            "`package.entry`, when present, is the `packages` entry to write, because the store holds the name in two tracks. " +
            "A package with no `state` has a store the host could not read. `collection.present` gives the collection with its path in the reference store. " +
            "That is the environment answer; do not call the listing tools for a package or a collection the answer already reports. " +
            "Call it once per situation; a second call with the same situation gives the same answer.",
        inputSchema: SituationFieldsSchema,
        view: "none",
        describeCall: ({ question, n_per_group_min, n_per_group_max, batch }) => `${question}: ${n_per_group_min}-${n_per_group_max} per group, batch ${batch}`,
        describeResult: (_input, result: KnowledgeRecommendOutput) =>
            result.match === "applicable" ? `${result.plan_skeleton.length} steps, ${result.claims.length} claims` : result.match,
        execute: async (input, ctx): Promise<Result<KnowledgeRecommendOutput, ToolError>> => {
            const answer = await deps.client.recommend(toSituation(input), "concise", toPreferences(input), deps.pin?.get());
            if (answer.match === "unavailable" || answer.match === "rejected" || answer.match === "snapshot_mismatch") return ok(answer);
            deps.pin?.set(answer.snapshot.digest);
            const farmLockFile = typeof deps.farmLockFile === "function" ? deps.farmLockFile(ctx.session.scope.analysisId) : deps.farmLockFile;
            const joined = await joinEnvironment(answer, {
                farmLockFile,
                imagePackagesFile: deps.imagePackagesFile,
                refStorePath: deps.refStorePath,
                readPoolInventory: deps.readPoolInventory,
            });
            const planner = toPlannerAnswer(joined);
            // The model reads the headings, and the call record keeps the full answer. The pin, the shelf, and
            // the memory of the planner fold the record after the round, thus a replay of the recorded result sets all three.
            return ok(withToolCallRecord(toModelView(planner), planner));
        },
        foldCallRecord: (answer) => {
            deps.pin?.set(answer.snapshot.digest);
            deps.shelf.keep(answer.claims);
            deps.onAnswer?.(answer);
        },
    });
}
