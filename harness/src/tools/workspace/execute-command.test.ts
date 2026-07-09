import { describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { CreateSandboxMeta, ExecEmit, ExecResult, SandboxRef, SubmitExecBody } from "../../sandbox/types.js";
import { createExecuteCommandTool } from "./execute-command.js";

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
        async createSandbox(_meta: CreateSandboxMeta) {
            return makeSandboxRef();
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
        const big = "x".repeat(9000);
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
