/**
 * `executeTargetAssessment` — the parent DBOS workflow.
 *
 * Shape (every external interaction is a `DBOS.runStep` so a crashed
 * workflow replays from the cache instead of repeating side effects):
 *
 *  Phase 0   `phase0Resolve`               — only step allowed to throw
 *                                            (terminates → `target-unresolved`)
 *  Phase 1   14 collectors in parallel     — coverage-envelope failures
 *  Progress  `emitProgress("deciding")`
 *  Phase 2   2 decisions in parallel       — LLM calls, attempt-numbered
 *  Progress  `emitProgress("fanning_out")`
 *  Phase 3   4 fan-out blocks in parallel  — per-item HTTP, withHost semaphore
 *  Progress  `emitProgress("assembling")`
 *  Phase 4   `phase4Assemble`              — deterministic
 *  Progress  `emitProgress("synthesizing")`
 *  Phase 5a  3 per-section syntheses in parallel
 *  Phase 5b  `dossierRecommendation` sequential
 *  Phase 5c  `phase5Persist` (pure)
 *  Terminal  outermost try/finally:
 *             - normal:           setDossier         → status="completed"
 *             - phase0 throw:     markFailed         → "target-unresolved"
 *             - schema violation: markFailed         → "schema-violation"
 *             - other throw:      markFailed         → "unexpected-throw"
 *             - 402 self-cancel:  markAssessmentSuspended → "suspended_insufficient_funds"
 *             - operator cancel:  markFailed         → "operator-cancelled"
 *             - soft-deleted row: no-op
 *
 * Workflow ID convention: `workflowID === assessmentId`. TA is one-shot
 * (re-runs create new rows), so the workflowID equals the assessmentId
 * directly. No `:runId` suffix.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";
import { z } from "zod";

import type { AgentSession, RunSession } from "../auth/types.js";
import { forSubAgent } from "../auth/types.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import type { AgentChat } from "../providers/types.js";

import { resolveTarget } from "../tools/lib/identifier-resolver.js";
import { TargetAssessmentInputSchema, type Phase1Bundle, type ResolvedTarget } from "./target-assessment/schemas.js";
import type { Phase2Bundle } from "./target-assessment/steps/phase2-aggregate.js";

import { getAssessment, markAssessmentSuspended, markFailed, setDossier } from "../state/target-assessments.js";

import { COLLECTOR_MANIFEST, type CollectorCtx } from "./target-assessment/collectors/index.js";
import { drugsInClass, modulatorTriage, type DrugsInClassResult, type ModulatorTriageResult } from "./target-assessment/decisions/index.js";
import {
    aesForOneClassDrug,
    aesForOneTrial,
    faersForOneModulator,
    polypharmForOneModulator,
    type ClassDrugItem,
    type ModulatorItem,
    type PerClassDrugAEsItem,
    type PerModulatorFaersItem,
    type PerModulatorPolypharmItem,
    type PerTrialAEsItem,
    type PolypharmInputItem,
    type TrialItem,
} from "./target-assessment/fanout/index.js";
import { fetchApprovalPrecedents, pickIndicationForPrecedents, renderApprovalPrecedents } from "./target-assessment/lib/approval-precedents.js";
import { readBudgetExceededMarker } from "./target-assessment/lib/llm-step.js";
import { recordTerminalReason } from "./target-assessment/metrics.js";
import { phase4Assemble } from "./target-assessment/phase4-assemble.js";
import { DossierDerivedInvariantError, DossierSchemaViolationError, phase5Persist } from "./target-assessment/phase5-persist.js";
import { emitProgress, type ProgressPhase } from "./target-assessment/progress.js";
import {
    dossierRecommendation,
    liabilityBullets,
    safetyFlagsTrail,
    translationalCommentary,
    type DossierRecommendationStepOutput,
    type LiabilityBulletsStepOutput,
    type SafetyFlagsTrailStepOutput,
    type SynthesisStepResult,
    type TranslationalCommentaryStepOutput,
} from "./target-assessment/synthesis/index.js";

// ── Workflow input ───────────────────────────────────────────────────

export const ExecuteTargetAssessmentInputSchema = z.object({
    assessmentId: z.string(),
    target: z.string(),
    goal: z.string().nullable().optional(),
    organizationId: z.string(),
    requestedBy: z.string(),
    billingContextId: z.string(),
});
type SerializedInput = z.infer<typeof ExecuteTargetAssessmentInputSchema>;
/**
 * Workflow input includes the `runSession` minted at the trigger route.
 * The schema is for the serialised wire shape (input persisted by DBOS);
 * the `runSession` is added at the type level so the workflow body can
 * read the run-authorization credential directly.
 */
export type ExecuteTargetAssessmentInput = SerializedInput & {
    readonly runSession: RunSession;
    /**
     * True when Cortex owns the run-authorization lifecycle and therefore must
     * revoke it on the terminal path. Optional because a workflow persisted
     * before this field existed (recovered across the deploy that added it)
     * deserializes without it; the body defaults absent → true, matching the
     * prior Cortex-owned behavior.
     */
    readonly ownsMandate?: boolean; // oss-core-managed-ok
};

export interface ExecuteTargetAssessmentResult {
    readonly assessmentId: string;
    readonly status: "completed" | "failed" | "suspended_insufficient_funds" | "deleted";
    readonly bytes: number;
}

// ── Dep injection ────────────────────────────────────────────────────

export interface ExecuteTargetAssessmentDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Pool;
    /** Run-authorization seam — the terminal path revokes through `revoke`. */
    readonly runAuthorizer: RunAuthorizer;
    /** NCBI E-utilities key for the ClinVar / PubMed Phase-1 collectors. */
    readonly ncbiApiKey?: string;
    /**
     * Chat provider — billing resolution is closure-wrapped via the TA
     * resolver in `harness/billing/target-assessment-resolver.ts` (see §12
     * registration). The session's `scope.kind === "target-assessment"`
     * carries the `billingContextId` the resolver keys on.
     */
    readonly chatProvider: AgentChat;
    /** Billing-gateway model for decision agents — typically `env.TARGET_ASSESSMENT_DECISION_MODEL`. */
    readonly decisionModel: string;
    /** Billing-gateway model for synthesis agents — typically `env.TARGET_ASSESSMENT_SYNTHESIS_MODEL`. */
    readonly synthesisModel: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Derive a sub-agent session from the durable `RunSession`. Identity, scope,
 * and the opaque `auth` capability come from the parent session — no synthetic
 * envelopes.
 */
function buildSession(input: ExecuteTargetAssessmentInput, agentId: string): AgentSession {
    return {
        ...input.runSession,
        provenance: { agentId, callPath: [agentId] },
    };
}

/**
 * Type guard: any phase result carrying `{kind: "budget-exceeded"}` means
 * the LLM step wrapper has already self-cancelled the workflow. The body
 * should propagate the sentinel up the call chain so no downstream
 * coverage envelope is fabricated for it.
 */
function isBudgetCancel(value: unknown): boolean {
    return typeof value === "object" && value !== null && "kind" in value && (value as { kind: string }).kind === "budget-exceeded";
}

interface CoverageQueriedNoData {
    readonly coverage: "queried_no_data";
    readonly error?: { readonly message: string };
}

function wrapCollectorThrow(err: unknown): CoverageQueriedNoData {
    return {
        coverage: "queried_no_data",
        error: { message: err instanceof Error ? err.message : String(err) },
    };
}

/**
 * Internal sentinel thrown by the workflow body when a 402 marker has
 * been observed at a phase boundary — short-circuits the remaining
 * phases and lands in the outermost catch, which sets `budgetExceeded`
 * for the terminal dispatch.
 */
class BudgetExceededSkip extends Error {
    constructor() {
        super("budget exceeded — skipping remaining phases");
        this.name = "BudgetExceededSkip";
    }
}

// ── Workflow registration ────────────────────────────────────────────

/**
 * Register the executeTargetAssessment workflow with DBOS. Caller is
 * responsible for setting `workflowID = assessmentId` via
 * `DBOS.startWorkflow(_, { workflowID })`.
 */
export function registerExecuteTargetAssessment(
    deps: ExecuteTargetAssessmentDeps,
): (input: ExecuteTargetAssessmentInput) => Promise<ExecuteTargetAssessmentResult> {
    return DBOS.registerWorkflow(
        async (input: ExecuteTargetAssessmentInput) => {
            return runExecuteTargetAssessmentBody(input, deps);
        },
        { name: "executeTargetAssessment" },
    );
}

/**
 * Body extracted so tests can drive it without registering a workflow
 * (the DBOS calls inside still rely on a workflow context being present).
 */
export async function runExecuteTargetAssessmentBody(
    input: ExecuteTargetAssessmentInput,
    deps: ExecuteTargetAssessmentDeps,
): Promise<ExecuteTargetAssessmentResult> {
    const logger = (deps.logger ?? createNoopLogger()).with({ assessmentId: input.assessmentId });
    // (§6.1) Outermost try/finally — every termination path dispatches the
    // matching terminal handler. Phase 0 throws are caught here; every
    // other phase wraps its body in coverage envelopes and does not throw.
    // Budget-exceeded (billing-gateway 402) reaches here via `budgetExceeded` set
    // when any LLM step returns the sentinel. The terminal block writes
    // `status = "suspended_insufficient_funds"` via DBOS.runStep BEFORE
    // materialising the cancel — the trailing `DBOS.cancelWorkflow` +
    // `DBOS.runStep("self-cancel-budget-exceeded")` puts the workflow into
    // CANCELLED status (the only state `DBOS.resumeWorkflow` replays).
    // Ownership defaults to true for inputs persisted before the field existed
    // (a workflow recovered across this deploy) — those were always Cortex-owned.
    const authorization: RunAuthorization = {
        runSession: input.runSession,
        ownsMandate: input.ownsMandate ?? true, // oss-core-managed-ok
    };

    let phase0Error: unknown;
    let schemaViolation: DossierSchemaViolationError | undefined;
    let derivedViolation: DossierDerivedInvariantError | undefined;
    let unexpectedError: unknown;
    let budgetExceeded = false;
    let dossierForPersist: Record<string, unknown> | undefined;
    let bytesForPersist = 0;

    try {
        // (§5.3, §6.3) Phase 0 — target resolution. The only legitimate throw
        // site. On throw, the catch below records `phase0Error` and the
        // terminal block dispatches `markFailed({kind: "target-unresolved"})`.
        await emitProgress(deps.pool, logger, input.assessmentId, "resolving");
        const resolved: ResolvedTarget = await DBOS.runStep(
            async () => {
                const r = await resolveTarget(input.target);
                return {
                    assessmentId: input.assessmentId,
                    goal: input.goal ?? null,
                    ...r,
                };
            },
            { name: "ta-phase0-resolve" },
        ).catch((err: unknown) => {
            phase0Error = err;
            throw err;
        });

        // (§5.4) Phase 1 — 14 collectors in parallel. Each is its own DBOS
        // step; coverage failures cache as `queried_no_data` and replay
        // returns the cached envelope. The per-collector run functions emit
        // different bundle shapes; the union is widened to `unknown` here
        // and `Phase1Bundle` is reconstructed by manifest key below.
        await emitProgress(deps.pool, logger, input.assessmentId, "collecting");
        type CollectorEntry = {
            id: string;
            run: (r: ResolvedTarget, ctx: CollectorCtx) => Promise<unknown>;
        };
        const manifest: readonly CollectorEntry[] = COLLECTOR_MANIFEST as unknown as readonly CollectorEntry[];
        const collectorCtx: CollectorCtx = { ncbiApiKey: deps.ncbiApiKey };
        const collectorPairs = await Promise.all(
            manifest.map((entry) =>
                DBOS.runStep(() => entry.run(resolved, collectorCtx), {
                    name: `ta-collector:${entry.id}`,
                })
                    .catch((err: unknown) => wrapCollectorThrow(err) as unknown)
                    .then((result) => [entry.id, result] as const),
            ),
        );
        const collectorById = Object.fromEntries(collectorPairs) as Record<string, unknown>;
        const phase1: Phase1Bundle = {
            resolved,
            collectors: {
                opentargets: collectorById["opentargets"],
                chemblModulators: collectorById["chembl-modulators"],
                ctgov: collectorById["ctgov"],
                faersByTarget: collectorById["faers-by-target"],
                expressionHuman: collectorById["expression-human"],
                expressionMultiSpecies: collectorById["expression-multi-species"],
                clinvar: collectorById["clinvar"],
                cbioportal: collectorById["cbioportal"],
                impc: collectorById["impc"],
                pubmedIndex: collectorById["pubmed-index"],
                pathways: collectorById["pathways"],
                stringPpi: collectorById["string-ppi"],
                familyComplexes: collectorById["family-complexes"],
                therapeuticPrograms: collectorById["therapeutic-programs"],
            },
        } as Phase1Bundle;

        // (§5.5, §5.11) Phase 2 — decisions. Lazy billing resolution happens
        // inside the chat provider's closure (TA-aware provider in §12). The
        // session carries the `billingContextId` the provider reads from.
        await emitProgress(deps.pool, logger, input.assessmentId, "deciding");
        const decisionSession = buildSession(input, "ta-decisions");
        const [modulatorRes, drugsRes]: [ModulatorTriageResult, DrugsInClassResult] = await Promise.all([
            modulatorTriage(phase1, {
                chatProvider: deps.chatProvider,
                session: forSubAgent(decisionSession, "modulator-triage"),
                model: deps.decisionModel,
                attempt: 0,
            }),
            drugsInClass(phase1, {
                chatProvider: deps.chatProvider,
                session: forSubAgent(decisionSession, "drugs-in-class"),
                model: deps.decisionModel,
                attempt: 0,
            }),
        ]);
        if (isBudgetCancel(modulatorRes) || isBudgetCancel(drugsRes)) {
            // An LLM step already sent the budget-exceeded marker. Skip the
            // remaining phases and fall through to the terminal block, which
            // dispatches `markAssessmentSuspended` and materialises the cancel.
            budgetExceeded = true;
            throw new BudgetExceededSkip();
        }
        const phase2: Phase2Bundle = {
            phase1,
            decisions: {
                modulatorTriage: modulatorRes as Phase2Bundle["decisions"]["modulatorTriage"],
                failedTrialClassifier: {
                    coverage: "not_loaded",
                    reason: "deterministic in Phase 4 (classifyFailureReason)",
                },
                offTargetCurator: {
                    coverage: "not_loaded",
                    reason: "deterministic in Phase 4 (aggregateOffTargetPanel)",
                },
                drugsInClass: drugsRes as Phase2Bundle["decisions"]["drugsInClass"],
            },
        };

        // (§5.6) Phase 3 — fan-out blocks. Each block iterates items via
        // Promise.all over DBOS.runStep; `withHost` semaphores inside each
        // item function cap concurrency to 4 per host.
        await emitProgress(deps.pool, logger, input.assessmentId, "fanning_out");

        const triage = phase2.decisions.modulatorTriage;
        type ShortlistItem = {
            moleculeChemblId: string;
            preferredName: string;
            maxPhase: number | null;
            firstApproval: number | null;
            rationale?: string;
        };
        const triageShortlist: ModulatorItem[] =
            triage.coverage === "available"
                ? (triage.data.shortlist as unknown as ShortlistItem[]).map((m) => ({
                      moleculeChemblId: m.moleculeChemblId,
                      preferredName: m.preferredName,
                      maxPhase: m.maxPhase,
                      firstApproval: m.firstApproval,
                      rationale: m.rationale ?? "",
                  }))
                : [];

        const chembl = phase1.collectors.chemblModulators;
        const primaryTargetChemblId = chembl.coverage === "available" ? chembl.data.targetChemblId : null;
        const polypharmItems: PolypharmInputItem[] = triageShortlist.map((m) => ({
            moleculeChemblId: m.moleculeChemblId,
            preferredName: m.preferredName,
            primaryTargetChemblId,
        }));

        const ctgov = phase1.collectors.ctgov;
        const trialItems: TrialItem[] = [];
        if (ctgov.coverage === "available") {
            const seen = new Set<string>();
            for (const t of [...ctgov.data.failed, ...ctgov.data.active]) {
                if (!t.nctId || seen.has(t.nctId)) continue;
                seen.add(t.nctId);
                trialItems.push({ nctId: t.nctId, title: t.title });
                if (trialItems.length >= 30) break;
            }
        }

        const dic = phase2.decisions.drugsInClass;
        type DicDrug = {
            moleculeChemblId: string;
            preferredName: string;
            maxPhase: number | null;
            firstApproval: number | null;
        };
        const classDrugItems: ClassDrugItem[] =
            dic.coverage === "available"
                ? (dic.data.drugs as DicDrug[]).map((d) => ({
                      moleculeChemblId: d.moleculeChemblId,
                      preferredName: d.preferredName,
                      maxPhase: d.maxPhase,
                      firstApproval: d.firstApproval,
                  }))
                : [];

        type FanoutEnvelope<T> = { coverage: "available"; data: T } | { coverage: "queried_no_data"; error?: { message: string } };

        async function runFanoutBlock<TItem, TOut>(
            items: readonly TItem[],
            stepKindForName: string,
            keyOf: (item: TItem) => string,
            fn: (item: TItem) => Promise<FanoutEnvelope<TOut>>,
        ): Promise<Array<FanoutEnvelope<TOut>>> {
            return Promise.all(
                items.map((item) =>
                    DBOS.runStep(() => fn(item), {
                        name: `ta-fanout:${stepKindForName}:${keyOf(item)}`,
                    }).catch((err: unknown) => wrapCollectorThrow(err) as FanoutEnvelope<TOut>),
                ),
            );
        }

        const [perModulatorFaersResults, perTrialAesResults, perModulatorPolypharmResults, perClassDrugAesResults] = await Promise.all([
            runFanoutBlock<ModulatorItem, PerModulatorFaersItem>(triageShortlist, "modulator-faers", (item) => item.moleculeChemblId, faersForOneModulator),
            runFanoutBlock<TrialItem, PerTrialAEsItem>(trialItems, "trial-aes", (item) => item.nctId, aesForOneTrial),
            runFanoutBlock<PolypharmInputItem, PerModulatorPolypharmItem>(
                polypharmItems,
                "modulator-polypharm",
                (item) => item.moleculeChemblId,
                polypharmForOneModulator,
            ),
            runFanoutBlock<ClassDrugItem, PerClassDrugAEsItem>(classDrugItems, "class-drug-aes", (item) => item.moleculeChemblId, aesForOneClassDrug),
        ]);

        const phase3 = {
            phase2,
            fanout: {
                perModulatorFaers: { results: perModulatorFaersResults },
                perTrialAes: { results: perTrialAesResults },
                perModulatorPolypharm: { results: perModulatorPolypharmResults },
                perClassDrugAes: { results: perClassDrugAesResults },
            },
        };

        // (§5.7) Phase 4 — deterministic assembly. Single DBOS step.
        await emitProgress(deps.pool, logger, input.assessmentId, "assembling");
        const phase4 = await DBOS.runStep(() => phase4Assemble(deps.pool, phase3 as Parameters<typeof phase4Assemble>[1]), { name: "ta-phase4-assemble" });

        // (§5.8-pre) Approval-precedent grounding — one deterministic openFDA
        // lookup, rendered to markdown and injected into every synthesis prompt.
        // A precedent-lookup failure must NOT fail the whole assessment: a fetch
        // throw degrades to a "no precedents" block.
        const approvalPrecedents = await DBOS.runStep(
            async () => {
                const indication = pickIndicationForPrecedents(phase4.dossier);
                let result: Awaited<ReturnType<typeof fetchApprovalPrecedents>> | null = null;
                if (indication !== null) {
                    try {
                        result = await fetchApprovalPrecedents({ indication });
                    } catch (err) {
                        logger.named("ta-approval-precedents").warn("openFDA lookup failed", { indication, ...logger.errorFields(err) });
                        result = null;
                    }
                }
                return renderApprovalPrecedents(indication, result);
            },
            { name: "ta-approval-precedents" },
        );

        // (§5.8) Phase 5 — three per-section syntheses in parallel.
        await emitProgress(deps.pool, logger, input.assessmentId, "synthesizing");
        const synthesisDeps = (agentId: string) => ({
            chatProvider: deps.chatProvider,
            session: { ...buildSession(input, agentId) },
            model: deps.synthesisModel,
            attempt: 0,
            approvalPrecedents,
        });
        const [bulletsRes, flagsRes, commentaryRes]: [
            SynthesisStepResult<LiabilityBulletsStepOutput>,
            SynthesisStepResult<SafetyFlagsTrailStepOutput>,
            SynthesisStepResult<TranslationalCommentaryStepOutput>,
        ] = await Promise.all([
            liabilityBullets(phase4, synthesisDeps("liability-bullets")),
            safetyFlagsTrail(phase4, synthesisDeps("safety-flags-trail")),
            translationalCommentary(phase4, synthesisDeps("translational-commentary")),
        ]);
        if (isBudgetCancel(bulletsRes) || isBudgetCancel(flagsRes) || isBudgetCancel(commentaryRes)) {
            budgetExceeded = true;
            throw new BudgetExceededSkip();
        }

        // (§5.9) Phase 5b — sequential dossier-recommendation step.
        const recommendationRes: SynthesisStepResult<DossierRecommendationStepOutput> = await dossierRecommendation(
            {
                phase4,
                perSection: {
                    liabilityBullets: bulletsRes as LiabilityBulletsStepOutput,
                    safetyFlagsTrail: flagsRes as SafetyFlagsTrailStepOutput,
                    translationalCommentary: commentaryRes as TranslationalCommentaryStepOutput,
                },
            },
            synthesisDeps("dossier-recommendation"),
        );
        if (isBudgetCancel(recommendationRes)) {
            budgetExceeded = true;
            throw new BudgetExceededSkip();
        }

        // (§5.10) Phase 5c — pure persist function. The DB write moves to
        // the terminal handler below; this step validates the v5 dossier
        // and returns the persisted-shape bundle. Schema/derived violations
        // throw and the terminal handler dispatches to `markFailed`.
        const persisted = await DBOS.runStep(
            () =>
                phase5Persist({
                    logger,
                    assessmentId: input.assessmentId,
                    phase4Dossier: phase4.dossier,
                    phase2,
                    synthesis: {
                        bullets: bulletsRes as LiabilityBulletsStepOutput,
                        flags: flagsRes as SafetyFlagsTrailStepOutput,
                        commentary: commentaryRes as TranslationalCommentaryStepOutput,
                        recommendation: recommendationRes as DossierRecommendationStepOutput,
                    },
                }),
            { name: "ta-phase5-persist" },
        );
        dossierForPersist = persisted.dossier;
        bytesForPersist = persisted.bytes;
    } catch (err) {
        if (err instanceof BudgetExceededSkip) {
            // Already classified; the terminal block reads `budgetExceeded`.
        } else if (err instanceof DossierSchemaViolationError) {
            schemaViolation = err;
        } else if (err instanceof DossierDerivedInvariantError) {
            derivedViolation = err;
        } else if (phase0Error === undefined) {
            unexpectedError = err;
        }
        // phase0Error is already set if it came from the Phase-0 catch above.
    }

    // (§6.1, §6.8) Terminal block. Read the row first; if soft-deleted,
    // no-op (the user's delete during the run wins).
    const row = await DBOS.runStep(async () => unwrapOrThrow(await getAssessment(deps.pool, input.assessmentId, input.organizationId)), {
        name: "ta-terminal-read-row",
    });
    if (row?.status === "deleted") {
        recordTerminalReason("deleted");
        return {
            assessmentId: input.assessmentId,
            status: "deleted",
            bytes: 0,
        };
    }

    // (§6.2) Normal completion — happy path wrote `dossierForPersist`.
    if (!phase0Error && !schemaViolation && !derivedViolation && !unexpectedError && !budgetExceeded && dossierForPersist) {
        try {
            await DBOS.runStep(async () => unwrapOrThrow(await setDossier(deps.pool, input.assessmentId, dossierForPersist!)), {
                name: "ta-terminal-completed",
            });
            await emitProgress(deps.pool, logger, input.assessmentId, "completed");
        } catch (err) {
            logger.named("ta-terminal").error("setDossier failed", logger.errorFields(err));
        }
        await revokeRunAuthorizationSafe(deps, authorization, "target-assessment-completed");
        recordTerminalReason("completed");
        return {
            assessmentId: input.assessmentId,
            status: "completed",
            bytes: bytesForPersist,
        };
    }

    // (§6.3) Phase 0 throw — target unresolved.
    if (phase0Error) {
        await DBOS.runStep(
            async () =>
                unwrapOrThrow(
                    await markFailed(deps.pool, input.assessmentId, {
                        kind: "target-unresolved",
                        message: phase0Error instanceof Error ? phase0Error.message : String(phase0Error),
                    }),
                ),
            { name: "ta-terminal-failed-resolve" },
        );
        await emitProgress(deps.pool, logger, input.assessmentId, "failed");
        await revokeRunAuthorizationSafe(deps, authorization, "target-assessment-failed");
        recordTerminalReason("target-unresolved");
        return {
            assessmentId: input.assessmentId,
            status: "failed",
            bytes: 0,
        };
    }

    // (§6.4) Schema violation.
    if (schemaViolation) {
        await DBOS.runStep(
            async () =>
                unwrapOrThrow(
                    await markFailed(deps.pool, input.assessmentId, {
                        kind: "schema-invariant-violation",
                        message: schemaViolation!.message,
                        details: schemaViolation!.issues,
                    }),
                ),
            { name: "ta-terminal-failed-schema" },
        );
        await emitProgress(deps.pool, logger, input.assessmentId, "failed");
        await revokeRunAuthorizationSafe(deps, authorization, "target-assessment-failed");
        recordTerminalReason("schema-violation");
        return {
            assessmentId: input.assessmentId,
            status: "failed",
            bytes: bytesForPersist,
        };
    }

    // (§6.4 — derived invariant variant — same terminal class, different kind.)
    if (derivedViolation) {
        await DBOS.runStep(
            async () =>
                unwrapOrThrow(
                    await markFailed(deps.pool, input.assessmentId, {
                        kind: "derived-invariant-violation",
                        message: derivedViolation!.message,
                    }),
                ),
            { name: "ta-terminal-failed-derived" },
        );
        await emitProgress(deps.pool, logger, input.assessmentId, "failed");
        await revokeRunAuthorizationSafe(deps, authorization, "target-assessment-failed");
        recordTerminalReason("derived-invariant-violation");
        return {
            assessmentId: input.assessmentId,
            status: "failed",
            bytes: bytesForPersist,
        };
    }

    // (§6.6) Budget exceeded — drain the marker for telemetry, flip the
    // row to `suspended_insufficient_funds`, then materialise the cancel.
    // The trailing `DBOS.cancelWorkflow` + `DBOS.runStep` puts the
    // workflow into CANCELLED status (the only state `DBOS.resumeWorkflow`
    // will replay; SUCCESS / ERROR are terminal).
    if (budgetExceeded) {
        await DBOS.runStep(() => readBudgetExceededMarker(), {
            name: "ta-terminal-drain-marker",
        }).catch(() => null);
        await DBOS.runStep(async () => unwrapOrThrow(await markAssessmentSuspended(deps.pool, input.assessmentId)), { name: "ta-terminal-suspended" });
        await emitProgress(deps.pool, logger, input.assessmentId, "suspended");
        await revokeRunAuthorizationSafe(deps, authorization, "target-assessment-canceled");
        const workflowId = DBOS.workflowID;
        if (workflowId) {
            await DBOS.cancelWorkflow(workflowId);
            // Force one more durable hop so the cancel materialises before the
            // body returns — without this trailing runStep the workflow would
            // land SUCCESS in some DBOS versions because the body completed
            // without re-entering the SDK after the cancel call.
            await DBOS.runStep(async () => undefined, {
                name: "ta-self-cancel-budget-exceeded",
            });
        }
        recordTerminalReason("suspended-on-402");
        return {
            assessmentId: input.assessmentId,
            status: "suspended_insufficient_funds",
            bytes: 0,
        };
    }

    // (§6.5) Unexpected throw — bug somewhere, coverage envelope failed.
    if (unexpectedError) {
        await DBOS.runStep(
            async () =>
                unwrapOrThrow(
                    await markFailed(deps.pool, input.assessmentId, {
                        kind: "unexpected-throw",
                        message: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
                    }),
                ),
            { name: "ta-terminal-failed-unexpected" },
        );
        await emitProgress(deps.pool, logger, input.assessmentId, "failed");
        await revokeRunAuthorizationSafe(deps, authorization, "target-assessment-failed");
        recordTerminalReason("unexpected-throw");
        return {
            assessmentId: input.assessmentId,
            status: "failed",
            bytes: 0,
        };
    }

    // Defensive: this branch is unreachable in practice (one of the
    // categories above must have fired). Fall through to a generic failed
    // status so a buggy refactor surfaces visibly.
    await DBOS.runStep(
        async () =>
            unwrapOrThrow(
                await markFailed(deps.pool, input.assessmentId, {
                    kind: "unexpected-throw",
                    message: "terminal block reached without classified outcome",
                }),
            ),
        { name: "ta-terminal-failed-uncategorized" },
    );
    recordTerminalReason("unexpected-throw");
    return {
        assessmentId: input.assessmentId,
        status: "failed",
        bytes: 0,
    };
}

/**
 * Best-effort revoke wrapped in a durableStep for replay idempotency. This
 * wrapper swallows any runStep-level error so a terminal path is never
 * aborted by a transient revoke failure.
 */
async function revokeRunAuthorizationSafe(deps: ExecuteTargetAssessmentDeps, authorization: RunAuthorization, reason: string): Promise<void> {
    const logger = (deps.logger ?? createNoopLogger()).named("execute-target-assessment");
    try {
        await DBOS.runStep(() => deps.runAuthorizer.revoke(authorization, reason), {
            name: `ta-revoke-run-auth:${reason}`,
        });
    } catch (err) {
        logger.warn("revokeRunAuthorization failed", { reason, ...logger.errorFields(err) });
    }
}

// Re-export the canonical TA input schema (consumers and the managed root
// validate against this shape on the trigger route).
export { TargetAssessmentInputSchema };

// Phase shape used by the SSE route's fold-on-read.
export type { ProgressPhase };
