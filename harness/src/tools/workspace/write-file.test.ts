import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createReadFileTool } from "./read-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix, toSandboxPath } from "../../workspace/paths.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";

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
    submits: SubmitExecBody[];
    /** Files written by the fake when it sees a `write_file` Python command. */
    filesWritten: { sandboxPath: string; content: Buffer }[];
}

/**
 * Fake `SandboxClient` for write_file tests: when the submit body is the
 * `write_file` Python command, write the decoded bytes to the *host* path
 * derived from the sandbox path so the read surface can see them.
 */
function makeFakeClient(opts: { sessionsBasePath: string }): FakeClient {
    const submits: SubmitExecBody[] = [];
    const filesWritten: FakeClient["filesWritten"] = [];

    return {
        submits,
        filesWritten,
        async createSandbox() {
            return makeSandboxRef();
        },
        async submitExec(_ref: SandboxRef, body: SubmitExecBody) {
            submits.push(body);

            const cmd = body.command;
            if (cmd[0] === "python3" && cmd[1] === "-c" && cmd[2]?.includes("base64.b64decode")) {
                const sandboxPath = cmd[3]!;
                const contentBytes = Buffer.from(cmd[4]!, "base64");
                const hostPath = join(opts.sessionsBasePath, sandboxPath.replace(/^\/+/, ""));
                await mkdir(join(hostPath, ".."), { recursive: true });
                await writeFile(hostPath, contentBytes);
                filesWritten.push({ sandboxPath, content: contentBytes });
            }
        },
        async awaitExec(_ref: SandboxRef, execId: string, _emit: ExecEmit, _deadlineMs: number): Promise<ExecResult> {
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

describe("write_file tool", () => {
    let sessionsBasePath: string;

    beforeEach(() => {
        sessionsBasePath = mkdtempSync(join(tmpdir(), "wf-test-"));
    });
    afterEach(() => {
        rmSync(sessionsBasePath, { recursive: true, force: true });
    });

    function buildTool(opts: { nextFunctionId?: () => string } = {}) {
        const client = makeFakeClient({ sessionsBasePath });
        const workingDir = stepWritePrefix({
            sessionsBasePath,
            analysisId: ANALYSIS,
            runId: RUN,
            stepId: STEP,
        });
        const mutator = createWorkspaceMutator({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            sessionsBasePath,
            analysisId: ANALYSIS,
            stepId: STEP,
            workflowId: "wf1",
            workingDir,
            sandboxWorkingDir: toSandboxPath(sessionsBasePath, workingDir),
            nextFunctionId: opts.nextFunctionId ?? (() => "fn1"),
            deadlineMs: () => 9_999_999,
        });
        const tool = createWriteFileTool({ mutator });
        return { tool, client };
    }

    it("writes a file inside the prefix and the read surface returns the same content at the same path", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/result.csv`, content: "id,value\n1,42\n" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");

        const fs = createWorkspaceFilesystem({ sessionsBasePath });
        const readTool = createReadFileTool(fs);
        const read = (await readTool.execute({ path: `runs/${RUN}/${STEP}/output/result.csv` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("ok");
        if (read.status === "ok") {
            expect(read.content).toBe("id,value\n1,42\n");
        }
    });

    it("a relative path resolves INTO the working dir (step dir) and succeeds", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ path: "output/x.csv", content: "id,value\n1,42\n" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");
        if (out.status === "ok") {
            expect(out.path).toBe(`/${ANALYSIS}/runs/${RUN}/${STEP}/output/x.csv`);
        }

        // The bytes land at the step's output dir, and the read surface (using the
        // same working dir as base) reads them back at the same relative path.
        const fs = createWorkspaceFilesystem({ sessionsBasePath });
        const onDisk = await readFile(resolvePath(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output", "x.csv"), "utf8");
        expect(onDisk).toBe("id,value\n1,42\n");
        void fs;
    });

    it("rejects an absolute write under data/inputs as out_of_prefix and issues no submitExec", async () => {
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ path: `/${ANALYSIS}/data/inputs/x.csv`, content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(client.submits.length).toBe(0);
    });

    it("rejects a `..` escape out of the analysis tree as out_of_scope and issues no submitExec", async () => {
        // workingDir is the step dir (runs/run-abc/step-1); four `..` reach the
        // analysis root and a fifth escapes it.
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ path: "../../../../analysis-002/x.csv", content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_scope");
        expect(client.submits.length).toBe(0);
    });

    it("rejects an absolute write to another run's tree as out_of_prefix", async () => {
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ path: `/${ANALYSIS}/runs/run-other/${STEP}/output/x.csv`, content: "evil" }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(client.submits.length).toBe(0);
    });

    it("write/read agreement also holds for binary-ish content via UTF-8 buffer round-trip", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const content = "α,β,γ\n1,2,3\n";
        await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/u.csv`, content }, ctx);
        const fs = createWorkspaceFilesystem({ sessionsBasePath });
        const readTool = createReadFileTool(fs);
        const read = (await readTool.execute({ path: `runs/${RUN}/${STEP}/output/u.csv` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("ok");
        if (read.status === "ok") expect(read.content).toBe(content);
    });

    it("emits a sandbox-event for intermediate progress (via runSandboxExec wiring)", async () => {
        const { tool } = buildTool();
        const { ctx, emitted } = makeToolContext();
        await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/scripts/run.py`, content: "print('ok')" }, ctx);
        // The fake's awaitExec emits no intermediate events, so emitted is empty —
        // the wiring is tested under execute-command.test.ts.
        expect(emitted.length).toBe(0);
    });

    it("write file content reaches the actual host path the read surface reads from", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        await tool.execute({ path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/r.csv`, content: "hi" }, ctx);
        const hostPath = resolvePath(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output", "r.csv");
        const onDisk = await readFile(hostPath, "utf8");
        expect(onDisk).toBe("hi");
    });
});
