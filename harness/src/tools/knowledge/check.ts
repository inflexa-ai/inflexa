/**
 * `knowledge_check` — the drafted steps against the rules, once, before
 * `submit_plan`. A violation names the rule and the permitted alternatives.
 * The planner revises once. There is no loop: the host counts the calls of
 * one plan generation, and past `CHECK_CALL_LIMIT` the tool answers with a
 * typed refusal and never reaches the service. A small model that cannot
 * satisfy a finding otherwise rephrases the step until the plan times out.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolError } from "../define-tool.js";
import type { CheckResponse, KnowledgeClient, KnowledgeRejected, KnowledgeSnapshotMismatch, KnowledgeUnavailable } from "./client.js";
import type { SnapshotPin } from "./pin.js";
import { SituationFieldsSchema, toSituation } from "./situation.js";

export interface KnowledgeCheckDeps {
    readonly client: KnowledgeClient;
    /** The release the plan pinned on its first recommend answer. The check sends it, thus another release refuses the call. */
    readonly pin?: SnapshotPin;
}

export type KnowledgeCheckOutput = CheckResponse | KnowledgeUnavailable | KnowledgeRejected | KnowledgeSnapshotMismatch;

/** The checks one plan generation may run. Two is a draft and one revision; the third is slack. */
export const CHECK_CALL_LIMIT = 3;

const DraftedStepSchema = z.object({
    step_type: z
        .enum([
            "cohort_assembly",
            "qc_sample_structure",
            "filter_low_counts",
            "normalize",
            "model_design",
            "differential_expression",
            "shrink_lfc",
            "multiple_testing",
            "enrichment",
            "variance_partition",
            "tf_activity",
            "pathway_activity",
            "signature_scoring",
            "deconvolution",
            "coexpression",
            "clustering",
            "survival",
            "transcript_level",
            "annotation",
            "report",
        ])
        .describe("The kind of work the drafted step does."),
    method: z.string().min(1).describe("The method as the step names it, for example `DESeq2 Wald test` or `edgeR quasi-likelihood`."),
    method_id: z
        .string()
        .regex(/^M-\d{4}$/)
        .optional()
        .describe(
            "The `method.id` of the step in the `knowledge_recommend` answer (for example `M-0001`), copied when the step uses that method. With it the check matches the method exactly and ignores the wording.",
        ),
    package: z.string().optional().describe("The main package of the step, for example `DESeq2`."),
    parameters: z
        .array(z.object({ name: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) }))
        .optional()
        .describe("The key parameters of the step, for example `alpha`, `min_count`, `lfc_shrink`, `rank_metric`."),
    outcome: z
        .string()
        .optional()
        .describe("The outcome the step states when a flag of `knowledge_recommend` removes inference, copied from the flag, for example `descriptive_only`."),
});

/** `ok`, or the counts of the findings, plus the steps the check did not assess when there are any. */
function describeFindings(result: CheckResponse): string {
    const findings = result.ok ? "ok" : `${result.violations.length} violation(s), ${result.warnings.length} warning(s)`;
    const notAssessed = result.not_assessed?.length ?? 0;
    return notAssessed > 0 ? `${findings}, ${notAssessed} not assessed` : findings;
}

export function createKnowledgeCheckTool(deps: KnowledgeCheckDeps) {
    let calls = 0;
    return defineTool({
        id: "knowledge_check",
        description:
            "Check the method steps you drafted for a bulk RNA-seq analysis against the rules of the Inflexa knowledge service, once, after the draft and before `submit_plan`. " +
            "Send the same situation you sent to `knowledge_recommend` and the drafted steps: the step type, the method as the step names it, its package, and its key parameters. " +
            "The answer lists `violations` (a forbidden method, or an inferential test on a design that a flag limits) and `warnings` (a method outside the set the rules name, a parameter that differs from a sourced default, or a required parameter that the step does not state), each with the rule id and the permitted alternatives. " +
            "Revise a violated step once, then submit. A warning is advice: keep the step when the data gives a reason, and state the reason in the step. `ok: true` means no finding on the assessed steps. " +
            "`not_assessed` lists the steps that no rule covers; the check neither passed nor failed them, so submit them as drafted. " +
            "`match: unavailable` means the service did not answer, and `match: snapshot_mismatch` means the service moved to another release than the one your recommend answer came from; in both cases submit the draft as it is. " +
            `The host accepts ${CHECK_CALL_LIMIT} checks per plan; after that the tool refuses and you submit with the findings you have.`,
        inputSchema: SituationFieldsSchema.extend({
            steps: z.array(DraftedStepSchema).min(1).describe("The drafted method steps, one entry per step type."),
        }),
        describeCall: ({ steps }) => `${steps.length} drafted step(s)`,
        describeResult: (_input, result: KnowledgeCheckOutput) => ("ok" in result ? describeFindings(result) : result.match),
        execute: async (input): Promise<Result<KnowledgeCheckOutput, ToolError>> => {
            calls += 1;
            if (calls > CHECK_CALL_LIMIT) {
                return ok({
                    match: "rejected",
                    message: `The host accepts ${CHECK_CALL_LIMIT} checks per plan, and this is call ${calls}. Submit the plan with the findings of the last check.`,
                    issues: [],
                });
            }
            const { steps, ...fields } = input;
            const answer = await deps.client.check(toSituation(fields), steps, deps.pin?.get());
            return ok(answer);
        },
    });
}
