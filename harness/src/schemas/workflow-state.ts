/**
 * Workflow state schemas for the omics-analysis workflow.
 *
 * Defines Zod schemas for step inputs/outputs, plan structure,
 * and the completion schemas that validate LLM structured output.
 */

import { z } from "zod";

// ── Plan structures ─────────────────────────────────────────────────

export const AnalysisStepSchema = z.object({
    id: z.string().describe("Step ID in format T{track}S{step}"),
    name: z.string(),
    track: z.string(),
    step_type: z.string(),
    question: z.string(),
    context: z.string().optional(),
    constraints: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()),
    caveats: z.array(z.string()).optional(),
    depends_on: z.array(z.string()),
    status: z.enum(["pending", "running", "completed", "failed", "skipped"]).default("pending"),
    // Optional on the persistence schema so historical plans (pre-resources)
    // still parse on the read side. `PlanStepSchema` re-requires it for planner
    // output, and the execution path rejects any step that reaches it without
    // resources (no silent default) and clamps to cluster limits before use.
    resources: z
        .object({
            cpu: z.number(),
            memoryGb: z.number(),
            gpu: z.object({ count: z.number() }).optional(),
        })
        .optional(),

    // Execution fields
    agent: z.string().optional().describe("Assigned sandbox agent name from registry"),
    timeout: z.number().optional().describe("Execution timeout in seconds (falls back to image default)"),
    maxSteps: z.number().describe("Max LLM agentic steps for sandbox agent"),
    description: z.string().optional().describe("Human-readable description of what the step does"),

    // Step result fields (populated during execution)
    summary: z.string().optional().describe("Execution result summary"),
    artifactIds: z.array(z.string()).optional().describe("Artifact IDs produced by this step"),
    error: z.string().optional().describe("Error message if step failed"),
});

export const AnalysisPlanSchema = z.object({
    // Optional on the persistence schema so historical plans (pre-title) still
    // parse on the read side. `PlannerPlanSchema` re-requires it for new plans.
    title: z.string().optional().describe("Concise human-readable plan name"),
    analytical_narrative: z.string(),
    steps: z.array(AnalysisStepSchema),
    created_at: z.string(),
    omicsType: z.string().optional().describe("Detected omics data type (e.g., transcriptomics, proteomics)"),
    omicsSubtype: z.string().optional().describe("Detected subtype (e.g., bulk-rna-seq, single-cell)"),
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
        data: z.record(z.string(), z.unknown()),
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
    value: z.record(z.string(), z.unknown()),
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
