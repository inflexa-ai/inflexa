/**
 * Unit tests for the `synthesizeRun` application-service function.
 *
 * The orchestration contract is the test surface: it drives the synthesizer,
 * indexes + persists, reports progress phases, and returns findings — or skips
 * honestly (no summaries / blocker) — or re-throws a genuine failure (D10).
 * The underlying pieces (`generateRunSynthesis`, `persistSynthesis`, …) are
 * tested in `execution/test/run-synthesis.test.ts`; here we assert the wiring.
 */

import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Querier } from "../../state/db.js";

import { okAsync } from "neverthrow";

import { defaultErrorFields, type LogFields, type LogLevel, type Logger } from "../../lib/logger.js";
import { presentFirst } from "../../lib/present.js";
import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import type { SynthesisDraft } from "../../schemas/run-synthesis.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RunSession } from "../../auth/types.js";
import type { EmitFn } from "../../loop/types.js";
import type { BioToolKeys } from "../../tools/bio/keys.js";
import { synthesizeRun, type SynthesizeRunDeps, type SynthesisProgressExtra } from "../synthesize-run.js";
import { unusedCitationResolver } from "../../citations/__fixtures__/resolver.js";

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
function emptyPool(): Querier {
    return {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
    };
}

/** A valid synthesis payload (schema + semantic checks); mirrors run-synthesis.test. */
function validSynthesisPayload(): SynthesisDraft {
    return {
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

/** One record captured by the test logger — the emitted diagnostic, as state. */
type LoggedRecord = {
    readonly level: LogLevel;
    readonly msg: string;
    readonly fields: LogFields;
};

/**
 * A `Logger` that appends every record to `sink`, so a test asserts on the
 * diagnostics the code actually emitted (loud skips) rather than on call counts.
 */
function makeCapturingLogger(sink: LoggedRecord[], bindings: LogFields = {}): Logger {
    const emit =
        (level: LogLevel) =>
        (msg: string, fields?: LogFields): void => {
            sink.push({ level, msg, fields: { ...bindings, ...fields } });
        };
    return {
        debug: emit("debug"),
        info: emit("info"),
        warn: emit("warn"),
        error: emit("error"),
        with: (extra) => makeCapturingLogger(sink, { ...bindings, ...extra }),
        named: () => makeCapturingLogger(sink, bindings),
        errorFields: defaultErrorFields,
    };
}

type Harness = {
    deps: SynthesizeRunDeps;
    embedderCalls: number;
    logs: LoggedRecord[];
    cleanup: () => Promise<void>;
};

async function makeHarness(provider: SynthesizeRunDeps["provider"], opts: { withSummary: boolean }): Promise<Harness> {
    const base = await mkdtemp(join(tmpdir(), "cortex-synthrun-"));
    if (opts.withSummary) {
        const outDir = join(base, ANALYSIS_ID, "runs", RUN_ID, STEP_ID, "output");
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "summary.md"), "## results\n\nFOXP3 up.");
    }
    let embedderCalls = 0;
    const embedding: SynthesizeRunDeps["embedding"] = {
        dimensions: 1536,
        embed: (texts) => {
            embedderCalls++;
            return okAsync(texts.map(() => new Array<number>(1536).fill(0.01)));
        },
    };
    const logs: LoggedRecord[] = [];
    return {
        deps: {
            logger: makeCapturingLogger(logs),
            pool: emptyPool(),
            provider,
            embedding,
            resolveWorkspaceRoot: (id) => Promise.resolve(join(base, id)),
            synthesisModel: "claude-test",
            bioKeys: BIO_KEYS,
            citationResolver: unusedCitationResolver,
        },
        get embedderCalls() {
            return embedderCalls;
        },
        logs,
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
    it("returns no findings and reports skipped_no_summaries with a warn when there are no step summaries", async () => {
        const model = scriptedModel([]);
        const h = await makeHarness(model.provider, { withSummary: false });
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
            expect(result.synthesisStatus).toBe("skipped_no_summaries");
            expect(result.synthesisReason).toBe("no-summaries");
            expect(phases).toEqual(["starting", "skipped"]);
            // The skip is logged loudly, carrying the run id + reason as fields.
            const warn = h.logs.find((r) => r.level === "warn");
            expect(warn?.fields).toMatchObject({ runId: RUN_ID, reason: "no-summaries" });
            // The synthesizer loop never ran.
            expect(model.calls.length).toBe(0);
            expect(h.embedderCalls).toBe(0);
        } finally {
            await h.cleanup();
        }
    });

    it("drives the synthesizer, persists synthesis.json, and returns findings", async () => {
        const model = scriptedModel([callTools(toolCall("tu-1", "submit_synthesis", { synthesis: validSynthesisPayload() })), reply([text("done")])]);
        const h = await makeHarness(model.provider, { withSummary: true });
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
            expect(result.synthesisStatus).toBe("produced");
            expect(result.synthesisReason).toBeNull();
            expect(phases).toEqual(["starting", "indexing", "persisting", "complete"]);
            expect(h.embedderCalls).toBe(1);
            // The produced path does not warn.
            expect(h.logs.some((r) => r.level === "warn")).toBe(false);
            // The final run-synthesis chat part was emitted.
            expect(emitted.some((e) => parseUnknownRecord(e)?.type === "data-run-synthesis")).toBe(true);
            // synthesis.json was written under the run directory.
            const path = join(await h.deps.resolveWorkspaceRoot(ANALYSIS_ID), "runs", RUN_ID, "synthesis.json");
            expect((await stat(path)).isFile()).toBe(true);
        } finally {
            await h.cleanup();
        }
    });

    it("returns skipped_blocker with the reason and a warn, writing no synthesis.json, when the synthesizer reports a blocker", async () => {
        const BLOCKER_REASON = "all step summaries were empty";
        const model = scriptedModel([callTools(toolCall("tu-1", "report_blocker", { reason: BLOCKER_REASON })), reply([text("done")])]);
        const h = await makeHarness(model.provider, { withSummary: true });
        const { phases, onProgress } = captureProgress();
        try {
            const result = await synthesizeRun(h.deps, {
                analysisId: ANALYSIS_ID,
                runId: RUN_ID,
                completedSteps: [STEP_ID],
                session: makeRunSession(),
                emit: () => {},
                onProgress,
            });

            expect(result.findings).toEqual([]);
            expect(result.synthesisStatus).toBe("skipped_blocker");
            expect(result.synthesisReason).toBe(BLOCKER_REASON);
            expect(phases).toEqual(["starting", "skipped"]);
            // The blocker is logged loudly, carrying the run id + blocker reason as fields.
            const warn = h.logs.find((r) => r.level === "warn");
            expect(warn?.fields).toMatchObject({ runId: RUN_ID, reason: BLOCKER_REASON });
            // A blocker writes no synthesis result to disk.
            const path = join(await h.deps.resolveWorkspaceRoot(ANALYSIS_ID), "runs", RUN_ID, "synthesis.json");
            await expect(stat(path)).rejects.toThrow();
        } finally {
            await h.cleanup();
        }
    });

    it("skips on a blocker that follows a rejected submission, writing nothing", async () => {
        const bad = validSynthesisPayload();
        presentFirst(bad.findings).stepId = "UNKNOWN";
        const model = scriptedModel([
            callTools(toolCall("tu-0", "submit_synthesis", { synthesis: bad })),
            callTools(toolCall("tu-b", "report_blocker", { reason: "cannot reconcile references" })),
            reply([text("done")]),
        ]);
        const h = await makeHarness(model.provider, { withSummary: true });
        const records: { phase: string; extra: SynthesisProgressExtra | Record<string, unknown> }[] = [];
        try {
            const result = await synthesizeRun(h.deps, {
                analysisId: ANALYSIS_ID,
                runId: RUN_ID,
                completedSteps: [STEP_ID],
                session: makeRunSession(),
                emit: () => {},
                onProgress: (phase, _activity, extra = {}) => {
                    records.push({ phase, extra });
                },
            });

            expect(result.synthesisStatus).toBe("skipped_blocker");
            // A rejected submission latches nothing: the blocker still ends the run as a skip.
            const skip = records.find((r) => r.phase === "skipped");
            expect(skip?.extra.reason).toBe("cannot reconcile references");
            const warn = h.logs.find((r) => r.level === "warn");
            expect(warn?.fields).toMatchObject({ runId: RUN_ID, reason: "cannot reconcile references" });
        } finally {
            await h.cleanup();
        }
    });

    it("reports failed and re-throws when synthesis cannot reach a terminal tool (D10)", async () => {
        // Plain prose only — the synthesizer never calls a terminal tool, so
        // generateRunSynthesis throws after the salvage request.
        const model = scriptedModel([reply([text("just thinking")]), reply([text("just thinking")])]);
        const h = await makeHarness(model.provider, { withSummary: true });
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
            ).rejects.toThrow("terminal tool call");
            expect(phases.at(0)).toBe("starting");
            expect(phases.at(-1)).toBe("failed");
        } finally {
            await h.cleanup();
        }
    });
});
