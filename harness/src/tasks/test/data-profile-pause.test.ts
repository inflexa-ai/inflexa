/**
 * The pause of the data profile inside a DBOS workflow (data-profile-init and work-pause specs).
 *
 * A test-registered workflow runs the body of the profile. The label gate refuses the first spawn with the
 * suspend flag, thus the profile waits in place with its row `running`. A resume through the host surface ends
 * the wait, and the body spawns again and completes the profile.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { DBOS } from "@dbos-inc/dbos-sdk";
import { errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { setupDbosForTests, type DbosTestRig } from "../../__tests__/setup/dbos.js";
import { silentLogger } from "../../__tests__/setup/logger.js";
import { makeFakeSandboxClient } from "../../agents/sandbox/__fixtures__/deps.js";
import { createPausedWork } from "../../app/paused-work.js";
import { makeLocalAuth } from "../../auth/local-auth-context.js";
import type { RunSession } from "../../auth/types.js";
import type { PausePart } from "../../contracts/chat-parts.js";
import { PausePartSchema } from "../../contracts/schemas/chat-parts.js";
import type { ChatProvider } from "../../providers/types.js";
import type { SandboxClient } from "../../sandbox/client.js";
import { loadDataProfileStatus, tryStartDataProfile } from "../../state/data-profile.js";
import { queryPausesOfWork, type PauseRecord } from "../../state/paused-work.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../testing.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { runDataProfileBody, type DataProfileDeps, type DataProfileWorkflowInput } from "../data-profile.js";

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

/** A sandbox client whose label gate refuses the first spawn with the suspend flag, and makes each later sandbox. */
function refusesFirstSpawn(reason: string): { client: SandboxClient; attempts: () => number; made: () => number } {
    const fake = makeFakeSandboxClient();
    let attempts = 0;
    let made = 0;
    const client: SandboxClient = {
        ...fake,
        createSandbox: (session, spec, identity) => {
            attempts += 1;
            if (attempts === 1) return errAsync({ type: "labels_refused", op: "createSandbox", reason, suspend: true });
            made += 1;
            return fake.createSandbox(session, spec, identity);
        },
    };
    return { client, attempts: () => attempts, made: () => made };
}

function depsFor(sandboxClient: SandboxClient, provider: ChatProvider, revoked: string[]): DataProfileDeps {
    return {
        logger: silentLogger,
        provider,
        pool,
        sandboxClient,
        workspaceFs: createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)) }),
        resolveWorkspaceRoot: (id) => Promise.resolve(join(root, id)),
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

/** The pause parts in the stream of the profile workflow. Read it after the workflow ends, because the read waits for the close. */
async function pauseParts(workflowId: string): Promise<PausePart[]> {
    const parts: PausePart[] = [];
    for await (const part of DBOS.readStream<unknown>(workflowId, "events")) {
        const pause = PausePartSchema.safeParse(part);
        if (pause.success) parts.push(pause.data);
    }
    return parts;
}

describe("the data profile inside a workflow — a refused spawn with the suspend flag", () => {
    it("waits in place with its row running, and spawns again after a resume", async () => {
        const analysisId = await seedProfile();
        const sandbox = refusesFirstSpawn("account_frozen");
        const revoked: string[] = [];
        const { provider } = scriptedModel([callTools(toolCall("s1", "submit_profile", ACCEPTED_SUBMISSION)), reply([text("done")])]);
        cases.set(analysisId, { input: { analysisId, runSession: runSession(analysisId), stagedInputs }, deps: depsFor(sandbox.client, provider, revoked) });
        const workflowId = rig.nextWorkflowId("profile-pause-");
        const handle = await DBOS.startWorkflow(profileWorkflow, { workflowID: workflowId })(analysisId);

        const row = await waitForPause(analysisId, workflowId);
        expect(row).toMatchObject({
            workflowId,
            workId: workflowId,
            workKind: "profile",
            analysisId,
            state: "paused",
            cause: { kind: "host", reason: "account_frozen" },
            attempt: 0,
        });
        expect(sandbox.attempts()).toBe(1);
        expect(sandbox.made()).toBe(0);
        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("running");
        expect((await DBOS.getWorkflowStatus(workflowId))?.status).toBe("PENDING");
        expect(await analysisStatus(analysisId)).toBe("active");
        expect(revoked).toEqual([]);

        const surface = createPausedWork({ pool });
        expect(await surface.list(analysisId)).toMatchObject([{ workId: workflowId, kind: "profile", analysisId, waiting: [{ workflowId, state: "paused" }] }]);
        const session = { identity: { user: "u-1" }, scope: { kind: "analysis" as const, analysisId }, auth: makeLocalAuth() };
        expect(await surface.resume(session, workflowId)).toEqual({ kind: "resumed", workflows: 1 });

        await handle.getResult();
        expect(sandbox.attempts()).toBe(2);
        expect(sandbox.made()).toBe(1);
        const settled = (await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap();
        expect(settled?.status).toBe("completed");
        expect(settled?.result?.summary).toBe("the profile after the resume");
        expect(revoked).toEqual(["data-profile-completed"]);
        expect(await analysisStatus(analysisId)).toBe("active");
        expect((await queryPausesOfWork(pool, analysisId, workflowId))._unsafeUnwrap()).toEqual([]);
        expect(await pauseParts(workflowId)).toEqual([
            {
                type: "data-pause",
                id: workflowId,
                workId: workflowId,
                workKind: "profile",
                state: "paused",
                cause: { kind: "host", reason: "account_frozen" },
                attempt: 0,
            },
            { type: "data-pause", id: workflowId, workId: workflowId, workKind: "profile", state: "running" },
        ]);
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
            deps: depsFor(makeFakeSandboxClient(), model.provider, revoked),
        });
        const workflowId = rig.nextWorkflowId("profile-model-pause-");
        const handle = await DBOS.startWorkflow(profileWorkflow, { workflowID: workflowId })(analysisId);

        const row = await waitForPause(analysisId, workflowId);
        expect(row).toMatchObject({ workKind: "profile", cause: { kind: "host", reason: "payment_required" } });
        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("running");
        expect(revoked).toEqual([]);

        const session = { identity: { user: "u-1" }, scope: { kind: "analysis" as const, analysisId }, auth: makeLocalAuth() };
        expect(await createPausedWork({ pool }).resume(session, workflowId)).toEqual({ kind: "resumed", workflows: 1 });
        await handle.getResult();

        expect(model.calls).toHaveLength(3);
        expect(JSON.stringify(model.calls[1]?.prompt)).toBe(JSON.stringify(model.calls[0]?.prompt));
        expect((await loadDataProfileStatus(pool, analysisId))._unsafeUnwrap()?.status).toBe("completed");
        expect(revoked).toEqual(["data-profile-completed"]);
        expect(await analysisStatus(analysisId)).toBe("active");
    }, 30_000);
});
