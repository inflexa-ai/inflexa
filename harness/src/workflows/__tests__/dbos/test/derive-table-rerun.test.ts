/**
 * A rerun of a `derive_table` call inside a workflow, against the real engine.
 *
 * The turn workflow runs the tool in a step named for its call, the way the loop does. The script of the
 * first attempt runs, and the attempt parks before its record lands, until the test cancels the workflow
 * from outside. That is a crash after the exec and before the record, with the container still up. The
 * resume runs the step again. The identity of the sandbox and of the exec comes from the step, thus the
 * rerun asks for the same container and the same exec. The stubbed sandbox gives the record of an exec id
 * that it ran, the same as sandbox-server, thus the script does not run again, and the table of the first
 * exec becomes the record.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { err, okAsync, ResultAsync, type Result } from "neverthrow";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { recoverAtCrashPoint } from "../../../../__tests__/setup/dbos-crash.js";
import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import type { DbError } from "../../../../lib/db-result.js";
import type { SandboxClient } from "../../../../sandbox/client.js";
import type { ExecRequest, ExecResult, SandboxIdentity, SandboxRef } from "../../../../sandbox/types.js";
import type { AppendDerivationOutcome, DerivationRecord } from "../../../../state/report-session-state.js";
import { makeToolContext } from "../../../../tools/__fixtures__/tool-context.js";
import type { ToolContext } from "../../../../tools/define-tool.js";
import type { ReportSessionStateGateway } from "../../../../tools/report-authoring/authoring-tools.js";
import { createDeriveTableTool, DERIVE_OUTPUT_ENV, type DeriveTableResult } from "../../../../tools/report-session/derive-table.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" in workflow-replay.test.ts).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS_ID = "analysis-derive-rerun";
const PINNED_PATH = "runs/r1/output/de.csv";
const TABLE = "group,yield\na,3\n";

let root = "";
const records: DerivationRecord[] = [];
const identities: SandboxIdentity[] = [];
const execIds: string[] = [];
let scriptRuns = 0;
let parked = false;
let release: (() => void) | undefined;

const gateway: ReportSessionStateGateway = {
    load: () => {
        const artifacts: Record<string, { hash: string }> = { [PINNED_PATH]: { hash: "sha256:aaa" } };
        for (const record of records) artifacts[record.outputPath] = { hash: record.outputHash };
        return Promise.resolve({
            outcome: "found",
            state: { document: { title: "", sections: [] }, snapshot: { artifacts } },
            analysisId: ANALYSIS_ID,
            token: { title: "", sections: [] },
            seenDocumentHash: null,
            derivations: [...records],
        });
    },
    persist: () => Promise.resolve({ outcome: "persisted" }),
    stampRendered: () => Promise.resolve({ outcome: "stamped" }),
    stampSeen: () => Promise.resolve({ outcome: "stamped" }),
};

/** The first append parks until the cancel, and then it fails, thus the record of the first attempt never lands. */
const derivations = {
    appendDerivation(_threadId: string, record: DerivationRecord): ResultAsync<AppendDerivationOutcome, DbError> {
        if (!parked) {
            parked = true;
            const fault: DbError = { type: "mutation_failed", op: "append", cause: new Error("the host stopped") };
            return new ResultAsync(
                new Promise<Result<AppendDerivationOutcome, DbError>>((resolve) => {
                    release = () => resolve(err(fault));
                }),
            );
        }
        records.push(record);
        return okAsync("appended");
    },
};

const ref: SandboxRef = { sandboxId: "sbx-derive", host: "127.0.0.1", port: 8765, backend: "docker" };
const held = new Map<string, ExecResult>();
const sandboxClient: SandboxClient = {
    toolchainSource: "store",
    createSandbox: (_session, _spec, identity) => {
        identities.push(identity);
        return okAsync(ref);
    },
    async exec(_ref: SandboxRef, request: ExecRequest, _emit, _deadline, execId?: string): Promise<ExecResult> {
        if (execId === undefined) throw new Error("the step sandbox gives each exec its id");
        execIds.push(execId);
        const known = held.get(execId);
        if (known !== undefined) return known;
        scriptRuns += 1;
        const output = request.env?.[DERIVE_OUTPUT_ENV];
        if (output === undefined) throw new Error("the derive output env is absent");
        const host = join(root, output.slice(`/${ANALYSIS_ID}/`.length));
        await mkdir(dirname(host), { recursive: true });
        await writeFile(host, TABLE, "utf8");
        const result: ExecResult = { execId, exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
        held.set(execId, result);
        return result;
    },
    teardown: () => Promise.resolve(),
    isAlive: () => Promise.resolve({ alive: true, oomKilled: false }),
    isAliveById: () => Promise.resolve({ alive: true, oomKilled: false }),
    teardownById: () => Promise.resolve(),
    listManagedSandboxes: () => Promise.resolve([]),
};

const tool = createDeriveTableTool({
    gateway,
    resolveWorkspaceRoot: () => Promise.resolve(root),
    derivations,
    sandboxClient,
});

function callContext(callId: string): ToolContext {
    const { ctx } = makeToolContext();
    return { ...ctx, invocationId: callId, session: { ...ctx.session, scope: { kind: "analysis", analysisId: ANALYSIS_ID, threadId: "t1" } } };
}

const turn = DBOS.registerWorkflow(
    async (callId: string): Promise<DeriveTableResult> =>
        DBOS.runStep(
            async () => (await tool.execute({ script: "print(1)", inputs: [PINNED_PATH], output: "yield.csv" }, callContext(callId)))._unsafeUnwrap(),
            { name: `derive_table.${callId}` },
        ),
    { name: "derive-table-rerun-turn" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("derive_table_rerun");
    if (!DBOS.isInitialized()) await DBOS.launch();
    root = await mkdtemp(join(tmpdir(), "derive-rerun-"));
});

afterAll(async () => {
    await rig.drop();
    await rm(root, { recursive: true, force: true });
});

describe("a rerun of a derive_table call before its record", () => {
    it("adopts the container and the exec of the first attempt, and the script does not run again", async () => {
        const wfId = rig.nextWorkflowId("derive-table-rerun-");
        const first = await DBOS.startWorkflow(turn, { workflowID: wfId })("call-1");
        // The parked append ends only when the test releases it after the cancel.
        const ended = (async (): Promise<void> => {
            while ((await DBOS.getWorkflowStatus(wfId))?.status !== "CANCELLED") await sleep(25);
            release?.();
            await first.getResult().catch(() => undefined);
        })();

        const handle = await recoverAtCrashPoint<DeriveTableResult>(wfId, () => parked, { ended });
        const result = await handle.getResult();

        expect(result).toMatchObject({ outcome: "derived", path: "report-sessions/t1/derived/yield.csv" });
        expect(scriptRuns).toBe(1);
        expect(identities).toHaveLength(2);
        expect(identities[1]).toEqual(identities[0]);
        expect(execIds).toHaveLength(2);
        expect(execIds[1]).toBe(execIds[0]);
        expect(execIds[0]?.startsWith(`${wfId}:`)).toBe(true);
        expect(records.map((record) => record.toolCallId)).toEqual(["call-1"]);
    });
});
