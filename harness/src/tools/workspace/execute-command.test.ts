import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createWorkspaceFilesystem } from "../../workspace/filesystem.js";
import { stepWritePrefix } from "../../workspace/paths.js";
import { createWorkspaceMutator } from "./mutator.js";
import { scriptSha256 } from "./decision-record.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import { createExecuteCommandTool } from "./execute-command.js";
import { EXEC_STREAM_BYTE_CAP } from "./result-bounds.js";

const DEFAULT_CWD = "/analysis-001/runs/run-abc/step1";

function makeSandboxRef(over: Partial<SandboxRef> = {}): SandboxRef {
    return {
        sandboxId: "sb-1",
        host: "127.0.0.1",
        port: 8765,
        backend: "docker",
        callbackSecret: "secret-abc",
        ...over,
    };
}

interface FakeOpts {
    result?: ExecResult;
    intermediateEvents?: readonly unknown[];
    awaitError?: Error;
}

interface FakeSandboxClient extends SandboxClient {
    readonly submits: { ref: SandboxRef; body: SubmitExecBody }[];
    readonly awaits: { execId: string; deadlineMs: number }[];
}

function makeFakeClient(opts: FakeOpts = {}): FakeSandboxClient {
    const submits: { ref: SandboxRef; body: SubmitExecBody }[] = [];
    const awaits: { execId: string; deadlineMs: number }[] = [];
    const result =
        opts.result ??
        ({
            execId: "",
            exitCode: 0,
            stdout: "hello\n",
            stderr: "",
            durationMs: 12,
            timedOut: false,
        } satisfies ExecResult);

    return {
        submits,
        awaits,
        toolchainSource: "store",
        createSandbox() {
            return okAsync(makeSandboxRef());
        },
        async submitExec(ref: SandboxRef, body: SubmitExecBody) {
            submits.push({ ref, body });
        },
        async awaitExec(_ref: SandboxRef, execId: string, emit: ExecEmit, deadlineMs: number) {
            awaits.push({ execId, deadlineMs });
            for (const ev of opts.intermediateEvents ?? []) await emit(ev);
            if (opts.awaitError) throw opts.awaitError;
            return { ...result, execId };
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

describe("execute_command and the decision record of a script", () => {
    const ANALYSIS = "analysis-001";
    let base: string;
    beforeEach(async () => {
        base = mkdtempSync(join(tmpdir(), "ec-record-"));
        await mkdir(join(base, ANALYSIS, "runs", "run-abc", "step1", "scripts"), { recursive: true });
        await mkdir(join(base, ANALYSIS, "runs", "run-abc", "step1", "output"), { recursive: true });
    });
    afterEach(() => {
        rmSync(base, { recursive: true, force: true });
    });

    function stepDir(): string {
        return join(base, ANALYSIS, "runs", "run-abc", "step1");
    }

    function buildTool() {
        const workspaceRoot = join(base, ANALYSIS);
        const workingDir = stepWritePrefix({ workspaceRoot, runId: "run-abc", stepId: "step1" });
        const client = makeFakeClient();
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
            workspaceFilesystem: createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(base, id) }),
            mutator: createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir }),
        });
        return { tool, client };
    }

    async function record(): Promise<Record<string, unknown>> {
        return JSON.parse(await readFile(join(stepDir(), "output", "decision_record_de.json"), "utf8"));
    }

    it("notes a script that changed since its record before the command runs, and leaves an unchanged one alone", async () => {
        const written = "ALPHA <- 0.05\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), written);
        await writeFile(join(stepDir(), "output", "decision_record_de.json"), JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }));
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();

        // Unchanged: the record stays as it is.
        await tool.execute({ command: ["Rscript", "scripts/de.R"] }, ctx);
        expect((await record()).unvetted_edits).toEqual([]);
        expect(client.submits).toHaveLength(1);

        // Changed by a path no file tool recorded: the note lands before the run, with the digest of the bytes that run.
        const changed = "ALPHA <- 0.5\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), changed);
        await tool.execute({ command: ["Rscript", "scripts/de.R", "--verbose"] }, ctx);
        const noted = await record();
        expect(noted.unvetted_edits).toEqual([
            { path: `${DEFAULT_CWD}/scripts/de.R`, note: "the script changed by a path no file tool recorded, before it ran", sha256: scriptSha256(changed) },
        ]);
        expect(client.submits).toHaveLength(2);

        // A second run of the same bytes notes nothing more: the last note is the expected digest now.
        await tool.execute({ command: ["Rscript", `${DEFAULT_CWD}/scripts/de.R`] }, ctx);
        expect(((await record()).unvetted_edits as unknown[]).length).toBe(1);
    });

    it("runs a script of another step whose record it cannot write, and leaves that record as it is", async () => {
        const other = join(base, ANALYSIS, "runs", "run-abc", "step0");
        await mkdir(join(other, "scripts"), { recursive: true });
        await mkdir(join(other, "output"), { recursive: true });
        await writeFile(join(other, "scripts", "de.R"), "ALPHA <- 1\n");
        await writeFile(join(other, "output", "decision_record_de.json"), JSON.stringify({ written_sha256: "sha256:old", unvetted_edits: [] }));
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ command: ["Rscript", `/${ANALYSIS}/runs/run-abc/step0/scripts/de.R`] }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");
        expect(client.submits).toHaveLength(1);
        // The record of another step is outside the writable prefix: the mutator refused the note, and the record is untouched.
        expect(JSON.parse(await readFile(join(other, "output", "decision_record_de.json"), "utf8")).unvetted_edits).toEqual([]);
    });

    it("runs a script without a record, and a command without a script, with no record read", async () => {
        await writeFile(join(stepDir(), "scripts", "own.R"), "x <- 1\n");
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ command: ["Rscript", "scripts/own.R"] }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");
        await tool.execute({ command: ["ls", "-la"] }, ctx);
        expect(client.submits).toHaveLength(2);
    });
});

describe("execute_command tool", () => {
    it("calls submitExec then awaitExec exactly once with one stable execId", async () => {
        const client = makeFakeClient();
        const sandbox = makeSandboxRef();
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox,
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ command: ["echo", "hi"] }, ctx))._unsafeUnwrap();

        expect(client.submits.length).toBe(1);
        expect(client.awaits.length).toBe(1);
        expect(client.submits[0]!.body.execId).toBe("wf1:step1:fn1");
        expect(client.awaits[0]!.execId).toBe("wf1:step1:fn1");
        expect(client.submits[0]!.body.command).toEqual(["echo", "hi"]);
        expect(out.status).toBe("ok");
        if (out.status === "ok") {
            expect(out.exitCode).toBe(0);
            expect(out.stdout).toBe("hello\n");
            expect(out.stdoutTruncated).toBe(false);
        }
    });

    it("names the real cap of each stream in its description", () => {
        const tool = createExecuteCommandTool({
            sandboxClient: makeFakeClient(),
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });

        // The text comes from the cap itself, thus the two cannot differ.
        expect(EXEC_STREAM_BYTE_CAP).toBe(1024 * 1024);
        expect(tool.description).toContain("capped at 1 MiB");
        expect(tool.description).toContain("excerpt");
        expect(tool.description).toContain("not a deliverable");
    });

    it("gives back a stdout of 200 KiB whole", async () => {
        const stdout = "r".repeat(200 * 1024);
        const client = makeFakeClient({ result: { execId: "", exitCode: 0, stdout, stderr: "", durationMs: 5, timedOut: false } });
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });

        const out = (await tool.execute({ command: ["cat", "big.txt"] }, makeToolContext().ctx))._unsafeUnwrap();

        expect(out).toMatchObject({ status: "ok", stdout, stdoutTruncated: false, stdoutTotalLength: 200 * 1024 });
    });

    it("forwards intermediate events via ctx.emit", async () => {
        const client = makeFakeClient({
            intermediateEvents: [
                { kind: "progress", pct: 10 },
                { kind: "progress", pct: 50 },
            ],
        });
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx, emitted } = makeToolContext();

        await tool.execute({ command: ["ls"] }, ctx);

        expect(emitted.length).toBe(2);
        expect((emitted[0] as { type: string }).type).toBe("data-sandbox-event");
    });

    it("derives the same execId across replay (same workflowId/stepId/functionId)", async () => {
        const client = makeFakeClient();
        const sandbox = makeSandboxRef();
        let counterRun1 = 0;
        let counterRun2 = 0;
        const toolRun1 = createExecuteCommandTool({
            sandboxClient: client,
            sandbox,
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => `${++counterRun1}`,
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const toolRun2 = createExecuteCommandTool({
            sandboxClient: client,
            sandbox,
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => `${++counterRun2}`,
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx: ctx1 } = makeToolContext();
        const { ctx: ctx2 } = makeToolContext();

        await toolRun1.execute({ command: ["a"] }, ctx1);
        await toolRun2.execute({ command: ["a"] }, ctx2);

        expect(client.submits[0]!.body.execId).toBe("wf1:step1:1");
        expect(client.submits[1]!.body.execId).toBe("wf1:step1:1");
    });

    it("propagates awaitExec errors so the loop wraps as is_error", async () => {
        const client = makeFakeClient({ awaitError: new Error("hmac mismatch") });
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx } = makeToolContext();

        await expect(tool.execute({ command: ["bad"] }, ctx)).rejects.toThrow(/hmac mismatch/);
    });

    it("truncates oversize stdout while leaving exit/duration/timedOut intact", async () => {
        // Derived from the cap, not a literal: a fixed size silently stops being
        // oversize the moment the cap is raised, and the test then asserts
        // truncation of something that was never truncated.
        const big = "x".repeat(EXEC_STREAM_BYTE_CAP + 1000);
        const client = makeFakeClient({
            result: {
                execId: "",
                exitCode: 137,
                stdout: big,
                stderr: "",
                durationMs: 4321,
                timedOut: true,
            },
        });
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ command: ["yes"] }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");
        if (out.status === "ok") {
            expect(out.stdoutTruncated).toBe(true);
            expect(out.stdoutTotalLength).toBe(big.length);
            expect(out.exitCode).toBe(137);
            expect(out.durationMs).toBe(4321);
            expect(out.timedOut).toBe(true);
        }
    });

    it("passes through cwd/env/timeoutSeconds when supplied", async () => {
        const client = makeFakeClient();
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx } = makeToolContext();
        await tool.execute(
            {
                command: ["pwd"],
                cwd: "/workspace",
                env: { FOO: "bar" },
                timeoutSeconds: 30,
            },
            ctx,
        );
        expect(client.submits[0]!.body.cwd).toBe("/workspace");
        expect(client.submits[0]!.body.env).toEqual({ FOO: "bar" });
        expect(client.submits[0]!.body.timeoutSeconds).toBe(30);
    });

    it("sends defaultCwd when no cwd is supplied", async () => {
        const client = makeFakeClient();
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx } = makeToolContext();
        await tool.execute({ command: ["pwd"] }, ctx);
        expect(client.submits[0]!.body.cwd).toBe(DEFAULT_CWD);
    });

    it("joins a relative cwd onto defaultCwd; uses an absolute cwd as-is", async () => {
        const client = makeFakeClient();
        const tool = createExecuteCommandTool({
            sandboxClient: client,
            sandbox: makeSandboxRef(),
            workflowId: "wf1",
            stepId: "step1",
            nextFunctionId: () => "fn1",
            deadlineMs: () => 9_999_999,
            defaultCwd: DEFAULT_CWD,
        });
        const { ctx } = makeToolContext();
        await tool.execute({ command: ["ls"], cwd: "output" }, ctx);
        expect(client.submits[0]!.body.cwd).toBe(`${DEFAULT_CWD}/output`);

        await tool.execute({ command: ["ls"], cwd: "/analysis-001/data" }, ctx);
        expect(client.submits[1]!.body.cwd).toBe("/analysis-001/data");
    });
});
