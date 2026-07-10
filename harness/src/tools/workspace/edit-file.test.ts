import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createEditFileTool } from "./edit-file.js";
import { createReadFileTool } from "./read-file.js";
import { createWorkspaceMutator } from "./mutator.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix, toSandboxPath } from "../../workspace/paths.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";

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
}

function makeFakeClient(sessionsBasePath: string): FakeClient {
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
                const hostPath = join(sessionsBasePath, sandboxPath.replace(/^\/+/, ""));
                await mkdir(join(hostPath, ".."), { recursive: true });
                await writeFile(hostPath, contentBytes);
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
            return { alive: true, oomKilled: false };
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

describe("edit_file tool", () => {
    let sessionsBasePath: string;

    beforeEach(async () => {
        sessionsBasePath = mkdtempSync(join(tmpdir(), "ef-test-"));
        const outputDir = join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output");
        await mkdir(outputDir, { recursive: true });
    });
    afterEach(() => {
        rmSync(sessionsBasePath, { recursive: true, force: true });
    });

    function buildTool() {
        const workspaceRoot = join(sessionsBasePath, ANALYSIS);
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(sessionsBasePath, id) });
        const client = makeFakeClient(sessionsBasePath);
        const workingDir = stepWritePrefix({
            workspaceRoot,
            runId: RUN,
            stepId: STEP,
        });
        const mutator = createWorkspaceMutator({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workspaceRoot,
            analysisId: ANALYSIS,
            stepId: STEP,
            workflowId: "wf1",
            workingDir,
            sandboxWorkingDir: toSandboxPath(workspaceRoot, ANALYSIS, workingDir),
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
        });
        const tool = createEditFileTool({
            mutator,
            workspaceFilesystem: fs,
            workingDir,
        });
        return { tool, client, fs };
    }

    async function seed(content: string, file = "notes.md") {
        await writeFile(join(sessionsBasePath, ANALYSIS, "runs", RUN, STEP, "output", file), content);
    }

    it("round-trip: edits a file in place and read surface returns the post-edit content", async () => {
        await seed("hello world");
        const { tool, fs } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "world",
                    new_string: "harness",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("ok");

        const readTool = createReadFileTool(fs);
        const read = (await readTool.execute({ path: `runs/${RUN}/${STEP}/output/notes.md` }, ctx))._unsafeUnwrap();
        expect(read.status).toBe("ok");
        if (read.status === "ok") expect(read.content).toBe("hello harness");
    });

    it("rejects edits under the read-only inputs tree as out_of_prefix and issues no submitExec", async () => {
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();
        await mkdir(join(sessionsBasePath, ANALYSIS, "data", "inputs"), {
            recursive: true,
        });
        await writeFile(join(sessionsBasePath, ANALYSIS, "data", "inputs", "x.csv"), "a");
        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/data/inputs/x.csv`,
                    old_string: "a",
                    new_string: "b",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("out_of_prefix");
        expect(client.submits.length).toBe(0);
    });

    it("search/replace: unique match required when replace_all=false (canonical case)", async () => {
        await seed("import pandas as pd\nimport numpy as np\nimport pandas as pd\n");
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();

        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "import pandas as pd",
                    new_string: "import polars as pl",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("not_unique");
        expect(client.submits.length).toBe(0);

        const out2 = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "import pandas as pd",
                    new_string: "import polars as pl",
                    replace_all: true,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out2.status).toBe("ok");
        if (out2.status === "ok") expect(out2.replacements).toBe(2);
    });

    it("returns not_found when old_string is absent", async () => {
        await seed("foo");
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/notes.md`,
                    old_string: "bar",
                    new_string: "baz",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("not_found");
    });

    it("returns file_not_found when the target file does not exist", async () => {
        const { tool } = buildTool();
        const { ctx } = makeToolContext();
        const out = (
            await tool.execute(
                {
                    path: `/${ANALYSIS}/runs/${RUN}/${STEP}/output/missing.md`,
                    old_string: "a",
                    new_string: "b",
                    replace_all: false,
                },
                ctx,
            )
        )._unsafeUnwrap();
        expect(out.status).toBe("file_not_found");
    });
});
