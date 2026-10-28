/**
 * The synthesis of a run in the body of its workflow, against the real engine.
 *
 * The synthesizer makes one lookup, then submits a synthesis that cites a PMID of that lookup. Then the index step of
 * the synthesis parks until the test cancels the workflow from outside, which is a crash after the model calls. The
 * resume returns each model call and the lookup from their checkpoints, folds the PMIDs of the lookup again, and runs
 * the index step again.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { z } from "zod";

import { recoverAtCrashPoint } from "../../../../__tests__/setup/dbos-crash.js";
import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { makeLocalAuth } from "../../../../auth/local-auth-context.js";
import type { RunSession } from "../../../../auth/types.js";
import { createWorkingMemory } from "../../../../memory/working-memory.js";
import type { EmbeddingProvider } from "../../../../providers/types.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../../../testing.js";
import { defineTool } from "../../../../tools/define-tool.js";
import { synthesizeFindings, type ExecuteAnalysisDeps } from "../../../execute-analysis.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" in workflow-replay.test.ts).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS_ID = "analysis-synthesis-1";

const toolNamesOf = (call: LanguageModelV4CallOptions): string[] => (call.tools ?? []).map((tool) => tool.name);
const isSynthesizer = (call: LanguageModelV4CallOptions): boolean => toolNamesOf(call).includes("submit_synthesis");

/** A synthesis of the step A that the checks of `submit_synthesis` accept. */
const SYNTHESIS = {
    overview: "A test run analyzed gene expression.",
    conclusions: "The analysis establishes a signature.",
    findings: [
        {
            stepId: "A",
            title: "Upregulation of FOXP3",
            description: "FOXP3 is upregulated.",
            confidence: "high",
            noveltyStatus: "confirmed",
            literatureInterpretation: "Consistent with prior reports.",
            references: [{ pmid: "12345678", citation: "Smith 2020", relevance: "directly supports", concordance: "supports" }],
        },
    ],
    themes: [{ name: "Regulatory program", findings: [{ stepId: "A", title: "Upregulation of FOXP3" }], narrative: "FOXP3 marks the program." }],
    limitations: ["Single cohort."],
    keyReferences: [{ pmid: "12345678", citation: "Smith 2020", description: "Established FOXP3." }],
};

// The synthesizer looks up once, then submits.
let synthesizerTurn = 0;
const answer: ScriptStep = (call) => {
    if (!isSynthesizer(call)) return reply([text("not the synthesizer")]);
    synthesizerTurn += 1;
    if (synthesizerTurn === 1) return callTools(toolCall("lk-1", "pubmed", { query: "FOXP3 regulatory T cells" }));
    if (synthesizerTurn === 2) return callTools(toolCall("tu-1", "submit_synthesis", { synthesis: SYNTHESIS }));
    return reply([text("done")]);
};
const model = scriptedModel(Array.from({ length: 3 }, () => answer));

/** A lookup that returns the PMID that the synthesis cites. It counts its runs, thus the test sees the replay. */
let lookupRuns = 0;
const pubmed = defineTool({
    id: "pubmed",
    description: "Search PubMed.",
    inputSchema: z.object({ query: z.string() }),
    describeCall: "none",
    execute: () => {
        lookupRuns += 1;
        return Promise.resolve(ok({ totalFound: 1, results: [{ pmid: "12345678", title: "FOXP3 in regulatory T cells" }] }));
    },
});

/**
 * The embedder of the index step. Its first call hangs until the cancel of its step, as a crash cuts it, and then
 * gives no vector. The synthesis logs a failed index and continues, and the cancel ends the execution at its next call
 * of the engine.
 */
let embedCalls = 0;
let embedParked = false;
let embedReleased = false;
const embedding: EmbeddingProvider = {
    dimensions: 3,
    embed: (texts) => {
        embedCalls += 1;
        if (embedCalls > 1) return okAsync(texts.map(() => [0, 0, 1]));
        embedParked = true;
        const cancel = DBOS.stepStatus?.cancelSignal;
        return ResultAsync.fromSafePromise(
            new Promise<number[][]>((resolve) => {
                cancel?.addEventListener(
                    "abort",
                    () => {
                        embedReleased = true;
                        resolve([]);
                    },
                    { once: true },
                );
            }),
        );
    },
};

let rig: DbosTestRig;
let base = "";

function deps(): ExecuteAnalysisDeps {
    return {
        pool: rig.pool,
        provider: model.provider,
        embedding,
        sandboxStepCallable: () => Promise.reject(new Error("the synthesis starts no sandbox step")),
        resolveWorkspaceRoot: (id: string) => Promise.resolve(join(base, id)),
        workingMemory: createWorkingMemory(rig.pool),
        synthesisModel: "test-model",
        synthesisLookups: [pubmed],
        runCharge: { open: () => okAsync(undefined), close: () => okAsync(undefined) },
        runAuthorizer: {
            authorize() {
                throw new Error("the synthesis authorizes no run");
            },
            revoke: () => okAsync(undefined),
            revokeByMandateId: () => okAsync(undefined),
            suspend: () => okAsync(undefined),
            renew: () => okAsync(undefined),
        },
    };
}

function runSession(runId: string): RunSession {
    return {
        identity: { user: "user-1" },
        scope: { kind: "analysis", analysisId: ANALYSIS_ID },
        provenance: { agentId: "run", callPath: ["run"] },
        runFrame: { runId },
        auth: makeLocalAuth(),
    };
}

const synthesisRun = DBOS.registerWorkflow(
    async (runId: string): Promise<string> => {
        const out = await synthesizeFindings({ analysisId: ANALYSIS_ID, runId, completedSteps: ["A"], session: runSession(runId), deps: deps() });
        return out.synthesisStatus;
    },
    { name: "synthesis-recovery-run" },
);

beforeAll(async () => {
    rig = await setupDbosForTests("synthesis_recovery");
    if (!DBOS.isInitialized()) await DBOS.launch();
    base = await mkdtemp(join(tmpdir(), "cortex-synthesis-recovery-"));
});

afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rig.drop();
});

describe("the synthesis of a run in the body of its workflow", () => {
    it("continues a crash after its model calls from the checkpoints, and the replay keeps the PMIDs of its lookup", async () => {
        const runId = rig.nextWorkflowId("synthesis-run-");
        const outputDir = join(base, ANALYSIS_ID, "runs", runId, "A", "output");
        await mkdir(outputDir, { recursive: true });
        await writeFile(join(outputDir, "summary.md"), "## results\n\nFOXP3 up.");

        const handle = await DBOS.startWorkflow(synthesisRun, { workflowID: runId })(runId);
        const ended = Promise.all([handle.getResult().catch(() => undefined), waitUntil(() => embedReleased)]);
        const resumed = await recoverAtCrashPoint<string>(runId, () => embedParked, { ended });

        expect(await resumed.getResult()).toBe("produced");
        // Three requests of the synthesizer and one lookup, each one time.
        expect(model.calls).toHaveLength(3);
        expect(lookupRuns).toBe(1);
        const stored = await readFile(join(base, ANALYSIS_ID, "runs", runId, "synthesis.json"), "utf8");
        expect(stored).toContain(SYNTHESIS.overview);
    });
});

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("the condition did not hold in time");
        await Bun.sleep(10);
    }
}
