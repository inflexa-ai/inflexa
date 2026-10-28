/**
 * The body of the data profile, driven outside a workflow: a refused spawn
 * (data-profile-init spec), where the body cannot wait in a pause, the keys
 * of its usage records (llm-usage-accounting spec), and the submission that
 * the profile records.
 */

import { textOf } from "../../lib/unknown-text.js";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import { z } from "zod";

import { makeFakeSandboxClient } from "../../agents/sandbox/__fixtures__/deps.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RunSession } from "../../auth/types.js";
import type { Querier } from "../../state/db.js";
import type { LlmUsageRecord } from "../../billing/usage-recorder.js";
import { silentLogger } from "../../__tests__/setup/logger.js";
import { parseJsonAs } from "../../lib/parse-json.js";
import { unusedChatProvider } from "../../providers/__fixtures__/chat-provider.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxError } from "../../sandbox/sandbox-error.js";
import type { SandboxRef } from "../../sandbox/types.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../testing.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { runDataProfileBody, type DataProfileDeps } from "../data-profile.js";
import { presentAt } from "../../lib/present.js";

const ANALYSIS_ID = "an-profile";
const OTHER_ANALYSIS_ID = "an-profile-other";

const stagedInputs = [
    {
        fileId: "f1",
        mountName: "f1",
        key: "f1/counts.csv",
        fileName: "counts.csv",
        hash: "sha256:x",
        size: 30,
        mtimeMs: 1_780_000_000_000,
        relativePath: "inputs/f1/counts.csv",
    },
];

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "harness-profile-body-"));
    for (const analysisId of [ANALYSIS_ID, OTHER_ANALYSIS_ID]) {
        const inputDir = join(root, analysisId, "data", "inputs", "f1");
        await mkdir(inputDir, { recursive: true });
        await writeFile(join(inputDir, "counts.csv"), "gene,count\nTP53,7\nBRCA1,3\n");
    }
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function statementPool(): { pool: Querier; statements: Array<{ text: string; values: readonly unknown[] }> } {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool: Querier = {
        query: (textOrConfig, values) => {
            const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
            const configValues = typeof textOrConfig === "string" ? undefined : textOrConfig.values;
            statements.push({ text, values: configValues ?? values ?? [] });
            return Promise.resolve({ rows: [], rowCount: 0 });
        },
    };
    return { pool, statements };
}

function runSession(analysisId = ANALYSIS_ID): RunSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: "data-profiler", callPath: ["data-profiler"] },
        runFrame: { runId: "data-profile", stepId: "profile" },
        auth: makeLocalAuth(),
    };
}

function deps(pool: Querier, sandboxClient: SandboxClient, revoked: string[]): DataProfileDeps {
    return {
        logger: silentLogger,
        provider: unusedChatProvider(),
        pool,
        sandboxClient,
        workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)) }),
        resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)),
        model: "test-model",
        runAuthorizer: {
            authorize: () => {
                throw new Error("the body never authorizes");
            },
            revoke: (_runSession, reason) => {
                revoked.push(reason);
                return okAsync(undefined);
            },
            revokeByMandateId: () => okAsync(undefined),
            suspend: () => okAsync(undefined),
            renew: () => okAsync(undefined),
        },
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        embedding: { dimensions: 3, embed: (texts) => okAsync(texts.map(() => [0, 0, 0])) },
        skillsDir: root,
    };
}

/** A write of the status of the analysis, not of `data_profile_status`. */
function writesAnalysisStatus(text: string): boolean {
    return ["SET status", ", status ="].some((write) => text.includes(write));
}

describe("the data profile — a refused spawn", () => {
    for (const suspend of [true, false]) {
        it(`with suspend ${String(suspend)}, fails the row with the reason, revokes, starts no pause, and does not mark the analysis`, async () => {
            const { pool, statements } = statementPool();
            const revoked: string[] = [];
            const refusing = {
                ...makeFakeSandboxClient(),
                createSandbox: () => errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "account_frozen", suspend }),
            };

            await runDataProfileBody({ analysisId: ANALYSIS_ID, runSession: runSession(), stagedInputs }, deps(pool, refusing, revoked));

            const failed = statements.filter((q) => q.text.includes("data_profile_status = 'failed'"));
            expect(failed).toHaveLength(1);
            expect(textOf(presentAt(failed, 0).values.find((v) => typeof v === "string" && v.includes("account_frozen")))).toContain("account_frozen");
            expect(revoked).toEqual(["data-profile-failed"]);
            expect(statements.some((q) => q.text.includes("cortex_paused_work"))).toBe(false);
            expect(statements.some((q) => writesAnalysisStatus(q.text))).toBe(false);
        });
    }

    it("passes a cancel from DBOS through with no change, and runs no failure path", async () => {
        const { pool, statements } = statementPool();
        const revoked: string[] = [];
        const cancel = new DBOSErrors.DBOSWorkflowCancelledError("wf-profile");
        const cancelled = {
            ...makeFakeSandboxClient(),
            createSandbox: () => new ResultAsync<SandboxRef, SandboxError>(Promise.reject(cancel)),
        };

        const outcome = await runDataProfileBody({ analysisId: ANALYSIS_ID, runSession: runSession(), stagedInputs }, deps(pool, cancelled, revoked)).then(
            () => "completed",
            (thrown: unknown) => thrown,
        );

        expect(outcome).toBe(cancel);
        expect(statements.some((q) => q.text.includes("data_profile_status = 'failed'"))).toBe(false);
        expect(revoked).toEqual([]);
    });
});

describe("the data profile — the keys of its usage records", () => {
    it("gives each profile its own keys, thus a ledger that upserts on the key keeps the calls of each profile", async () => {
        const { pool } = statementPool();
        const records: LlmUsageRecord[] = [];

        for (const analysisId of [ANALYSIS_ID, OTHER_ANALYSIS_ID]) {
            // A model of its own for each profile gives each profile the same response ids, thus only the key can tell the calls apart.
            const answer = reply([text("The inputs are a count table.")], "stop", { inputTokens: 10, outputTokens: 2 });
            const { provider } = scriptedModel([answer, answer]);
            await runDataProfileBody(
                { analysisId, runSession: runSession(analysisId), stagedInputs },
                {
                    ...deps(pool, makeFakeSandboxClient(), []),
                    provider,
                    usageRecorder: {
                        record: (record) => {
                            records.push(record);
                            return okAsync(undefined);
                        },
                    },
                },
            );
        }

        const keysOf = (analysisId: string): string[] => records.filter((record) => record.scope.analysisId === analysisId).map((record) => record.recordKey);
        expect(keysOf(ANALYSIS_ID).length).toBeGreaterThan(0);
        expect(keysOf(OTHER_ANALYSIS_ID).length).toBeGreaterThan(0);
        expect(keysOf(OTHER_ANALYSIS_ID).filter((key) => keysOf(ANALYSIS_ID).includes(key))).toEqual([]);
    });
});

describe("the data profile — the submission that it records", () => {
    const INPUT_PATH = "data/inputs/f1/counts.csv";

    function submission(summary: string, paths: readonly string[]): Record<string, unknown> {
        return {
            operations: [
                {
                    op: "group",
                    paths,
                    group: {
                        name: "counts",
                        memberRepresents: "one count table",
                        description: "The count table.",
                        role: "data",
                        category: "expression-matrix",
                    },
                },
            ],
            analysisSummary: summary,
            domain: "transcriptomics",
            organism: null,
        };
    }

    /** Claims the one kept file, thus the submit accepts it. */
    const claimsTheFile = (summary: string): Record<string, unknown> => submission(summary, [INPUT_PATH]);
    /** Names a path that no file has, thus the submit asks for a repair, and the kept file stays unclaimed. */
    const claimsNothing = (summary: string): Record<string, unknown> => submission(summary, ["data/inputs/f1/missing.csv"]);

    const submit = (id: string, input: Record<string, unknown>): ScriptStep => callTools(toolCall(id, "submit_profile", input));

    const CompletedProfileSchema = z.object({ summary: z.string(), groups: z.array(z.object({ id: z.string(), count: z.number() })) });

    /** The profile that the completed row holds. */
    function completedProfile(statements: ReadonlyArray<{ text: string; values: readonly unknown[] }>): z.infer<typeof CompletedProfileSchema> {
        const completed = statements.filter((q) => q.text.includes("data_profile_status = 'completed'"));
        expect(completed).toHaveLength(1);
        const record = presentAt(completed, 0).values[1];
        if (typeof record !== "string") throw new Error("the completed row holds no profile");
        return parseJsonAs(record, CompletedProfileSchema);
    }

    async function profile(
        script: readonly ScriptStep[],
    ): Promise<{ statements: Array<{ text: string; values: readonly unknown[] }>; revoked: string[]; calls: number }> {
        const { pool, statements } = statementPool();
        const revoked: string[] = [];
        const { provider, calls } = scriptedModel(script);
        await runDataProfileBody(
            { analysisId: ANALYSIS_ID, runSession: runSession(), stagedInputs },
            { ...deps(pool, makeFakeSandboxClient(), revoked), provider },
        );
        return { statements, revoked, calls: calls.length };
    }

    it("records the last accepted submission, not a later one that asks for a repair", async () => {
        const run = await profile([submit("s1", claimsTheFile("the accepted profile")), submit("s2", claimsNothing("a later draft")), reply([text("done")])]);

        expect(completedProfile(run.statements)).toMatchObject({ summary: "the accepted profile", groups: [{ id: "counts", count: 1 }] });
        expect(run.revoked).toEqual(["data-profile-completed"]);
    });

    it("resolves the last submission as final when no submission is accepted, and sweeps the unclaimed file", async () => {
        // The run ends with two drafts and no accepted one, thus the salvage asks again, and it gets a third reply with no call.
        const run = await profile([
            submit("s1", claimsNothing("the first draft")),
            submit("s2", claimsNothing("the last draft")),
            reply([text("done")]),
            reply([text("no change")]),
        ]);

        expect(run.calls).toBe(4);
        expect(completedProfile(run.statements)).toMatchObject({ summary: "the last draft", groups: [{ id: "unclassified", count: 1 }] });
    });

    it("fails the profile when the run and its salvage make no submission", async () => {
        const run = await profile([reply([text("The inputs are a count table.")]), reply([text("Still no submission.")])]);

        expect(run.calls).toBe(2);
        const failed = run.statements.filter((q) => q.text.includes("data_profile_status = 'failed'"));
        expect(failed).toHaveLength(1);
        expect(presentAt(failed, 0).values).toContain("Data profiling failed: agent did not call submit_profile");
        expect(run.statements.some((q) => q.text.includes("data_profile_status = 'completed'"))).toBe(false);
        expect(run.revoked).toEqual(["data-profile-failed"]);
    });

    describe("on a recovery", () => {
        const original = { isInWorkflow: DBOS.isInWorkflow.bind(DBOS), runStep: DBOS.runStep.bind(DBOS) };

        afterEach(() => {
            Reflect.set(DBOS, "isInWorkflow", original.isInWorkflow);
            Reflect.set(DBOS, "runStep", original.runStep);
        });

        it("selects the same profile after a crash that follows the accepted submit", async () => {
            // Inside a workflow, the loop runs each model call and each tool call as a step. The fake runs each step inline.
            Reflect.set(
                DBOS,
                "isInWorkflow",
                mock(() => true),
            );
            const recorded: Array<{ readonly name: string | undefined; readonly value: unknown }> = [];
            Reflect.set(
                DBOS,
                "runStep",
                mock(async (fn: () => Promise<unknown>, config?: { name?: string }) => {
                    const value = await fn();
                    recorded.push({ name: config?.name, value });
                    return value;
                }),
            );
            const first = await profile([submit("s1", claimsTheFile("the accepted profile")), reply([text("done")])]);
            expect(recorded.map((step) => step.name)).toEqual(["data-profiler.model", "submit_profile.s1", "data-profiler.model"]);

            // The crash comes after the checkpoint of the submit, thus the recovery gets the first two steps from their checkpoints, in order.
            const checkpoints = recorded.slice(0, 2);
            let next = 0;
            Reflect.set(
                DBOS,
                "runStep",
                mock(async (fn: () => Promise<unknown>, config?: { name?: string }) => {
                    const step = checkpoints[next];
                    next += 1;
                    if (step === undefined) return fn();
                    if (step.name !== config?.name)
                        throw new Error(`the recovery reached the step ${config?.name ?? "(unnamed)"} where the record holds ${step.name ?? "(unnamed)"}`);
                    return step.value;
                }),
            );
            // The model gets only the request after the crash: a second copy of the first request would get this reply and no submit.
            const recovered = await profile([reply([text("done")])]);

            expect(recovered.calls).toBe(1);
            expect(completedProfile(recovered.statements)).toEqual(completedProfile(first.statements));
            expect(completedProfile(recovered.statements)).toMatchObject({ summary: "the accepted profile", groups: [{ id: "counts", count: 1 }] });
        });
    });
});
