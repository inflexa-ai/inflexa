/**
 * The claim-investigation phase.
 *
 * Corroboration says which organs several sources agree on. Agreement is not
 * adjudication: sources that all re-import one curation agree perfectly and are
 * wrong together. This phase interrogates each corroborated organ claim —
 * propose a mechanism, argue against it, re-verify, converge — and records what
 * survived, plus every candidate it did not get to and why.
 *
 * Three LLM steps per round, chosen per step rather than uniformly:
 *
 *   - **propose** and **re-verify** are single-shot structured extractions
 *     (`structuredLlmCall`). Everything they reason over is already in the
 *     prompt; a retrieval surface would only let them ground an answer in
 *     something the run never collected.
 *   - **critique** is a real agent loop (`runToTerminal` over `runAgent`) with a
 *     literature tool and a `defineTool` terminal recorder. Disconfirmation is a
 *     search task: the dossier is assembled to state what the run found, not to
 *     refute it, so a critic confined to it can only observe that the evidence
 *     is thin — which is the rubber stamp this step exists to avoid.
 *
 * Nothing here scores a claim. The verdict is a four-word vocabulary the model
 * states, no threshold decides survival, and no claim is removed from the
 * dossier by anything this phase concludes.
 *
 * Durability arrives through the injected `runStep` seam and through
 * `structuredLlmCall`'s own attempt-named steps; this module imports no
 * durability engine.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import type {
    ClaimCritique,
    ClaimEvidence,
    ClaimInvestigation,
    ClaimSupport,
    ClaimVerdict,
    DossierBody,
    InvestigatedClaimRow,
    InvestigationConvergence,
    MechanismProposal,
    OrganCorroborationRow,
    SafetyCorroboration,
    UninvestigatedClaim,
} from "@inflexa-ai/harness/contracts/target-dossier.js";

import { composeSystemPrompt } from "../../../agents/system-prompt.js";
import type { AgentSession } from "../../../auth/types.js";
import type { UsageRecorder } from "../../../billing/usage-recorder.js";
import type { OrganSystem } from "../../../contracts/organ-system.js";
import { createNoopLogger } from "../../../lib/console-logger.js";
import type { Logger } from "../../../lib/logger.js";
import type { StepNameFormatter } from "../../../loop/run-agent.js";
import { runToTerminal } from "../../../loop/run-to-terminal.js";
import type { AgentDefinition, RunStep } from "../../../loop/types.js";
import { adversarialCritiquePrompt, claimReverificationBrief, mechanismProposalBrief } from "../../../prompts/target-assessment/investigation/index.js";
import type { AgentChat } from "../../../providers/types.js";
import { defineTool, type Tool } from "../../../tools/define-tool.js";
import { forSubAgent } from "../../../auth/types.js";
import { BUDGET_EXCEEDED_SENTINEL } from "../lib/llm-step.js";
import { structuredLlmCall } from "../lib/structured-llm.js";

// ── Configuration ────────────────────────────────────────────────────

/**
 * The bounds the phase runs under.
 *
 * These are configuration with stated defaults, not clinical constants: nothing
 * about biology says six claims or two rounds. They exist to bound cost and to
 * guarantee termination, the section reports the values in force, and an
 * embedder that wants a deeper pass sets its own.
 */
export interface ClaimInvestigationConfig {
    /** Corroborated organ claims investigated per run; the rest are reported as budget-cut. */
    readonly claimBudget: number;
    /** Propose → critique → re-verify rounds a single claim may run. */
    readonly roundBound: number;
    /** Iteration budget for the adversarial critic's tool-using loop. */
    readonly criticMaxIterations: number;
}

export const DEFAULT_CLAIM_INVESTIGATION_CONFIG: ClaimInvestigationConfig = {
    claimBudget: 6,
    roundBound: 2,
    criticMaxIterations: 8,
};

// ── Deps and input ───────────────────────────────────────────────────

export interface ClaimInvestigationDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly chatProvider: AgentChat;
    /** Session for the phase; each step derives its own sub-agent session from it. */
    readonly session: AgentSession;
    readonly model: string;
    /** Attempt counter — bumped on resume so a cancelled call lands a fresh durable slot. */
    readonly attempt: number;
    /** Durability seam for the critic's agent loop. */
    readonly runStep: RunStep;
    /** Retrieval surface the adversarial critic searches for disconfirming records. */
    readonly critiqueTools: readonly Tool[];
    /** Overrides for {@link DEFAULT_CLAIM_INVESTIGATION_CONFIG}. */
    readonly config?: Partial<ClaimInvestigationConfig>;
    /** LLM usage-accounting seam for the critic loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    readonly signal?: AbortSignal;
}

export interface ClaimInvestigationInput {
    /** The run's corroboration record — the source of candidate claims. */
    readonly corroboration: SafetyCorroboration;
    /** The assembled dossier body, read for per-organ risk context and completeness. */
    readonly dossier: DossierBody;
}

/** The sentinel an LLM step returns once it has self-cancelled the workflow on a 402. */
export interface BudgetExceeded {
    readonly kind: "budget-exceeded";
    readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL;
}

export type ClaimInvestigationResult = ClaimInvestigation | BudgetExceeded;

function isBudgetCancel<T>(value: T | BudgetExceeded): value is BudgetExceeded {
    return typeof value === "object" && value !== null && "kind" in value && (value as { kind: string }).kind === "budget-exceeded";
}

// ── The model-facing claim contract ──────────────────────────────────

/**
 * What a step is asked to return as support.
 *
 * Structurally the claim contract, minus the locator refinement — a refinement
 * cannot be expressed in a tool input schema, so requiring it here would mean
 * requiring it in prose and hoping. {@link resolveSupport} enforces it instead,
 * at this producer's own boundary.
 */
const ModelEvidenceSchema = z.object({
    source: z.string().min(1).describe("Which corpus or record set the evidence came from."),
    pmid: z.string().optional().describe("PubMed identifier, digits only, of a record you actually read."),
    doi: z.string().optional().describe("Digital object identifier of a record you actually read."),
    accession: z.string().optional().describe("Database accession of a record you actually read."),
    regulatory_reference: z
        .object({
            document: z.string().min(1).describe("The regulatory document, e.g. an NDA/BLA application number."),
            section: z.string().optional().describe("The label section the statement came from."),
        })
        .optional()
        .describe("Set only when the evidence is a regulatory document you were shown or retrieved."),
    excerpt: z.string().optional().describe("Short quotation or paraphrase of what the record says."),
});

const ModelSupportSchema = z.discriminatedUnion("state", [
    z.object({
        state: z.literal("scored"),
        evidence: z
            .array(ModelEvidenceSchema)
            .min(1)
            .describe("Records supporting the claim. Each needs a pmid, doi, accession, or regulatory reference you retrieved."),
    }),
    z.object({
        state: z.literal("unknown"),
        reason: z.string().min(1).describe("One line saying why no record supports the claim. A complete, expected answer."),
    }),
]);
type ModelSupport = z.infer<typeof ModelSupportSchema>;

/**
 * Resolve model-supplied support onto the claim contract.
 *
 * Evidence naming only a source resolves to nothing a reader can check, so it is
 * dropped; a scored claim left with no admissible evidence becomes `unknown`
 * with a reason saying so. Degrading here rather than failing keeps a
 * hallucinated citation from taking the whole assessment down at schema
 * validation, and keeps the honest answer cheaper than the invented one.
 */
function resolveSupport(support: ModelSupport): ClaimSupport {
    if (support.state === "unknown") return { state: "unknown", reason: support.reason };
    const admissible: ClaimEvidence[] = support.evidence.filter((e) => Boolean(e.pmid ?? e.doi ?? e.accession ?? e.regulatory_reference)) as ClaimEvidence[];
    if (admissible.length === 0) {
        return { state: "unknown", reason: "the cited support named a source but carried no publication identifier, doi, accession, or regulatory reference" };
    }
    return { state: "scored", evidence: admissible };
}

// ── Step output schemas ──────────────────────────────────────────────

const MechanismProposalOutputSchema = z.object({
    mechanism: z.string().nullable().describe("How the target produces the liability in this organ. Null when the evidence supports none."),
    support: ModelSupportSchema,
});

const CritiqueOutputSchema = z.object({
    objection: z.string().min(1).describe("The concrete case against the claim. Not 'the evidence is limited'."),
    support: ModelSupportSchema,
});

const ReverificationOutputSchema = z.object({
    verdict: z.enum(["upheld", "weakened", "overturned", "undetermined"]).describe("What the record supports once the objection is weighed."),
    support: ModelSupportSchema,
});

// ── Prompt payloads ──────────────────────────────────────────────────

/**
 * What a step is shown about the organ under investigation.
 *
 * The corroboration row already carries every contributing source, its signal,
 * and the record it came from, so the claim's whole evidential basis travels as
 * one value. The rollup row adds the assessment's own per-organ risk read.
 */
function claimContext(row: OrganCorroborationRow, dossier: DossierBody): string {
    const rollup = dossier.safety_profile.organ_rollup;
    const rollupRow = rollup.coverage === "available" ? rollup.data.rows.find((r) => r.organ === row.organ) : undefined;
    return JSON.stringify(
        {
            target: dossier.entity.symbol,
            organ: row.organ,
            corroboration: {
                corroborating_sources: row.corroborating_sources,
                independent_source_count: row.independent_source_count,
                contributions: row.contributions,
            },
            organ_rollup: rollupRow ?? null,
        },
        null,
        2,
    );
}

// ── Steps ────────────────────────────────────────────────────────────

interface StepDeps {
    readonly deps: ClaimInvestigationDeps;
    readonly config: ClaimInvestigationConfig;
}

const PROPOSER_AGENT_ID = "claim-mechanism-proposer";
const CRITIC_AGENT_ID = "claim-adversarial-critic";
const VERIFIER_AGENT_ID = "claim-reverifier";

type StepResult<T> = { readonly kind: "ok"; readonly value: T } | BudgetExceeded;

async function proposeMechanism(
    row: OrganCorroborationRow,
    dossier: DossierBody,
    round: number,
    priorObjection: string | null,
    { deps }: StepDeps,
): Promise<StepResult<MechanismProposal | null>> {
    const prompt = [
        `Propose a mechanism for the ${row.organ} liability of ${dossier.entity.symbol}.`,
        "",
        claimContext(row, dossier),
        ...(priorObjection ? ["", "A previous round raised this objection. Answer it or revise the mechanism:", priorObjection] : []),
    ].join("\n");

    const result = await structuredLlmCall({
        ...(deps.logger ? { logger: deps.logger } : {}),
        stepName: `ta-investigate:propose:${row.organ}:${deps.attempt}:${round}`,
        agentId: PROPOSER_AGENT_ID,
        provider: deps.chatProvider,
        session: forSubAgent(deps.session, PROPOSER_AGENT_ID),
        system: composeSystemPrompt(mechanismProposalBrief),
        prompt,
        schema: MechanismProposalOutputSchema,
        model: deps.model,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (result.kind === "budget-exceeded") return result;
    const out = result.value;
    if (out.mechanism === null || out.mechanism.trim().length === 0) return { kind: "ok", value: null };
    return { kind: "ok", value: { statement: out.mechanism, support: resolveSupport(out.support) } };
}

/**
 * Namespace the critic loop's own step names.
 *
 * `runAgent` names its steps `llm-{i}` / `tool-{name}-{id}`, which are unique
 * only within one run. Several claims are investigated concurrently and each
 * runs several rounds, so without this every one of them would write into the
 * same durable cache slots and replay another claim's answers.
 */
function criticStepNames(organ: OrganSystem, attempt: number, round: number): StepNameFormatter {
    const prefix = `ta-investigate:critique:${organ}:${attempt}:${round}`;
    return {
        llm: (i) => `${prefix}:llm-${i}`,
        tool: (name, id) => `${prefix}:tool-${name}-${id}`,
    };
}

async function critiqueClaim(
    row: OrganCorroborationRow,
    dossier: DossierBody,
    mechanism: MechanismProposal,
    round: number,
    { deps, config }: StepDeps,
): Promise<ClaimCritique | null> {
    // A mutable holder rather than a plain `let`: the cell is written from the
    // tool's `execute` closure, which the compiler cannot see, so a bare local
    // would still read as `null` at every use after the loop returns.
    const cell: { recorded: z.infer<typeof CritiqueOutputSchema> | null } = { recorded: null };

    const recordCritique = defineTool({
        id: "record_critique",
        description:
            "Record your case against the claim and finish. Call exactly once, with the strongest objection you " +
            "could build and the counter-evidence you actually retrieved. If you found no record that disconfirms " +
            "the claim, record the objection with support state 'unknown' and a one-line reason — that is a " +
            "complete answer, not a failure.",
        inputSchema: CritiqueOutputSchema,
        describeCall: ({ objection }) => objection,
        executionMode: "inline",
        execute: (input) => {
            cell.recorded = input;
            return Promise.resolve(ok({ recorded: true }));
        },
    });

    const agent: AgentDefinition = {
        id: CRITIC_AGENT_ID,
        systemPrompt: composeSystemPrompt(adversarialCritiquePrompt),
        model: deps.model,
        tools: [...deps.critiqueTools, recordCritique],
        maxIterations: config.criticMaxIterations,
    };

    const brief = [
        `Argue that the ${row.organ} liability claim about ${dossier.entity.symbol} does not hold.`,
        "",
        "Proposed mechanism:",
        mechanism.statement,
        "",
        "Evidence the assessment collected for this organ:",
        claimContext(row, dossier),
    ].join("\n");

    const controller = new AbortController();
    await runToTerminal(
        agent,
        [{ role: "user", content: brief }],
        forSubAgent(deps.session, CRITIC_AGENT_ID),
        {
            provider: deps.chatProvider,
            signal: deps.signal ?? controller.signal,
            emit: () => {},
            runStep: deps.runStep,
            formatStepName: criticStepNames(row.organ, deps.attempt, round),
            resolved: () => cell.recorded !== null,
            ...(deps.logger ? { logger: deps.logger } : {}),
            ...(deps.usageRecorder ? { usageRecorder: deps.usageRecorder } : {}),
        },
        {
            tools: [recordCritique],
            nudge: "You have not recorded a critique. Call `record_critique` now with the case you built; if you found no disconfirming record, use support state 'unknown' with a one-line reason.",
        },
    );

    const outcome = cell.recorded;
    if (outcome === null) return null;
    return { objection: outcome.objection, support: resolveSupport(outcome.support) };
}

async function reverifyClaim(
    row: OrganCorroborationRow,
    dossier: DossierBody,
    mechanism: MechanismProposal,
    critique: ClaimCritique,
    round: number,
    { deps }: StepDeps,
): Promise<StepResult<{ verdict: ClaimVerdict; support: ClaimSupport }>> {
    const prompt = [
        `Re-verify the ${row.organ} liability claim about ${dossier.entity.symbol}.`,
        "",
        "Proposed mechanism:",
        mechanism.statement,
        "",
        "Objection raised against it:",
        critique.objection,
        "",
        "Counter-evidence offered with the objection:",
        JSON.stringify(critique.support, null, 2),
        "",
        "Evidence the assessment collected for this organ:",
        claimContext(row, dossier),
    ].join("\n");

    const result = await structuredLlmCall({
        ...(deps.logger ? { logger: deps.logger } : {}),
        stepName: `ta-investigate:reverify:${row.organ}:${deps.attempt}:${round}`,
        agentId: VERIFIER_AGENT_ID,
        provider: deps.chatProvider,
        session: forSubAgent(deps.session, VERIFIER_AGENT_ID),
        system: composeSystemPrompt(claimReverificationBrief),
        prompt,
        schema: ReverificationOutputSchema,
        model: deps.model,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    if (result.kind === "budget-exceeded") return result;
    return { kind: "ok", value: { verdict: result.value.verdict, support: resolveSupport(result.value.support) } };
}

// ── One claim, to convergence ────────────────────────────────────────

type ClaimOutcome =
    | { readonly kind: "investigated"; readonly row: InvestigatedClaimRow }
    | { readonly kind: "unavailable"; readonly organ: OrganSystem; readonly detail: string }
    | BudgetExceeded;

/**
 * Investigate one organ claim to convergence.
 *
 * The loop stops on the first of three conditions: a terminal verdict, a verdict
 * that repeats the previous round's, or the configured round bound. Critiques
 * are keyed by organ, so a later round's objection replaces the earlier one it
 * was written in answer to.
 */
async function investigateOneClaim(row: OrganCorroborationRow, dossier: DossierBody, stepDeps: StepDeps): Promise<ClaimOutcome> {
    const logger = (stepDeps.deps.logger ?? createNoopLogger()).named("ta-claim-investigation").with({ organ: row.organ });

    let mechanism: MechanismProposal | null = null;
    let critique: ClaimCritique | null = null;
    let verdict: ClaimVerdict | null = null;
    let previousVerdict: ClaimVerdict | null = null;
    let support: ClaimSupport = { state: "unknown", reason: "the investigation recorded no verdict support" };
    let convergence: InvestigationConvergence = "round_bound_reached";
    let roundsRun = 0;

    for (let round = 1; round <= stepDeps.config.roundBound; round += 1) {
        roundsRun = round;

        let proposed: StepResult<MechanismProposal | null>;
        try {
            proposed = await proposeMechanism(row, dossier, round, critique?.objection ?? null, stepDeps);
        } catch (err) {
            logger.warn("mechanism proposal failed", { round, ...logger.errorFields(err) });
            return { kind: "unavailable", organ: row.organ, detail: `mechanism proposal failed: ${messageOf(err)}` };
        }
        if (proposed.kind === "budget-exceeded") return proposed;
        if (proposed.value === null) {
            return { kind: "unavailable", organ: row.organ, detail: "no mechanism was proposable from the evidence collected for this organ" };
        }
        mechanism = proposed.value;

        let rounded: ClaimCritique | null;
        try {
            rounded = await critiqueClaim(row, dossier, mechanism, round, stepDeps);
        } catch (err) {
            logger.warn("adversarial critique failed", { round, ...logger.errorFields(err) });
            return { kind: "unavailable", organ: row.organ, detail: `adversarial critique failed: ${messageOf(err)}` };
        }
        if (rounded === null) {
            // A verdict reached without the adversarial step is the rubber stamp
            // this phase exists to avoid, so the claim goes uninvestigated rather
            // than acquiring an unchallenged verdict.
            return { kind: "unavailable", organ: row.organ, detail: "the adversarial critic recorded no objection" };
        }
        critique = rounded;

        let verified: StepResult<{ verdict: ClaimVerdict; support: ClaimSupport }>;
        try {
            verified = await reverifyClaim(row, dossier, mechanism, critique, round, stepDeps);
        } catch (err) {
            logger.warn("re-verification failed", { round, ...logger.errorFields(err) });
            return { kind: "unavailable", organ: row.organ, detail: `re-verification failed: ${messageOf(err)}` };
        }
        if (verified.kind === "budget-exceeded") return verified;

        verdict = verified.value.verdict;
        support = verified.value.support;

        if (verdict === "upheld" || verdict === "overturned") {
            convergence = "verdict_terminal";
            break;
        }
        if (verdict === previousVerdict) {
            convergence = "verdict_settled";
            break;
        }
        previousVerdict = verdict;
    }

    if (verdict === null || mechanism === null) {
        return { kind: "unavailable", organ: row.organ, detail: "the investigation completed no round" };
    }

    return {
        kind: "investigated",
        row: {
            organ: row.organ,
            mechanism,
            critique,
            verdict,
            rounds_run: roundsRun,
            convergence,
            support,
        },
    };
}

function messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ── The phase ────────────────────────────────────────────────────────

/**
 * Interrogate the run's corroborated organ claims.
 *
 * Coverage is the honest account of what happened: `not_loaded` when there was
 * no corroboration record to work from, `queried_no_data` when the fold produced
 * no corroborated organ, and `available` once at least one candidate reached the
 * phase — including when every one of them ended up in `not_investigated`, since
 * that list is what the section has to say in that case.
 */
export async function investigateClaims(input: ClaimInvestigationInput, deps: ClaimInvestigationDeps): Promise<ClaimInvestigationResult> {
    const config: ClaimInvestigationConfig = { ...DEFAULT_CLAIM_INVESTIGATION_CONFIG, ...deps.config };
    const bounds = { round_bound: config.roundBound, claim_budget: config.claimBudget };

    if (input.corroboration.coverage === "not_loaded") {
        return { coverage: "not_loaded", reason: "no corroboration record was assembled for this run" };
    }

    const candidates: readonly OrganCorroborationRow[] = input.corroboration.coverage === "available" ? input.corroboration.data.rows : [];
    if (candidates.length === 0) {
        return { coverage: "queried_no_data", error: { message: "no corroborated organ claim reached the investigation" } };
    }

    const admitted = candidates.slice(0, config.claimBudget);
    const notInvestigated: UninvestigatedClaim[] = candidates.slice(config.claimBudget).map((row) => ({
        organ: row.organ,
        reason: "exceeded_claim_budget" as const,
        detail: `the run investigates at most ${config.claimBudget} corroborated claims; this one ranked below that`,
    }));

    // Organs the assessment's own per-organ risk read carries, which the
    // corroboration fold never admitted. They are candidates a reader would
    // expect to see interrogated, so their absence is stated rather than left
    // to be noticed.
    const corroboratedOrgans = new Set(candidates.map((r) => r.organ));
    const rollup = input.dossier.safety_profile.organ_rollup;
    if (rollup.coverage === "available") {
        for (const rollupRow of rollup.data.rows) {
            if (corroboratedOrgans.has(rollupRow.organ)) continue;
            notInvestigated.push({
                organ: rollupRow.organ,
                reason: "not_corroborated",
                detail: "the per-organ risk rollup carries this organ, but fewer independent sources corroborated it than the fold requires",
            });
        }
    }

    const outcomes = await Promise.all(admitted.map((row) => investigateOneClaim(row, input.dossier, { deps, config })));

    const cancelled = outcomes.find(isBudgetCancel);
    if (cancelled) return cancelled;

    const rows: InvestigatedClaimRow[] = [];
    for (const outcome of outcomes) {
        if (outcome.kind === "investigated") rows.push(outcome.row);
        else if (outcome.kind === "unavailable") {
            notInvestigated.push({ organ: outcome.organ, reason: "investigation_unavailable", detail: outcome.detail });
        }
    }

    rows.sort((a, b) => a.organ.localeCompare(b.organ));
    notInvestigated.sort((a, b) => a.organ.localeCompare(b.organ) || a.reason.localeCompare(b.reason));

    const droppedByBudget = candidates.length - admitted.length;
    return {
        coverage: "available",
        data: { rows, not_investigated: notInvestigated, ...bounds },
        ...(droppedByBudget > 0 ? { dropped_count: droppedByBudget } : {}),
    };
}

export { isBudgetCancel as isClaimInvestigationBudgetExceeded };
