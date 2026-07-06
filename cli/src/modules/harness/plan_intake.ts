// TODO(extend): this file-based plan intake is a deliberately temporary dev
// surface that exists only to exercise the run engine before plan authoring
// lands with the conversation-agent/planner adoption — the harness's
// `generatePlan` tool is the product path, not a hand-written JSON file. The
// spec `openspec/specs/plan-intake/spec.md` is the spec-level record to clear
// when that adoption arrives, together with the replicated trigger flow in the
// run module (its own `TODO(extend)` names the same contract). Do not grow this
// surface into a product feature: when the planner arrives, retire file intake
// or demote it to an explicit debug tool.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ok, err, type Result, type ResultAsync } from "neverthrow";
import { AnalysisPlanSchema, validatePlan, upsertPlan, type AnalysisPlan, type DbError, type ResourceLimits, type UpsertPlanInput } from "@inflexa-ai/harness";

/**
 * The real `upsertPlan(pool, input)` return, captured by `ReturnType` so the
 * injected seam's signature tracks the harness function exactly — a change to
 * its return shape flows here rather than drifting a hand-copied type.
 */
type UpsertPlanResult = ReturnType<typeof upsertPlan>;

/**
 * The verbatim zod issues from a failed `AnalysisPlanSchema.safeParse`. Typed by
 * derivation from the schema itself rather than a zod-internal type name so it
 * cannot drift with zod's type-export layout, and so the raw issues reach the
 * caller unflattened for a precise, field-level error message.
 */
type PlanSchemaIssue = Extract<ReturnType<typeof AnalysisPlanSchema.safeParse>, { success: false }>["error"]["issues"][number];

/**
 * The persistence seam plan intake writes through, injected so unit tests run
 * fully offline against a fake — the cli test suite has no Postgres. Production
 * callers wire `(input) => upsertPlan(pool, input)`; the `UpsertPlanInput`/return
 * types are the harness's own, so the wired call satisfies this by construction.
 */
export type PlanIntakeDeps = {
    /** Insert-if-absent under the caller-derived id; a repeat upsert is a success no-op. */
    readonly upsertPlan: (input: UpsertPlanInput) => UpsertPlanResult;
};

/**
 * Why intake rejected a plan file. Every variant carries the file `path` so the
 * command can name the offending file, and each surfaces the underlying errors
 * VERBATIM — zod issues for a schema mismatch, `validatePlan`'s own strings for a
 * structural failure — rather than a flattened summary. No side effect (no plan
 * row, no run, no staging) occurs on any of these paths.
 */
export type PlanIntakeError =
    | { readonly type: "read_failed"; readonly path: string; readonly cause: unknown }
    | { readonly type: "invalid_json"; readonly path: string; readonly cause: unknown }
    | { readonly type: "schema_invalid"; readonly path: string; readonly issues: readonly PlanSchemaIssue[] }
    | { readonly type: "plan_invalid"; readonly path: string; readonly errors: readonly string[] }
    | { readonly type: "persist_failed"; readonly path: string; readonly cause: DbError };

/**
 * A plan taken in successfully: the deterministic id it was persisted under, the
 * parsed plan for the run command to build `ExecuteAnalysisInput` from,
 * and the display summary derived exactly as the harness's own trigger derives it
 * — so the run command consumes it rather than re-deriving the same fallback.
 */
export type PlanIntake = {
    /** Deterministic over `(analysisId, exact file bytes)`; matches `/^pln-[a-f0-9]{8}$/`. */
    readonly planId: string;
    readonly plan: AnalysisPlan;
    /** `plan.title` (trimmed) or, absent a title, the narrative's first 280 chars. */
    readonly planSummary: string;
};

/**
 * Read the plan file as raw bytes. A single-caller wrapper (kept here, not in
 * `lib/fs.ts`, per the single-caller rule) because the id hash must run over the
 * EXACT on-disk bytes: `lib/fs.ts`'s `readFileResult` decodes to a UTF-8 string,
 * and a decode+re-encode round-trip could perturb the bytes the id derives from.
 */
function readPlanBytes(path: string): Result<Buffer, PlanIntakeError> {
    try {
        return ok(readFileSync(path));
    } catch (cause) {
        return err({ type: "read_failed", path, cause });
    }
}

/**
 * Parse the file bytes as JSON. A local wrapper rather than `JSON.parseWith`
 * (`extensions/json.ext.ts`) because that helper collapses a parse failure and a
 * schema mismatch into a single `null`, discarding the zod issues — intake needs
 * the two failures distinct (`invalid_json` vs `schema_invalid`) and the issues
 * verbatim, so it parses and schema-validates in separate, individually-typed steps.
 */
function parsePlanJson(path: string, bytes: Buffer): Result<unknown, PlanIntakeError> {
    try {
        // unknown: external file content, validated by `AnalysisPlanSchema` next.
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        return ok(parsed);
    } catch (cause) {
        return err({ type: "invalid_json", path, cause });
    }
}

/**
 * Derive the plan id: `pln-` + the first 8 hex of `sha256(analysisId + "\n" + bytes)`.
 *
 * Determinism is load-bearing, not cosmetic: run dedup is keyed `(analysisId,
 * planId)` (`queryActiveRun`), so a stable id makes re-running the SAME file
 * attach to the already-active run instead of double-launching, while editing the
 * file yields a new id (a genuinely different plan → a new run). The analysisId is
 * hashed in to prevent cross-analysis collisions: `cortex_plans.plan_id` is a
 * global primary key but `loadPlan` is analysis-scoped, so a shared id across two
 * analyses would misroute the second to "plan not found".
 *
 * `createHash` is not wrapped in a `Result`: with a hardcoded algorithm and
 * Buffer/string input it is total — a bad algorithm would be a programmer bug
 * surfaced at first run, not a runtime failure mode worth a branch.
 */
function derivePlanId(analysisId: string, fileBytes: Buffer): string {
    const digest = createHash("sha256")
        .update(analysisId + "\n")
        .update(fileBytes)
        .digest("hex");
    return `pln-${digest.slice(0, 8)}`;
}

/**
 * The pure, side-effect-free plan gate: read the file bytes, run the three
 * read-side checks the harness's own trigger (`tools/execute-plan.ts`) applies —
 * JSON parse, `AnalysisPlanSchema`, then `validatePlan` — and, only once all pass,
 * derive the deterministic id and summary. No persistence, so the run command
 * calls this BEFORE it boots the runtime, rejecting a malformed plan before any
 * side effect (no boot, no staging, no ledger row — the plan-intake spec's
 * "rejected before any side effect" gate). {@link persistPlan} does the pool-backed
 * write afterward, from the {@link PlanIntake} this returns.
 */
export function validatePlanFile(analysisId: string, path: string, perStepCeiling?: ResourceLimits): Result<PlanIntake, PlanIntakeError> {
    return readPlanBytes(path).andThen((bytes) =>
        parsePlanJson(path, bytes)
            .andThen((raw): Result<AnalysisPlan, PlanIntakeError> => {
                const parsed = AnalysisPlanSchema.safeParse(raw);
                return parsed.success ? ok(parsed.data) : err({ type: "schema_invalid", path, issues: parsed.error.issues });
            })
            .andThen((plan): Result<AnalysisPlan, PlanIntakeError> => {
                // `validatePlan` deliberately treats an empty `steps` array as
                // valid (a no-op run — harness `validate-plan.ts`). The cli refuses
                // it: a zero-step run only reserves a ledger row and resolves to an
                // empty `completed`, never what a hand-authored plan file intends.
                if (plan.steps.length === 0) {
                    return err({ type: "plan_invalid", path, errors: ["Plan has no steps — add at least one analysis step to run."] });
                }
                // The ceiling makes an over-sized step a loud pre-boot rejection —
                // the same loud-at-plan-time gate the harness planner applies —
                // instead of a run that fails at its first scheduling round.
                const structural = validatePlan(plan, { perStepCeiling });
                return structural.valid ? ok(plan) : err({ type: "plan_invalid", path, errors: structural.errors });
            })
            .map((plan): PlanIntake => ({
                planId: derivePlanId(analysisId, bytes),
                plan,
                // The exact fallback the harness trigger uses (`execute-plan.ts`):
                // an empty/whitespace title falls through to the narrative slice.
                planSummary: plan.title?.trim() || plan.analytical_narrative.trim().slice(0, 280),
            })),
    );
}

/**
 * Persist an already-validated {@link PlanIntake} through the injected seam, under
 * the id {@link validatePlanFile} derived. Split from validation so the run command
 * can gate a bad plan BEFORE boot and reach the pool-backed write only here, once a
 * runtime exists. The intake is carried across that boundary rather than re-read, so
 * the file is read exactly once and its deterministic id cannot shift under a
 * mid-run edit of the file. A seam failure surfaces as `persist_failed` carrying the
 * file path (for the command's message) and the underlying `DbError`.
 */
export function persistPlan(analysisId: string, path: string, intake: PlanIntake, deps: PlanIntakeDeps): ResultAsync<PlanIntake, PlanIntakeError> {
    return deps
        .upsertPlan({ planId: intake.planId, analysisId, plan: intake.plan })
        .map((): PlanIntake => intake)
        .mapErr((cause): PlanIntakeError => ({ type: "persist_failed", path, cause }));
}

/**
 * Take an analysis plan in from a JSON file in a single call: {@link validatePlanFile}
 * then {@link persistPlan}. On success yields `{ planId, plan, planSummary }`; on any
 * gate failure rejects with the file path and the verbatim errors, having persisted
 * nothing. The run command splits these two halves across its runtime-boot boundary
 * (validate pre-boot, persist post-boot) to fail fast; this composed form is the
 * whole-intake contract for a caller that already holds a pool. Pass the resolved
 * policy's `perStep` as `perStepCeiling` to apply the same over-ceiling gate the
 * split path applies — omitting it skips that check, nothing else.
 *
 * Idempotent by the id's determinism plus the seam's insert-if-absent semantics:
 * re-taking the same file under the same analysis re-derives the same id and the
 * seam no-ops, so a repeat intake reports success without a duplicate row.
 */
export function intakePlan(analysisId: string, path: string, deps: PlanIntakeDeps, perStepCeiling?: ResourceLimits): ResultAsync<PlanIntake, PlanIntakeError> {
    return validatePlanFile(analysisId, path, perStepCeiling).asyncAndThen((intake) => persistPlan(analysisId, path, intake, deps));
}
