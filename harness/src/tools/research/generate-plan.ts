/**
 * generatePlan — a loop-driving tool: a focused agent loop that builds an
 * analysis plan (a DAG of steps).
 *
 * The dataset's facts are NOT an input. They are read here, server-side, from
 * the analysis's persisted data profile — the one durable record of what the
 * input data is — and projected into the planner's seed. The caller supplies
 * only what the profile cannot hold: the research question, facts the user
 * volunteered (`analystNotes`), prior run results, and plan constraints. A
 * caller-typed dataset summary would be a model re-transcribing a record the
 * database already holds, and it would lose fidelity at every hop.
 *
 * The tool drives an internal "planner" agent that gives its outcome through
 * three terminal tools. None of them ends the run, and none writes:
 *
 *   - submit_plan(plan)         → checks a candidate; gives back the accepted
 *                                 plan or structured issues
 *   - request_clarification(…)  → the planner needs more context
 *   - report_blocker(reason)    → no viable plan
 *
 * After the run, the tool selects the outcome from the recorded calls — the
 * last accepted plan, else the last clarification, else the first blocker —
 * and persists an accepted plan under an id that a rerun of the call gives again.
 */

import type { ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { createReadScriptTools } from "../script/file-tools.js";
import type { ScriptRuntime } from "../script/run-script.js";
import { createReadSurfaceTools, type ReadSurfaceDeps } from "../workspace/read-surface.js";
import { errorMessageOf } from "../../lib/thrown.js";
import { textOf } from "../../lib/unknown-text.js";
import { createHash } from "node:crypto";

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { formatAgentCatalog } from "../../agents/sandbox-catalog.js";
import { composeSystemPrompt } from "../../agents/system-prompt.js";
import { DEFAULT_SALVAGE_REQUESTS, runWithSalvage, type LoopStep, type SalvagedResult } from "../../loop/run-loop.js";
import type { SubAgentRegistrar } from "../../loop/sub-agent.js";
import type { ToolOutputStore } from "../../loop/tool-output.js";
import type { AgentDefinition, LoopMessage } from "../../loop/types.js";
import { forSubAgent, scopeResource } from "../../auth/types.js";
import { PLAN_ID_RE } from "../../contracts/schemas/chat-parts.js";
import { effectiveDeadlineMs, type ChatProvider } from "../../providers/types.js";
import type { UsageRecorder } from "../../billing/usage-recorder.js";
import { isUnknownArray } from "../../lib/unknown-array.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { createReadToolOutputTool } from "../read-tool-output.js";
import type { EnvironmentStorePaths } from "../../config/environment-stores.js";
import { createListAvailablePackagesTool } from "../sandbox/list-available-packages.js";
import { createListAvailableRefsTool } from "../sandbox/list-available-refs.js";
import { blockerOf, createReportBlockerToolFor } from "../sandbox/report-blocker.js";
import { terminalTextSchema } from "../terminal-text.js";
import { searchGeoDatasetsTool } from "../bio/search-geo-datasets.js";
import { createNcbiTools, type BioToolKeys } from "../bio/keys.js";
import { createKnowledgeTools, type KnowledgeClient, type KnowledgeRecommendAnswer, type SkeletonStep } from "../knowledge/index.js";
import { queryDocsTool, resolveLibraryIdTool } from "./context7-docs.js";
import { searchArxivTool } from "./search-arxiv.js";
import { createSearchGithubReposTool } from "./search-github-repos.js";
import { createSearchSemanticScholarTool } from "./search-semantic-scholar.js";

import { DATA_PROFILE_ORIENTATION_MAX_CHARS, buildDataProfileOrientation } from "../../app/data-profile-orientation.js";
import { DEFAULT_SANDBOX_MAX_STEPS } from "../../config/resource-limits.js";
import { plannerPrompt } from "../../prompts/planner.js";
import { planCardOf } from "../../memory/card-builders.js";
import { hydratePlanSteps, PlannerPlanSchema, type PlannerPlan, type PlanningAgentOutput } from "../../schemas/plan-schemas.js";
import { validatePlan } from "../../schemas/validate-plan.js";
import { AnalysisPlanSchema } from "../../schemas/workflow-state.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { LogFields, Logger } from "../../lib/logger.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { decodeObjectString, hintForZodIssue } from "../../lib/zod-issues.js";
import { loadDataProfileStatus, loadPlan, upsertPlan, type DataProfileResult, type DataProfileStatus } from "../../state/index.js";

// ── Tool-level config ──────────────────────────────────────────────

/** Sub-agent identity for the planner — provenance only. */
const PLANNER_AGENT_ID = "planner";

/**
 * Budget for the planner's internal loop: the research phase, one draft/submit
 * attempt, correction retries, and headroom.
 *
 * The number is deliberately far above what a plan costs. A well-grounded plan
 * still costs two or three calls, because the prompt gates the research phase on
 * what the seed does not already answer. What the ceiling must never do is stop
 * a planner that is searching correctly. A capped run gets the salvage request
 * and submits the plan that it had, not the plan that it was building. Thus the
 * wall-clock guard, not this number, is what bounds the worst case.
 */
const PLANNER_MAX_ITERATIONS = 300;

/** Wall-clock guard for a single plan-generation invocation. */
const PLAN_TIMEOUT_MS = 1_800_000;

/**
 * The refusals of the call guard that end the search phase of one plan. A
 * planner that the guard refused this many times is not searching, it is
 * looping, and the salvage request lets it submit the plan it has. Six
 * is above any count a frontier planner reached in the Phase 0 campaign
 * (zero) and far below the hundred-plus refused calls of a looping run.
 */
const PLANNER_REFUSAL_LIMIT = 6;

// ── Diagnostic bounds ───────────────────────────────────────────────
//
// This tool writes no ledger row before its persist and owns no durable stream,
// so its log records are the ONLY account of an invocation that
// survives the turn. That makes them worth spending detail on — and makes every
// one of them a place an unbounded model-authored string could reach a log file.
// Each bound below is what keeps a record readable and a sink affordable when the
// planner is behaving at its worst, which is exactly when the record gets read.

/** Issues kept per rejection record. A plan bounces on a handful of distinct faults; the tail repeats. */
const MAX_LOGGED_ISSUES = 8;
/** Per-issue message budget — enough to identify the fault, not to reproduce the plan. */
const MAX_LOGGED_ISSUE_CHARS = 240;
/** Rejections kept on the finish record. Enough to show whether the planner converged or thrashed. */
const MAX_LOGGED_REJECTIONS = 6;
/** Excerpt of the planner's last words — the one artifact that explains a run ending on prose. */
const MAX_LOGGED_PROSE_CHARS = 800;
/** Tool-call trace length. A long research phase passes it, and `toolCallsTruncated` marks the record when it does. */
const MAX_LOGGED_TOOL_CALLS = 48;

/** Trim to `max`, marking the cut so a truncated value never reads as a complete one. */
function bounded(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, max)}…[+${value.length - max} chars]`;
}

/**
 * Record key under which free-form MODEL-authored text rides — never a structural
 * field, only prose a language model wrote.
 *
 * The segregation exists because these two things need different handling and are
 * otherwise indistinguishable in a flat record. A planner's own words routinely
 * quote the analysis: "atopic dermatitis skin biopsies; sample S7 is a QC outlier"
 * is a real example. That is the user's data. It belongs in a local diagnostic
 * file, where the user already holds it — and an embedder shipping records off the
 * machine needs one rule to keep it there, not a list of field names that goes
 * stale the moment a new field is added.
 *
 * The harness cannot enforce that rule: it does not own the sink. It owns the
 * declaration, so a host has something to act on. The cli drops this key at its
 * OTLP export boundary (`cli/src/lib/otel.ts`) while keeping it in the log file.
 *
 * Redaction at the logger root was the alternative and is wrong here: it applies
 * to every stream, so it would blank the field in the local file too — deleting
 * the one artifact that explains a planner which stopped on prose.
 */
const MODEL_AUTHORED_KEY = "modelAuthored";

/** Nest model-authored prose under {@link MODEL_AUTHORED_KEY}, or contribute nothing when there is none. */
function modelAuthored(fields: Record<string, string | undefined>): LogFields {
    const present = Object.entries(fields).reduce<[string, string][]>((kept, entry) => {
        const value = entry[1];
        if (value !== undefined && value.length > 0) kept.push([entry[0], value]);
        return kept;
    }, []);
    return present.length === 0 ? {} : { [MODEL_AUTHORED_KEY]: Object.fromEntries(present) };
}

/**
 * One `submit_plan` rejection, in the shape a log query wants.
 *
 * `codes` separates the two failure families that call for different fixes: a
 * `schema` count means the planner cannot produce the declared shape, a `semantic`
 * count means it produces valid JSON describing an impossible DAG. `paths` is what
 * makes repeated rejections comparable at a glance — identical paths across
 * attempts is a planner stuck, moving paths is a planner making progress and
 * merely running out of budget.
 */
type RejectionRecord = {
    readonly attempt: number;
    readonly issueCount: number;
    readonly codes: { readonly schema: number; readonly semantic: number };
    readonly paths: readonly string[];
    readonly messages: readonly string[];
};

function toRejectionRecord(attempt: number, issues: readonly ValidationIssue[]): RejectionRecord {
    const kept = issues.slice(0, MAX_LOGGED_ISSUES);
    return {
        attempt,
        issueCount: issues.length,
        codes: {
            schema: issues.filter((i) => i.code === "schema").length,
            semantic: issues.filter((i) => i.code === "semantic").length,
        },
        paths: kept.map((i) => i.path),
        messages: kept.map((i) => bounded(i.message, MAX_LOGGED_ISSUE_CHARS)),
    };
}

/**
 * What the planner did over one invocation, read from its recorded calls.
 *
 * The failure this exists for is invisible from the outcome alone: `submit_plan`
 * does not end the run, so a planner can spend its entire budget on submit →
 * reject → fix → reject and end with no accepted plan. That reads as "the
 * planner never called a terminal tool" — the same ending as a planner that
 * stopped on prose after one turn, and the opposite problem.
 */
type PlannerTrace = {
    readonly submitAttempts: number;
    /**
     * True count of rejected attempts — NOT `rejections.length`, which stops at
     * {@link MAX_LOGGED_REJECTIONS}. A record reporting 16 attempts and 6 rejections
     * says ten of them were accepted, which is the opposite of what happened.
     */
    readonly rejectedAttempts: number;
    /** The first {@link MAX_LOGGED_REJECTIONS} rejections, in full. */
    readonly rejections: readonly RejectionRecord[];
};

function traceOf(steps: readonly LoopStep[]): PlannerTrace {
    let submitAttempts = 0;
    let rejectedAttempts = 0;
    const rejections: RejectionRecord[] = [];
    for (const step of steps) {
        for (const call of step.calls) {
            if (call.toolName !== SUBMIT_PLAN_TOOL_ID || call.output === undefined) continue;
            submitAttempts += 1;
            const issues = submitIssuesOf(call.output);
            if (issues === undefined) continue;
            rejectedAttempts += 1;
            if (rejections.length < MAX_LOGGED_REJECTIONS) rejections.push(toRejectionRecord(submitAttempts, issues));
        }
    }
    return { submitAttempts, rejectedAttempts, rejections };
}

// ── Prompt / catalog ────────────────────────────────────────────────

/** The planner system prompt is deterministic for the process: the catalog is fixed at load. */
export function plannerInstructions(): string {
    return plannerPrompt(formatAgentCatalog());
}

// ── Shared types ────────────────────────────────────────────────────

/** The outcome of an invocation: the selection from the recorded calls, then the persist of a plan. */
type PlannerOutcome =
    | { kind: "plan_submitted"; planId: string; plan: PlannerPlan }
    | { kind: "clarification"; question: string; questionContext?: string }
    | { kind: "blocker"; reason: string }
    | { kind: "persist_error"; message: string };

type PersistContext = {
    analysisId: string;
    parentPlanId: string | null;
    /** The request of the call, which the stored plan carries to the briefing of each step. */
    request: string;
    /** The id of the `generate_plan` call: a rerun of the call gives it again, thus the persist gives one plan. */
    invocationId: string;
};

type ValidationIssue = {
    path: string;
    code: "schema" | "semantic";
    message: string;
    hint?: string;
};

const ValidationIssueSchema = z.object({ path: z.string(), code: z.enum(["schema", "semantic"]), message: z.string(), hint: z.string().optional() });

type SubmitPlanOutput = { accepted: false; issues: ValidationIssue[] } | { accepted: true; plan: PlannerPlan };

const SubmitPlanOutputSchema = z.discriminatedUnion("accepted", [
    z.object({ accepted: z.literal(false), issues: z.array(ValidationIssueSchema) }),
    z.object({ accepted: z.literal(true), plan: PlannerPlanSchema }),
]);

const SUBMIT_PLAN_TOOL_ID = "submit_plan";
const REQUEST_CLARIFICATION_TOOL_ID = "request_clarification";

const ClarificationSchema = z.object({ kind: z.literal("clarification"), question: z.string(), questionContext: z.string().optional() });

/** The issues of a refused submission, or `undefined` for an accepted one and for an output that is no submission. */
function submitIssuesOf(output: NonNullable<LoopStep["calls"][number]["output"]>): readonly ValidationIssue[] | undefined {
    if (output.outcome === "error") return [{ path: "plan", code: "schema", message: output.text }];
    if (output.outcome !== "ok") return undefined;
    const parsed = SubmitPlanOutputSchema.safeParse(output.value);
    return parsed.success && !parsed.data.accepted ? parsed.data.issues : undefined;
}

/**
 * The outcome of a run, selected from its recorded calls: the last accepted
 * plan, else the last clarification, else the first blocker.
 */
function selectedOutcomeOf(
    steps: readonly LoopStep[],
): { kind: "plan"; plan: PlannerPlan } | Extract<PlannerOutcome, { kind: "clarification" | "blocker" }> | null {
    let plan: PlannerPlan | undefined;
    let clarification: Extract<PlannerOutcome, { kind: "clarification" }> | undefined;
    for (const step of steps) {
        for (const call of step.calls) {
            if (call.output?.outcome !== "ok") continue;
            if (call.toolName === SUBMIT_PLAN_TOOL_ID) {
                const parsed = SubmitPlanOutputSchema.safeParse(call.output.value);
                if (parsed.success && parsed.data.accepted) plan = parsed.data.plan;
            } else if (call.toolName === REQUEST_CLARIFICATION_TOOL_ID) {
                const parsed = ClarificationSchema.safeParse(call.output.value);
                if (parsed.success) clarification = { kind: "clarification", question: parsed.data.question, questionContext: parsed.data.questionContext };
            }
        }
    }
    if (plan !== undefined) return { kind: "plan", plan };
    if (clarification !== undefined) return clarification;
    const blocker = blockerOf(steps);
    return blocker === null ? null : { kind: "blocker", reason: blocker.reason };
}

// ── Prior plan serialization (iteration context) ───────────────────

/**
 * Format a loaded prior plan as a markdown block the planner can read —
 * narrative + one line per step. Used only when `parentPlanId` is set.
 */
export function formatPriorPlan(parentPlanId: string, plan: unknown): string | null {
    const parsed = AnalysisPlanSchema.safeParse(plan);
    if (!parsed.success) return null;
    const p = parsed.data;

    const stepLines = p.steps.map((s) => {
        const deps = s.depends_on.length ? ` [deps: ${s.depends_on.join(", ")}]` : "";
        const agent = s.agent ? ` (${s.agent})` : "";
        return `- **${s.id}**${agent}: ${s.name} — ${s.question}${deps}`;
    });

    return [
        `## Prior Plan (${parentPlanId} — being iterated)`,
        "",
        ...(p.analytical_narrative ? [`**Analytical narrative:** ${p.analytical_narrative}`, ""] : []),
        "**Steps:**",
        ...stepLines,
        "",
        "The user is revising this plan, not asking for a new one. The changes are in `## User Constraints`. " +
            "Each step keeps its id, its agent, and its order, also a step that the user asked to change: apply the change to that step. " +
            "Thus `depends_on` and the stored artifacts survive. Give a new id to new work only.",
    ].join("\n");
}

// ── Data context (server-derived, never model-authored) ────────────

/**
 * What the planner actually holds about the dataset.
 *
 * Every lifecycle state is a variant because every one of them is ordinary: an
 * analysis can be planned before it has been profiled, while profiling is in
 * flight, after an attempt failed, and against a profile whose input files have
 * since changed. None of those is an error, and none of them may stop a plan
 * being produced — a planner told which state it is in can plan accordingly; a
 * planner told nothing plans on facts it cannot know are rotten.
 */
export type DataGrounding =
    | { kind: "ready"; result: DataProfileResult }
    /** A profile IS available, but may not describe the analysis's current inputs. */
    | { kind: "provisional"; result: DataProfileResult; reasons: readonly string[] }
    /** Profiling is in flight and no earlier profile exists. */
    | { kind: "pending" }
    /** Profiling failed and no earlier profile exists. */
    | { kind: "failed"; error: string | null }
    /** Never profiled, cleared, or nothing to profile. */
    | { kind: "absent" };

/**
 * Read the profile ledger row into a grounding variant.
 *
 * A profile is re-invoked by the embedder when the input set changes, never derived
 * as stale on read, so the only qualification this can raise is one the ledger row
 * states outright: an attempt that superseded this result is running, or failed.
 */
function classifyGrounding(status: DataProfileStatus | null): DataGrounding {
    // `loadDataProfileStatus` collapses "no analysis row" and "profile cleared"
    // into one null, deliberately — both mean "no profile" to a consumer.
    if (!status) return { kind: "absent" };

    const result = status.result;
    if (!result) {
        if (status.status === "failed") return { kind: "failed", error: status.error };
        // `completed` with no result is the empty-manifest path: there were no
        // input files to profile. "Nothing is known about the data" is the honest
        // reading of that, not a failure.
        if (status.status === "completed") return { kind: "absent" };
        return { kind: "pending" };
    }

    // A result outlives the attempt that superseded it: `tryRerun` / `tryRetry`
    // preserve `data_profile_result` on purpose, so a non-`completed` status
    // carrying a result means what is on the row is the PREVIOUS profile.
    const reasons: string[] = [];
    if (status.status === "pending" || status.status === "running") {
        reasons.push("a re-profile is in progress — this is the previous profile");
    }
    if (status.status === "failed") {
        reasons.push(`the most recent profiling attempt failed (${status.error ?? "no reason recorded"}) — this is the previous profile`);
    }

    return reasons.length > 0 ? { kind: "provisional", result, reasons } : { kind: "ready", result };
}

/** What a seed says when it has no dataset facts to give the planner. */
const NO_FACTS_GUIDANCE =
    "Plan from the research question alone, do not invent dataset specifics, and call " +
    "`request_clarification` if a specific fact about the data is essential to the plan.";

/**
 * Render the seed's `## Data Context` from the grounding.
 *
 * The facts come from `buildDataProfileOrientation` — the same bounded projector
 * the sandbox step seed uses, so a step and the plan that produced it are oriented
 * by identical text. It is not re-derived here, and the planner cannot reach past
 * it: the planner has no `inspect_data_profile` tool, so what this section does not
 * say is simply not known to it.
 *
 * An absent profile renders NOTHING — no heading, no apology. Planning without
 * dataset facts is worse-grounded but entirely possible, and a section announcing
 * its own emptiness is an invitation to fill it. Every other state renders,
 * including the two that carry no facts either: a planner told that its record is
 * still being built, or that its facts may have moved, can act on that; one handed
 * stale facts silently cannot.
 *
 * Pure — the same grounding renders the same string.
 */
export function renderDataContext(grounding: DataGrounding, analysisId: string): string {
    switch (grounding.kind) {
        case "absent":
            return "";

        case "pending":
            return ["## Data Context", "", `This analysis is still being profiled — no dataset facts are available yet. ${NO_FACTS_GUIDANCE}`].join("\n");

        case "failed":
            return [
                "## Data Context",
                "",
                `Data profiling failed (${grounding.error ?? "no reason recorded"}) and no earlier profile exists, ` +
                    `so no dataset facts are available. ${NO_FACTS_GUIDANCE}`,
            ].join("\n");

        case "ready":
        case "provisional": {
            const lines = [
                "## Data Context",
                "",
                "From this analysis's persisted data profile — the authoritative record of what the input data " +
                    "is, derived by profiling the files themselves. Nobody typed it; ground your plan in it.",
                "",
                buildDataProfileOrientation(grounding.result, analysisId, DATA_PROFILE_ORIENTATION_MAX_CHARS),
            ];
            if (grounding.kind === "provisional") {
                lines.push(
                    "",
                    `PROVISIONAL — this profile may not describe the analysis's current inputs: ${grounding.reasons.join("; ")}. ` +
                        "Plan on it, but keep the plan robust to any fact above having moved.",
                );
            }
            return lines.join("\n");
        }
    }
}

// ── Persistence ─────────────────────────────────────────────────────

/** The id of the plan of one call. A rerun of the call gives the same id, thus the upsert keeps one plan. */
function planIdFor(ctx: PersistContext): string {
    return `pln-${createHash("sha256").update(`${ctx.analysisId}:${ctx.invocationId}`).digest("hex").slice(0, 8)}`;
}

/**
 * Persist a validated plan. Returns the planId, or an outcome-ready error
 * with a sanitized message — DB-shape errors never leak to the planner.
 *
 * The sanitization is for the model, not for the operator: "plan could not be
 * saved, please try again" is all the planner may see, and it is useless to
 * whoever has to fix the cause. The record here is the only place the real
 * failure survives, so it is written before the message is flattened.
 */
async function persistPlan(
    plan: PlannerPlan,
    ctx: PersistContext,
    pool: Pool,
    logger: Logger,
): Promise<{ ok: true; planId: string } | { ok: false; message: string }> {
    try {
        const planId = planIdFor(ctx);
        unwrapOrThrow(
            await upsertPlan(pool, {
                planId,
                analysisId: ctx.analysisId,
                plan: { ...hydratePlanSteps(plan), request: ctx.request },
                parentPlanId: ctx.parentPlanId,
            }),
        );
        return { ok: true, planId };
    } catch (err) {
        const raw = errorMessageOf(err) ?? textOf(err);
        const lower = raw.toLowerCase();
        const isParentValidation = lower.startsWith("parent plan ") && (lower.endsWith("not found") || lower.endsWith("belongs to a different analysis"));
        logger.error("plan persistence failed", {
            parentPlanId: ctx.parentPlanId,
            stepCount: plan.steps.length,
            classified: isParentValidation ? "invalid_parent_plan" : "write_failed",
            ...logger.errorFields(err),
        });
        return {
            ok: false,
            message: isParentValidation ? "parentPlanId is not a valid plan for this analysis" : "plan could not be saved, please try again",
        };
    }
}

// ── Validation ──────────────────────────────────────────────────────

function zodIssuesToValidationIssues(error: z.ZodError, input: unknown, rootPath = "plan"): ValidationIssue[] {
    return error.issues.map((i) => ({
        path: [rootPath, ...i.path.map((p) => String(p))].join("."),
        code: "schema" as const,
        message: i.message,
        hint: hintForZodIssue(i, input),
    }));
}

/**
 * The last `knowledge_recommend` answer of one invocation: the skeleton steps
 * by step id, every claim id the answer returned, from the steps, their
 * alternatives, their disputed rules, the claim views, and the flags, and
 * the snapshot digest the answer came from.
 */
type RecommendMemory = {
    readonly steps: Map<string, SkeletonStep>;
    readonly claims: Set<string>;
    /** The digest of the last answer; `undefined` before the first. */
    digest?: string;
};

function rememberAnswer(memory: RecommendMemory, answer: KnowledgeRecommendAnswer): void {
    memory.steps.clear();
    memory.claims.clear();
    memory.digest = answer.snapshot.digest;
    for (const step of answer.plan_skeleton) {
        memory.steps.set(step.id, step);
        for (const claim of step.grounding.claims) memory.claims.add(claim);
        for (const alternative of step.alternatives) for (const rule of alternative.rules) memory.claims.add(rule);
        if (step.disputed !== undefined) memory.claims.add(step.disputed.rule);
    }
    for (const claim of answer.claims) memory.claims.add(claim.id);
    for (const flag of answer.flags) memory.claims.add(flag.rule);
}

/** The rule of a claim id: `R-0001` of `R-0001@e7d0`. */
function ruleOf(claim: string): string {
    return claim.split("@")[0] ?? claim;
}

/** One claim id per rule of the answer. A rule with two ids in one answer cannot be repaired, and it is absent. */
function claimsByRule(claims: ReadonlySet<string>): ReadonlyMap<string, string> {
    const byRule = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const claim of claims) {
        const rule = ruleOf(claim);
        if (byRule.has(rule)) ambiguous.add(rule);
        else byRule.set(rule, claim);
    }
    for (const rule of ambiguous) byRule.delete(rule);
    return byRule;
}

/** A claim id the model repaired on one step: the id it wrote and the id of the answer. */
type RepairedClaim = {
    readonly step: string;
    readonly from: string;
    readonly to: string;
};

/**
 * Restore the grounding fields the host owns on each candidate step, from the
 * last answer. A model copies the skeleton into the plan, and it drops the
 * template field at times, or it miscopies the 64-character digest or the
 * hash of a claim id, while it keeps the claims and the settings.
 *
 * On a step that copies a skeleton step, by step id, the host stamps the
 * snapshot digest of the answer and restores a dropped template: the digest
 * is what pins the step to the snapshot, and the template is what the host
 * binds the contract to. A step whose snapshot is `none` states that it does
 * not use the answer, and it stays as it is. A step whose status is
 * `ungrounded` states a departure from the answer: the digest is stamped,
 * and no template is restored, because the template realizes the method the
 * step left.
 *
 * On every step, a claim id the answer did not return is repaired when the
 * answer holds one claim of the same rule: one snapshot holds one version of
 * a rule, thus the rule names the claim. A claim of a rule the answer does
 * not hold is an issue that rejects the plan, so the model cites a claim of
 * the answer or removes it.
 *
 * A step the skeleton does not hold, for example a robustness step the model
 * adds under its own id, gets the digest stamped too when one of its claims
 * is a claim of the answer: the claim vouches that the step consulted the
 * answer, and the digest it typed is as prone to a miscopy as any other. A
 * step with no claim of the answer stays as the model wrote it, because
 * nothing of the answer vouches for it. Returns the stamped steps, the
 * restored steps, the repaired claims, and the issues beside the new
 * candidate. A candidate that is not a plan-shaped object, or a plan with no
 * answer, comes back as it is.
 */
function restoreSkeletonGrounding(
    candidate: unknown,
    memory: RecommendMemory,
): {
    readonly candidate: unknown;
    readonly stamped: readonly string[];
    readonly restored: readonly string[];
    readonly repaired: readonly RepairedClaim[];
    readonly unknown: readonly ValidationIssue[];
} {
    const decoded = decodeObjectString(candidate);
    const decodedRecord = parseUnknownRecord(decoded);
    const decodedSteps = decodedRecord?.steps;
    if (memory.steps.size === 0 || !isUnknownArray(decodedSteps)) {
        return { candidate: decoded, stamped: [], restored: [], repaired: [], unknown: [] };
    }
    const byRule = claimsByRule(memory.claims);
    const stamped: string[] = [];
    const restored: string[] = [];
    const repaired: RepairedClaim[] = [];
    const unknown: ValidationIssue[] = [];
    const steps = decodedSteps.map((step, index) => {
        const fields = parseUnknownRecord(step);
        if (fields === undefined) return step;
        const { id, grounding } = fields;
        const current = parseUnknownRecord(grounding);
        if (current === undefined) return step;
        const label = typeof id === "string" ? id : String(index);
        let next = current;
        const source = typeof id === "string" ? memory.steps.get(id) : undefined;
        if (source !== undefined && current.snapshot !== "none") {
            if (next.snapshot !== source.grounding.snapshot) {
                stamped.push(label);
                next = { ...next, snapshot: source.grounding.snapshot };
            }
            if (next.template === undefined && source.grounding.template !== undefined && current.status !== "ungrounded") {
                restored.push(label);
                next = { ...next, template: source.grounding.template };
            }
        }
        if (isUnknownArray(current.claims)) {
            let changed: boolean | undefined;
            const claims = current.claims.map((claim, position) => {
                if (typeof claim !== "string" || memory.claims.has(claim)) return claim;
                const match = byRule.get(ruleOf(claim));
                if (match !== undefined) {
                    repaired.push({ step: label, from: claim, to: match });
                    changed = true;
                    return match;
                }
                unknown.push({
                    path: `plan.steps.${index}.grounding.claims.${position}`,
                    code: "semantic",
                    message: `Claim ${claim} is not a claim of the knowledge_recommend answer of this run. Cite a claim id the answer returned, or remove it.`,
                });
                return claim;
            });
            if (changed) next = { ...next, claims };
        }
        // The repaired claims are the ones compared, thus a step whose only claim was miscopied still gets the digest.
        const vouched = Array.isArray(next.claims) && next.claims.some((claim) => typeof claim === "string" && memory.claims.has(claim));
        if (source === undefined && vouched && memory.digest !== undefined && current.snapshot !== "none" && next.snapshot !== memory.digest) {
            stamped.push(label);
            next = { ...next, snapshot: memory.digest };
        }
        return next === current ? step : { ...fields, grounding: next };
    });
    return { candidate: { ...decodedRecord, steps }, stamped, restored, repaired, unknown };
}

/**
 * Full validation: Zod schema + semantic checks. The plan is valid only if
 * BOTH pass.
 */
function fullyValidate(candidate: unknown): { valid: true; plan: PlannerPlan } | { valid: false; issues: ValidationIssue[] } {
    // The permissive arg schema of the planner tools accepts a string, thus the
    // loop-boundary repair never sees a plan that a model sent as a JSON-encoded
    // string. A small model does this on a large nested schema. Decode it here,
    // the same as run-synthesis does, so the schema issues describe the plan
    // inside the string and not the string.
    const decoded = decodeObjectString(candidate);
    const parsed = PlannerPlanSchema.safeParse(decoded);
    if (!parsed.success) {
        return { valid: false, issues: zodIssuesToValidationIssues(parsed.error, decoded) };
    }

    // Semantic checks operate on the AnalysisPlan shape — PlannerPlan omits
    // maxSteps, so inject the execution-time default to satisfy the validator.
    const semantic = validatePlan({
        analytical_narrative: parsed.data.analytical_narrative,
        steps: parsed.data.steps.map((s) => ({
            ...s,
            status: "pending" as const,
            maxSteps: DEFAULT_SANDBOX_MAX_STEPS,
        })),
        created_at: parsed.data.created_at,
        omicsType: parsed.data.omicsType,
        omicsSubtype: parsed.data.omicsSubtype,
    });

    if (!semantic.valid) {
        return {
            valid: false,
            issues: semantic.errors.map((msg) => ({
                path: "plan",
                code: "semantic" as const,
                message: msg,
            })),
        };
    }

    return { valid: true, plan: parsed.data };
}

// ── Inner tools (fresh instance per outer tool invocation) ─────────

/**
 * The planner's inner tools. Only terminal tools enter the loop
 * (`submit_plan`, `request_clarification`, `report_blocker`); environment
 * inventories are read before the loop and injected into its seed message.
 * The ids of the terminal list make the mask of the salvage, if one is needed.
 */
type InnerTools = {
    readonly terminal: Tool[];
};

/** The planner agent over its search tools and its terminal tools. */
export function plannerAgentOf(deps: GeneratePlanDeps, searchTools: readonly Tool[], terminal: readonly Tool[]): AgentDefinition {
    const readTools = deps.toolOutputStore ? [createReadToolOutputTool(deps.toolOutputStore)] : [];
    return {
        id: PLANNER_AGENT_ID,
        systemPrompt: composeSystemPrompt(plannerInstructions()),
        model: deps.conversation.model,
        // The search tools come first, and the terminal tools come last. The order is the order of the prompt, and it
        // is stable across every invocation, thus the cached request prefix holds.
        tools: [...searchTools, ...createReadSurfaceTools(deps.workspace), ...readTools, ...terminal],
        scriptTools: createReadScriptTools(deps.workspace),
        scriptRuntime: deps.scriptRuntime,
        maxIterations: PLANNER_MAX_ITERATIONS,
    };
}

/** The terminal tools of a planner with no knowledge answer, for a consumer that runs the planner outside this tool. */
export function plannerTerminalTools(logger: Logger): Tool[] {
    return buildInnerTools(logger, { steps: new Map(), claims: new Set() }).terminal;
}

/**
 * Build the planner's inner tools for one invocation. `memory` holds the last
 * `knowledge_recommend` answer of the run, which the loop folds after each round.
 */
function buildInnerTools(logger: Logger, memory: RecommendMemory): InnerTools {
    const submitPlanTool = defineTool({
        id: SUBMIT_PLAN_TOOL_ID,
        description:
            "Submit the plan. Checks the plan; on success returns {accepted: true, plan} " +
            "with the plan as the harness saves it — stop after an accepted plan. On " +
            "rejection returns {accepted: false, issues} — fix and call again, " +
            "or switch to report_blocker if the plan cannot be made valid. The last " +
            "accepted plan is the plan of this session. This arg schema is the " +
            "authoritative plan contract.",
        // Permissive on purpose: every candidate reaches `execute`, where the
        // model gets structured schema and semantic issues in one response.
        // The field-by-field contract remains visible in this tool's description
        // and the validation below is authoritative.
        inputSchema: z.object({
            // Keep the authoritative shape visible to the model while the
            // permissive branch lets malformed candidates reach execute for
            // structured issue reporting.
            plan: z.union([PlannerPlanSchema, z.unknown()]).describe("Candidate plan; malformed values are reported in issues."),
        }),
        view: "none",
        describeCall: "none",
        execute: (input): Promise<Result<SubmitPlanOutput, ToolError>> => {
            // The host owns the grounding fields: it fills them from the last answer of the run.
            const { candidate, stamped, restored, repaired, unknown } = restoreSkeletonGrounding(input.plan, memory);
            if (stamped.length > 0) logger.info("submit_plan stamped the snapshot digest of the answer on steps", { steps: stamped });
            if (restored.length > 0) logger.info("submit_plan restored the template of skeleton steps", { steps: restored });
            if (repaired.length > 0) logger.info("submit_plan repaired the claim ids of plan steps", { claims: repaired });
            const result = fullyValidate(candidate);
            // An unknown claim rejects a plan that the schema accepts, beside the
            // schema issues when the schema rejects it, thus one attempt shows both.
            if (!result.valid || unknown.length > 0) {
                const issues = [...(result.valid ? [] : result.issues), ...unknown];
                // `warn`, not `debug`: a rejection is non-terminal by design, so the model
                // reads the issues and the invocation carries on — nothing else reports that
                // an attempt was spent.
                logger.warn("submit_plan rejected a plan", { issueCount: issues.length, paths: issues.slice(0, MAX_LOGGED_ISSUES).map((i) => i.path) });
                return Promise.resolve(ok({ accepted: false as const, issues }));
            }
            logger.info("submit_plan accepted a plan", {
                stepCount: result.plan.steps.length,
                agents: [...new Set(result.plan.steps.map((s) => s.agent))],
            });
            return Promise.resolve(ok({ accepted: true as const, plan: result.plan }));
        },
    });

    const requestClarificationTool = defineTool({
        id: REQUEST_CLARIFICATION_TOOL_ID,
        description:
            "Terminal. Use when a specific fact you need is missing from the " +
            "input and cannot be inferred. The question reaches the user through " +
            "the conversation agent, and no plan is saved. Stop after this call.",
        inputSchema: z.object({
            question: terminalTextSchema("One short question that names each missing fact, and the step that needs it."),
            questionContext: z.string().optional().describe("Optional context: why the plan needs the fact, and what the inputs already say about it."),
        }),
        view: "none",
        describeCall: "none",
        execute: (input) =>
            Promise.resolve(
                ok({
                    kind: "clarification" as const,
                    question: input.question,
                    questionContext: input.questionContext,
                    message: "Clarification recorded. Stop now.",
                }),
            ),
    });

    const reportBlockerTool = createReportBlockerToolFor({
        blockedWhen:
            "Ends plan generation with no plan saved. Use it when no valid plan can " +
            "be produced for this data and research question (out of scope, data " +
            "incompatible with every available agent, etc.) — not for a plan you " +
            "could fix and submit.",
    });

    const terminal = [submitPlanTool, requestClarificationTool, reportBlockerTool];
    return { terminal };
}

/**
 * Render one environment inventory into the seed, reporting a lookup that failed.
 *
 * A failed lookup is written INTO the prompt as prose the planner then plans
 * around — a silent degradation of its grounding that no caller is told about and
 * no outcome distinguishes. The record is what makes "the planner produced a plan
 * naming packages this install does not have" traceable to its cause.
 */
export function inventoryContent(label: string, result: Awaited<ReturnType<Tool["execute"]>>, logger: Logger): string {
    if (result.isErr()) {
        logger.warn("planner grounding inventory lookup failed", { inventory: label, error: result.error.error });
        return `## ${label}\n\nInventory lookup failed: ${result.error.error}`;
    }
    const value = result.value;
    const content = parseUnknownRecord(value)?.["content"];
    if (typeof content === "string") {
        return `## ${label}\n\n${content}`;
    }
    return `## ${label}\n\n${JSON.stringify(value)}`;
}

// ── Transcript reading (diagnostics only) ───────────────────────────

/**
 * The planner's own account of the run, read off the message array that the run
 * returns. Nothing else can produce it: the transcript is ephemeral — a sub-agent
 * loop persists no messages anywhere — so it is read here or it is lost with the
 * turn.
 *
 * `toolCalls` in order is what shows the SHAPE of a failure at a glance:
 * `[submit_plan × 13]` is a planner thrashing on validation, `[]` is a planner
 * that never called anything, and a trailing `report_blocker` on a run that ended
 * with no outcome means the terminal call was cut off before it executed.
 */
function readTranscript(messages: readonly LoopMessage[]): { toolCalls: string[]; truncatedToolCalls: boolean; finalProse: string } {
    const toolCalls: string[] = [];
    let finalProse = "";
    for (const message of messages) {
        if (message.role !== "assistant" || typeof message.content === "string") {
            if (message.role === "assistant" && typeof message.content === "string" && message.content.length > 0) finalProse = message.content;
            continue;
        }
        for (const part of message.content) {
            if (part.type === "tool-call") toolCalls.push(part.toolName);
            // Last one wins: the closing text of the run is what explains a run that
            // stopped talking instead of calling its terminal tool.
            else if (part.type === "text" && part.text.trim().length > 0) finalProse = part.text;
        }
    }
    return {
        toolCalls: toolCalls.slice(0, MAX_LOGGED_TOOL_CALLS),
        truncatedToolCalls: toolCalls.length > MAX_LOGGED_TOOL_CALLS,
        finalProse: bounded(finalProse.trim(), MAX_LOGGED_PROSE_CHARS),
    };
}

/**
 * The loop half of the finish record: how the planner's run ended, and what it
 * did to get there.
 *
 * Without it, `no_outcome` is a single word covering three unrelated failures — a
 * budget spent on rejected submits (`max_iterations`), a planner that answered in
 * prose (`stop`), and a reply cut off at the output-token limit (`length`) — which
 * is why three identical-looking retries taught nobody anything.
 */
function loopFields(run: SalvagedResult, kind: OutcomeKind): LogFields {
    const transcript = readTranscript(run.messages);
    const fields: LogFields = {
        loop: {
            finishReason: run.finish.reason,
            cappedOut: run.finish.cappedOut,
            salvaged: run.salvage !== null,
            firstFinishReason: run.salvage === null ? undefined : run.salvage.firstFinish.reason,
            salvageFinishReason: run.salvage === null ? undefined : run.salvage.finish.reason,
            toolCalls: transcript.toolCalls,
            toolCallsTruncated: transcript.truncatedToolCalls ? true : undefined,
        },
    };
    if (PROSE_EXPLAINS_OUTCOME.has(kind)) Object.assign(fields, modelAuthored({ plannerFinalProse: transcript.finalProse }));
    return fields;
}

/**
 * The endings whose only account is what the planner said last.
 *
 * Everywhere else something better already explains the outcome: the selected
 * result carries its own argument, the blocker record gives its reason, or a
 * thrown cause carries the fault. Logging the
 * prose there would put model output describing the user's data into a record
 * that had no use for it — including on every successful plan, where the closing
 * text is the planner narrating work that demonstrably went fine.
 */
const PROSE_EXPLAINS_OUTCOME: ReadonlySet<OutcomeKind> = new Set<OutcomeKind>(["no_outcome", "loop_error", "timeout"]);

// ── Outcome shaping ─────────────────────────────────────────────────

type ShapeOutcomeArgs = {
    outcome: PlannerOutcome | null;
    runError: unknown;
    timedOut: boolean;
    outerAborted: boolean;
};

/**
 * How the invocation ended, at the granularity a diagnostic reader needs.
 *
 * Finer than `PlanningAgentOutput.event`, which collapses six distinct endings
 * into `"error"` because the conversation agent only needs to know it has no
 * plan. Whoever is asking *why* plan generation keeps failing needs the six kept
 * apart — a wall-clock guard elapsing and a planner stopping on prose call for
 * opposite responses.
 */
type OutcomeKind =
    | "plan_submitted"
    | "clarification"
    | "blocker"
    | "persist_error"
    | "timeout"
    | "cancelled"
    | "loop_error"
    | "no_outcome"
    /** Rejected before the planner ran — the parent plan named for iteration is not this analysis's. */
    | "invalid_parent_plan"
    /** Rejected before the planner ran — the parent plan could not be read. */
    | "parent_plan_load_failed";

type ShapedOutcome = {
    readonly output: PlanningAgentOutput;
    readonly kind: OutcomeKind;
};

/**
 * Translate the captured `PlannerOutcome` (plus any loop error) into the
 * `PlanningAgentOutput` contract the conversation agent consumes, alongside the
 * kind the diagnostic record carries.
 *
 * Both come out of one branch deliberately: deriving the kind separately would
 * be a second copy of this precedence order, free to drift from the answer the
 * caller actually returned.
 */
function shapeOutcome(args: ShapeOutcomeArgs): ShapedOutcome {
    const { outcome, runError, timedOut, outerAborted } = args;

    if (outcome?.kind === "plan_submitted") {
        return { output: { event: "plan_complete", planId: outcome.planId, plan: outcome.plan }, kind: "plan_submitted" };
    }
    if (outcome?.kind === "clarification") {
        return {
            output: {
                event: "clarification_needed",
                question: outcome.question,
                questionContext: outcome.questionContext ? outcome.questionContext : undefined,
            },
            kind: "clarification",
        };
    }
    if (outcome?.kind === "blocker") {
        return { output: { event: "error", error: outcome.reason }, kind: "blocker" };
    }
    if (outcome?.kind === "persist_error") {
        return { output: { event: "error", error: `Failed to save plan: ${outcome.message}` }, kind: "persist_error" };
    }

    // No terminal outcome — something went wrong in the loop.
    if (timedOut) {
        return {
            output: {
                event: "error",
                error: "Plan generation timed out — the model may be overloaded.",
            },
            kind: "timeout",
        };
    }
    if (outerAborted) {
        return { output: { event: "error", error: "Plan generation was cancelled." }, kind: "cancelled" };
    }
    if (runError) {
        const msg = errorMessageOf(runError) ?? textOf(runError);
        return { output: { event: "error", error: `Plan generation failed: ${msg}` }, kind: "loop_error" };
    }
    return {
        output: {
            event: "error",
            error:
                "Plan generation completed without a terminal outcome — the planner " + "did not call submit_plan, request_clarification, or report_blocker.",
        },
        kind: "no_outcome",
    };
}

/**
 * Severity follows the ending, not the return type — which is uniformly `ok(...)`,
 * so it distinguishes nothing. A submitted plan and a clarification request are
 * both this tool working as designed; a blocker is a real answer that cost the
 * user their plan; the rest are failures.
 */
const OUTCOME_LEVEL: Record<OutcomeKind, "info" | "warn" | "error"> = {
    plan_submitted: "info",
    clarification: "info",
    blocker: "warn",
    persist_error: "error",
    timeout: "error",
    cancelled: "error",
    loop_error: "error",
    no_outcome: "error",
    invalid_parent_plan: "warn",
    parent_plan_load_failed: "error",
};

// ── Outer tool ──────────────────────────────────────────────────────

export type GeneratePlanDeps = EnvironmentStorePaths & {
    /**
     * The conversation-role backend the planner is pinned to. Keeping the
     * provider and its model label in one value prevents composition roots from
     * accidentally pairing the planner with the sandbox or utility role.
     */
    readonly conversation: {
        readonly provider: ChatProvider;
        readonly model: string;
    };
    /** Database pool — plan persistence and prior-plan loading. */
    readonly pool: Pool;
    /** Diagnostic sink. Absent, the tool runs silently — see `LoopOptions.logger`. */
    readonly logger?: Logger;
    /** LLM usage-accounting seam for the planner loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** The store of the planner loop and of its read tool. */
    readonly toolOutputStore?: ToolOutputStore;
    /** API keys for the search tools the planner uses to ground a plan. */
    readonly bioKeys: BioToolKeys;
    /** The read-only workspace: the file tools, the search, the data profile, and the script reads of a PDF and a table. */
    readonly workspace: ReadSurfaceDeps & { readonly resolveWorkspaceRoot: ResolveWorkspaceRoot };
    /** Where the VM of `run_script` comes from, for the script reads. See `ScriptRuntime`. */
    readonly scriptRuntime?: ScriptRuntime;
    /**
     * The knowledge service client. Bound, the planner gains `knowledge_recommend`
     * and `knowledge_check`. Absent, no knowledge tool attaches and no
     * description of one enters the context, which is the default state of
     * the open-source host.
     */
    readonly knowledge?: KnowledgeClient;
};

/**
 * The search tools of the planner — built one time, not per invocation.
 *
 * The set answers the two questions that a seed cannot. "What did a study of
 * this kind do before?" reaches the public dataset records and the literature.
 * "What does this package actually give me?" reaches the developer docs. The
 * planner reads its reference and package inventories from the seed, thus the
 * docs pair is what turns a package name into a real function.
 *
 * A tool here never writes and never computes. Thus the worst outcome of a
 * needless call is latency, and the prompt is what bounds that.
 */
export function buildPlannerSearchTools(deps: GeneratePlanDeps, hooks: { readonly onRecommend?: (answer: KnowledgeRecommendAnswer) => void } = {}): Tool[] {
    const bioKeys = deps.bioKeys;
    const ncbi = createNcbiTools(bioKeys);
    return [
        // Comparable public studies — the design, the platform, and the sample
        // count that a plan for the same assay must answer to.
        searchGeoDatasetsTool,
        // Prior methods, in three corpora that do not overlap: the biomedical
        // literature, the statistics and machine-learning preprints, and the
        // cross-field index that ranks a method paper best.
        ncbi.pubmed,
        searchArxivTool,
        createSearchSemanticScholarTool({ apiKey: bioKeys.semanticScholar }),
        // The same approach as running code — a pipeline that someone published.
        createSearchGithubReposTool({ githubToken: bioKeys.github }),
        // The API of a staged package, so a step names a function that exists.
        resolveLibraryIdTool,
        queryDocsTool,
        // The environment itself. The seed already carries a rendered census of
        // both stores. These two tools are for the narrow second look: one
        // collection of the reference store, or one batch of the package names
        // that the census leaves unclear.
        createListAvailableRefsTool(deps.refStorePath === undefined ? {} : { refStorePath: deps.refStorePath }),
        // The planner is a conversation surface, thus the pool-scope reader binds
        // when the embedder gives one, and the answer names what the store HOLDS.
        createListAvailablePackagesTool({
            farmLockFile: deps.farmLockFile,
            imagePackagesFile: deps.imagePackagesFile,
            readPoolInventory: deps.readPoolInventory,
        }),
        // The knowledge plane: one cited procedure per situation, and one check
        // of the draft. Both attach only when the embedder binds a client.
        ...createKnowledgeTools({
            client: deps.knowledge,
            farmLockFile: deps.farmLockFile,
            imagePackagesFile: deps.imagePackagesFile,
            refStorePath: deps.refStorePath,
            onRecommend: hooks.onRecommend,
        }),
    ];
}

/**
 * The seed of the planner: the prior plan when the call revises one, the data context, the two censuses, and then
 * what the caller gave. Each block is optional where the call holds none.
 */
export function composePlannerSeed(parts: {
    readonly priorPlanBlock: string | null;
    readonly dataContextBlock: string;
    readonly groundingBlock: string;
    readonly input: Pick<z.infer<typeof generatePlanInputSchema>, "researchQuestion" | "analystNotes" | "priorRuns" | "userConstraints">;
}): string {
    const { priorPlanBlock, dataContextBlock, groundingBlock, input } = parts;
    return [
        ...(priorPlanBlock ? [priorPlanBlock, ""] : []),
        ...(dataContextBlock ? [dataContextBlock, ""] : []),
        groundingBlock,
        "",
        "## Research Question",
        input.researchQuestion,
        ...(input.analystNotes ? ["", "## Analyst Notes (from the user — facts about the data the profile does not record)", input.analystNotes] : []),
        ...(input.priorRuns ? ["", "## Prior Run Results", input.priorRuns] : []),
        ...(input.userConstraints ? ["", "## User Constraints", input.userConstraints] : []),
    ].join("\n");
}

const generatePlanInputSchema = z.object({
    researchQuestion: z
        .string()
        .describe(
            "The request of the user, in the words of the user: the goal, the questions, and each deliverable that the user named, with its format. The plan stores it, and each step of the run reads it.",
        ),
    analystNotes: z
        .string()
        .optional()
        .describe(
            "Facts about the data that ONLY the user could have told you and the data profile cannot know — " +
                'e.g. "samples 3 and 7 were re-sequenced", "treat batch B as the reference", ' +
                '"the tumor/normal labels in column 4 are swapped". ' +
                "This is NOT a place to restate the data profile: organism, omics type, experimental design, " +
                "condition names, file names and dimensions are already loaded server-side and given to the " +
                "planner — repeating them here only risks contradicting the record. Omit entirely unless the " +
                "user has told you something the profile does not already hold.",
        ),
    priorRuns: z
        .string()
        .optional()
        .describe("Summary of prior run results if any exist: which steps ran, " + "what succeeded/failed, key findings. Omit if no prior runs."),
    userConstraints: z
        .string()
        .optional()
        .describe("User-specified constraints: preferred methods, steps to " + "include/exclude, resource limits, modifications to a prior plan."),
    parentPlanId: z
        .string()
        .regex(PLAN_ID_RE, "parentPlanId must be a pln-<8hex> value")
        .optional()
        .describe("The planId of the prior plan being iterated on. Set only when " + "the user is asking for modifications to an existing plan."),
});

type GeneratePlanInput = z.infer<typeof generatePlanInputSchema>;

/** What the planner reads before its loop: the seed, or the outcome of a call that cannot plan. */
type PlannerSeed =
    | { readonly early: ShapedOutcome }
    | {
          readonly prompt: string;
          readonly grounding: DataGrounding["kind"];
          readonly chars: { readonly priorPlan: number; readonly dataContext: number; readonly referenceData: number; readonly packages: number };
      };

/** Build the `generate_plan` tool bound to its provider and pool. */
export function createGeneratePlanTool(deps: GeneratePlanDeps, registerSubAgent: SubAgentRegistrar): Tool {
    const baseLogger = (deps.logger ?? createNoopLogger()).named("generate-plan");
    const plan = registerSubAgent<GeneratePlanInput, PlanningAgentOutput>(PLANNER_AGENT_ID, async ({ payload: input, ctx, loop, durably }) => {
        const analysisId = scopeResource(ctx.session.scope).resourceId;
        // Bound per invocation: `analysisId` comes from the call-time session, not from
        // the construction-time deps the factory closes over.
        const logger = baseLogger.with({ analysisId });
        const startedAt = Date.now();
        let trace: PlannerTrace = { submitAttempts: 0, rejectedAttempts: 0, rejections: [] };

        // Every exit routes through here, so "recorded exactly once per invocation" holds
        // by construction rather than by remembering. `elapsedMs` is what separates a
        // planner that gave up early from one still working when the guard cut it — the
        // fixed budget above makes the number readable without any other context.
        //
        // `extra` carries the loop account on the paths that reached the loop. The two
        // parent-plan early returns never do, and a record claiming `loop.finishReason`
        // for a run that never started would be worse than one that omits the field.
        const finish = (shaped: ShapedOutcome, extra: LogFields = {}): PlanningAgentOutput => {
            logger[OUTCOME_LEVEL[shaped.kind]]("plan generation finished", {
                outcome: shaped.kind,
                elapsedMs: Date.now() - startedAt,
                submitAttempts: trace.submitAttempts,
                rejectedAttempts: trace.rejectedAttempts,
                rejections: trace.rejections,
                rejectionsTruncated: trace.rejectedAttempts > trace.rejections.length ? true : undefined,
                ...extra,
            });
            return shaped.output;
        };

        const seed = await durably("planner.seed", async (): Promise<PlannerSeed> => {
            // If iterating, load the parent plan so the planner sees what it is
            // revising. Fails fast with the sanitized message submit_plan would
            // have surfaced — saves a wasted planner run.
            let priorPlanBlock: string | null = null;
            if (input.parentPlanId) {
                try {
                    const priorPlan = unwrapOrThrow(
                        await loadPlan(deps.pool, input.parentPlanId, {
                            analysisId,
                        }),
                    );
                    if (!priorPlan) {
                        return {
                            early: {
                                output: { event: "error", error: "parentPlanId is not a valid plan for this analysis" },
                                kind: "invalid_parent_plan",
                            },
                        };
                    }
                    priorPlanBlock = formatPriorPlan(input.parentPlanId, priorPlan);
                    // `formatPriorPlan` returns null on a stored plan that no longer parses as an
                    // `AnalysisPlan`. Iteration then silently becomes generation-from-scratch, and
                    // the user gets a plan that ignored everything they asked to keep.
                    if (priorPlanBlock === null) {
                        logger.warn("prior plan did not parse — iterating without it", { parentPlanId: input.parentPlanId });
                    }
                } catch (err) {
                    logger.error("parent plan could not be loaded", { parentPlanId: input.parentPlanId, ...logger.errorFields(err) });
                    return {
                        early: {
                            output: { event: "error", error: "Plan iteration failed — parent plan could not be loaded." },
                            kind: "parent_plan_load_failed",
                        },
                    };
                }
            }

            // The dataset's facts come from the ledger, not from a string a model
            // typed: the profile is the only durable record of what the input data
            // is, and every re-transcription of it loses fidelity.
            //
            // A read failure degrades to "no profile" rather than throwing. Planning
            // without dataset facts is a real, supported state (see `renderDataContext`),
            // so a ledger read that fails must cost the planner its grounding — never
            // the user their plan.
            const profileStatus = await loadDataProfileStatus(deps.pool, analysisId).match(
                (status) => status,
                (error) => {
                    // Degrading to "no profile" is correct behaviour and indistinguishable, from
                    // the outcome, from an analysis that genuinely has none — so the read failure
                    // is reported here or it is never known to have happened.
                    const fields = { dbErrorType: error.type, dbOp: error.op };
                    if ("cause" in error) Object.assign(fields, logger.errorFields(error.cause));
                    logger.warn("data profile read failed — planning without dataset facts", fields);
                    return null;
                },
            );
            const grounding = classifyGrounding(profileStatus);
            const dataContextBlock = renderDataContext(grounding, analysisId);

            // Reference data and package availability are mandatory grounding,
            // not optional planner lookups. Read both inventories host-side before
            // the loop and put their rendered content in the planner's seed.
            const listAvailableRefs = createListAvailableRefsTool(deps.refStorePath === undefined ? {} : { refStorePath: deps.refStorePath });
            const listAvailablePackages = createListAvailablePackagesTool({
                farmLockFile: deps.farmLockFile,
                imagePackagesFile: deps.imagePackagesFile,
                readPoolInventory: deps.readPoolInventory,
            });
            // A path-separator query matches every reference path and selects the
            // tool's recursive leaf scan, so the seed contains usable file paths,
            // not only top-level directory summaries.
            const [refsResult, packagesResult] = await Promise.all([listAvailableRefs.execute({ query: "/" }, ctx), listAvailablePackages.execute({}, ctx)]);
            const refsBlock = inventoryContent("Available Reference Data", refsResult, logger);
            const packagesBlock = inventoryContent("Available Packages", packagesResult, logger);
            const groundingBlock = [refsBlock, packagesBlock].join("\n\n");

            const prompt = composePlannerSeed({ priorPlanBlock, dataContextBlock, groundingBlock, input });
            return {
                prompt,
                grounding: grounding.kind,
                chars: {
                    priorPlan: priorPlanBlock?.length ?? 0,
                    dataContext: dataContextBlock.length,
                    referenceData: refsBlock.length,
                    packages: packagesBlock.length,
                },
            };
        });
        if ("early" in seed) return finish(seed.early);
        const { prompt } = seed;

        const planTimeoutMs = effectiveDeadlineMs(deps.conversation.provider, PLAN_TIMEOUT_MS);

        // Opens the invocation. Two things are only knowable here and both are
        // first-order suspects when a planner runs long and returns nothing: the size
        // of the seed it was handed, and which of its blocks made it that size. The
        // reference inventory in particular is a recursive leaf scan of whatever this
        // install has staged — a quantity the harness does not control and no other
        // record reports. The census is sizes only: the seed carries the user's
        // research question and dataset facts, which belong in the model's context and
        // not in a log file.
        logger.info("plan generation started", {
            model: deps.conversation.model,
            maxIterations: PLANNER_MAX_ITERATIONS,
            salvageRequests: DEFAULT_SALVAGE_REQUESTS,
            timeoutMs: planTimeoutMs,
            grounding: seed.grounding,
            parentPlanId: input.parentPlanId,
            seedChars: {
                total: prompt.length,
                ...seed.chars,
                researchQuestion: input.researchQuestion.length,
                analystNotes: input.analystNotes?.length ?? 0,
                priorRuns: input.priorRuns?.length ?? 0,
                userConstraints: input.userConstraints?.length ?? 0,
            },
        });

        const persistCtx: PersistContext = {
            analysisId,
            parentPlanId: input.parentPlanId ?? null,
            invocationId: ctx.invocationId,
            request: input.researchQuestion,
        };
        // The last recommend answer of this invocation, thus `submit_plan`
        // stamps the snapshot digest, restores a template the model dropped,
        // and repairs or refuses a claim id the answer did not return. The loop
        // folds each answer after its round, on the first run and on a replay.
        const memory: RecommendMemory = { steps: new Map(), claims: new Set() };
        const innerTools = buildInnerTools(logger, memory);
        // Built here rather than at construction: a `describeCall` hook reads no
        // dep, thus the tool must stay constructible from an empty bag. The tool
        // definitions are identical across invocations, thus the request prefix
        // that the cache keys on does not move.
        const searchTools = buildPlannerSearchTools(deps, {
            onRecommend: (answer) => rememberAnswer(memory, answer),
        });
        const planner = plannerAgentOf(deps, searchTools, innerTools.terminal);

        // Merge the outer abort signal with a wall-clock timeout — either
        // cancels the planner promptly.
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(planTimeoutMs)]);

        // The guard bounds the repeated calls of one plan: the third call with
        // an input the plan already sent, or the call past the budget of one
        // tool, answers a refusal that says to continue. The terminal tools
        // stay outside it, because a refused submit would strand the plan.
        let refusals = 0;
        let runError: unknown = null;
        let run: SalvagedResult | null = null;
        try {
            run = await runWithSalvage(
                planner,
                [{ role: "user", content: prompt }],
                forSubAgent(ctx.session, PLANNER_AGENT_ID),
                {
                    ...loop,
                    provider: deps.conversation.provider,
                    signal,
                    policy: {
                        guard: {
                            tools: searchTools.map((tool) => tool.id),
                            onRefusal: (refusal) => {
                                refusals += 1;
                                logger.warn("planner call refused by the guard", { ...refusal, refusals });
                            },
                        },
                    },
                    // A planner the guard refused too many times is looping:
                    // the early cap ends the search, and the salvage request
                    // submits the plan it has.
                    capWhen: () => refusals >= PLANNER_REFUSAL_LIMIT,
                    // No forced tool choice: some Claude models reject it with a
                    // 400. The prompt names the terminal tools, and the salvage
                    // request below recovers a run that ends on prose.
                    logger,
                    usageRecorder: deps.usageRecorder,
                    toolOutputStore: deps.toolOutputStore,
                },
                {
                    tools: innerTools.terminal.map((tool) => tool.id),
                    nudge:
                        "You ended without a terminal outcome. Call submit_plan with " +
                        "your final plan now, or request_clarification / report_blocker " +
                        "if you cannot. Do not reply with prose.",
                    hasOutcome: (steps) => selectedOutcomeOf(steps) !== null,
                },
            );
        } catch (err) {
            runError = err;
        }

        let outcome: PlannerOutcome | null = null;
        if (run !== null) {
            trace = traceOf(run.steps);
            const selected = selectedOutcomeOf(run.steps);
            if (selected?.kind === "plan") {
                const persisted = await durably("planner.persist", () => persistPlan(selected.plan, persistCtx, deps.pool, logger));
                outcome = persisted.ok
                    ? { kind: "plan_submitted", planId: persisted.planId, plan: selected.plan }
                    : { kind: "persist_error", message: persisted.message };
            } else {
                outcome = selected;
            }
            if (selected?.kind === "blocker") {
                // A blocker after several rejected submits is a planner giving up on a plan it
                // could not make valid — a validation problem wearing a blocker's clothes. The
                // attempt count is what tells those apart, and only this record carries both.
                logger.warn("planner reported a blocker", {
                    submitAttempts: trace.submitAttempts,
                    ...modelAuthored({ blockerReason: bounded(selected.reason, MAX_LOGGED_PROSE_CHARS) }),
                });
            }
        }

        const shaped = shapeOutcome({
            outcome,
            runError,
            timedOut: signal.aborted && !ctx.signal.aborted,
            outerAborted: ctx.signal.aborted,
        });
        const extra: LogFields = {};
        if (run) Object.assign(extra, loopFields(run, shaped.kind));
        // A throw leaves no result to read the transcript off, so the cause takes its
        // place — `shapeOutcome` folds it into one prose sentence for the model, and
        // this is the only place its type and stack survive.
        if (runError) Object.assign(extra, logger.errorFields(runError));
        return finish(shaped, extra);
    });
    return defineTool({
        id: "generate_plan",
        description:
            "Generate an analysis plan (DAG of steps) for this analysis's data and the user's research question. " +
            "The dataset's own facts — domain, organism, experimental design, condition names, quality concerns, " +
            "per-file data types and dimensions — are read server-side from the persisted data profile and handed " +
            "to the planner directly. Do NOT summarize or re-type them into this call; you cannot restate that " +
            "record more faithfully than the record itself. Pass only what the profile cannot hold: the research " +
            "question, facts the user told you (analystNotes), prior run results, and their constraints. " +
            "The planner is a multi-step sub-agent, thus a call can take many minutes. " +
            "The result carries an `event`: `plan_complete` with {planId, plan} — the plan is saved, the call shows its plan card to the user, " +
            "and it does not run it (execute_analysis plan mode does, after the approval); `clarification_needed` with {question, questionContext?} " +
            "when the planner is missing a fact it cannot infer; or `error` with {error} when no plan was saved (the planner reported " +
            "a blocker, the save failed, the call timed out or was cancelled, or parentPlanId is not a plan of this analysis).",
        inputSchema: generatePlanInputSchema,
        view: {
            input: (input) => input,
            error: true,
        },
        describeCall: ({ researchQuestion }) => researchQuestion,
        startsWorkflow: true,
        execute: async (input, ctx): Promise<Result<PlanningAgentOutput, ToolError>> => {
            const output = await plan(input, ctx);
            // The card comes from the result of the planner, with no read of the store, thus a replay of the body
            // gives the same card under the same id, and a reader keeps one card.
            if (output.event === "plan_complete" && output.planId !== undefined && output.plan !== undefined) {
                const card = planCardOf({ planId: output.planId, plan: hydratePlanSteps(output.plan), parentPlanId: input.parentPlanId ?? null });
                if (card !== null) await ctx.emit({ type: "data-plan", source: ctx.session.provenance, data: card });
            }
            return ok(output);
        },
    });
}
