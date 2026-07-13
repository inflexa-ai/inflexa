/**
 * Step-handoff briefing — the standing briefing a dependent analysis step's
 * sandbox-agent loop receives, one per upstream `depends_on` step (see the
 * conversation-briefings spec).
 *
 * `render` is PURE over one upstream step's handoff payload. Unlike the
 * run-index / synthesis briefings, the interpretation summary IS the payload:
 * these summaries are written by a dedicated sub-agent to be compact and
 * grounded in persisted files, so the content embeds the summary markdown
 * VERBATIM — no re-summarization, truncation, or reformatting — followed by the
 * upstream step's artifact locations. Artifact paths are rendered as
 * sandbox-canonical absolute paths (`/{analysisId}/runs/{runId}/{stepId}/…`),
 * the namespace the agent's tools resolve; a host filesystem path must never
 * leak into prompt content. The `output/summary.md` file is the briefing body,
 * not a pointer, so it is excluded from the artifact list (the child that
 * builds the payload drops it).
 */

import type { BriefingDefinition } from "./types.js";

export const STEP_HANDOFF_BRIEFING_NAME = "step-handoff";

/**
 * One upstream step's handoff payload. `artifactPaths` are already
 * sandbox-canonical absolute paths with `output/summary.md` excluded — the
 * child workflow body derives them before composing.
 */
export interface StepHandoffInput {
    /** Upstream step id — the caption's identity and the path namespace segment. */
    readonly stepId: string;
    /** Upstream step's human-readable plan name. */
    readonly name: string;
    /** The upstream step's interpretation-summary markdown, embedded verbatim. */
    readonly summaryMarkdown: string;
    /** Sandbox-canonical absolute artifact paths (summary.md excluded). */
    readonly artifactPaths: readonly string[];
}

function renderArtifacts(paths: readonly string[]): string {
    if (paths.length === 0) return "_No artifacts beyond the summary._";
    return paths.map((p) => `- ${p}`).join("\n");
}

function renderContent(input: StepHandoffInput): string {
    return [
        `# Upstream step ${input.stepId} — "${input.name}"`,
        "",
        `This step's dependency completed. Its interpretation summary and artifact locations follow.`,
        "",
        input.summaryMarkdown,
        "",
        "## Artifacts",
        "",
        renderArtifacts(input.artifactPaths),
    ].join("\n");
}

function renderCaption(input: StepHandoffInput): string {
    const n = input.artifactPaths.length;
    return `step ${input.stepId} "${input.name}" · ${n} artifact${n === 1 ? "" : "s"}`;
}

export const stepHandoffBriefing: BriefingDefinition<StepHandoffInput> = {
    name: STEP_HANDOFF_BRIEFING_NAME,
    description: "One completed upstream step's interpretation summary and artifact locations.",
    mode: "standing",
    render(input) {
        return { content: renderContent(input), caption: renderCaption(input) };
    },
};
