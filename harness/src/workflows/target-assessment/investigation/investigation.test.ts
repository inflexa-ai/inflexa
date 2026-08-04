/**
 * Claim-investigation phase tests.
 *
 * The LLM steps run through `structuredLlmCall`, which owns a durable step, so
 * the suite needs a launched DBOS engine. The provider is scripted per call so
 * a test states the model's answers and asserts on the record the phase builds
 * out of them — state, not interactions.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import type { DossierBody, SafetyCorroboration } from "../../../contracts/target-dossier.js";
import { ClaimInvestigationSchema } from "../../../contracts/target-dossier.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import { passthroughStep } from "../../../loop/run-step.js";
import type { AgentChat, ChatRequest } from "../../../providers/types.js";
import { withDbos } from "../../../__tests__/setup/dbos.js";
import { investigateClaims, type ClaimInvestigationDeps } from "./index.js";

// ── Scripted provider ────────────────────────────────────────────────

interface Script {
    /** Mechanism statement, or null for "no mechanism proposable". */
    readonly mechanism: string | null;
    /** Evidence the proposer offers. An empty array means it claims no support. */
    readonly mechanismEvidence?: ReadonlyArray<Record<string, unknown>>;
    /** Objection the critic records, or null to have it never call the recorder. */
    readonly objection: string | null;
    /** One verdict per round, consumed in order; the last repeats if rounds outrun it. */
    readonly verdicts: readonly string[];
    /** Evidence the re-verifier offers for its verdict. */
    readonly verdictEvidence?: ReadonlyArray<Record<string, unknown>>;
}

function firstUserText(req: ChatRequest): string {
    const content = req.messages[0]?.content;
    return typeof content === "string" ? content : JSON.stringify(content);
}

function toolCall(toolName: string, input: unknown) {
    return okAsync({
        message: { role: "assistant" as const, content: [{ type: "tool-call", toolCallId: `c-${Math.random()}`, toolName, input }] },
        finishReason: "tool-calls" as const,
    });
}

function scriptedProvider(script: Script): AgentChat {
    let reverifyCalls = 0;
    return {
        capabilities: { toolCalling: true },
        chat: (req: ChatRequest) => {
            const forcedSubmit = req.toolChoice !== undefined && typeof req.toolChoice === "object" && "toolName" in req.toolChoice;
            if (!forcedSubmit) {
                // The critic's agent loop.
                if (script.objection === null) {
                    return okAsync({ message: { role: "assistant" as const, content: "I could not build a case." }, finishReason: "stop" as const });
                }
                return toolCall("record_critique", {
                    objection: script.objection,
                    support: { state: "unknown", reason: "no disconfirming record retrieved" },
                });
            }
            const prompt = firstUserText(req);
            if (prompt.startsWith("Propose a mechanism")) {
                const evidence = script.mechanismEvidence ?? [{ source: "pubmed", pmid: "11111111" }];
                return toolCall("submit", {
                    mechanism: script.mechanism,
                    support: evidence.length > 0 ? { state: "scored", evidence } : { state: "unknown", reason: "no supporting record" },
                });
            }
            const verdict = script.verdicts[Math.min(reverifyCalls, script.verdicts.length - 1)]!;
            reverifyCalls += 1;
            const evidence = script.verdictEvidence ?? [{ source: "pubmed", pmid: "22222222" }];
            return toolCall("submit", {
                verdict,
                support: evidence.length > 0 ? { state: "scored", evidence } : { state: "unknown", reason: "the record settles nothing" },
            });
        },
    } as unknown as AgentChat;
}

// ── Fixtures ─────────────────────────────────────────────────────────

function corroborationRow(organ: string, sources: readonly string[]) {
    return {
        organ,
        contributions: sources.map((s) => ({
            source: s,
            signal: `${s} raised a ${organ} signal`,
            evidence: { source: s, accession: `ACC-${s}` },
        })),
        corroborating_sources: [...sources],
        independent_source_count: sources.length,
        support: { state: "scored" as const, evidence: sources.map((s) => ({ source: s, accession: `ACC-${s}` })) },
    };
}

function corroborationAvailable(rows: ReadonlyArray<ReturnType<typeof corroborationRow>>): SafetyCorroboration {
    return {
        coverage: "available",
        data: { rows: [...rows], sources_considered: ["impc", "monarch"], min_independent_sources: 2 },
    } as unknown as SafetyCorroboration;
}

/** Only the two fields the phase reads; the rest of the body is irrelevant here. */
function dossierWithRollupOrgans(organs: readonly string[]): DossierBody {
    return {
        entity: { symbol: "TARGET1" },
        safety_profile: {
            organ_rollup: {
                coverage: "available",
                data: { rows: organs.map((organ) => ({ organ, risk_level: "medium" })) },
            },
        },
    } as unknown as DossierBody;
}

let baseDeps: Omit<ClaimInvestigationDeps, "chatProvider">;

beforeAll(async () => {
    await withDbos("claim-investigation");
    baseDeps = {
        session: makeSession({ agentId: "ta-claim-investigation" }),
        model: "test-model",
        attempt: 0,
        runStep: passthroughStep,
        critiqueTools: [],
    };
});

function depsFor(script: Script, config?: ClaimInvestigationDeps["config"]): ClaimInvestigationDeps {
    return { ...baseDeps, chatProvider: scriptedProvider(script), ...(config ? { config } : {}) };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("coverage", () => {
    it("reports not_loaded when no corroboration record was assembled", async () => {
        const result = await investigateClaims(
            { corroboration: { coverage: "not_loaded", reason: "fold did not run" }, dossier: dossierWithRollupOrgans([]) },
            depsFor({ mechanism: "m", objection: "o", verdicts: ["upheld"] }),
        );
        expect(result).toMatchObject({ coverage: "not_loaded" });
    });

    it("reports queried_no_data when the fold admitted no corroborated organ", async () => {
        const result = await investigateClaims(
            { corroboration: { coverage: "filtered", filter: "below the source floor", dropped_count: 7 }, dossier: dossierWithRollupOrgans([]) },
            depsFor({ mechanism: "m", objection: "o", verdicts: ["upheld"] }),
        );
        expect(result).toMatchObject({ coverage: "queried_no_data" });
    });
});

describe("propose → critique → re-verify → converge", () => {
    it("records a terminal verdict on the first round and stops there", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("hepatic", ["impc", "monarch"])]), dossier: dossierWithRollupOrgans(["hepatic"]) },
            depsFor({ mechanism: "bile-salt export pump inhibition", objection: "both sources trace to one 2011 curation", verdicts: ["upheld"] }),
        );

        expect(ClaimInvestigationSchema.safeParse(result).success).toBe(true);
        expect(result).toMatchObject({
            coverage: "available",
            data: {
                round_bound: 2,
                claim_budget: 6,
                not_investigated: [],
                rows: [
                    {
                        organ: "hepatic",
                        verdict: "upheld",
                        rounds_run: 1,
                        convergence: "verdict_terminal",
                        mechanism: { statement: "bile-salt export pump inhibition" },
                        critique: { objection: "both sources trace to one 2011 curation" },
                    },
                ],
            },
        });
    });

    it("stops when a verdict repeats the previous round's", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("renal", ["impc", "monarch"])]), dossier: dossierWithRollupOrgans(["renal"]) },
            depsFor({ mechanism: "tubular accumulation", objection: "the model is a whole-body knockout", verdicts: ["weakened", "weakened"] }),
        );

        expect(result).toMatchObject({
            coverage: "available",
            data: { rows: [{ organ: "renal", verdict: "weakened", rounds_run: 2, convergence: "verdict_settled" }] },
        });
    });

    it("stops at the configured round bound when the verdict keeps moving", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("cardiac", ["impc", "fda_label"])]), dossier: dossierWithRollupOrgans(["cardiac"]) },
            depsFor({ mechanism: "hERG cross-reactivity", objection: "the signal is confounded by co-medication", verdicts: ["weakened", "undetermined"] }),
        );

        expect(result).toMatchObject({
            coverage: "available",
            data: { round_bound: 2, rows: [{ organ: "cardiac", verdict: "undetermined", rounds_run: 2, convergence: "round_bound_reached" }] },
        });
    });

    it("honours a supplied round bound and reports it", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("cns", ["impc", "monarch"])]), dossier: dossierWithRollupOrgans(["cns"]) },
            depsFor(
                { mechanism: "central receptor occupancy", objection: "expression is not consequence", verdicts: ["weakened", "undetermined", "weakened"] },
                { roundBound: 1 },
            ),
        );

        expect(result).toMatchObject({
            coverage: "available",
            data: { round_bound: 1, rows: [{ organ: "cns", rounds_run: 1, convergence: "round_bound_reached" }] },
        });
    });
});

describe("claim contract at the boundary", () => {
    it("resolves locator-less support to unknown rather than emitting it as scored", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("gi", ["impc", "monarch"])]), dossier: dossierWithRollupOrgans(["gi"]) },
            depsFor({
                mechanism: "enteric receptor engagement",
                mechanismEvidence: [{ source: "the literature" }],
                objection: "the finding is species-specific",
                verdicts: ["upheld"],
                verdictEvidence: [{ source: "general knowledge" }],
            }),
        );

        expect(ClaimInvestigationSchema.safeParse(result).success).toBe(true);
        expect(result).toMatchObject({
            coverage: "available",
            data: {
                rows: [
                    {
                        organ: "gi",
                        support: { state: "unknown" },
                        mechanism: { support: { state: "unknown" } },
                    },
                ],
            },
        });
    });

    it("keeps a scored claim's locator-bearing evidence", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("immune", ["impc", "monarch"])]), dossier: dossierWithRollupOrgans(["immune"]) },
            depsFor({ mechanism: "cytokine release", objection: "the cohort is small", verdicts: ["upheld"] }),
        );

        expect(result).toMatchObject({
            coverage: "available",
            data: { rows: [{ support: { state: "scored", evidence: [{ pmid: "22222222" }] } }] },
        });
    });
});

describe("completeness", () => {
    it("names the claims the budget cut and reports how many it dropped", async () => {
        const result = await investigateClaims(
            {
                corroboration: corroborationAvailable([corroborationRow("hepatic", ["impc", "monarch"]), corroborationRow("renal", ["impc", "fda_label"])]),
                dossier: dossierWithRollupOrgans(["hepatic", "renal"]),
            },
            depsFor({ mechanism: "m", objection: "o", verdicts: ["upheld"] }, { claimBudget: 1 }),
        );

        expect(result).toMatchObject({
            coverage: "available",
            dropped_count: 1,
            data: {
                claim_budget: 1,
                rows: [{ organ: "hepatic" }],
                not_investigated: [{ organ: "renal", reason: "exceeded_claim_budget" }],
            },
        });
    });

    it("names rollup organs the fold never corroborated", async () => {
        const result = await investigateClaims(
            {
                corroboration: corroborationAvailable([corroborationRow("hepatic", ["impc", "monarch"])]),
                dossier: dossierWithRollupOrgans(["hepatic", "ocular"]),
            },
            depsFor({ mechanism: "m", objection: "o", verdicts: ["upheld"] }),
        );

        expect(result).toMatchObject({
            coverage: "available",
            data: { not_investigated: [{ organ: "ocular", reason: "not_corroborated" }] },
        });
    });

    it("reports a claim whose critic recorded nothing as uninvestigated rather than verdicted", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("vascular", ["impc", "monarch"])]), dossier: dossierWithRollupOrgans(["vascular"]) },
            depsFor({ mechanism: "endothelial signalling", objection: null, verdicts: ["upheld"] }),
        );

        expect(result).toMatchObject({
            coverage: "available",
            data: { rows: [], not_investigated: [{ organ: "vascular", reason: "investigation_unavailable" }] },
        });
    });

    it("reports a claim with no proposable mechanism as uninvestigated", async () => {
        const result = await investigateClaims(
            { corroboration: corroborationAvailable([corroborationRow("pancreas", ["impc", "monarch"])]), dossier: dossierWithRollupOrgans(["pancreas"]) },
            depsFor({ mechanism: null, objection: "o", verdicts: ["upheld"] }),
        );

        expect(result).toMatchObject({
            coverage: "available",
            data: { rows: [], not_investigated: [{ organ: "pancreas", reason: "investigation_unavailable" }] },
        });
    });
});
