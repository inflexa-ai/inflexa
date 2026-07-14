/**
 * The step briefing — the seed message a sandbox-step agent receives as its
 * sole initial user message.
 *
 * The briefing is composed at DISPATCH time (the parent scheduler, at the
 * moment it starts a step), not at plan-submission time. That is the whole
 * point of this module: when a step is dispatched its dependencies have
 * already run, so the seed can name what they produced and where it lives. A
 * prompt frozen when the user approved the plan cannot — it is written before
 * the first step has run — and the agent is left to rediscover its upstream by
 * searching the filesystem.
 *
 * Every section is a pure `(typed data) => string` that returns `""` when its
 * data is absent; `composeStepBriefing` joins the non-empty ones. No builder,
 * no registry, no pipeline: a new section is a function plus a line in the
 * compose array. The bounds live in the section functions rather than in their
 * callers, so no caller can blow the seed's size by handing over an unbounded
 * summary or dependency list.
 *
 * `STEP_TASK_FIELDS` / `STEP_NON_TASK_FIELDS` partition every AnalysisStep
 * field so the field-coverage guard test fails when a new field is added to the
 * schema without a deliberate decision about whether the agent needs to see it.
 */

import { DATA_PROFILE_ORIENTATION_MAX_CHARS, buildDataProfileOrientation } from "../app/data-profile-orientation.js";
import type { DataProfileResult } from "../state/data-profile.js";
import type { AnalysisStep } from "../schemas/workflow-state.js";

// ── Bounds ────────────────────────────────────────────────────────────

/** Completed dependencies rendered as upstream blocks; the tail is counted, not rendered. */
export const MAX_UPSTREAM_DEPS = 5;

/** Characters of each dependency's summary carried in the seed — the gist, not the document. */
export const UPSTREAM_SUMMARY_MAX_CHARS = 500;

/** Artifact paths listed per dependency; the rest are reachable from its output directory. */
export const MAX_UPSTREAM_ARTIFACTS = 8;

// ── Field partition (the coverage guard's two halves) ─────────────────

/** Fields whose content is agent-facing and MUST appear in the rendered task. */
export const STEP_TASK_FIELDS = [
    "name",
    "question",
    "description",
    "context",
    "constraints",
    "acceptance_criteria",
    "caveats",
] as const satisfies readonly (keyof AnalysisStep)[];

/**
 * Fields deliberately excluded from the task section: identity/DAG structure
 * threaded separately through the workflow input, execution knobs, and result
 * fields populated after the step runs. `depends_on` is not rendered here
 * because the dependencies appear as {@link renderUpstream} blocks — with their
 * results — rather than as bare ids.
 */
export const STEP_NON_TASK_FIELDS = [
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

// ── Formatting primitives ─────────────────────────────────────────────

function section(heading: string, body: string): string {
    return `## ${heading}\n${body}`;
}

function bullets(items: readonly string[]): string {
    return items.map((i) => `- ${i}`).join("\n");
}

/** Clamp to `max` chars, marking any elision with an ellipsis. */
function clamp(text: string, max: number): string {
    if (text.length <= max) return text;
    if (max <= 1) return "";
    return text.slice(0, max - 1).trimEnd() + "…";
}

// ── (1) Task ──────────────────────────────────────────────────────────

/**
 * The step's own instructions. Only `question` is guaranteed present; the
 * remaining task fields are appended as dedicated sections when populated, so a
 * sparse step renders cleanly. The planner writes the bulk of a step's
 * instructions into these structured fields, so every one of them must be
 * folded in here — otherwise the agent runs against the bare question and
 * improvises the rest.
 */
export function renderTask(step: AnalysisStep): string {
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

// ── (2) Workspace ─────────────────────────────────────────────────────

/** The two in-sandbox paths that anchor every path the agent writes or reads. */
export interface WorkspaceFrame {
    /** In-sandbox analysis root — the read-only mount of the whole analysis tree. */
    readonly analysisRoot: string;
    /** In-sandbox working directory — this step's writable artifact directory, and its cwd. */
    readonly workingDir: string;
}

export function renderWorkspace(frame: WorkspaceFrame): string {
    if (!frame.analysisRoot.trim() || !frame.workingDir.trim()) return "";
    return section(
        "Workspace",
        bullets([
            `Working directory (writable, your cwd): \`${frame.workingDir}\` — write outputs to \`output/\`, \`figures/\`, \`scripts/\`, \`logs/\` under it.`,
            `Analysis root (read-only): \`${frame.analysisRoot}\` — inputs at \`${frame.analysisRoot}/data/inputs/\`, prior runs at \`${frame.analysisRoot}/runs/\`.`,
        ]),
    );
}

// ── (3) Data orientation ──────────────────────────────────────────────

/**
 * What dataset the analysis is holding, projected from the persisted profile.
 * Absent or not-yet-profiled → `""`, and the agent falls back to its always-on
 * `inspect_data_profile` tool.
 */
export function renderOrientation(profile: DataProfileResult | null | undefined): string {
    if (!profile) return "";
    const orientation = buildDataProfileOrientation(profile, DATA_PROFILE_ORIENTATION_MAX_CHARS);
    if (orientation.trim().length === 0) return "";
    return section("Data orientation", `${orientation}\n\nThis is a bounded projection — call \`inspect_data_profile\` for the full profile.`);
}

// ── (4) Upstream results ──────────────────────────────────────────────

/**
 * One completed dependency's handoff. The seed carries the gist plus the PATHS
 * to the rest — an agent that needs more than the excerpt reads the summary at
 * `summaryPath` rather than having the whole document pushed into its context.
 */
export interface UpstreamHandoff {
    readonly stepId: string;
    readonly agentId: string;
    /** The dependency's step summary. Clamped to {@link UPSTREAM_SUMMARY_MAX_CHARS} here, not by the caller. */
    readonly summaryMarkdown: string;
    /** In-sandbox absolute path of the full summary. */
    readonly summaryPath: string;
    /** In-sandbox absolute path of the dependency's output directory. */
    readonly outputDir: string;
    /** In-sandbox absolute paths of the artifacts the dependency registered. */
    readonly artifacts: readonly string[];
}

export function renderUpstream(handoffs: readonly UpstreamHandoff[]): string {
    if (handoffs.length === 0) return "";

    const shown = handoffs.slice(0, MAX_UPSTREAM_DEPS);
    const blocks = shown.map(renderHandoff);

    const omitted = handoffs.length - shown.length;
    if (omitted > 0) {
        blocks.push(`(+${omitted} more completed ${omitted === 1 ? "dependency" : "dependencies"} — \`inspect_run\` lists every step of this run.)`);
    }

    return section("Upstream results (these already ran — build on them, do not redo them)", blocks.join("\n\n"));
}

function renderHandoff(handoff: UpstreamHandoff): string {
    const lines = [`### ${handoff.stepId} (${handoff.agentId})`];

    const excerpt = clamp(handoff.summaryMarkdown.trim(), UPSTREAM_SUMMARY_MAX_CHARS);
    if (excerpt.length > 0) lines.push(excerpt);

    lines.push(`- Full summary: \`${handoff.summaryPath}\``);
    lines.push(`- Output directory: \`${handoff.outputDir}\``);

    if (handoff.artifacts.length > 0) {
        const shown = handoff.artifacts.slice(0, MAX_UPSTREAM_ARTIFACTS);
        const more = handoff.artifacts.length - shown.length;
        lines.push(`- Artifacts: ${shown.map((a) => `\`${a}\``).join(", ")}${more > 0 ? ` (+${more} more in the output directory)` : ""}`);
    }

    return lines.join("\n");
}

// ── Composition ───────────────────────────────────────────────────────

/** Everything one step's seed is composed from — all of it known at dispatch time. */
export interface StepBriefing {
    readonly step: AnalysisStep;
    readonly workspace: WorkspaceFrame;
    /** The analysis's persisted data profile; `null` when never profiled or still pending. */
    readonly profile: DataProfileResult | null;
    /** The step's completed dependencies, in the plan's declared `depends_on` order. */
    readonly upstream: readonly UpstreamHandoff[];
}

/**
 * Compose the seed. Absent sections collapse out entirely — an independent step
 * with no profile yields exactly the task and workspace sections, byte-identical
 * to what a step got before any of this existed plus its paths.
 *
 * Pure: the same briefing composes to the same string, which is what makes the
 * caller's durable step replay-stable.
 */
export function composeStepBriefing(briefing: StepBriefing): string {
    return [renderTask(briefing.step), renderWorkspace(briefing.workspace), renderOrientation(briefing.profile), renderUpstream(briefing.upstream)]
        .filter(Boolean)
        .join("\n\n");
}
