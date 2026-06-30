/**
 * Cross-surface end-to-end coverage for the mutate surface — write → read
 * round-trip with the shared resolver, prefix-gated rejection, execute_command
 * stream bounding, and stable execId derivation across multiple calls.
 *
 * Uses a fake `SandboxClient` that materialises `write_file`/`edit_file` Python
 * commands on the host so the read seam can verify path agreement.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createExecuteCommandTool } from "./execute-command.js";
import { createReadFileTool } from "./read-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix, toSandboxPath } from "../../workspace/paths.js";
import type { ProvenanceCollector, ProvenanceSnapshot } from "../../workspace/provenance-collector.js";
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

function makeFakeClient(opts: { sessionsBasePath: string; lsResult?: { stdout: string; stderr: string } }): FakeClient {
    const submits: SubmitExecBody[] = [];
    return {
        submits,
        async createSandbox() {
            return makeSandboxRef();
        },
        async submitExec(_ref, body) {
            submits.push(body);
            const cmd = body.command;
            if (cmd[0] === "python3" && cmd[2]?.includes("base64.b64decode")) {
                const sandboxPath = cmd[3]!;
                const contentBytes = Buffer.from(cmd[4]!, "base64");
                const hostPath = join(opts.sessionsBasePath, sandboxPath.replace(/^\/+/, ""));
                await mkdir(join(hostPath, ".."), { recursive: true });
                await writeFile(hostPath, contentBytes);
            }
        },
        async awaitExec(execId: string, _secret: string, _emit: ExecEmit, _deadlineMs: number): Promise<ExecResult> {
            if (opts.lsResult) {
                return {
                    execId,
                    exitCode: 0,
                    stdout: opts.lsResult.stdout,
                    stderr: opts.lsResult.stderr,
                    durationMs: 4,
                    timedOut: false,
                };
            }
            return {
                execId,
                exitCode: 0,
                stdout: "",
                stderr: "",
                durationMs: 1,
                timedOut: false,
            };
        },
        async isAlive() {
            return true;
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

class CollectingProvenance implements ProvenanceCollector {
    readonly snapshots: ProvenanceSnapshot[] = [];
    async recordSnapshot(s: ProvenanceSnapshot) {
        this.snapshots.push(s);
    }
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
        const workingDir = stepWritePrefix({
            sessionsBasePath,
            analysisId: ANALYSIS,
            runId: RUN,
            stepId: STEP,
        });
        const prov = new CollectingProvenance();
        const fs = createWorkspaceFilesystem({ sessionsBasePath });
        const sandboxWorkingDir = toSandboxPath(sessionsBasePath, workingDir);
        return { sandbox, workingDir, sandboxWorkingDir, prov, fs };
    }

    it("relative write resolves into the working dir; read_file agrees; single provenance snapshot", async () => {
        const { sandbox, workingDir, sandboxWorkingDir, prov, fs } = setup();
        const client = makeFakeClient({ sessionsBasePath });

        const mutator = createWorkspaceMutator({
            sandboxClient: client,
            sandbox,
            sessionsBasePath,
            analysisId: ANALYSIS,
            runId: RUN,
            stepId: STEP,
            workflowId: "wf1",
            workingDir,
            sandboxWorkingDir,
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            provenance: prov,
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
        expect(prov.snapshots.length).toBe(1);
    });

    it("execute_command runs a command and the result is bounded as expected", async () => {
        const { sandbox, workingDir } = setup();
        const big = "x".repeat(EXEC_STREAM_BYTE_CAP + 10);
        const client = makeFakeClient({
            sessionsBasePath,
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
        const { sandbox, workingDir, sandboxWorkingDir, fs } = setup();
        const client = makeFakeClient({ sessionsBasePath });
        const mutator = createWorkspaceMutator({
            sandboxClient: client,
            sandbox,
            sessionsBasePath,
            analysisId: ANALYSIS,
            runId: RUN,
            stepId: STEP,
            workflowId: "wf1",
            workingDir,
            sandboxWorkingDir,
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
        });
        const writeTool = createWriteFileTool({ mutator });
        const readTool = createReadFileTool(fs);
        const { ctx } = makeToolContext();

        const out = (await writeTool.execute({ path: `/${ANALYSIS}/data/inputs/leak.csv`, content: "leak" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(client.submits.length).toBe(0);

        const read = (await readTool.execute({ path: `/${ANALYSIS}/data/inputs/leak.csv` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("not_found");
    });

    it("two execute_command calls in the same step produce distinct execIds", async () => {
        const { sandbox } = setup();
        const client = makeFakeClient({ sessionsBasePath });
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
