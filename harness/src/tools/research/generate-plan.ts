/**
 * generatePlan — a loop-driving tool: a focused `runAgent` loop that builds
 * an analysis plan (a DAG of steps).
 *
 * The dataset's facts are NOT an input. They are read here, server-side, from
 * the analysis's persisted data profile — the one durable record of what the
 * input data is — and projected into the planner's seed. The caller supplies
 * only what the profile cannot hold: the research question, facts the user
 * volunteered (`analystNotes`), prior run results, and plan constraints. A
 * caller-typed dataset summary would be a model re-transcribing a record the
 * database already holds, and it would lose fidelity at every hop.
 *
 * The tool drives an internal "planner" agent that communicates outcomes
 * EXCLUSIVELY via three terminal tool calls:
 *
 *   - submit_plan(plan)         → terminal success: re-validates + persists;
 *                                 rejected candidates return structured issues
 *   - request_clarification(…)  → terminal: planner needs more context
 *   - report_blocker(reason)    → terminal: no viable plan
 *
 * The planner is an `AgentDefinition` driven by `runAgent`; the pool and
 * resource id are an explicit `Pool` dependency and the request-scoped
 * `Session`. The planner prompt injects the agent catalog and exposes the
 * terminal-tool surface above.
 */

import { ok, type Result } from "neverthrow";
import type { Pool } from "pg";
import { z } from "zod";

import { formatAgentCatalog } from "../../agents/sandbox-catalog.js";
import { composeSystemPrompt } from "../../agents/system-prompt.js";
import { DEFAULT_SALVAGE_ITERATIONS, runToTerminal, type RunToTerminalResult } from "../../loop/run-to-terminal.js";
import { passthroughStep } from "../../loop/run-step.js";
import type { AgentDefinition, LoopMessage } from "../../loop/types.js";
import { forSubAgent, scopeResource } from "../../auth/types.js";
import { effectiveDeadlineMs, type ChatProvider } from "../../providers/types.js";
import type { UsageRecorder } from "../../billing/usage-recorder.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import type { EnvironmentStorePaths } from "../../config/environment-stores.js";
import { createListAvailablePackagesTool } from "../sandbox/list-available-packages.js";
import { createListAvailableRefsTool } from "../sandbox/list-available-refs.js";
import { createReportBlockerToolFor } from "../sandbox/report-blocker.js";

import { DATA_PROFILE_ORIENTATION_MAX_CHARS, buildDataProfileOrientation } from "../../app/data-profile-orientation.js";
import { DEFAULT_SANDBOX_MAX_STEPS, type ResourcePolicy } from "../../config/resource-limits.js";
import { plannerPrompt } from "../../prompts/planner.js";
import { hydratePlanSteps, PlannerPlanSchema, type PlannerPlan, type PlanningAgentOutput } from "../../schemas/plan-schemas.js";
import { validatePlan } from "../../schemas/validate-plan.js";
import { AnalysisPlanSchema } from "../../schemas/workflow-state.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { LogFields, Logger } from "../../lib/logger.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { hintForZodIssue } from "../../lib/zod-issues.js";
import { insertPlan, loadDataProfileStatus, loadPlan, type DataProfileResult, type DataProfileStatus } from "../../state/index.js";

// ── Tool-level config ──────────────────────────────────────────────

/** Sub-agent identity for the planner — provenance only. */
const PLANNER_AGENT_ID = "planner";

/**
 * Budget for the planner's internal loop: one draft/submit attempt plus
 * correction retries and headroom.
 */
const PLANNER_MAX_ITERATIONS = 13;

/** Wall-clock guard for a single plan-generation invocation. */
const PLAN_TIMEOUT_MS = 600_000;

// ── Diagnostic bounds ───────────────────────────────────────────────
//
// This tool runs on `passthroughStep`: it writes no ledger row and owns no
// durable stream, so its log records are the ONLY account of an invocation that
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
/** Tool-call trace length. The planner's whole budget is ~16 turns, so this rarely truncates. */
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
    const present = Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].length > 0);
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
interface RejectionRecord {
    readonly attempt: number;
    readonly issueCount: number;
    readonly codes: { readonly schema: number; readonly semantic: number };
    readonly paths: readonly string[];
    readonly messages: readonly string[];
}

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
 * What the planner did over one invocation, accumulated by the inner tools.
 *
 * The failure this exists for is invisible from the outcome alone: `submit_plan`
 * is non-terminal on rejection by design, so a planner can spend its entire
 * iteration budget on submit → reject → fix → reject and end with `holder.outcome`
 * still null. That reads as "the planner never called a terminal tool" — the same
 * ending as a planner that stopped on prose after one turn, and the opposite
 * problem.
 */
interface PlannerTrace {
    submitAttempts: number;
    /**
     * True count of rejected attempts — NOT `rejections.length`, which stops at
     * {@link MAX_LOGGED_REJECTIONS}. A record reporting 16 attempts and 6 rejections
     * says ten of them were accepted, which is the opposite of what happened.
     */
    rejectedAttempts: number;
    /** The first {@link MAX_LOGGED_REJECTIONS} rejections, in full. */
    rejections: RejectionRecord[];
    /** Terminal calls made after an outcome was already recorded — a planner ignoring "stop after this". */
    duplicateTerminalCalls: number;
}

function createPlannerTrace(): PlannerTrace {
    return { submitAttempts: 0, rejectedAttempts: 0, rejections: [], duplicateTerminalCalls: 0 };
}

// ── Prompt / catalog ────────────────────────────────────────────────

/** The planner system prompt is deterministic per policy — build it once per
 *  factory (the policy is a construction-time dep, fixed for the process). */
function plannerInstructions(resourcePolicy?: ResourcePolicy): string {
    return plannerPrompt(formatAgentCatalog(), resourcePolicy);
}

// ── Shared types ────────────────────────────────────────────────────

/**
 * The outcome captured across inner tool calls. Exactly one terminal
 * outcome is recorded per invocation; additional terminal calls are
 * rejected by the tool implementations.
 */
type PlannerOutcome =
    | { kind: "plan_submitted"; planId: string; plan: PlannerPlan }
    | { kind: "clarification"; question: string; questionContext?: string }
    | { kind: "blocker"; reason: string }
    | { kind: "persist_error"; message: string };

interface OutcomeHolder {
    outcome: PlannerOutcome | null;
}

interface PersistContext {
    analysisId: string;
    parentPlanId: string | null;
}

interface ValidationIssue {
    path: string;
    code: "schema" | "semantic";
    message: string;
    hint?: string;
}

type SubmitPlanOutput = { accepted: false; issues: ValidationIssue[] } | { accepted: true; planId: string };

// ── Prior plan serialization (iteration context) ───────────────────

/**
 * Format a loaded prior plan as a markdown block the planner can read —
 * narrative + one line per step. Used only when `parentPlanId` is set.
 */
function formatPriorPlan(parentPlanId: string, plan: unknown): string | null {
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
        "The user is iterating on this plan. Preserve steps and IDs that are " +
            "not being changed; modify only what `userConstraints` describes. " +
            "Reuse step IDs when a step's purpose is unchanged so downstream " +
            "references survive.",
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
type DataGrounding =
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
function renderDataContext(grounding: DataGrounding, analysisId: string): string {
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
        const planId = unwrapOrThrow(
            await insertPlan(pool, {
                analysisId: ctx.analysisId,
                plan: hydratePlanSteps(plan),
                parentPlanId: ctx.parentPlanId,
            }),
        );
        return { ok: true, planId };
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const isParentValidation = /^parent plan .* (?:not found|belongs to a different analysis)$/i.test(raw);
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
 * Full validation: Zod schema + semantic checks. The plan is valid only if
 * BOTH pass.
 */
function fullyValidate(candidate: unknown, resourcePolicy?: ResourcePolicy): { valid: true; plan: PlannerPlan } | { valid: false; issues: ValidationIssue[] } {
    const parsed = PlannerPlanSchema.safeParse(candidate);
    if (!parsed.success) {
        return { valid: false, issues: zodIssuesToValidationIssues(parsed.error, candidate) };
    }

    // Semantic checks operate on the AnalysisPlan shape — PlannerPlan omits
    // maxSteps, so inject the execution-time default to satisfy the validator.
    const semantic = validatePlan(
        {
            analytical_narrative: parsed.data.analytical_narrative,
            steps: parsed.data.steps.map((s) => ({
                ...s,
                status: "pending" as const,
                maxSteps: DEFAULT_SANDBOX_MAX_STEPS,
            })),
            created_at: parsed.data.created_at,
            omicsType: parsed.data.omicsType,
            omicsSubtype: parsed.data.omicsSubtype,
        },
        { perStepCeiling: resourcePolicy?.perStep },
    );

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
 * The terminal list is re-offered if salvage is needed.
 */
interface InnerTools {
    readonly terminal: Tool[];
}

/**
 * Build the planner's inner tools for one invocation. They close over the
 * shared `holder` so the outer `execute` reads the terminal outcome after the
 * loop finishes.
 */
function buildInnerTools(
    holder: OutcomeHolder,
    trace: PlannerTrace,
    persistCtx: PersistContext,
    pool: Pool,
    resourcePolicy: ResourcePolicy | undefined,
    logger: Logger,
): InnerTools {
    const submitPlanTool = defineTool({
        id: "submit_plan",
        description:
            "Submit the final plan for persistence. Re-validates the plan; on " +
            "success returns {accepted: true, planId} — STOP after this. On " +
            "rejection returns {accepted: false, issues} — fix and call again, " +
            "or switch to report_blocker if the plan cannot be made valid. This " +
            "arg schema is the authoritative plan contract.",
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
        describeCall: "none",
        execute: async (input): Promise<Result<SubmitPlanOutput, ToolError>> => {
            if (holder.outcome !== null) {
                trace.duplicateTerminalCalls++;
                logger.warn("submit_plan called after a terminal outcome was recorded", {
                    recordedOutcome: holder.outcome.kind,
                    duplicateTerminalCalls: trace.duplicateTerminalCalls,
                });
                return ok({
                    accepted: false as const,
                    issues: [
                        {
                            path: "plan",
                            code: "semantic" as const,
                            message: "A terminal outcome has already been recorded; submit_plan " + "can only be called once per invocation.",
                        },
                    ],
                });
            }

            const attempt = ++trace.submitAttempts;
            const result = fullyValidate(input.plan, resourcePolicy);
            if (!result.valid) {
                trace.rejectedAttempts++;
                const rejection = toRejectionRecord(attempt, result.issues);
                if (trace.rejections.length < MAX_LOGGED_REJECTIONS) trace.rejections.push(rejection);
                // `warn`, not `debug`: a rejection is non-terminal by design, so the model
                // reads the issues and the invocation carries on — nothing else reports that
                // an attempt was spent. A run that exhausts its budget on rejections ends
                // looking identical to one that never tried, and this is the difference.
                logger.warn("submit_plan rejected a plan", { ...rejection });
                return ok({ accepted: false as const, issues: result.issues });
            }

            const persisted = await persistPlan(result.plan, persistCtx, pool, logger);
            if (!persisted.ok) {
                holder.outcome = { kind: "persist_error", message: persisted.message };
                return ok({
                    accepted: false as const,
                    issues: [
                        {
                            path: "plan",
                            code: "semantic" as const,
                            message: persisted.message,
                            hint: "Persistence failed — do not retry submit_plan.",
                        },
                    ],
                });
            }

            holder.outcome = {
                kind: "plan_submitted",
                planId: persisted.planId,
                plan: result.plan,
            };
            // The attempt count is the cost of this plan, and it is only knowable here.
            // A plan accepted on attempt 5 is a success that nearly was not one.
            logger.info("submit_plan accepted a plan", {
                planId: persisted.planId,
                attempt,
                stepCount: result.plan.steps.length,
                agents: [...new Set(result.plan.steps.map((s) => s.agent))],
            });
            return ok({ accepted: true as const, planId: persisted.planId });
        },
    });

    const requestClarificationTool = defineTool({
        id: "request_clarification",
        description:
            "Terminal. Use when a specific fact you need is missing from the " +
            "input and cannot be inferred. Pass a short question and optional " +
            "context. Stop after calling.",
        inputSchema: z.object({
            question: z.string().min(1),
            questionContext: z.string().optional(),
        }),
        describeCall: "none",
        execute: async (input) => {
            if (holder.outcome !== null) {
                trace.duplicateTerminalCalls++;
                logger.warn("request_clarification called after a terminal outcome was recorded", {
                    recordedOutcome: holder.outcome.kind,
                    duplicateTerminalCalls: trace.duplicateTerminalCalls,
                });
                return ok({ recorded: true as const });
            }
            holder.outcome = {
                kind: "clarification",
                question: input.question,
                questionContext: input.questionContext,
            };
            // The question is the answer to "why did planning stop?" — and it reaches the
            // user through the conversation agent, which may paraphrase it into something
            // that no longer identifies the missing fact.
            logger.info("planner requested clarification", {
                submitAttempts: trace.submitAttempts,
                ...modelAuthored({ clarificationQuestion: bounded(input.question, MAX_LOGGED_PROSE_CHARS) }),
            });
            return ok({ recorded: true as const });
        },
    });

    const reportBlockerTool = createReportBlockerToolFor({
        record: (outcome) => {
            if (holder.outcome !== null) {
                trace.duplicateTerminalCalls++;
                logger.warn("report_blocker called after a terminal outcome was recorded", {
                    recordedOutcome: holder.outcome.kind,
                    duplicateTerminalCalls: trace.duplicateTerminalCalls,
                });
                return;
            }
            holder.outcome = outcome;
            // A blocker after several rejected submits is a planner giving up on a plan it
            // could not make valid — a validation problem wearing a blocker's clothes. The
            // attempt count is what tells those apart, and only this record carries both.
            logger.warn("planner reported a blocker", {
                submitAttempts: trace.submitAttempts,
                ...modelAuthored({ blockerReason: bounded(outcome.reason, MAX_LOGGED_PROSE_CHARS) }),
            });
        },
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
function inventoryContent(label: string, result: Awaited<ReturnType<Tool["execute"]>>, logger: Logger): string {
    if (result.isErr()) {
        logger.warn("planner grounding inventory lookup failed", { inventory: label, error: result.error.error });
        return `## ${label}\n\nInventory lookup failed: ${result.error.error}`;
    }
    const value = result.value;
    if (typeof value === "object" && value !== null && "content" in value && typeof value.content === "string") {
        return `## ${label}\n\n${value.content}`;
    }
    return `## ${label}\n\n${JSON.stringify(value)}`;
}

// ── Transcript reading (diagnostics only) ───────────────────────────

/**
 * The planner's own account of the run, read off the message array `runToTerminal`
 * returns. Nothing else can produce it: the transcript is ephemeral — a sub-agent
 * loop on `passthroughStep` persists no messages anywhere — so it is read here or
 * it is lost with the turn.
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
 * Built from the `runToTerminal` result that the tool previously discarded
 * entirely. Without it, `no_outcome` is a single word covering three unrelated
 * failures — a budget spent on rejected submits (`max_iterations`), a planner that
 * answered in prose (`stop`), and a reply cut off at the output-token limit
 * (`length`) — which is why three identical-looking retries taught nobody anything.
 */
function loopFields(run: RunToTerminalResult, kind: OutcomeKind): LogFields {
    const transcript = readTranscript(run.messages);
    return {
        loop: {
            finishReason: run.finish.reason,
            cappedOut: run.finish.cappedOut,
            truncationRecoveries: run.finish.truncationRecoveries,
            salvaged: run.salvage !== null,
            ...(run.salvage ? { firstFinishReason: run.salvage.firstFinish.reason, salvageFinishReason: run.salvage.finish.reason } : {}),
            toolCalls: transcript.toolCalls,
            ...(transcript.truncatedToolCalls ? { toolCallsTruncated: true } : {}),
        },
        ...(PROSE_EXPLAINS_OUTCOME.has(kind) ? modelAuthored({ plannerFinalProse: transcript.finalProse }) : {}),
    };
}

/**
 * The endings whose only account is what the planner said last.
 *
 * Everywhere else something better already explains the outcome: a terminal tool
 * recorded its own argument, or a thrown cause carries the fault. Logging the
 * prose there would put model output describing the user's data into a record
 * that had no use for it — including on every successful plan, where the closing
 * text is the planner narrating work that demonstrably went fine.
 */
const PROSE_EXPLAINS_OUTCOME: ReadonlySet<OutcomeKind> = new Set<OutcomeKind>(["no_outcome", "loop_error", "timeout"]);

// ── Outcome shaping ─────────────────────────────────────────────────

interface ShapeOutcomeArgs {
    holder: OutcomeHolder;
    runError: unknown;
    timedOut: boolean;
    outerAborted: boolean;
}

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

interface ShapedOutcome {
    readonly output: PlanningAgentOutput;
    readonly kind: OutcomeKind;
}

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
    const { holder, runError, timedOut, outerAborted } = args;
    const outcome = holder.outcome;

    if (outcome?.kind === "plan_submitted") {
        return { output: { event: "plan_complete", planId: outcome.planId, plan: outcome.plan }, kind: "plan_submitted" };
    }
    if (outcome?.kind === "clarification") {
        return {
            output: {
                event: "clarification_needed",
                question: outcome.question,
                ...(outcome.questionContext ? { questionContext: outcome.questionContext } : {}),
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
        const msg = runError instanceof Error ? runError.message : String(runError);
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

export interface GeneratePlanDeps extends EnvironmentStorePaths {
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
    /**
     * Host resource policy — stated to the planner as concrete per-step
     * ceilings and enforced by `submit_plan`. Absent, the prompt keeps its
     * default guidance and validation skips the ceiling check.
     */
    readonly resourcePolicy?: ResourcePolicy;
    /** Diagnostic sink. Absent, the tool runs silently — see `RunAgentOptions.logger`. */
    readonly logger?: Logger;
    /** LLM usage-accounting seam for the planner loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
}

/** Build the `generate_plan` tool bound to its provider and pool. */
export function createGeneratePlanTool(deps: GeneratePlanDeps): Tool {
    const baseLogger = (deps.logger ?? createNoopLogger()).named("generate-plan");
    return defineTool({
        id: "generate_plan",
        description:
            "Generate an analysis plan (DAG of steps) for this analysis's data and the user's research question. " +
            "The dataset's own facts — domain, organism, experimental design, condition names, quality concerns, " +
            "per-file data types and dimensions — are read server-side from the persisted data profile and handed " +
            "to the planner directly. Do NOT summarize or re-type them into this call; you cannot restate that " +
            "record more faithfully than the record itself. Pass only what the profile cannot hold: the research " +
            "question, facts the user told you (analystNotes), prior run results, and their constraints. " +
            "Returns a structured plan ready for show_plan and execute_analysis plan mode, or a clarification question if " +
            "the planner is missing something it cannot infer.",
        inputSchema: z.object({
            researchQuestion: z.string().describe("What the user wants to analyze — their goal and specific questions."),
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
                .regex(/^pln-[a-f0-9]{8}$/, "parentPlanId must be a pln-<8hex> value")
                .optional()
                .describe("The planId of the prior plan being iterated on. Set only when " + "the user is asking for modifications to an existing plan."),
        }),
        describeCall: ({ researchQuestion }) => researchQuestion,
        execute: async (input, ctx): Promise<Result<PlanningAgentOutput, ToolError>> => {
            const analysisId = scopeResource(ctx.session.scope).resourceId;
            // Bound per invocation: `analysisId` comes from the call-time session, not from
            // the construction-time deps the factory closes over.
            const logger = baseLogger.with({ analysisId });
            const startedAt = Date.now();
            const trace = createPlannerTrace();

            // Every exit routes through here, so "recorded exactly once per invocation" holds
            // by construction rather than by remembering. `elapsedMs` is what separates a
            // planner that gave up early from one still working when the guard cut it — the
            // fixed budget above makes the number readable without any other context.
            //
            // `extra` carries the loop account on the paths that reached the loop. The two
            // parent-plan early returns never do, and a record claiming `loop.finishReason`
            // for a run that never started would be worse than one that omits the field.
            const finish = (shaped: ShapedOutcome, extra: LogFields = {}): Result<PlanningAgentOutput, ToolError> => {
                logger[OUTCOME_LEVEL[shaped.kind]]("plan generation finished", {
                    outcome: shaped.kind,
                    elapsedMs: Date.now() - startedAt,
                    submitAttempts: trace.submitAttempts,
                    rejectedAttempts: trace.rejectedAttempts,
                    ...(trace.rejections.length > 0 ? { rejections: trace.rejections } : {}),
                    ...(trace.rejectedAttempts > trace.rejections.length ? { rejectionsTruncated: true } : {}),
                    ...(trace.duplicateTerminalCalls > 0 ? { duplicateTerminalCalls: trace.duplicateTerminalCalls } : {}),
                    ...extra,
                });
                return ok(shaped.output);
            };

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
                        return finish({
                            output: { event: "error", error: "parentPlanId is not a valid plan for this analysis" },
                            kind: "invalid_parent_plan",
                        });
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
                    return finish({
                        output: { event: "error", error: "Plan iteration failed — parent plan could not be loaded." },
                        kind: "parent_plan_load_failed",
                    });
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
                    logger.warn("data profile read failed — planning without dataset facts", {
                        dbErrorType: error.type,
                        ...("op" in error ? { dbOp: error.op } : {}),
                        ...("cause" in error ? logger.errorFields(error.cause) : {}),
                    });
                    return null;
                },
            );
            const grounding = classifyGrounding(profileStatus);
            const dataContextBlock = renderDataContext(grounding, analysisId);

            // Reference data and package availability are mandatory grounding,
            // not optional planner lookups. Read both inventories host-side before
            // the loop and put their rendered content in the planner's seed.
            const listAvailableRefs = createListAvailableRefsTool(deps.refStorePath === undefined ? {} : { refStorePath: deps.refStorePath });
            const listAvailablePackages = createListAvailablePackagesTool(deps.packagesFile === undefined ? {} : { packagesFile: deps.packagesFile });
            // A path-separator query matches every reference path and selects the
            // tool's recursive leaf scan, so the seed contains usable file paths,
            // not only top-level directory summaries.
            const [refsResult, packagesResult] = await Promise.all([listAvailableRefs.execute({ query: "/" }, ctx), listAvailablePackages.execute({}, ctx)]);
            const refsBlock = inventoryContent("Available Reference Data", refsResult, logger);
            const packagesBlock = inventoryContent("Available Packages", packagesResult, logger);
            const groundingBlock = [refsBlock, packagesBlock].join("\n\n");

            const prompt = [
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
                salvageIterations: DEFAULT_SALVAGE_ITERATIONS,
                timeoutMs: planTimeoutMs,
                grounding: grounding.kind,
                ...(input.parentPlanId ? { parentPlanId: input.parentPlanId } : {}),
                seedChars: {
                    total: prompt.length,
                    priorPlan: priorPlanBlock?.length ?? 0,
                    dataContext: dataContextBlock.length,
                    referenceData: refsBlock.length,
                    packages: packagesBlock.length,
                    researchQuestion: input.researchQuestion.length,
                    analystNotes: input.analystNotes?.length ?? 0,
                    priorRuns: input.priorRuns?.length ?? 0,
                    userConstraints: input.userConstraints?.length ?? 0,
                },
            });

            const holder: OutcomeHolder = { outcome: null };
            const persistCtx: PersistContext = {
                analysisId,
                parentPlanId: input.parentPlanId ?? null,
            };
            const innerTools = buildInnerTools(holder, trace, persistCtx, deps.pool, deps.resourcePolicy, logger);
            const planner: AgentDefinition = {
                id: PLANNER_AGENT_ID,
                systemPrompt: composeSystemPrompt(plannerInstructions(deps.resourcePolicy)),
                model: deps.conversation.model,
                tools: innerTools.terminal,
                maxIterations: PLANNER_MAX_ITERATIONS,
            };

            // Merge the outer abort signal with a wall-clock timeout — either
            // cancels the planner promptly.
            const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(planTimeoutMs)]);

            let runError: unknown = null;
            let run: RunToTerminalResult | null = null;
            try {
                run = await runToTerminal(
                    planner,
                    [{ role: "user", content: prompt }],
                    forSubAgent(ctx.session, PLANNER_AGENT_ID),
                    {
                        provider: deps.conversation.provider,
                        signal,
                        emit: ctx.emit,
                        runStep: passthroughStep,
                        resolved: () => holder.outcome !== null,
                        // Planner prose is unusable: every meaningful outcome is
                        // a tool call, and the terminal predicate stops the loop
                        // as soon as one is recorded.
                        toolChoice: "required",
                        logger,
                        usageRecorder: deps.usageRecorder,
                        // Fold the planner's calls into the turn total the root loop reports.
                        turnUsage: ctx.turnUsage,
                        // Keeps the usage record keys of two parallel dispatches disjoint —
                        // same frame, same call path, same loop-local step names.
                        invocationId: ctx.invocationId,
                    },
                    {
                        tools: innerTools.terminal,
                        nudge:
                            "You ended without a terminal outcome. Call submit_plan with " +
                            "your final plan now, or request_clarification / report_blocker " +
                            "if you cannot. Do not reply with prose.",
                    },
                );
            } catch (err) {
                runError = err;
            }

            const shaped = shapeOutcome({
                holder,
                runError,
                timedOut: signal.aborted && !ctx.signal.aborted,
                outerAborted: ctx.signal.aborted,
            });
            return finish(shaped, {
                // A throw leaves no result to read the transcript off, so the cause takes its
                // place — `shapeOutcome` folds it into one prose sentence for the model, and
                // this is the only place its type and stack survive.
                ...(run ? loopFields(run, shaped.kind) : {}),
                ...(runError ? logger.errorFields(runError) : {}),
            });
        },
    });
}
