/**
 * Unit tests for the `synthesizeRun` application-service function.
 *
 * The orchestration contract is the test surface: it drives the synthesizer,
 * indexes + persists, reports progress phases, and returns findings — or skips
 * honestly (no summaries / blocker) — or re-throws a genuine failure (D10).
 * The underlying pieces (`generateRunSynthesis`, `persistSynthesis`, …) are
 * tested in `execution/run-synthesis.test.ts`; here we assert the wiring.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";

import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunSession } from "../auth/types.js";
import type { EmitFn } from "../loop/types.js";
import type { BioToolKeys } from "../tools/bio/keys.js";
import { synthesizeRun, type SynthesisEmbedder, type SynthesizeRunDeps } from "./synthesize-run.js";

const ANALYSIS_ID = "analysis-001";
const RUN_ID = "run-001";
const STEP_ID = "T1S1";
const BIO_KEYS: BioToolKeys = { drugbank: "", disgenet: "", epaCcte: "" };

function makeRunSession(): RunSession {
    return {
        identity: { user: "user-001" },
        scope: { kind: "analysis", analysisId: ANALYSIS_ID },
        provenance: { agentId: "run-synthesizer", callPath: ["run-synthesizer"] },
        runFrame: { runId: RUN_ID },
        auth: makeLocalAuth(),
    };
}

/** A pool stub that returns no rows — `queryRun` → null → empty narrative. */
function emptyPool(): Pool {
    return {
        query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as Pool;
}

/** A valid synthesis payload (schema + semantic checks); mirrors run-synthesis.test. */
function validSynthesisPayload(): unknown {
    return {
        runId: RUN_ID,
        overview: "A test run analyzed gene expression in T-cells.",
        conclusions: "The analysis establishes a novel signature.",
        findings: [
            {
                stepId: STEP_ID,
                title: "Upregulation of FOXP3",
                description: "FOXP3 is upregulated in stimulated cells.",
                confidence: "high",
                noveltyStatus: "confirmed",
                literatureInterpretation: "Consistent with prior reports.",
                references: [
                    {
                        pmid: "12345678",
                        citation: "Smith 2020",
                        relevance: "directly supports",
                        concordance: "supports",
                    },
                ],
            },
        ],
        themes: [
            {
                name: "Regulatory T-cell program",
                findings: [{ stepId: STEP_ID, title: "Upregulation of FOXP3" }],
                narrative: "FOXP3 expression marks the regulatory program.",
            },
        ],
        limitations: ["Single cohort; n=24."],
        keyReferences: [
            {
                pmid: "12345678",
                citation: "Smith 2020",
                description: "Established FOXP3 as the master regulator.",
            },
        ],
    };
}

interface Harness {
    deps: SynthesizeRunDeps;
    embedderCalls: number;
    cleanup: () => Promise<void>;
}

async function makeHarness(provider: SynthesizeRunDeps["provider"], opts: { withSummary: boolean }): Promise<Harness> {
    const base = await mkdtemp(join(tmpdir(), "cortex-synthrun-"));
    if (opts.withSummary) {
        const outDir = join(base, ANALYSIS_ID, "runs", RUN_ID, STEP_ID, "output");
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "summary.md"), "## results\n\nFOXP3 up.");
    }
    let embedderCalls = 0;
    const embedder: SynthesisEmbedder = async () => {
        embedderCalls++;
        return new Array(1536).fill(0.01);
    };
    return {
        deps: {
            pool: emptyPool(),
            provider,
            embedder,
            sessionsBasePath: base,
            synthesisModel: "claude-test",
            bioKeys: BIO_KEYS,
        },
        get embedderCalls() {
            return embedderCalls;
        },
        cleanup: () => rm(base, { recursive: true, force: true }),
    };
}

function captureProgress(): {
    phases: string[];
    onProgress: NonNullable<Parameters<typeof synthesizeRun>[1]>["onProgress"];
} {
    const phases: string[] = [];
    return {
        phases,
        onProgress: (phase) => {
            phases.push(phase);
        },
    };
}

describe("synthesizeRun", () => {
    it("returns no findings and reports skipped when there are no step summaries", async () => {
        const provider = scriptedProvider([]);
        const h = await makeHarness(provider, { withSummary: false });
        const { phases, onProgress } = captureProgress();
        try {
            const result = await synthesizeRun(h.deps, {
                analysisId: ANALYSIS_ID,
                runId: RUN_ID,
                completedSteps: ["nope"],
                session: makeRunSession(),
                emit: () => {},
                onProgress,
            });
            expect(result.findings).toEqual([]);
            expect(phases).toEqual(["starting", "skipped"]);
            // The synthesizer loop never ran.
            expect(provider.calls.length).toBe(0);
            expect(h.embedderCalls).toBe(0);
        } finally {
            await h.cleanup();
        }
    });

    it("drives the synthesizer, persists synthesis.json, and returns findings", async () => {
        const provider = scriptedProvider((i) =>
            i === 0
                ? makeMessage(
                      [
                          toolUseBlock("tu-1", "submit_synthesis", {
                              synthesis: validSynthesisPayload(),
                          }),
                      ],
                      "tool_use",
                  )
                : makeMessage([textBlock("done")], "end_turn"),
        );
        const h = await makeHarness(provider, { withSummary: true });
        const { phases, onProgress } = captureProgress();
        const emitted: unknown[] = [];
        const emit: EmitFn = (e) => {
            emitted.push(e);
        };
        try {
            const result = await synthesizeRun(h.deps, {
                analysisId: ANALYSIS_ID,
                runId: RUN_ID,
                completedSteps: [STEP_ID],
                session: makeRunSession(),
                emit,
                onProgress,
            });

            expect(result.findings).toEqual([{ title: "Upregulation of FOXP3", confidence: "high" }]);
            expect(phases).toEqual(["starting", "indexing", "persisting", "complete"]);
            expect(h.embedderCalls).toBe(1);
            // The final run-synthesis chat part was emitted.
            expect(emitted.some((e) => typeof e === "object" && e !== null && (e as { type?: string }).type === "data-run-synthesis")).toBe(true);
            // synthesis.json was written under the run directory.
            const path = join(h.deps.sessionsBasePath, ANALYSIS_ID, "runs", RUN_ID, "synthesis.json");
            expect((await stat(path)).isFile()).toBe(true);
        } finally {
            await h.cleanup();
        }
    });

    it("reports failed and re-throws when synthesis cannot reach a terminal tool (D10)", async () => {
        // Plain prose only — the synthesizer never calls a terminal tool, so
        // generateRunSynthesis throws after the corrective re-prompt.
        const provider = scriptedProvider(() => makeMessage([textBlock("just thinking")], "end_turn"));
        const h = await makeHarness(provider, { withSummary: true });
        const { phases, onProgress } = captureProgress();
        try {
            await expect(
                synthesizeRun(h.deps, {
                    analysisId: ANALYSIS_ID,
                    runId: RUN_ID,
                    completedSteps: [STEP_ID],
                    session: makeRunSession(),
                    emit: () => {},
                    onProgress,
                }),
            ).rejects.toThrow(/terminal tool call/);
            expect(phases.at(0)).toBe("starting");
            expect(phases.at(-1)).toBe("failed");
        } finally {
            await h.cleanup();
        }
    });
});
