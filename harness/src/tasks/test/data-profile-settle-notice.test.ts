/**
 * The settle notice of the data-profile deps, driven through the workflow body
 * against a real ledger (data-profile-observation spec): one call for each
 * settled claim, none for a refused stamp, and a failed notice leaves the row.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { makeFakeSandboxClient } from "../../agents/sandbox/__fixtures__/deps.js";
import { silentLogger } from "../../__tests__/setup/logger.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RunSession } from "../../auth/types.js";
import { unusedChatProvider } from "../../providers/__fixtures__/chat-provider.js";
import type { SandboxClient } from "../../sandbox/client.js";
import { loadDataProfileStatus, tryStartDataProfile } from "../../state/data-profile.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { runDataProfileBody, type DataProfileDeps, type DataProfileSettlement, type NotifyDataProfileSettled } from "../data-profile.js";

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

function runSession(analysisId: string): RunSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: "data-profiler", callPath: ["data-profiler"] },
        runFrame: { runId: "data-profile", stepId: "profile" },
        auth: makeLocalAuth(),
    };
}

describe("the settle notice of the data profile", () => {
    let pool: Pool;
    let drop: () => Promise<void>;
    let root: string;
    let counter = 0;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("profile_settle_notice"));
    });
    afterAll(async () => {
        await drop();
    });
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "harness-profile-settle-"));
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    /** A seeded analysis whose profile row is `running`, or `failed` when the claim is not taken. */
    async function seedAnalysis(claim: boolean): Promise<string> {
        const analysisId = `an-settle-${counter++}`;
        const now = new Date().toISOString();
        await pool.query({
            text: `INSERT INTO cortex_analysis_state (analysis_id, status, data_profile_status, seed_input_file_ids, created_at, updated_at)
                   VALUES ($1, 'active', 'pending', '["f1"]'::jsonb, $2, $2)`,
            values: [analysisId, now],
        });
        if (claim) (await tryStartDataProfile(pool, analysisId))._unsafeUnwrap();
        else await pool.query("UPDATE cortex_analysis_state SET data_profile_status = 'failed' WHERE analysis_id = $1", [analysisId]);
        const inputDir = join(root, analysisId, "data", "inputs", "f1");
        await mkdir(inputDir, { recursive: true });
        await writeFile(join(inputDir, "counts.csv"), "gene,count\nTP53,7\nBRCA1,3\n");
        return analysisId;
    }

    function depsWith(sandboxClient: SandboxClient, notifyDataProfileSettled: NotifyDataProfileSettled | undefined): DataProfileDeps {
        return {
            logger: silentLogger,
            // The profile body reaches the provider only inside the sandbox agent loop, which no case here enters.
            provider: unusedChatProvider(),
            pool,
            sandboxClient,
            workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot: async (id) => join(root, id) }),
            resolveWorkspaceRoot: async (id) => join(root, id),
            model: "test-model",
            runAuthorizer: {
                authorize: () => {
                    throw new Error("the body never authorizes");
                },
                revoke: () => okAsync(undefined),
                revokeByJti: () => okAsync(undefined),
            },
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            // The embedder is read only when the body indexes a profile, which no case here reaches.
            embedding: { dimensions: 3, embed: () => okAsync([]) },
            skillsDir: root,
            notifyDataProfileSettled,
        };
    }

    // The body calls only `createSandbox` of the client before it fails, thus only that method is overridden.
    const refusingSandbox = {
        ...makeFakeSandboxClient(),
        createSandbox: () => errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "labels_unavailable", suspend: false }),
    };
    // The empty-manifest path settles before any sandbox call, thus no method of the client is read.
    const unusedSandbox = makeFakeSandboxClient();

    function recordingNotice(): { notify: NotifyDataProfileSettled; settlements: DataProfileSettlement[] } {
        const settlements: DataProfileSettlement[] = [];
        return {
            settlements,
            notify: (settlement) => {
                settlements.push(settlement);
                return okAsync(undefined);
            },
        };
    }

    it("sends one settlement of a completed claim, with the stamped time", async () => {
        const analysisId = await seedAnalysis(true);
        const { notify, settlements } = recordingNotice();

        await runDataProfileBody({ analysisId, runSession: runSession(analysisId), stagedInputs: [] }, depsWith(unusedSandbox, notify));

        const row = (await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap();
        expect(row?.status).toBe("completed");
        const completedAt = row?.completedAt;
        if (typeof completedAt !== "string") throw new Error("the row carries a stamped time");
        expect(settlements).toEqual([{ analysisId, status: "completed", completedAt }]);
    });

    it("sends one settlement of a failed claim, with the stamped time", async () => {
        const analysisId = await seedAnalysis(true);
        const { notify, settlements } = recordingNotice();

        await runDataProfileBody({ analysisId, runSession: runSession(analysisId), stagedInputs }, depsWith(refusingSandbox, notify));

        const row = (await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap();
        expect(row?.status).toBe("failed");
        const completedAt = row?.completedAt;
        if (typeof completedAt !== "string") throw new Error("the row carries a stamped time");
        expect(settlements).toEqual([{ analysisId, status: "failed", completedAt }]);
    });

    it("sends nothing when the guard refuses the stamp", async () => {
        const analysisId = await seedAnalysis(false);
        const { notify, settlements } = recordingNotice();

        await runDataProfileBody({ analysisId, runSession: runSession(analysisId), stagedInputs: [] }, depsWith(unusedSandbox, notify));

        expect(settlements).toEqual([]);
        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("failed");
    });

    it("keeps the settled row when the notice gives an err", async () => {
        const analysisId = await seedAnalysis(true);
        let calls = 0;
        const failing: NotifyDataProfileSettled = () => {
            calls += 1;
            return errAsync({ reason: "the store is down" });
        };

        await runDataProfileBody({ analysisId, runSession: runSession(analysisId), stagedInputs: [] }, depsWith(unusedSandbox, failing));

        expect(calls).toBe(1);
        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("completed");
    });

    it("settles as before when the deps bind no notice", async () => {
        const analysisId = await seedAnalysis(true);

        await runDataProfileBody({ analysisId, runSession: runSession(analysisId), stagedInputs: [] }, depsWith(unusedSandbox, undefined));

        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("completed");
    });
});
