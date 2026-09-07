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
import type { TemplateParameter } from "../tools/knowledge/client.js";
import type { TemplateBindingValue } from "../tools/knowledge/template.js";

// ── Bounds ────────────────────────────────────────────────────────────

/** Completed dependencies rendered as upstream blocks; the tail is counted, not rendered. */
export const MAX_UPSTREAM_DEPS = 5;

/** Characters of each dependency's summary carried in the seed — the gist, not the document. */
export const UPSTREAM_SUMMARY_MAX_CHARS = 500;

/** Artifact paths listed per dependency; the rest are reachable from its output directory. */
export const MAX_UPSTREAM_ARTIFACTS = 8;

/** Adaptable slots rendered in the Template contract section; the tail is counted, not rendered. */
export const MAX_TEMPLATE_SLOTS = 24;

/** Characters of one slot description carried in the seed — the constraint, not the manual. */
export const TEMPLATE_SLOT_DESCRIPTION_MAX_CHARS = 160;

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
    // The step agent reads the template id and the claim identifiers from the
    // step, not from prose: the grounding renders beside the task fields.
    "grounding",
] as const satisfies readonly (keyof AnalysisStep)[];

/**
 * Fields deliberately excluded from the task section: identity/DAG structure
 * threaded separately through the workflow input, execution knobs, and result
 * fields populated after the step runs. `depends_on` is not rendered here
 * because the dependencies appear as {@link renderUpstream} blocks — with their
 * results — rather than as bare ids. `resources` renders as its own
 * {@link renderResources} section, because the budget is an execution bound,
 * not a task instruction.
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
    // Withheld on purpose: every step reaches an agent through a launch, and
    // the pre-launch link pass consumes the packages of every step it carries —
    // an ad hoc step as much as a planned one. Thus the set is settled before
    // the agent reads its task, and a step agent must not re-litigate it. What
    // the agent does need to know about them — a dropped entry, or a step that
    // declares none — rides in `caveats`.
    "packages",
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
export function renderTask(step: AnalysisStep, contract: Pick<StepBriefing, "template" | "templateNotRetrieved"> = {}): string {
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
    if (step.grounding) {
        parts.push(section("Grounding", renderGrounding(step.grounding, contract)));
    }

    return parts.join("\n\n");
}

/**
 * The grounding as data lines. The template id is the one value the agent
 * acts on (it names it to `knowledge_template`), thus it renders first after
 * the status. The claim identifiers and the digest are for the record.
 *
 * A grounding that names a template promises a Template contract section.
 * When the seed carries none, one line says so with the reason, thus the
 * agent knows the contract was not fetched rather than guessing at slots.
 */
function renderGrounding(grounding: NonNullable<AnalysisStep["grounding"]>, contract: Pick<StepBriefing, "template" | "templateNotRetrieved">): string {
    const lines = [`- Status: ${grounding.status}`];
    if (grounding.template) {
        lines.push(`- Template: \`${grounding.template}\``);
        if (!contract.template) lines.push(`- Template contract: not retrieved (${contract.templateNotRetrieved ?? "no contract was fetched for this step"})`);
    }
    lines.push(`- Snapshot: ${grounding.snapshot}`);
    lines.push(`- Claims: ${grounding.claims.length > 0 ? grounding.claims.join(", ") : "none"}`);
    lines.push(`- Reason: ${grounding.reason}`);
    return lines.join("\n");
}

// ── (1b) Template contract ────────────────────────────────────────────

/** A file the script of the template reads. `path` names the slot that gives it, for example `{{counts_path}}`. */
export interface TemplateBriefInput {
    readonly name: string;
    readonly path: string;
    readonly description?: string;
}

/** One plan setting bound to an adaptable slot of the template. */
export interface TemplateBoundSetting {
    readonly name: string;
    readonly value: TemplateBindingValue;
    /** The source of the value (a doi or a document), or `plan` when the procedure names none. */
    readonly source: string;
}

/**
 * The contract of the template a step renders, projected for the seed. The
 * parent fetches it at dispatch and binds the plan settings to it; the
 * section is what lets an agent that has never seen the template make one
 * valid render call.
 */
export interface TemplateBrief {
    /** The template reference of the plan step, with its version when the plan names one. */
    readonly ref: string;
    /** The version the service serves. Differs from the version of `ref` when the snapshot moved on. */
    readonly version_served: string;
    /** The adaptable slots of the contract, in the order the template declares them. A pinned slot is never rendered. */
    readonly slots: readonly TemplateParameter[];
    readonly inputs: readonly TemplateBriefInput[];
    /** The plan settings bound to a slot, in plan order. Empty when the served version differs from the plan. */
    readonly bound: readonly TemplateBoundSetting[];
    /** The plan settings no bound slot carries, one line each with the reason. */
    readonly unbound_settings: readonly string[];
}

/** A value as the render request carries it: JSON, thus `"apeglm"` and `10` cannot be confused. */
function slotValue(value: unknown): string {
    return JSON.stringify(value);
}

/** The version of a template reference (`tpl-x@1.0.0` gives `1.0.0`), or `undefined` when the reference has none. */
function versionOfRef(ref: string): string | undefined {
    const at = ref.indexOf("@");
    return at < 0 ? undefined : ref.slice(at + 1);
}

/**
 * One adaptable slot as a bullet: the name, the type, the default with its
 * source or the required state, the description, and the constraints the
 * render enforces. A slot without a default is required unless the contract
 * says otherwise, which is the rule of the renderer.
 */
function renderSlot(slot: TemplateParameter): string {
    const facts: string[] = [slot.type];
    if (slot.default !== undefined) {
        facts.push(`default ${slotValue(slot.default)}${slot.default_source ? ` [${slot.default_source}]` : ""}`);
    } else {
        facts.push(slot.required === false ? "optional" : "required");
    }
    if (slot.minimum !== undefined) facts.push(`min ${slot.minimum}`);
    if (slot.maximum !== undefined) facts.push(`max ${slot.maximum}`);

    const tail: string[] = [];
    if (slot.enum && slot.enum.length > 0) tail.push(`Permitted: ${slot.enum.map(slotValue).join(", ")}.`);
    if (slot.pattern) tail.push(`Pattern: \`${slot.pattern}\`.`);

    const description = clamp(slot.description.trim(), TEMPLATE_SLOT_DESCRIPTION_MAX_CHARS);
    return `\`${slot.name}\` (${facts.join("; ")})${description ? `: ${description}` : ""}${tail.length > 0 ? ` ${tail.join(" ")}` : ""}`;
}

/**
 * The Template contract section. Only the adaptable slots render, bounded by
 * {@link MAX_TEMPLATE_SLOTS} and the description clamp, so a wide template
 * cannot blow the seed. A served version that differs from the plan renders
 * as a caveat: the render refuses the plan version, and the settings are not
 * bound to a version the plan did not name.
 */
export function renderTemplateContract(brief: TemplateBrief | undefined): string {
    if (!brief) return "";

    const refVersion = versionOfRef(brief.ref);
    const lead = [
        `\`${brief.ref}\` (the service serves version ${brief.version_served}). Send only the slots listed here to \`knowledge_template\`; a slot not listed is pinned or unknown, and the render refuses it.`,
    ];
    if (refVersion !== undefined && refVersion !== brief.version_served) {
        lead.push(
            `Caveat: the plan names version ${refVersion}, and the service serves version ${brief.version_served}. The plan settings are not bound to this render. Render the served version, and state each plan value yourself.`,
        );
    }
    const blocks: string[] = [lead.join("\n")];

    const adaptable = brief.slots.filter((slot) => slot.adaptable);
    if (adaptable.length > 0) {
        const shown = adaptable.slice(0, MAX_TEMPLATE_SLOTS);
        const lines = [bullets(shown.map(renderSlot))];
        const omitted = adaptable.length - shown.length;
        if (omitted > 0)
            lines.push(`(+${omitted} more adaptable ${omitted === 1 ? "slot" : "slots"} not listed. The render answer names a required one that is absent.)`);
        blocks.push(`Slots:\n${lines.join("\n")}`);
    }

    if (brief.inputs.length > 0) {
        blocks.push(
            `Inputs the script reads:\n${bullets(brief.inputs.map((input) => `${input.name}: \`${input.path}\`${input.description ? ` — ${input.description}` : ""}`))}`,
        );
    }

    if (brief.bound.length > 0) {
        blocks.push(
            `Bound by the plan (send each value as it is, or add an \`overrides\` entry with the slot and the reason for the change; a changed value without an override is refused):\n${bullets(
                brief.bound.map((setting) => `\`${setting.name}\` = ${slotValue(setting.value)} (${setting.source})`),
            )}`,
        );
    }

    if (brief.unbound_settings.length > 0) {
        blocks.push(`Unbound settings (the plan states them, and no bound slot carries them):\n${bullets(brief.unbound_settings)}`);
    }

    return section("Template contract", blocks.join("\n\n"));
}

// ── (2) Workspace ─────────────────────────────────────────────────────

/**
 * What anchors every path the agent writes or reads: the id the tree is mounted
 * at, and the step's writable directory.
 *
 * The frame carries the id rather than the analysis root, because the root is
 * `/{analysisId}` and two fields for one value can disagree. The id is also what
 * every other path in the briefing is rooted with, thus one field serves the
 * workspace section and the orientation alike.
 */
export interface WorkspaceFrame {
    /** The analysis id. The sandbox mounts the read-only analysis tree at `/{analysisId}`. */
    readonly analysisId: string;
    /** In-sandbox working directory — this step's writable artifact directory, and its cwd. */
    readonly workingDir: string;
}

/** The in-sandbox analysis root of a frame — the read-only mount of the whole tree. */
export function analysisRootOf(frame: WorkspaceFrame): string {
    return `/${frame.analysisId}`;
}

export function renderWorkspace(frame: WorkspaceFrame): string {
    if (!frame.analysisId.trim() || !frame.workingDir.trim()) return "";
    const analysisRoot = analysisRootOf(frame);
    return section(
        "Workspace",
        bullets([
            `Working directory (writable, your cwd): \`${frame.workingDir}\` — write outputs to \`output/\`, \`figures/\`, \`scripts/\`, \`logs/\` under it.`,
            `Analysis root (read-only): \`${analysisRoot}\` — inputs at \`${analysisRoot}/data/inputs/\`, prior runs at \`${analysisRoot}/runs/\`.`,
        ]),
    );
}

// ── (2b) Resources ────────────────────────────────────────────────────

/**
 * The cpu and memory budget of the step, with the one rule that keeps a
 * parallel workload inside it. The mounted cpu files make `detectCores()` and
 * `os.cpu_count()` report the quota, thus the fork count is right by default.
 * The thread pools default to one thread (see `sandbox/thread-env.ts`), and
 * only the agent knows when a step is thread-parallel. Thus the briefing names
 * the budget and the rule, and the agent raises a pool per command.
 */
export function renderResources(resources: AnalysisStep["resources"]): string {
    if (!resources) return "";
    const cores = Math.max(1, Math.floor(resources.cpu));
    const items = [
        `CPU: ${resources.cpu} ${resources.cpu === 1 ? "core" : "cores"} (hard quota). Memory: ${resources.memoryGb} GB (hard limit — exceeding it kills the process).`,
        `Core-count calls (\`parallel::detectCores()\`, \`os.cpu_count()\`) report this quota — worker counts sized from them are already right, nothing to raise.`,
        `BLAS/OpenMP thread pools default to **1 thread** (\`OMP_NUM_THREADS\` etc.). For a thread-parallel single-process step, raise them per command via \`execute_command\`'s \`env\`, up to ${cores}.`,
        `The one rule: workers × threads-per-worker must stay ≤ ${cores}. A mix is fine while the product holds.`,
    ];
    if (resources.gpu) items.push(`GPU: ${resources.gpu.count}.`);
    return section("Resources (hard limits)", bullets(items));
}

// ── (3) Data orientation ──────────────────────────────────────────────

/**
 * What dataset the analysis is holding, projected from the persisted profile.
 * Absent or not-yet-profiled → `""`, and the agent falls back to its always-on
 * `inspect_data_profile` tool.
 */
export function renderOrientation(profile: DataProfileResult | null | undefined, analysisId: string): string {
    if (!profile) return "";
    const orientation = buildDataProfileOrientation(profile, analysisId, DATA_PROFILE_ORIENTATION_MAX_CHARS);
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
    /** The contract of the template the step renders, with the plan settings bound to it. Absent when none was retrieved. */
    readonly template?: TemplateBrief;
    /**
     * Why the seed carries no template contract for a step whose grounding
     * names one: no client is bound, the service did not answer, or the
     * service does not hold the template. Read only when `template` is absent.
     */
    readonly templateNotRetrieved?: string;
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
    return [
        renderTask(briefing.step, briefing),
        renderTemplateContract(briefing.template),
        renderWorkspace(briefing.workspace),
        renderResources(briefing.step.resources),
        renderOrientation(briefing.profile, briefing.workspace.analysisId),
        renderUpstream(briefing.upstream),
    ]
        .filter(Boolean)
        .join("\n\n");
}
