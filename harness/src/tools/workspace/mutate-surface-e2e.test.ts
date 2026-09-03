/**
 * Cross-surface end-to-end coverage for the mutate surface — write → read
 * round-trip with the shared resolver, prefix-gated rejection, execute_command
 * stream bounding, and stable execId derivation across multiple calls.
 *
 * `write_file` lands on the host filesystem; a fake `SandboxClient` backs
 * `execute_command` only.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createExecuteCommandTool } from "./execute-command.js";
import { createReadFileTool } from "./read-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import { EXEC_STREAM_BYTE_CAP } from "./result-bounds.js";

const ANALYSIS = "analysis-001";
const RUN = "run-abc";
const STEP = "step-1";

function makeSandboxRef(): SandboxRef {
    return {
        sandboxId: "sb-1",
        host: "127.0.0.1",
        port: 8765,
        backend: "docker",
        callbackSecret: "secret-abc",
    };
}

interface FakeClient extends SandboxClient {
    readonly submits: SubmitExecBody[];
}

function makeFakeClient(opts: { lsResult?: { stdout: string; stderr: string } } = {}): FakeClient {
    const submits: SubmitExecBody[] = [];
    return {
        submits,
        toolchainSource: "store",
        async createSandbox() {
            return makeSandboxRef();
        },
        async submitExec(_ref, body) {
            submits.push(body);
        },
        async awaitExec(_ref: SandboxRef, execId: string, _emit: ExecEmit, _deadlineMs: number): Promise<ExecResult> {
            return {
                execId,
                exitCode: 0,
                stdout: opts.lsResult?.stdout ?? "",
                stderr: opts.lsResult?.stderr ?? "",
                durationMs: 1,
                timedOut: false,
            };
        },
        async isAlive() {
            return { alive: true, oomKilled: false };
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

describe("mutate surface — end-to-end", () => {
    let sessionsBasePath: string;

    beforeEach(() => {
        sessionsBasePath = mkdtempSync(join(tmpdir(), "mutate-e2e-"));
    });
    afterEach(() => {
        rmSync(sessionsBasePath, { recursive: true, force: true });
    });

    function setup() {
        const sandbox = makeSandboxRef();
        const workspaceRoot = join(sessionsBasePath, ANALYSIS);
        const workingDir = stepWritePrefix({
            workspaceRoot,
            runId: RUN,
            stepId: STEP,
        });
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(sessionsBasePath, id) });
        return { sandbox, workspaceRoot, workingDir, fs };
    }

    it("relative write resolves into the working dir; read_file agrees", async () => {
        const { workspaceRoot, workingDir, fs } = setup();

        const mutator = createWorkspaceMutator({
            workspaceRoot,
            analysisId: ANALYSIS,
            workingDir,
        });
        const writeTool = createWriteFileTool({ mutator });
        const readTool = createReadFileTool(fs);

        const { ctx } = makeToolContext();
        const written = (await writeTool.execute({ path: "output/result.csv", content: "id,value\n1,42\n" }, ctx))._unsafeUnwrap();
        expect(written.status).toBe("ok");

        // read the same file back via its analysis-root-relative path
        const read = (await readTool.execute({ path: `runs/${RUN}/${STEP}/output/result.csv` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("ok");
        if (read.status === "ok") expect(read.content).toBe("id,value\n1,42\n");
    });

    it("execute_command runs a command and the result is bounded as expected", async () => {
        const { sandbox, workingDir } = setup();
        const big = "x".repeat(EXEC_STREAM_BYTE_CAP + 10);
        const client = makeFakeClient({
            lsResult: { stdout: big, stderr: "" },
        });

        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox,
            workflowId: "wf1",
            stepId: STEP,
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: `/${ANALYSIS}/runs/${RUN}/${STEP}`,
        });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ command: ["ls", "-la"] }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");
        if (out.status === "ok") {
            expect(out.stdoutTruncated).toBe(true);
            expect(out.stdoutTotalLength).toBe(big.length);
            expect(out.stdout.length).toBe(EXEC_STREAM_BYTE_CAP);
        }
        void workingDir;
    });

    it("absolute write outside the working dir rejected as out_of_prefix + read_file returns not_found (no leak)", async () => {
        const { workspaceRoot, workingDir, fs } = setup();
        const mutator = createWorkspaceMutator({
            workspaceRoot,
            analysisId: ANALYSIS,
            workingDir,
        });
        const writeTool = createWriteFileTool({ mutator });
        const readTool = createReadFileTool(fs);
        const { ctx } = makeToolContext();

        const out = (await writeTool.execute({ path: `/${ANALYSIS}/data/inputs/leak.csv`, content: "leak" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(existsSync(join(workspaceRoot, "data", "inputs", "leak.csv"))).toBe(false);

        const read = (await readTool.execute({ path: `/${ANALYSIS}/data/inputs/leak.csv` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("not_found");
    });

    it("two execute_command calls in the same step produce distinct execIds", async () => {
        const { sandbox } = setup();
        const client = makeFakeClient();
        let counter = 0;
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox,
            workflowId: "wf1",
            stepId: STEP,
            nextFunctionId: () => `${++counter}`,
            deadlineMs: () => 9_999_999,
            defaultCwd: `/${ANALYSIS}/runs/${RUN}/${STEP}`,
        });
        const { ctx } = makeToolContext();
        await tool.execute({ command: ["a"] }, ctx);
        await tool.execute({ command: ["b"] }, ctx);
        expect(client.submits[0]!.execId).toBe(`wf1:${STEP}:1`);
        expect(client.submits[1]!.execId).toBe(`wf1:${STEP}:2`);
        expect(client.submits[0]!.execId).not.toBe(client.submits[1]!.execId);
    });
});
