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
import type { CheckResponse, KnowledgeClient, KnowledgeRejected, KnowledgeUnavailable } from "./client.js";
import { SituationFieldsSchema, toSituation } from "./situation.js";

export interface KnowledgeCheckDeps {
    readonly client: KnowledgeClient;
}

export type KnowledgeCheckOutput = CheckResponse | KnowledgeUnavailable | KnowledgeRejected;

/** The checks one plan generation may run. Two is a draft and one revision; the third is slack. */
export const CHECK_CALL_LIMIT = 3;

const DraftedStepSchema = z.object({
    step_type: z
        .enum([
            "qc_sample_structure",
            "filter_low_counts",
            "normalize",
            "model_design",
            "differential_expression",
            "shrink_lfc",
            "multiple_testing",
            "enrichment",
            "report",
        ])
        .describe("The kind of work the drafted step does."),
    method: z.string().min(1).describe("The method as the step names it, for example `DESeq2 Wald test` or `edgeR quasi-likelihood`."),
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

export function createKnowledgeCheckTool(deps: KnowledgeCheckDeps) {
    let calls = 0;
    return defineTool({
        id: "knowledge_check",
        description:
            "Check the method steps you drafted for a bulk RNA-seq analysis against the rules of the Inflexa knowledge service, once, after the draft and before `submit_plan`. " +
            "Send the same situation you sent to `knowledge_recommend` and the drafted steps: the step type, the method as the step names it, its package, and its key parameters. " +
            "The answer lists `violations` (a forbidden method, a method outside the permitted set, an inferential test on a flagged design) and `warnings` (a parameter that differs from a sourced default), each with the rule id and the permitted alternatives. " +
            "Revise a violated step once, then submit. `ok: true` means nothing applies. `match: unavailable` means the service did not answer; submit the draft as it is. " +
            `The host accepts ${CHECK_CALL_LIMIT} checks per plan; after that the tool refuses and you submit with the findings you have.`,
        inputSchema: SituationFieldsSchema.extend({
            steps: z.array(DraftedStepSchema).min(1).describe("The drafted method steps, one entry per step type."),
        }),
        describeCall: ({ steps }) => `${steps.length} drafted step(s)`,
        describeResult: (_input, result: KnowledgeCheckOutput) =>
            "ok" in result ? (result.ok ? "ok" : `${result.violations.length} violation(s), ${result.warnings.length} warning(s)`) : result.match,
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
            const answer = await deps.client.check(toSituation(fields), steps);
            return ok(answer);
        },
    });
}
