/**
 * The pause of the data profile inside a DBOS workflow (data-profile-init and work-pause specs).
 *
 * A test-registered workflow runs the body of the profile. A suspend error of the profiler model pauses the profile
 * in place with its row `running`. A resume through the host surface ends the wait, and a stop ends the profile. A
 * refused spawn pauses the lease workflow, not the profile; the tests of the sandbox module cover it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DBOS } from "@dbos-inc/dbos-sdk";
import { okAsync } from "neverthrow";
import type { Pool } from "pg";

import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { silentLogger } from "../../__tests__/setup/logger.js";
import { makeFakeSandboxClient } from "../../agents/sandbox/__fixtures__/deps.js";
import { createLocalRunAuthorizer } from "../../auth/local-run-authorizer.js";
import { createWork } from "../../app/work.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RunSession } from "../../auth/types.js";
import type { ChatProvider } from "../../providers/types.js";
import { fakeLeases, leaseOverClient } from "../../sandbox/__fixtures__/leases.js";
import { loadDataProfileStatus, tryStartDataProfile } from "../../state/data-profile.js";
import { queryPausesOfWork, type PauseRecord } from "../../state/paused-work.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { DATA_PROFILE_STOPPED, runDataProfileBody, stopDataProfile, type DataProfileDeps, type DataProfileWorkflowInput } from "../data-profile.js";

/** The deps of a work surface in this file: a local run authorizer, and the stops that a test does not reach. */
const WORK_DEPS = {
    runAuthorizer: createLocalRunAuthorizer(),
    stopTurn: () => Promise.reject(new Error("no turn stops in this file")),
    runCanceler: { cancel: () => Promise.reject(new Error("no run stops in this file")) },
    stopProfile: () => Promise.reject(new Error("no profile stops in this file")),
};

if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const INPUT_PATH = "data/inputs/f1/counts.csv";

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

/** The input and the deps of one profile, keyed by its analysis. */
const cases = new Map<string, { readonly input: DataProfileWorkflowInput; readonly deps: DataProfileDeps }>();

const profileWorkflow = DBOS.registerWorkflow(
    async (analysisId: string): Promise<void> => {
        const current = cases.get(analysisId);
        if (current === undefined) throw new Error(`no case for ${analysisId}`);
        await runDataProfileBody(current.input, current.deps);
    },
    { name: "data-profile-pause" },
);

let rig: DbosTestRig;
let pool: Pool;
let root: string;

beforeAll(async () => {
    rig = await setupDbosForTests("data_profile_pause");
    pool = rig.pool;
    root = await mkdtemp(join(tmpdir(), "harness-profile-pause-"));
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
    await rm(root, { recursive: true, force: true });
});

function runSession(analysisId: string): RunSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: "data-profiler", callPath: ["data-profiler"] },
        runFrame: { runId: "data-profile", stepId: "profile" },
        auth: makeLocalAuth(),
    };
}

/** An analysis whose profile row is `running`, with one staged count table on disk. */
async function seedProfile(): Promise<string> {
    const analysisId = rig.nextWorkflowId("an-profile-pause-");
    const now = new Date().toISOString();
    await pool.query({
        text: `INSERT INTO cortex_analysis_state (analysis_id, status, data_profile_status, seed_input_file_ids, created_at, updated_at)
               VALUES ($1, 'active', 'pending', '["f1"]'::jsonb, $2, $2)`,
        values: [analysisId, now],
    });
    expect((await tryStartDataProfile(pool, analysisId))._unsafeUnwrap()).toBe(true);
    const inputDir = join(root, analysisId, "data", "inputs", "f1");
    await mkdir(inputDir, { recursive: true });
    await writeFile(join(inputDir, "counts.csv"), "gene,count\nTP53,7\nBRCA1,3\n");
    return analysisId;
}

const MACHINE = { sandboxId: "sb-test", host: "127.0.0.1", port: 8765, backend: "docker" as const };

function depsFor(provider: ChatProvider, revoked: string[]): DataProfileDeps {
    return {
        logger: silentLogger,
        provider,
        pool,
        leases: fakeLeases(leaseOverClient(makeFakeSandboxClient(), MACHINE)),
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
        embedding: { dimensions: 3, embed: (texts) => okAsync(texts.map(() => [1, 0, 0])) },
        skillsDir: root,
    };
}

/** A submission whose one group claims the staged file, thus the submit accepts it. */
const ACCEPTED_SUBMISSION = {
    operations: [
        {
            op: "group",
            paths: [INPUT_PATH],
            group: { name: "counts", memberRepresents: "one count table", description: "The count table.", role: "data", category: "expression-matrix" },
        },
    ],
    analysisSummary: "the profile after the resume",
    domain: "transcriptomics",
    organism: null,
};

async function waitForPause(analysisId: string, workflowId: string, timeoutMs = 15_000): Promise<PauseRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const rows = (await queryPausesOfWork(pool, analysisId, workflowId))._unsafeUnwrap();
        const row = rows.find((candidate) => candidate.state === "paused");
        if (row !== undefined) return row;
        if (Date.now() > deadline) throw new Error(`timed out: the pause of ${workflowId}`);
        await sleep(25);
    }
}

async function analysisStatus(analysisId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM cortex_analysis_state WHERE analysis_id = $1", [analysisId]);
    return rows[0]?.status;
}

describe("the data profile inside a workflow — a stop", () => {
    it("ends a paused profile: the workflow is cancelled, the row fails, and its pause rows go", async () => {
        const analysisId = await seedProfile();
        const { provider } = scriptedModel([{ fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) }, reply([text("unused")])]);
        const revoked: string[] = [];
        cases.set(analysisId, { input: { analysisId, runSession: runSession(analysisId), stagedInputs }, deps: depsFor(provider, revoked) });
        const workflowId = rig.nextWorkflowId("profile-stop-");
        const handle = await DBOS.startWorkflow(profileWorkflow, { workflowID: workflowId })(analysisId);
        await waitForPause(analysisId, workflowId);

        const surface = createWork({ pool, ...WORK_DEPS, stopProfile: (id, workflow) => stopDataProfile({ pool }, id, workflow) });
        const session = { identity: { user: "u-1" }, scope: { kind: "analysis" as const, analysisId }, auth: makeLocalAuth() };
        const elsewhere = { ...session, scope: { kind: "analysis" as const, analysisId: "a-other" } };
        expect(await surface.stop(elsewhere, workflowId)).toEqual({ kind: "not_found" });
        expect(await surface.stop(session, workflowId)).toMatchObject({ kind: "stopped", work: { workId: workflowId, kind: "profile" } });

        await expect(handle.getResult()).rejects.toThrow("has been cancelled");
        expect((await DBOS.getWorkflowStatus(workflowId))?.status).toBe("CANCELLED");
        const settled = (await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap();
        expect(settled).toMatchObject({ status: "failed", error: DATA_PROFILE_STOPPED });
        expect((await queryPausesOfWork(pool, analysisId, workflowId))._unsafeUnwrap()).toEqual([]);
        expect(await surface.list(analysisId)).toEqual([]);
        expect(revoked).toEqual(["data-profile-stopped"]);
    }, 30_000);
});

describe("the data profile inside a workflow — a suspend error of the profiler model", () => {
    it("waits in place with its row running, and sends the request again after a resume", async () => {
        const analysisId = await seedProfile();
        const revoked: string[] = [];
        const model = scriptedModel([
            { fail: Object.assign(new Error("HTTP 402"), { statusCode: 402 }) },
            callTools(toolCall("s1", "submit_profile", ACCEPTED_SUBMISSION)),
            reply([text("done")]),
        ]);
        cases.set(analysisId, {
            input: { analysisId, runSession: runSession(analysisId), stagedInputs },
            deps: depsFor(model.provider, revoked),
        });
        const workflowId = rig.nextWorkflowId("profile-model-pause-");
        const handle = await DBOS.startWorkflow(profileWorkflow, { workflowID: workflowId })(analysisId);

        const row = await waitForPause(analysisId, workflowId);
        expect(row).toMatchObject({ workKind: "profile", cause: { kind: "host", reason: "payment_required" } });
        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("running");
        expect(revoked).toEqual([]);

        const session = { identity: { user: "u-1" }, scope: { kind: "analysis" as const, analysisId }, auth: makeLocalAuth() };
        expect(await createWork({ pool, ...WORK_DEPS }).resume(session, workflowId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(model.calls).toHaveLength(3);
        expect(JSON.stringify(model.calls[1]?.prompt)).toBe(JSON.stringify(model.calls[0]?.prompt));
        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("completed");
        expect(revoked).toEqual(["data-profile-completed"]);
        expect(await analysisStatus(analysisId)).toBe("active");
    }, 30_000);
});
