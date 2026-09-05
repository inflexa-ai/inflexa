/**
 * The wire contract of the knowledge service.
 *
 * Three operations, one situation schema, one response envelope. The harness
 * keeps its own copy of these shapes, because the two subsystems are
 * independent packages. The digest of this file is the tool definition hash
 * of a snapshot, thus a change here changes the snapshot identity.
 *
 *   POST /v1/recommend        { situation, response_format? }      -> RecommendResponse
 *   POST /v1/check            { situation, steps }                 -> CheckResponse
 *   POST /v1/template/render  { template, slots, farm? }           -> RenderResponse | 400 validation
 *   GET  /v1/snapshot                                              -> SnapshotMeta
 *   GET  /v1/claims/{claim}                                        -> Claim | 404
 *   GET  /v1/templates/{id}                                        -> TemplateContract | 404
 *   GET  /v1/sources                                               -> the locators of every source of the snapshot
 *
 * Every request carries `Authorization: Bearer <key>` when the service holds a
 * key. A validation failure is a 400 whose body names the field and the
 * permitted values, thus a model corrects itself in one turn.
 */

import { z } from "zod";

import { SituationSchema, StepTypeEnum } from "../model.js";
import type { Situation, StepType, TemplateParameter } from "../model.js";
import type { CheckFinding } from "../engine/check.js";
import type { ProcedureFlag, ProcedureStep } from "../engine/procedure.js";
import type { NearMiss } from "../engine/rules.js";
import type { EnvironmentReport } from "../render/environment.js";
import type { SlotIssue, SlotReportEntry } from "../render/render.js";
import type { SyntaxCheck } from "../render/syntax.js";

export const ResponseFormatEnum = z.enum(["concise", "detailed"]);

export const RecommendRequestSchema = z.object({
    situation: SituationSchema,
    response_format: ResponseFormatEnum.optional(),
});
export type RecommendRequest = z.infer<typeof RecommendRequestSchema>;

export const DraftedStepSchema = z.object({
    step_type: StepTypeEnum,
    method: z.string().min(1),
    package: z.string().optional(),
    parameters: z.array(z.object({ name: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
    outcome: z.string().optional(),
});

export const CheckRequestSchema = z.object({
    situation: SituationSchema,
    steps: z.array(DraftedStepSchema).min(1),
});
export type CheckRequest = z.infer<typeof CheckRequestSchema>;

export const FarmPackageSchema = z.object({ name: z.string().min(1), version: z.string().min(1) });

export const RenderRequestSchema = z.object({
    /** `tpl-deseq2-two-group@1.4.0`, or the bare id for the served version. */
    template: z.string().regex(/^tpl-[a-z0-9-]+(@\d+\.\d+\.\d+)?$/),
    slots: z.record(z.string(), z.unknown()),
    /** The package versions of the farm, added by the tool and not by the model. */
    farm: z.array(FarmPackageSchema).optional(),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export interface EvidenceView {
    readonly doi?: string;
    readonly pmid?: string;
    readonly url?: string;
    readonly title: string;
    readonly year: number;
    readonly direction: "supports" | "disputes" | "neutral";
    readonly eco?: string;
    readonly paraphrase?: string;
    readonly span?: string;
    readonly anchor?: string;
}

export interface ClaimView {
    readonly id: string;
    readonly rule: string;
    readonly title: string;
    readonly statement: string;
    readonly step_type: StepType;
    readonly severity: "info" | "warn" | "flag";
    readonly strength: "consensus" | "common_practice" | "disputed";
    readonly evidence_quality: "high" | "moderate" | "low";
    readonly recommendation_strength: "strong" | "conditional";
    readonly evidence: readonly EvidenceView[];
    readonly alternatives?: readonly { readonly method: string; readonly when: string }[];
    readonly disputed_sides?: readonly string[];
    readonly status: "active" | "scheduled_for_deprecation" | "deprecated";
    readonly replaced_by?: string;
    readonly license: string;
}

export interface SnapshotRef {
    readonly date: string;
    readonly digest: string;
}

export interface RecommendResponse {
    readonly match: "applicable" | "none" | "flag";
    readonly snapshot: SnapshotRef;
    readonly situation: Situation;
    readonly procedure: readonly ProcedureStep[];
    readonly uncovered: readonly StepType[];
    readonly flags: readonly ProcedureFlag[];
    readonly claims: readonly ClaimView[];
    readonly nearest?: readonly NearMiss[];
    readonly reason?: string;
}

export interface CheckResponse {
    readonly ok: boolean;
    readonly snapshot: SnapshotRef;
    readonly violations: readonly CheckFinding[];
    readonly warnings: readonly CheckFinding[];
}

export interface DecisionRecord {
    readonly schema: "inflexa.decision_record/0.1";
    readonly template: { readonly id: string; readonly version: string; readonly label: string; readonly method: string };
    readonly snapshot: SnapshotRef;
    readonly rendered_at: string;
    readonly slots: readonly SlotReportEntry[];
    readonly environment: EnvironmentReport;
    readonly syntax: SyntaxCheck;
    readonly citations: readonly EvidenceView[];
    /** Each residual change through `edit_file`, listed by the tool that applied it. Empty at render time. */
    readonly unvetted_edits: readonly { readonly path: string; readonly note: string }[];
}

export interface RenderResponse {
    readonly ok: true;
    readonly snapshot: SnapshotRef;
    readonly template: { readonly id: string; readonly version: string; readonly label: string; readonly method: string; readonly language: "R" | "python" };
    readonly script: string;
    readonly slots: readonly SlotReportEntry[];
    readonly environment: EnvironmentReport;
    readonly syntax: SyntaxCheck;
    readonly outputs: readonly { readonly name: string; readonly path: string; readonly format?: string; readonly description?: string }[];
    readonly decision_record: DecisionRecord;
}

export interface ValidationFailure {
    readonly error: "validation";
    readonly message: string;
    readonly issues: readonly SlotIssue[] | readonly { readonly field: string; readonly message: string; readonly permitted?: readonly string[] }[];
}

export interface TemplateContract {
    readonly id: string;
    readonly version: string;
    readonly label: string;
    readonly method: string;
    readonly language: "R" | "python";
    readonly step_types: readonly StepType[];
    readonly applicability: unknown;
    readonly parameters: readonly TemplateParameter[];
    readonly outputs: readonly { readonly name: string; readonly path: string; readonly format?: string; readonly description?: string }[];
    readonly environment: readonly { readonly name: string; readonly version: string; readonly track: string }[];
    readonly bioconductor: string;
}
