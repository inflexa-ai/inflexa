/**
 * Phase-2 decision functions for the harness DBOS workflow.
 *
 * `modulatorTriage` selects up to 8 ChEMBL modulators for downstream
 * fan-out; `drugsInClass` identifies clinically-advanced drugs in the
 * class. Both are single-shot, structured-output LLM calls — no tools,
 * no multi-step reasoning. Each function is `(input, deps) => Promise<CoverageEnvelope<...>>`.
 *
 * Coverage envelope is the failure mode: an LLM throw (non-402) → the
 * function returns `coverage: "queried_no_data"`. A billing-gateway 402 reaches
 * here as a `RunLlmStepResult` with `kind: "budget-exceeded"`; the caller
 * stops scheduling because the workflow has self-cancelled.
 */

import { z } from "zod";

import { drugsInClassPrompt } from "../../../prompts/target-assessment/drugs-in-class.js";
import { modulatorTriagePrompt } from "../../../prompts/target-assessment/modulator-triage.js";
import { dedupModulatorsByParent } from "../lib/dedup-modulators.js";

import type { AgentSession } from "../../../auth/types.js";
import type { AgentChat } from "../../../providers/types.js";
import type { Phase1Bundle } from "../schemas.js";

import { BUDGET_EXCEEDED_SENTINEL, type RunLlmStepResult } from "../lib/llm-step.js";
import { structuredLlmCall } from "../lib/structured-llm.js";

// ── Output schemas ────────────────────────────────────────────────────

export const ModulatorTriageOutputSchema = z.object({
    shortlist: z.array(
        z.object({
            moleculeChemblId: z.string(),
            preferredName: z.string(),
            maxPhase: z.number().nullable(),
            firstApproval: z.number().nullable(),
            rationale: z.string(),
        }),
    ),
    notes: z.string(),
    dropped_synonyms: z
        .array(
            z.object({
                chemblId: z.string(),
                reason: z.enum(["same_active_substance", "ambiguous_name_synonym"]),
                keptId: z.string().nullable(),
            }),
        )
        .default([]),
});
export type ModulatorTriageOutput = z.infer<typeof ModulatorTriageOutputSchema>;

export const DrugsInClassOutputSchema = z.object({
    drugs: z.array(
        z.object({
            moleculeChemblId: z.string(),
            preferredName: z.string(),
            maxPhase: z.number().nullable(),
            firstApproval: z.number().nullable(),
            moleculeType: z.string().nullable(),
            sources: z.array(z.enum(["chembl", "dgidb", "drugbank"])),
        }),
    ),
    total: z.number(),
    truncated: z.boolean(),
});
export type DrugsInClassOutput = z.infer<typeof DrugsInClassOutputSchema>;

// ── Coverage envelope shape ──────────────────────────────────────────

interface CoverageAvailable<T> {
    readonly coverage: "available";
    readonly data: T;
}
interface CoverageQueriedNoData {
    readonly coverage: "queried_no_data";
    readonly error?: { message: string };
}
type CoverageEnvelope<T> = CoverageAvailable<T> | CoverageQueriedNoData;

// ── Dep bundle ───────────────────────────────────────────────────────

export interface DecisionAgentDeps {
    readonly chatProvider: AgentChat;
    readonly session: AgentSession;
    /** Billing-gateway model id — e.g. `env.TARGET_ASSESSMENT_DECISION_MODEL`. */
    readonly model: string;
    /** Attempt counter — bumped on resume so a 402-cancelled call lands a fresh DBOS step slot. */
    readonly attempt: number;
}

function fail(message: string): CoverageQueriedNoData {
    return { coverage: "queried_no_data", error: { message } };
}
function failFromErr(err: unknown): CoverageQueriedNoData {
    return fail(err instanceof Error ? err.message : String(err));
}

// ── modulator-triage ─────────────────────────────────────────────────

export type ModulatorTriageResult =
    | CoverageEnvelope<ModulatorTriageOutput & { dropped_synonyms?: unknown }>
    | { readonly kind: "budget-exceeded"; readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL };

export async function modulatorTriage(input: Phase1Bundle, deps: DecisionAgentDeps): Promise<ModulatorTriageResult> {
    const modulators = input.collectors.chemblModulators;
    if (modulators.coverage !== "available" || modulators.data.modulators.length === 0) {
        return fail("no modulators to triage");
    }
    const { kept, dropped } = dedupModulatorsByParent(modulators.data.modulators);
    if (kept.length === 0) {
        return fail("no modulators after dedup");
    }

    const prompt = [
        `Target: ${input.resolved.geneSymbol} (${input.resolved.canonicalId})`,
        `ChEMBL target id: ${modulators.data.targetChemblId ?? "unknown"}`,
        ``,
        `Modulators (${kept.length}, deduped from ${modulators.data.modulators.length}):`,
        JSON.stringify(kept, null, 2),
    ].join("\n");

    try {
        const result: RunLlmStepResult | { kind: "budget-exceeded"; sentinel: typeof BUDGET_EXCEEDED_SENTINEL } | { kind: "ok"; value: ModulatorTriageOutput } =
            await structuredLlmCall<typeof ModulatorTriageOutputSchema>({
                stepName: `ta-decision:modulator-triage:${deps.attempt}`,
                agentId: "modulator-triage",
                provider: deps.chatProvider,
                session: deps.session,
                system: modulatorTriagePrompt,
                prompt,
                schema: ModulatorTriageOutputSchema,
                model: deps.model,
            });

        if (result.kind === "budget-exceeded") {
            return { kind: "budget-exceeded", sentinel: result.sentinel };
        }
        return {
            coverage: "available",
            data: { ...result.value, dropped_synonyms: dropped },
        };
    } catch (err) {
        return failFromErr(err);
    }
}

// ── drugs-in-class ───────────────────────────────────────────────────

export type DrugsInClassResult =
    CoverageEnvelope<DrugsInClassOutput> | { readonly kind: "budget-exceeded"; readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL };

export async function drugsInClass(input: Phase1Bundle, deps: DecisionAgentDeps): Promise<DrugsInClassResult> {
    const modulators = input.collectors.chemblModulators;
    if (modulators.coverage !== "available" || modulators.data.modulators.length === 0) {
        return fail("no modulators in class");
    }
    const { kept } = dedupModulatorsByParent(modulators.data.modulators);
    if (kept.length === 0) {
        return fail("no modulators after dedup");
    }

    const prompt = [
        `Target: ${input.resolved.geneSymbol}`,
        `ChEMBL modulators (max_phase ≥ 2, deduped by active substance):`,
        JSON.stringify(kept, null, 2),
    ].join("\n");

    try {
        const result = await structuredLlmCall<typeof DrugsInClassOutputSchema>({
            stepName: `ta-decision:drugs-in-class:${deps.attempt}`,
            agentId: "drugs-in-class",
            provider: deps.chatProvider,
            session: deps.session,
            system: drugsInClassPrompt,
            prompt,
            schema: DrugsInClassOutputSchema,
            model: deps.model,
        });

        if (result.kind === "budget-exceeded") {
            return { kind: "budget-exceeded", sentinel: result.sentinel };
        }
        return { coverage: "available", data: result.value };
    } catch (err) {
        return failFromErr(err);
    }
}
