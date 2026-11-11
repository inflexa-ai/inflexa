/**
 * Workflow state schemas for the omics-analysis workflow.
 *
 * Defines Zod schemas for step inputs/outputs, plan structure,
 * and the completion schemas that validate LLM structured output.
 */

import { z } from "zod";

// ── Plan structures ─────────────────────────────────────────────────

/**
 * One scientific setting of a grounded step: a parameter of the procedure
 * that `knowledge_recommend` returned, with the procedure step it belongs to
 * and the source of its value. The host binds the settings to the template
 * of the step at dispatch, thus a template default never replaces a plan
 * decision silently.
 */
/** A value of a setting: a scalar, or a list of strings. */
const GroundingValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

export const GroundingSettingSchema = z.object({
    step: z.string().describe("The procedure step the setting belongs to (for example `differential_expression` or `normalize`)."),
    name: z.string().describe("The parameter name as the procedure names it (for example `alpha` or `lfc_shrink`)."),
    value: GroundingValueSchema.describe("The value the procedure sets."),
    source: z.string().optional().describe("The source of the value (a doi or a document) when the procedure names one. Absent otherwise."),
});
export type GroundingSetting = z.infer<typeof GroundingSettingSchema>;

/**
 * One place where a grounded step departs from a rule it cites. A departure
 * with a value replaces the value of its setting in the binding of the
 * template, and a departure with a setting and no value removes the setting
 * from the binding.
 */
export const GroundingDepartureSchema = z.object({
    rule: z.string().describe("The claim id of the rule the step departs from, as `grounding.claims` holds it (for example `R-0147@3c1d`)."),
    setting: z
        .string()
        .optional()
        .describe(
            "The `name` of the entry of `grounding.settings` that the departure changes. Absent when the step leaves out a part of the rule that no setting carries, for example a diagnostic the plan does not run.",
        ),
    value: GroundingValueSchema.optional().describe(
        "The value of the plan for the setting. The host binds it in place of the value of the rule. Absent when the plan does not apply the setting.",
    ),
    reason: z.string().describe("Why the step departs from the rule, from the design or the data, in one line."),
});
export type GroundingDeparture = z.infer<typeof GroundingDepartureSchema>;

/**
 * The grounding of one method step: the claim identifiers and the snapshot
 * digest that `knowledge_recommend` returned in this run, the template the
 * step renders, the settings of the procedure, and a one-line reason.
 * Optional on both step schemas, thus a stored plan and a plan made without
 * the knowledge service load and validate as before. Phase 0 validates the
 * shape only. An empty field is visible: the evaluation counts a method step
 * without a value as ungrounded.
 */
export const GroundingSchema = z.object({
    status: z
        .enum(["grounded", "ungrounded", "flagged"])
        .describe(
            "`grounded` when the step follows a returned procedure; `ungrounded` when no rule covered it or the service did not answer; `flagged` when a rule changed the outcome of the step.",
        ),
    snapshot: z.string().describe("The `snapshot.digest` that `knowledge_recommend` returned in this run, or `none`."),
    claims: z
        .array(z.string())
        .describe("The claim identifiers of the step as `knowledge_recommend` returned them (for example `R-0031@e7d0`). Empty when ungrounded."),
    template: z
        .string()
        .optional()
        .describe("The template id with its version (for example `tpl-deseq2-two-group@1.0.0`) when the step renders a template. Absent otherwise."),
    settings: z
        .array(GroundingSettingSchema)
        .optional()
        .describe(
            "The scientific settings of the step: the parameters of the procedure steps the plan step holds, as `knowledge_recommend` returned them. " +
                "Leave this field out on a step that keeps the id of a skeleton step: the host writes the `grounding.settings` of that skeleton step, one entry per parameter, with its step, name, value, and source. " +
                "Do not restate a setting as prose only, and do not change a value here: give a different value as an entry of `departures`. Absent when the step is ungrounded.",
        ),
    departures: z
        .array(GroundingDepartureSchema)
        .optional()
        .describe(
            "Each place where the step keeps its method and departs from a rule it cites: a setting with a different value, a setting the plan does not apply, or a part of the rule the plan leaves out. " +
                "One entry per setting, with the claim id of the rule, the setting name, the value of the plan, and the reason. " +
                "The host binds the value of a departure in place of the value of the rule. Absent when the step obeys each rule it cites.",
        ),
    reason: z
        .string()
        .describe(
            "One line: the situation and the method with the rule that selects it, the side chosen for a disputed rule, or why the step is ungrounded or flagged.",
        ),
});
export type Grounding = z.infer<typeof GroundingSchema>;

/** One source of the evidence of a claim, as the knowledge snapshot holds it. */
export const ClaimEvidenceSchema = z.object({
    doi: z.string().optional(),
    pmid: z.string().optional(),
    url: z.string().optional(),
    title: z.string(),
    year: z.number(),
    direction: z.string(),
});

/**
 * The view of one claim that a step of the plan cites, as the snapshot of
 * the step holds it. The host writes the views from the answer of
 * `knowledge_recommend` when it saves the plan. A digest names one fixed
 * release, thus the view of a claim id never changes for its digest, and a
 * surface reads the rule text here with no call to the service.
 */
export const ClaimViewSchema = z.object({
    id: z.string(),
    snapshot: z.string(),
    rule: z.string().optional(),
    title: z.string().optional(),
    statement: z.string(),
    strength: z.string(),
    severity: z.string().optional(),
    evidence: z.array(ClaimEvidenceSchema),
    license: z.string().optional(),
});
export type ClaimView = z.infer<typeof ClaimViewSchema>;

/**
 * A step of an analysis plan. `PlanStepSchema` (schemas/plan-schemas.ts) narrows
 * this into the planner's output contract and emits it as the `submit_plan`
 * arg schema — so each field's meaning belongs in `.describe()`,
 * not in a comment the model never sees.
 */
export const AnalysisStepSchema = z.object({
    id: z.string().describe("Step ID in format T{track}S{step} (e.g. T1S1, T1S2, T2S1). Unique within the plan and usable as a directory-name segment."),
    name: z.string().describe("Short human-readable step name."),
    track: z.string().describe("The track this step belongs to. Steps in the same track share a logical theme; steps in different tracks are independent."),
    step_type: z.string().describe('Short label for the kind of work the step does (e.g. "analysis").'),
    question: z
        .string()
        .describe("The specific question this step answers, framed with the actual condition names and comparisons from the experimental design."),
    context: z.string().optional().describe("Background the sandbox agent needs to do the work."),
    constraints: z.array(z.string()).optional().describe("Requirements the sandbox agent must follow exactly — not suggestions."),
    acceptance_criteria: z.array(z.string()).describe("What the result must satisfy for the step to count as successful."),
    caveats: z.array(z.string()).optional().describe("Pitfalls the sandbox agent should watch for."),
    // Optional on the persistence schema so historical plans (pre-packages)
    // still parse on the read side. `PlanStepSchema` re-requires it for
    // planner output. The briefing withholds it from the rendered task — the
    // pre-launch link pass consumes it, and a step agent must not re-litigate it.
    packages: z
        .array(z.string())
        .optional()
        .describe(
            'The packages this step imports, each as a query in the grammar [python:|r:]<name>[==<version>]: a bare name ("scanpy"), a name with one exact version ("numpy==1.26.4"), or either behind a track prefix ("python:igraph", "r:decoupleR==2.17.0"). ' +
                "A bare name searches both tracks. " +
                "When the package census shows one name under the Python section and under the R section, write the prefixed form — a bare both-track name refuses the launch. " +
                "Never a path, a URL, or a store directory. An empty array means the step needs nothing beyond the baked toolchain. " +
                "The set is not a promise of completeness — the execution agent can still link a missing package.",
        ),
    depends_on: z
        .array(z.string())
        .describe("IDs of steps in this plan that must complete before this one runs. Empty when the step has no prerequisites. The graph must be acyclic."),
    status: z.enum(["pending", "running", "completed", "failed", "skipped"]).default("pending"),
    grounding: GroundingSchema.optional().describe(
        "The knowledge grounding of a method step: fill it from the answer of `knowledge_recommend` when that tool is attached. Omit it when no knowledge tool is attached.",
    ),

    // Execution fields
    agent: z.string().optional().describe("Assigned sandbox agent name from registry"),
    maxSteps: z.number().describe("Max LLM agentic steps for sandbox agent"),
    description: z.string().optional().describe("Human-readable description of what the step produces."),

    // Step result fields (populated during execution)
    summary: z.string().optional().describe("Execution result summary"),
    artifactIds: z.array(z.string()).optional().describe("Artifact IDs produced by this step"),
    error: z.string().optional().describe("Error message if step failed"),
});

export const AnalysisPlanSchema = z.object({
    // Optional on the persistence schema so historical plans (pre-title) still
    // parse on the read side. `PlannerPlanSchema` re-requires it for new plans.
    title: z.string().optional().describe("Concise human-readable plan name"),
    analytical_narrative: z
        .string()
        .describe(
            "Brief narrative of the logical flow: why these steps, in this order, address the research question. " +
                "Reference the data characteristics that informed the choices.",
        ),
    steps: z.array(AnalysisStepSchema),
    created_at: z.string().describe("ISO-8601 timestamp for when the plan was created."),
    omicsType: z.string().optional().describe("Omics data type detected from the data context (e.g. transcriptomics, proteomics, metabolomics)."),
    omicsSubtype: z.string().optional().describe("Subtype detected from the data context (e.g. bulk-rna-seq, single-cell, microarray)."),
    request: z
        .string()
        .optional()
        .describe(
            "The request that the plan answers, as `generate_plan` received it. The briefing of each step renders it. Absent on an ad hoc plan and on a historical plan.",
        ),
    claims: z
        .array(ClaimViewSchema)
        .optional()
        .describe(
            "The view of each claim that a step cites, one per claim id and snapshot, as the host saved it with the plan. Absent when no step cites a claim of a knowledge answer.",
        ),
});

// ── Suspension Payload ──────────────────────────────────────────────

/**
 * Declarative suspension format — tells the frontend what to render
 * without requiring per-type components. New suspension types only
 * need changes on the cortex side.
 *
 * The frontend (lumen) renders the payload as:
 *   1. A severity-themed container (border + background color)
 *   2. Title + optional message header
 *   3. Content blocks in order (rich display widgets)
 *   4. Input fields (collected before any action)
 *   5. Action buttons
 *
 * When the user clicks an action button, the frontend sends
 * `{ ...action.value, ...filledInputValues }` as `resumeData`
 * to the workflow resume endpoint.
 */

/**
 * Content blocks — a library of renderable widgets the frontend knows
 * how to display. New widget types require a frontend change, but each
 * widget is reusable across all suspension types.
 *
 * - "markdown": rendered as prose via react-markdown
 * - "plan": rich plan view (analytical narrative + step list)
 * - "json": collapsible JSON preview in a <pre> block
 * - "text": plain text paragraph
 */
export const ContentBlockSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("markdown"), text: z.string() }),
    z.object({ type: z.literal("plan"), plan: AnalysisPlanSchema }),
    z.object({
        type: z.literal("json"),
        data: z.record(z.string(), z.json()),
        label: z.string().optional(),
    }),
    z.object({ type: z.literal("text"), text: z.string() }),
]);

/**
 * A button the user can click to resume the workflow.
 *
 * - `label`: button text (literal string, not an i18n key)
 * - `value`: key-value pairs merged into resumeData when clicked
 * - `variant`: button style — "default" (primary), "outline", or "destructive"
 * - `icon`: optional icon rendered before the label
 */
export const SuspensionActionSchema = z.object({
    label: z.string(),
    value: z.record(z.string(), z.json()),
    variant: z.enum(["default", "outline", "destructive"]).optional(),
    icon: z.enum(["check", "x", "alert-circle"]).optional(),
});

/**
 * A form field rendered above the action buttons. The user's input
 * is merged into resumeData under the `key` field when any action
 * button is clicked. Empty inputs are omitted from resumeData.
 *
 * - `key`: the resumeData field name (e.g. "modifications", "answer")
 * - `type`: "text" (single line), "textarea" (multi-line), or "select" (dropdown)
 * - `required`: if true, all action buttons are disabled until filled
 * - `options`: only used for "select" type — dropdown choices
 */
export const SuspensionInputSchema = z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["text", "textarea", "select"]),
    placeholder: z.string().optional(),
    required: z.boolean().optional(),
    options: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
});

/**
 * Top-level suspension payload stored in `cortex_runs.suspension`.
 *
 * - `title`: header text (e.g. "Plan Ready for Review")
 * - `message`: optional secondary text below the title
 * - `severity`: controls the visual theme — "info" (blue), "warning" (amber), "error" (red).
 *   Defaults to "warning" on the frontend if omitted.
 * - `content`: ordered list of display widgets
 * - `actions`: at least one button for the user to resume the workflow
 * - `inputs`: optional form fields collected before any action
 */
export const SuspensionPayloadSchema = z.object({
    title: z.string(),
    message: z.string().optional(),
    severity: z.enum(["info", "warning", "error"]).optional(),
    content: z.array(ContentBlockSchema).optional(),
    actions: z.array(SuspensionActionSchema),
    inputs: z.array(SuspensionInputSchema).optional(),
});

// ── Types ───────────────────────────────────────────────────────────

export type AnalysisStep = z.infer<typeof AnalysisStepSchema>;
export type AnalysisPlan = z.infer<typeof AnalysisPlanSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type SuspensionAction = z.infer<typeof SuspensionActionSchema>;
export type SuspensionInput = z.infer<typeof SuspensionInputSchema>;
export type SuspensionPayload = z.infer<typeof SuspensionPayloadSchema>;
