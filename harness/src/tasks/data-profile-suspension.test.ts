/**
 * The body of the data profile, driven outside a workflow: its suspension
 * (data-profile-init spec), where the body has nothing to cancel, and the keys
 * of its usage records (llm-usage-accounting spec).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { makeFakeSandboxClient } from "../agents/sandbox/__fixtures__/deps.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunSession } from "../auth/types.js";
import type { LlmUsageRecord } from "../billing/usage-recorder.js";
import { setupDbosForTests, type DbosTestRig } from "../__tests__/setup/dbos.js";
import { silentLogger } from "../__tests__/setup/logger.js";
import { makeMessage, scriptedProvider, textBlock } from "../loop/__fixtures__/scripted-provider.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { SandboxError } from "../sandbox/sandbox-error.js";
import type { SandboxRef } from "../sandbox/types.js";
import { createWorkspaceFilesystem } from "../workspace/filesystem.js";
import { runDataProfileBody, type DataProfileDeps } from "./data-profile.js";

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
    root = await mkdtemp(join(tmpdir(), "harness-profile-suspension-"));
    for (const analysisId of [ANALYSIS_ID, OTHER_ANALYSIS_ID]) {
        const inputDir = join(root, analysisId, "data", "inputs", "f1");
        await mkdir(inputDir, { recursive: true });
        await writeFile(join(inputDir, "counts.csv"), "gene,count\nTP53,7\nBRCA1,3\n");
    }
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

function statementPool(): { pool: Pool; statements: Array<{ text: string; values: readonly unknown[] }> } {
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const pool = {
        query: async (arg: unknown, params?: unknown[]) => {
            const text = typeof arg === "string" ? arg : ((arg as { text?: string }).text ?? "");
            const values = typeof arg === "object" && arg !== null && "values" in arg ? ((arg as { values?: unknown[] }).values ?? []) : (params ?? []);
            statements.push({ text, values });
            return { rows: [], rowCount: 0 };
        },
    } as unknown as Pool;
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

function deps(pool: Pool, sandboxClient: SandboxClient, revoked: string[]): DataProfileDeps {
    return {
        logger: silentLogger,
        provider: {} as ChatProvider,
        pool,
        sandboxClient,
        workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(root, id) }),
        resolveWorkspaceRoot: (id) => join(root, id),
        model: "test-model",
        runAuthorizer: {
            authorize: () => {
                throw new Error("the body never authorizes");
            },
            revoke: (_authorization, reason) => {
                revoked.push(reason);
                return okAsync(undefined);
            },
            revokeByJti: () => okAsync(undefined),
        },
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        embedding: { dimensions: 3, embed: () => okAsync([]) } as unknown as EmbeddingProvider,
        skillsDir: root,
    };
}

describe("the data profile — a refused spawn", () => {
    it("with the suspend flag, fails the row with the reason, revokes, and marks the analysis as suspended", async () => {
        const { pool, statements } = statementPool();
        const revoked: string[] = [];
        const refusing = {
            createSandbox: () => errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "account_frozen", suspend: true }),
        } as unknown as SandboxClient;

        await runDataProfileBody({ analysisId: ANALYSIS_ID, runSession: runSession(), stagedInputs }, deps(pool, refusing, revoked));

        const failed = statements.filter((q) => /data_profile_status\s*=\s*'failed'/i.test(q.text));
        expect(failed).toHaveLength(1);
        expect(failed[0]!.values).toContain("account_frozen");
        expect(revoked).toEqual(["data-profile-suspended"]);
        expect(statements.some((q) => /SET status = 'suspended_insufficient_funds'/.test(q.text))).toBe(true);
    });

    it("without the suspend flag, fails the row with the reason and does not mark the analysis", async () => {
        const { pool, statements } = statementPool();
        const revoked: string[] = [];
        const refusing = {
            createSandbox: () => errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "labels_unavailable", suspend: false }),
        } as unknown as SandboxClient;

        await runDataProfileBody({ analysisId: ANALYSIS_ID, runSession: runSession(), stagedInputs }, deps(pool, refusing, revoked));

        const failed = statements.filter((q) => /data_profile_status\s*=\s*'failed'/i.test(q.text));
        expect(failed).toHaveLength(1);
        expect(String(failed[0]!.values.find((v) => typeof v === "string" && v.includes("labels_unavailable")))).toContain("labels_unavailable");
        expect(revoked).toEqual(["data-profile-failed"]);
        expect(statements.some((q) => /SET status = 'suspended_insufficient_funds'/.test(q.text))).toBe(false);
    });

    it("passes a cancel from DBOS through with no change, and runs no failure path", async () => {
        const { pool, statements } = statementPool();
        const revoked: string[] = [];
        const cancel = new DBOSErrors.DBOSWorkflowCancelledError("wf-profile");
        const cancelled = {
            createSandbox: () => new ResultAsync<SandboxRef, SandboxError>(Promise.reject(cancel)),
        } as unknown as SandboxClient;

        const outcome = await runDataProfileBody({ analysisId: ANALYSIS_ID, runSession: runSession(), stagedInputs }, deps(pool, cancelled, revoked)).then(
            () => "completed",
            (thrown: unknown) => thrown,
        );

        expect(outcome).toBe(cancel);
        expect(statements.some((q) => /data_profile_status\s*=\s*'failed'/i.test(q.text))).toBe(false);
        expect(revoked).toEqual([]);
    });
});

describe("the data profile — the keys of its usage records", () => {
    // The loop runs each call in a durable step, and a step needs a launched engine, also outside a workflow.
    let rig: DbosTestRig;
    beforeAll(async () => {
        rig = await setupDbosForTests("data_profile_usage_keys");
    });
    afterAll(async () => {
        await rig.drop();
    });

    it("gives each profile its own keys, thus a ledger that upserts on the key keeps the calls of each profile", async () => {
        const { pool } = statementPool();
        const records: LlmUsageRecord[] = [];
        const provider = scriptedProvider(() => makeMessage([textBlock("The inputs are a count table.")], "end_turn", { inputTokens: 10, outputTokens: 2 }));

        for (const analysisId of [ANALYSIS_ID, OTHER_ANALYSIS_ID]) {
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
