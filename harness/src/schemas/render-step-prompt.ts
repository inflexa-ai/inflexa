/**
 * Render an AnalysisStep into the user-content prompt the sandbox agent
 * receives as its initial message.
 *
 * The planner writes the bulk of a step's instructions into structured
 * fields (`constraints`, `acceptance_criteria`, `context`, `caveats`,
 * `description`) alongside the one-line `question`. The execution path
 * forwards a single `prompt` string to the sandbox agent, so every
 * instruction-bearing field must be folded into that string here — otherwise
 * the agent runs against the bare question and improvises the rest.
 *
 * `STEP_PROMPT_INSTRUCTION_FIELDS` / `STEP_PROMPT_NON_INSTRUCTION_FIELDS`
 * partition every AnalysisStep field so the field-coverage guard test can
 * fail when a new field is added to the schema without a deliberate decision
 * about whether the agent needs to see it.
 */

import type { AnalysisStep } from "./workflow-state.js";

/** Fields whose content is agent-facing and MUST appear in the rendered prompt. */
export const STEP_PROMPT_INSTRUCTION_FIELDS = [
    "name",
    "question",
    "description",
    "context",
    "constraints",
    "acceptance_criteria",
    "caveats",
] as const satisfies readonly (keyof AnalysisStep)[];

/**
 * Fields deliberately excluded from the prompt: identity/DAG structure
 * threaded separately through the workflow input, execution knobs, and
 * result fields populated after the step runs.
 */
export const STEP_PROMPT_NON_INSTRUCTION_FIELDS = [
    "id",
    "track",
    "step_type",
    "depends_on",
    "status",
    "resources",
    "agent",
    "timeout",
    "maxSteps",
    "summary",
    "artifactIds",
    "error",
] as const satisfies readonly (keyof AnalysisStep)[];

function section(heading: string, body: string): string {
    return `## ${heading}\n${body}`;
}

function bullets(items: readonly string[]): string {
    return items.map((i) => `- ${i}`).join("\n");
}

/**
 * Compose the agent's initial prompt from a plan step. Only the `question`
 * is guaranteed present; the remaining instruction fields are appended as
 * dedicated sections when populated. Empty strings and empty arrays are
 * skipped so a sparse step renders cleanly.
 */
export function renderStepPrompt(step: AnalysisStep): string {
    const parts: string[] = [`# ${step.name}`, section("Task", step.question)];

    if (step.description?.trim()) {
        parts.push(section("What this step produces", step.description.trim()));
    }
    if (step.context?.trim()) {
        parts.push(section("Context", step.context.trim()));
    }
    if (step.constraints && step.constraints.length > 0) {
        parts.push(section("Constraints (these are requirements, not suggestions — follow them exactly)", bullets(step.constraints)));
    }
    if (step.acceptance_criteria && step.acceptance_criteria.length > 0) {
        parts.push(section("Acceptance criteria (the result must satisfy all of these)", bullets(step.acceptance_criteria)));
    }
    if (step.caveats && step.caveats.length > 0) {
        parts.push(section("Caveats", bullets(step.caveats)));
    }

    return parts.join("\n\n");
}
