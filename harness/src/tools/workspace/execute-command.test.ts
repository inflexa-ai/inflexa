import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { readToolCallRecord } from "../define-tool.js";
import { ProvenanceCollector } from "../../provenance/collector.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { ExecEmit, ExecRequest, ExecResult, SandboxRef } from "../../sandbox/types.js";
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
    execError?: Error;
}

interface FakeSandboxClient extends SandboxClient {
    readonly execs: { ref: SandboxRef; request: ExecRequest; deadlineMs: number }[];
}

function makeFakeClient(opts: FakeOpts = {}): FakeSandboxClient {
    const execs: { ref: SandboxRef; request: ExecRequest; deadlineMs: number }[] = [];
    const result =
        opts.result ??
        ({
            execId: "wf1:7",
            exitCode: 0,
            stdout: "hello\n",
            stderr: "",
            durationMs: 12,
            timedOut: false,
        } satisfies ExecResult);

    return {
        execs,
        toolchainSource: "store",
        createSandbox() {
            return okAsync(makeSandboxRef());
        },
        async exec(ref: SandboxRef, request: ExecRequest, emit: ExecEmit, deadlineMs: number) {
            execs.push({ ref, request, deadlineMs });
            for (const ev of opts.intermediateEvents ?? []) await emit(ev);
            if (opts.execError) throw opts.execError;
            return result;
        },
        async isAlive() {
            return { alive: true, oomKilled: false };
        },
        async isAliveById() {
            return { alive: true, oomKilled: false };
        },
        async teardown() {},
        async teardownById() {},
        async listManagedSandboxes() {
            return [];
        },
    };
}

function makeTool(client: SandboxClient, over: Partial<Parameters<typeof createExecuteCommandTool>[0]> = {}) {
    return createExecuteCommandTool({
        sandboxClient: client,
        sandbox: makeSandboxRef(),
        deadlineMs: () => 9_999_999,
        defaultCwd: DEFAULT_CWD,
        ...over,
    });
}

describe("execute_command tool", () => {
    it("runs exactly one exec with the command and the step deadline", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();

        const out = (await makeTool(client).execute({ command: ["echo", "hi"] }, ctx))._unsafeUnwrap();

        expect(client.execs).toHaveLength(1);
        expect(client.execs[0]!.request.command).toEqual(["echo", "hi"]);
        expect(client.execs[0]!.deadlineMs).toBe(9_999_999);
        expect(out.status).toBe("ok");
        expect(out.exitCode).toBe(0);
        expect(out.stdout).toBe("hello\n");
        expect(out.stdoutTruncated).toBe(false);
    });

    it("names the real cap of each stream in its description", () => {
        const tool = createExecuteCommandTool({
            sandboxClient: makeFakeClient(),
            sandbox: makeSandboxRef(),
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
        const { ctx, emitted } = makeToolContext();

        await makeTool(client).execute({ command: ["ls"] }, ctx);

        expect(emitted).toEqual([
            { type: "data-sandbox-event", data: { event: { kind: "progress", pct: 10 } } },
            { type: "data-sandbox-event", data: { event: { kind: "progress", pct: 50 } } },
        ]);
    });

    it("propagates an exec error so the loop wraps it as is_error", async () => {
        const client = makeFakeClient({ execError: new Error("hmac mismatch") });
        const { ctx } = makeToolContext();

        await expect(makeTool(client).execute({ command: ["bad"] }, ctx)).rejects.toThrow(/hmac mismatch/);
    });

    it("truncates oversize stdout while leaving exit/duration/timedOut intact", async () => {
        // Derived from the cap, not a literal: a fixed size silently stops being
        // oversize the moment the cap is raised, and the test then asserts
        // truncation of something that was never truncated.
        const big = "x".repeat(EXEC_STREAM_BYTE_CAP + 1000);
        const client = makeFakeClient({
            result: {
                execId: "wf1:7",
                exitCode: 137,
                stdout: big,
                stderr: "",
                durationMs: 4321,
                timedOut: true,
            },
        });
        const { ctx } = makeToolContext();
        const out = (await makeTool(client).execute({ command: ["yes"] }, ctx))._unsafeUnwrap();
        expect(out.stdoutTruncated).toBe(true);
        expect(out.stdoutTotalLength).toBe(big.length);
        expect(out.exitCode).toBe(137);
        expect(out.durationMs).toBe(4321);
        expect(out.timedOut).toBe(true);
    });

    it("passes through cwd/env/timeoutSeconds when supplied", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();
        await makeTool(client).execute({ command: ["pwd"], cwd: "/workspace", env: { FOO: "bar" }, timeoutSeconds: 30 }, ctx);
        expect(client.execs[0]!.request.cwd).toBe("/workspace");
        expect(client.execs[0]!.request.env).toEqual({ FOO: "bar" });
        expect(client.execs[0]!.request.timeoutSeconds).toBe(30);
    });

    it("sends defaultCwd when no cwd is supplied", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();
        await makeTool(client).execute({ command: ["pwd"] }, ctx);
        expect(client.execs[0]!.request.cwd).toBe(DEFAULT_CWD);
    });

    it("joins a relative cwd onto defaultCwd; uses an absolute cwd as-is", async () => {
        const client = makeFakeClient();
        const tool = makeTool(client);
        const { ctx } = makeToolContext();
        await tool.execute({ command: ["ls"], cwd: "output" }, ctx);
        expect(client.execs[0]!.request.cwd).toBe(`${DEFAULT_CWD}/output`);

        await tool.execute({ command: ["ls"], cwd: "/analysis-001/data" }, ctx);
        expect(client.execs[1]!.request.cwd).toBe("/analysis-001/data");
    });
});

describe("execute_command lineage", () => {
    const frame = {
        disabled: false,
        reads: [{ path: "/analysis-001/data/inputs/counts.csv", layers: ["inotify"] }],
        writes: [{ path: "/analysis-001/runs/run-abc/step1/output/de.csv", layers: ["inotify"] }],
        deletes: [],
    };

    it("carries the provenance frame on the call record, never in the model-facing value", async () => {
        const client = makeFakeClient({ result: { execId: "wf1:7", exitCode: 0, stdout: "", stderr: "", durationMs: 5, timedOut: false, provenance: frame } });
        const collector = new ProvenanceCollector({ stepId: "step1", runId: "run-abc", dependsOn: [] });
        const { ctx } = makeToolContext();

        const out = (
            await makeTool(client, { lineageCollector: collector, mountRoot: "/analysis-001" }).execute({ command: ["python", "scripts/de.py"] }, ctx)
        )._unsafeUnwrap();

        expect(JSON.stringify(out)).not.toContain("layers");
        expect(readToolCallRecord(out)).toEqual({ command: ["python", "scripts/de.py"], exitCode: 0, durationMs: 5, provenance: frame });
        // The tool records nothing on its own: the loop folds the record after the call settles.
        expect(collector.getRecords()).toEqual([]);
    });

    it("feeds the frame to the collector when the loop folds the record", async () => {
        const client = makeFakeClient({ result: { execId: "wf1:7", exitCode: 0, stdout: "", stderr: "", durationMs: 5, timedOut: false, provenance: frame } });
        const collector = new ProvenanceCollector({ stepId: "step1", runId: "run-abc", dependsOn: [] });
        const tool = makeTool(client, { lineageCollector: collector, mountRoot: "/analysis-001" });
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ command: ["python", "scripts/de.py"] }, ctx))._unsafeUnwrap();
        tool.foldCallRecord!(readToolCallRecord(out));

        expect(collector.getRecords().map((record) => record.outputPath)).toEqual(["output/de.csv"]);
    });

    it("carries no call record when no collector is wired", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();

        const out = (await makeTool(client).execute({ command: ["ls"] }, ctx))._unsafeUnwrap();

        expect(readToolCallRecord(out)).toBeUndefined();
    });
});
