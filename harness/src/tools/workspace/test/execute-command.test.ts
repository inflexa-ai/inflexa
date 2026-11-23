import { describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { parseUnknownRecord } from "../../../lib/unknown-containers.js";

import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readToolCallRecord } from "../../define-tool.js";
import { ProvenanceCollector } from "../../../provenance/collector.js";
import type { SandboxClient } from "../../../sandbox/client.js";
import type { ExecEmit, ExecRequest, ExecResult, SandboxRef } from "../../../sandbox/types.js";
import { createExecuteCommandTool, execNote } from "../execute-command.js";
import { leaseOverClient } from "../../../sandbox/__fixtures__/leases.js";
import { EXEC_STREAM_BYTE_CAP } from "../result-bounds.js";
import { presentAt } from "../../../lib/present.js";
import { awaitOk } from "../../../lib/test/result-assert.js";
import { healthySandboxTail } from "../../../agents/sandbox/__fixtures__/deps.js";

const DEFAULT_CWD = "/analysis-001/runs/run-abc/step1";

function makeSandboxRef(over: Partial<SandboxRef> = {}): SandboxRef {
    return {
        sandboxId: "sb-1",
        host: "127.0.0.1",
        port: 8765,
        backend: "docker",
        ...over,
    };
}

type FakeOpts = {
    result?: ExecResult;
    intermediateEvents?: readonly unknown[];
    execError?: Error;
};

type FakeSandboxClient = SandboxClient & {
    readonly execs: { ref: SandboxRef; request: ExecRequest; deadlineMs: number }[];
};

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
        resourceLimits: { maxCpu: 4, maxMemoryGb: 16, maxGpuCount: 0 },
        createSandbox() {
            return okAsync(makeSandboxRef());
        },
        async exec(ref: SandboxRef, request: ExecRequest, emit: ExecEmit, deadlineMs: number) {
            execs.push({ ref, request, deadlineMs });
            for (const ev of opts.intermediateEvents ?? []) await emit(ev);
            if (opts.execError) throw opts.execError;
            return result;
        },
        ...healthySandboxTail(),
    };
}

function makeTool(client: SandboxClient, over: Partial<Parameters<typeof createExecuteCommandTool>[0]> = {}) {
    return createExecuteCommandTool({
        lease: leaseOverClient(client, makeSandboxRef()),
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
        expect(presentAt(client.execs, 0).request.command).toEqual(["echo", "hi"]);
        expect(out.status).toBe("ok");
        expect(out.exitCode).toBe(0);
        expect(out.stdout).toBe("hello\n");
        expect(out.stdoutTruncated).toBe(false);
    });

    it("runs a shell line as a one-element argv", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();
        const tool = makeTool(client);
        const input = tool.inputSchema.parse({ command: "python scripts/cox.py 2>&1 | tail -70" });

        await awaitOk(tool.execute(input, ctx));

        expect(presentAt(client.execs, 0).request.command).toEqual(["python scripts/cox.py 2>&1 | tail -70"]);
    });

    it("names the lease and the deliverable in its description", () => {
        const tool = createExecuteCommandTool({
            lease: leaseOverClient(makeFakeClient(), makeSandboxRef()),
            defaultCwd: DEFAULT_CWD,
        });

        expect(tool.description).toContain("not a deliverable");
        expect(tool.description).toContain("acquire_sandbox");
    });

    it("gives back a stdout of 200 KiB whole", async () => {
        const stdout = "r".repeat(200 * 1024);
        const client = makeFakeClient({ result: { execId: "", exitCode: 0, stdout, stderr: "", durationMs: 5, timedOut: false } });
        const tool = createExecuteCommandTool({
            lease: leaseOverClient(client, makeSandboxRef()),
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

        await awaitOk(makeTool(client).execute({ command: ["ls"] }, ctx));

        expect(emitted).toEqual([
            { type: "data-sandbox-event", data: { event: { kind: "progress", pct: 10 } } },
            { type: "data-sandbox-event", data: { event: { kind: "progress", pct: 50 } } },
        ]);
    });

    it("propagates an exec error so the loop wraps it as is_error", async () => {
        const client = makeFakeClient({ execError: new Error("sandbox unreachable") });
        const { ctx } = makeToolContext();

        await expect(makeTool(client).execute({ command: ["bad"] }, ctx)).rejects.toThrow("sandbox unreachable");
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
        // The result explains the states that it carries, thus the description need not explain them before the call.
        expect(out.note).toContain("The timeout stopped the command.");
        expect(out.note).toContain(`cap of ${EXEC_STREAM_BYTE_CAP / (1024 * 1024)} MiB`);
    });

    it("carries no note for a plain exit", async () => {
        const out = (await makeTool(makeFakeClient()).execute({ command: ["true"] }, makeToolContext().ctx))._unsafeUnwrap();
        expect(out.note).toBeUndefined();
    });

    it("passes through cwd/env/timeoutSeconds when supplied", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();
        await awaitOk(makeTool(client).execute({ command: ["pwd"], cwd: "/workspace", env: { FOO: "bar" }, timeoutSeconds: 30 }, ctx));
        expect(presentAt(client.execs, 0).request.cwd).toBe("/workspace");
        expect(presentAt(client.execs, 0).request.env).toEqual({ FOO: "bar" });
        expect(presentAt(client.execs, 0).request.timeoutSeconds).toBe(30);
    });

    it("sends defaultCwd when no cwd is supplied", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();
        await awaitOk(makeTool(client).execute({ command: ["pwd"] }, ctx));
        expect(presentAt(client.execs, 0).request.cwd).toBe(DEFAULT_CWD);
    });

    it("joins a relative cwd onto defaultCwd; uses an absolute cwd as-is", async () => {
        const client = makeFakeClient();
        const tool = makeTool(client);
        const { ctx } = makeToolContext();
        await awaitOk(tool.execute({ command: ["ls"], cwd: "output" }, ctx));
        expect(presentAt(client.execs, 0).request.cwd).toBe(`${DEFAULT_CWD}/output`);

        await awaitOk(tool.execute({ command: ["ls"], cwd: "/analysis-001/data" }, ctx));
        expect(presentAt(client.execs, 1).request.cwd).toBe("/analysis-001/data");
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
        expect(readToolCallRecord(out)).toEqual({
            command: ["python", "scripts/de.py"],
            scriptPath: "runs/run-abc/step1/scripts/de.py",
            exitCode: 0,
            durationMs: 5,
            provenance: frame,
        });
        // The tool records nothing on its own: the loop folds the record after the call settles.
        expect(collector.getRecords()).toEqual([]);
    });

    it("feeds the frame to the collector when the loop folds the record", async () => {
        const client = makeFakeClient({ result: { execId: "wf1:7", exitCode: 0, stdout: "", stderr: "", durationMs: 5, timedOut: false, provenance: frame } });
        const collector = new ProvenanceCollector({ stepId: "step1", runId: "run-abc", dependsOn: [] });
        const tool = makeTool(client, { lineageCollector: collector, mountRoot: "/analysis-001" });
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ command: ["python", "scripts/de.py"] }, ctx))._unsafeUnwrap();
        const foldCallRecord = tool.foldCallRecord?.bind(tool);
        if (foldCallRecord === undefined) throw new Error("the tool folds no call record");
        foldCallRecord(readToolCallRecord(out));

        expect(collector.getRecords().map((record) => [record.outputPath, record.scriptPath])).toEqual([["output/de.csv", "runs/run-abc/step1/scripts/de.py"]]);
    });

    it.each<[string, string[], string | undefined, string | undefined]>([
        ["a token under a relative cwd", ["Rscript", "../scripts/qc.R"], "output", "runs/run-abc/step1/scripts/qc.R"],
        ["a shell line", ["python3 scripts/de.py --fdr 0.05 > out.txt"], undefined, "runs/run-abc/step1/scripts/de.py"],
        ["an absolute token under the mount", ["bash", "/analysis-001/runs/run-abc/shared/run.sh"], undefined, "runs/run-abc/shared/run.sh"],
        ["a token outside the mount", ["bash", "/usr/local/bin/tool.sh"], undefined, undefined],
        ["no script token", ["ls", "-la"], undefined, undefined],
    ])("records the analysis-relative script path of %s", async (_label, command, cwd, expected) => {
        const client = makeFakeClient({ result: { execId: "wf1:7", exitCode: 0, stdout: "", stderr: "", durationMs: 5, timedOut: false, provenance: frame } });
        const collector = new ProvenanceCollector({ stepId: "step1", runId: "run-abc", dependsOn: [] });
        const { ctx } = makeToolContext();

        const input = cwd === undefined ? { command } : { command, cwd };
        const out = (await makeTool(client, { lineageCollector: collector, mountRoot: "/analysis-001" }).execute(input, ctx))._unsafeUnwrap();

        expect(parseUnknownRecord(readToolCallRecord(out))?.scriptPath).toBe(expected);
    });

    it("carries no call record when no collector is wired", async () => {
        const client = makeFakeClient();
        const { ctx } = makeToolContext();

        const out = (await makeTool(client).execute({ command: ["ls"] }, ctx))._unsafeUnwrap();

        expect(readToolCallRecord(out)).toBeUndefined();
    });
});

describe("execute_command with no lease", () => {
    it("gives an error that names acquire_sandbox, and runs no command", async () => {
        const client = makeFakeClient();
        const tool = createExecuteCommandTool({ lease: leaseOverClient(client, makeSandboxRef(), { held: false }), defaultCwd: DEFAULT_CWD });

        const out = await tool.execute({ command: ["echo", "hi"] }, makeToolContext().ctx);

        expect(out.isErr()).toBe(true);
        expect(out._unsafeUnwrapErr().error).toContain("acquire_sandbox");
        expect(client.execs).toHaveLength(0);
    });
});

describe("execNote — a machine with no exec token", () => {
    it("says that the command did not run, not that the sandbox ended under it", () => {
        const note = execNote({
            execId: "e1",
            exitCode: null,
            stdout: "",
            stderr: "",
            durationMs: null,
            timedOut: false,
            syntheticFailure: { reason: "sandbox-no-exec-token" },
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutTotalLength: 0,
            stderrTotalLength: 0,
        });

        expect(note).toContain("did not run");
        expect(note).not.toContain("ended under the command");
    });
});
