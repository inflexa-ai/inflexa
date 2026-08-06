/**
 * Body-level tests for the data-profile workflow's terminal provenance.
 *
 * These tests drive `runDataProfileBody` directly with a fake DBOS clock and a
 * fake deps bundle, the same pattern `execute-analysis.test.ts` uses. They
 * cover the `data_profile_completed` observation on both terminal paths:
 *
 * - the completion path (an empty staged manifest is a terminal completion
 *   like any other — see the body), with `status: "completed"`,
 * - the failure path (sandbox provisioning throws), with `status: "failed"`,
 *
 * and that each emission delivers the `RunSession` from the durable workflow
 * input alongside the event.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Pool } from "pg";

import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunSession } from "../auth/types.js";
import type { StagedInput } from "../execution/staged-input.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { RunProvenanceEvent } from "../workflows/execute-analysis.js";
import { runDataProfileBody, type DataProfileDeps, type DataProfileWorkflowInput } from "./data-profile.js";

// ── Fake DBOS surface ────────────────────────────────────────────────

/**
 * Fake checkpointed clock, mirroring `execute-analysis.test.ts`: `DBOS.now()`
 * returns the current value then advances by a fixed step, so every emitted
 * `atMs` is a distinct, deterministic, unmistakably stub-sourced value.
 */
const FAKE_CLOCK_BASE_MS = 1_000_000;
const FAKE_CLOCK_STEP_MS = 1_000;

let nowMs = FAKE_CLOCK_BASE_MS;

/**
 * The mocks are installed by DIRECT property assignment on the DBOS class,
 * which `mock.restore()` does NOT undo — capture the originals once and put
 * them back in `afterAll` so the fakes never leak into a later test file.
 */
let originalDbosFns: Record<string, unknown> | undefined;

async function mockDbos(): Promise<void> {
    const dbos = await import("@dbos-inc/dbos-sdk");

    originalDbosFns ??= {
        now: dbos.DBOS.now,
        writeStream: dbos.DBOS.writeStream,
        runStep: dbos.DBOS.runStep,
    };

    (dbos.DBOS.now as unknown) = mock(async () => {
        const t = nowMs;
        nowMs += FAKE_CLOCK_STEP_MS;
        return t;
    });
    (dbos.DBOS.writeStream as unknown) = mock(async () => undefined);
    (dbos.DBOS.runStep as unknown) = mock(async (fn: () => Promise<unknown>) => fn());
}

beforeEach(async () => {
    nowMs = FAKE_CLOCK_BASE_MS;
    await mockDbos();
});

afterEach(() => {
    mock.restore();
});

afterAll(async () => {
    if (!originalDbosFns) return;
    const dbos = await import("@dbos-inc/dbos-sdk");
    for (const [name, fn] of Object.entries(originalDbosFns)) {
        (dbos.DBOS as unknown as Record<string, unknown>)[name] = fn;
    }
});

// ── Fixtures ─────────────────────────────────────────────────────────

/** Every ledger accessor tolerates an empty rowset; a refused terminal CAS only logs. */
function makeFakePool(): Pool {
    return { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
}

function makeRunSession(): RunSession {
    return {
        identity: { user: "u-1" },
        scope: { kind: "analysis", analysisId: "a1" },
        provenance: { agentId: "data-profiler", callPath: ["data-profiler"] },
        runFrame: { runId: "data-profile", stepId: "profile" },
        auth: makeLocalAuth(),
    };
}

function stagedInput(fileId: string): StagedInput {
    return {
        fileId,
        mountName: fileId,
        key: `${fileId}.csv`,
        fileName: `${fileId}.csv`,
        hash: `hash-${fileId}`,
        size: 1024,
        mtimeMs: 1_780_000_000_000,
        relativePath: `inputs/${fileId}/${fileId}.csv`,
    };
}

function makeDeps(opts: { emitProvenance: (event: RunProvenanceEvent, session: RunSession) => void; sandboxClient?: SandboxClient }): DataProfileDeps {
    return {
        provider: {} as ChatProvider,
        pool: makeFakePool(),
        sandboxClient: opts.sandboxClient ?? ({} as SandboxClient),
        workspaceFs: {} as WorkspaceFilesystem,
        resolveWorkspaceRoot: (id: string) => `/tmp/cortex-data-profile-test/${id}`,
        model: "test-model",
        runAuthorizer: {
            async authorize() {
                throw new Error("runAuthorizer.authorize not exercised in body tests");
            },
            async revoke() {},
        },
        bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        embedding: {} as EmbeddingProvider,
        skillsDir: "/tmp/cortex-data-profile-test-skills",
        emitProvenance: opts.emitProvenance,
    };
}

// ── Terminal provenance ──────────────────────────────────────────────

describe("runDataProfileBody terminal provenance", () => {
    it("the completion path emits data_profile_completed(completed) with the durable input's runSession", async () => {
        const events: RunProvenanceEvent[] = [];
        const sessions: RunSession[] = [];
        const deps = makeDeps({
            emitProvenance: (e, s) => {
                events.push(e);
                sessions.push(s);
            },
        });
        const input: DataProfileWorkflowInput = { analysisId: "a1", runSession: makeRunSession(), stagedInputs: [] };

        await runDataProfileBody(input, deps);

        // Clock reads, in body order: the body-start read, then the terminal
        // read. Both are stub values, and the duration is their difference.
        expect(events).toEqual([
            {
                type: "data_profile_completed",
                analysisId: "a1",
                status: "completed",
                atMs: FAKE_CLOCK_BASE_MS + FAKE_CLOCK_STEP_MS,
                durationMs: FAKE_CLOCK_STEP_MS,
            },
        ]);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toBe(input.runSession);
    });

    it("the failure path emits data_profile_completed(failed) with the durable input's runSession", async () => {
        const events: RunProvenanceEvent[] = [];
        const sessions: RunSession[] = [];
        const deps = makeDeps({
            emitProvenance: (e, s) => {
                events.push(e);
                sessions.push(s);
            },
            sandboxClient: {
                createSandbox: async () => {
                    throw new Error("provisioning boom");
                },
            } as unknown as SandboxClient,
        });
        const input: DataProfileWorkflowInput = { analysisId: "a1", runSession: makeRunSession(), stagedInputs: [stagedInput("file-aaa")] };

        await runDataProfileBody(input, deps);

        expect(events).toEqual([
            {
                type: "data_profile_completed",
                analysisId: "a1",
                status: "failed",
                atMs: FAKE_CLOCK_BASE_MS + FAKE_CLOCK_STEP_MS,
                durationMs: FAKE_CLOCK_STEP_MS,
            },
        ]);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toBe(input.runSession);
    });

    it("without emitProvenance the profile settles (absent callback changes nothing)", async () => {
        const { emitProvenance: _omitted, ...deps } = makeDeps({ emitProvenance: () => {} });
        const input: DataProfileWorkflowInput = { analysisId: "a1", runSession: makeRunSession(), stagedInputs: [] };

        await expect(runDataProfileBody(input, deps)).resolves.toBeUndefined();
    });

    it("a throwing observer does not fail the profile", async () => {
        const deps = makeDeps({
            emitProvenance: () => {
                throw new Error("observer boom");
            },
        });
        const input: DataProfileWorkflowInput = { analysisId: "a1", runSession: makeRunSession(), stagedInputs: [] };

        await expect(runDataProfileBody(input, deps)).resolves.toBeUndefined();
    });
});
