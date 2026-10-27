/**
 * The identity of an extraction pass inside the step of a tool call, against the real engine.
 *
 * One call of `preview_report` can run more than one pass, thus each pass keys its exec and its container by
 * the step and by its requests. A pass over other requests gets another exec. A pass over the same requests,
 * as in a rerun of the step, gets the same exec, and sandbox-server gives its record.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { okAsync } from "neverthrow";

import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { makeLocalAuth } from "../../../../auth/local-auth-context.js";
import type { ExtractionRequest } from "../../../../report-model/production-resolver.js";
import type { SandboxClient } from "../../../../sandbox/client.js";
import type { ExecResult, SandboxIdentity, SandboxRef } from "../../../../sandbox/types.js";
import { runExtraction } from "../../../../tasks/extract-values.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" in workflow-replay.test.ts).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const identities: SandboxIdentity[] = [];
const execIds: string[] = [];
const ref: SandboxRef = { sandboxId: "sbx-extract", host: "127.0.0.1", port: 8765, backend: "docker" };
const sandboxClient: SandboxClient = {
    toolchainSource: "store",
    createSandbox: (_session, _spec, identity) => {
        identities.push(identity);
        return okAsync(ref);
    },
    exec(_ref, _request, _emit, _deadline, execId?: string): Promise<ExecResult> {
        if (execId === undefined) throw new Error("the step sandbox gives each exec its id");
        execIds.push(execId);
        return Promise.resolve({ execId, exitCode: 0, stdout: "{}", stderr: "", durationMs: 1, timedOut: false });
    },
    teardown: () => Promise.resolve(),
    isAlive: () => Promise.resolve({ alive: true, oomKilled: false }),
    isAliveById: () => Promise.resolve({ alive: true, oomKilled: false }),
    teardownById: () => Promise.resolve(),
    listManagedSandboxes: () => Promise.resolve([]),
};

const first: ExtractionRequest[] = [{ path: "data/a.parquet", hash: "h1", format: "parquet" }];
const second: ExtractionRequest[] = [{ path: "data/b.parquet", hash: "h2", format: "parquet" }];
const caller = { analysisId: "analysis-1", identity: { user: "u-1" }, auth: makeLocalAuth() };

const call = DBOS.registerWorkflow(
    async (): Promise<void> =>
        DBOS.runStep(
            async () => {
                for (const requests of [first, second, first]) {
                    (await runExtraction({ sandboxClient }, caller, requests))._unsafeUnwrap();
                }
            },
            { name: "preview_report.call-1" },
        ),
    { name: "extract-values-step" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("extract_values_step");
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
});

describe("the extraction passes of one tool call", () => {
    it("key each exec and each container by the step and by the requests", async () => {
        const wfId = rig.nextWorkflowId("extract-values-step-");
        await (await DBOS.startWorkflow(call, { workflowID: wfId })()).getResult();

        const [a, b, again] = execIds;
        expect(execIds).toHaveLength(3);
        expect(a?.startsWith(`${wfId}:`)).toBe(true);
        expect(b?.startsWith(`${wfId}:`)).toBe(true);
        expect(b).not.toBe(a);
        expect(again).toBe(a);
        expect(identities[1]).not.toEqual(identities[0]);
        expect(identities[2]).toEqual(identities[0]);
    });
});
