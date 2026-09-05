/**
 * `knowledge_recommend` — one typed situation in, one cited procedure out.
 *
 * The description is the whole contract with the planner: when to call, what
 * to send, and where the answer goes (the `grounding` field of each method
 * step). No prompt names this tool. Whether a model calls it from the
 * description alone is a Phase 0 measurement.
 */

import { ok, type Result } from "neverthrow";

import { defineTool, type ToolError } from "../define-tool.js";
import type { KnowledgeClient, KnowledgeRejected, KnowledgeUnavailable } from "./client.js";
import { joinEnvironment, type EnvironmentPaths, type RecommendWithEnvironment } from "./environment.js";
import { SITUATION_EXAMPLE, SituationFieldsSchema, toPreferences, toSituation } from "./situation.js";
import { buildPlanSkeleton, type SkeletonStep } from "./skeleton.js";

export interface KnowledgeRecommendDeps extends EnvironmentPaths {
    readonly client: KnowledgeClient;
}

export type KnowledgeRecommendOutput =
    (RecommendWithEnvironment & { readonly plan_skeleton?: readonly SkeletonStep[] }) | KnowledgeUnavailable | KnowledgeRejected;

export function createKnowledgeRecommendTool(deps: KnowledgeRecommendDeps) {
    return defineTool({
        id: "knowledge_recommend",
        description:
            "Get the cited, versioned procedure for a bulk RNA-seq analysis situation from the Inflexa knowledge service: " +
            "which method for each step (QC, filter, normalize, model, test, shrinkage, multiple testing, enrichment, report), " +
            "its parameters with their sources, a tested script template per step, the rules that select them, and the evidence. " +
            "Call it BEFORE you draft a method step for bulk RNA-seq differential expression, enrichment, or QC. " +
            "Fill the situation from the Data Context (the design, the replicate counts, the batch structure, the data state, the quality concerns); never send a sample name or a file path. " +
            `Example input: ${SITUATION_EXAMPLE}. ` +
            "Read the answer this way. `match: applicable`: draft the steps on the returned procedure, and put into the `grounding` field of each method step " +
            "`status: grounded`, the `snapshot.digest`, the claim ids of the step (`rules`), the step `template` when one is named, and a one-line reason. " +
            "`match: flag`: a rule changes the outcome (for example no replication, or a batch confounded with the condition); obey the flag `outcome`, and set `status: flagged` with the rule id. " +
            "`match: none`: no rule covers the central step; plan from your own knowledge and set `status: ungrounded` with the reason. " +
            "`match: unavailable`: the service did not answer; plan as usual and set `status: ungrounded`. " +
            "`match: rejected`: a field was invalid; the answer names the field and the permitted values, so correct the call once. " +
            "A step with `disputed` sides: choose one side and state the choice in the step. A step `flags` entry with severity warn is a caveat for that step. " +
            "The `alternatives` of a step are also permitted methods. `dropped` lists the steps the procedure removed because a flag removed inference; do not plan them. " +
            "Each step carries `environment` when the host bound the stores: `package.present` and its version from the farm, and `collection.present` with its path in the reference store. " +
            "That is the environment answer; do not call the listing tools for a package or a collection the answer already reports. " +
            "`plan_skeleton` is the procedure folded into plan steps with the id, the name, the track, the agent, the packages, the dependencies, the constraints, the caveats, and the grounding filled. " +
            "Copy each skeleton step into `submit_plan` as it is, then add the question, the acceptance criteria, the resources, and the step budget from the data profile. " +
            "Call it once per situation; a second call with the same situation gives the same answer.",
        inputSchema: SituationFieldsSchema,
        describeCall: ({ question, n_per_group_min, n_per_group_max, batch }) => `${question}: ${n_per_group_min}-${n_per_group_max} per group, batch ${batch}`,
        describeResult: (_input, result: KnowledgeRecommendOutput) =>
            result.match === "applicable" ? `${result.procedure.length} steps, ${result.claims.length} claims` : result.match,
        execute: async (input): Promise<Result<KnowledgeRecommendOutput, ToolError>> => {
            const answer = await deps.client.recommend(toSituation(input), "concise", toPreferences(input));
            if (answer.match !== "applicable" && answer.match !== "flag") return ok(answer);
            const joined = await joinEnvironment(answer, {
                ...(deps.farmLockFile ? { farmLockFile: deps.farmLockFile } : {}),
                ...(deps.refStorePath ? { refStorePath: deps.refStorePath } : {}),
            });
            return ok({ ...joined, plan_skeleton: buildPlanSkeleton(joined) });
        },
    });
}
