import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { okAsync } from "neverthrow";

import { parseJsonAs } from "../../../lib/parse-json.js";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { isUnknownArray } from "../../../lib/unknown-array.js";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readToolCallRecord } from "../../define-tool.js";
import { ProvenanceCollector } from "../../../provenance/collector.js";
import { createWorkspaceFilesystem } from "../../../workspace/filesystem.js";
import { stepDecisionRecordDir, stepWritePrefix } from "../../../workspace/paths.js";
import { createWorkspaceMutator } from "../mutator.js";
import { createDecisionRecordStore, scriptSha256 } from "../decision-record.js";
import type { SandboxClient } from "../../../sandbox/client.js";
import type { ExecEmit, ExecRequest, ExecResult, SandboxRef } from "../../../sandbox/types.js";
import { createExecuteCommandTool, runScriptPathsOf, scriptPathsOf } from "../execute-command.js";
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
            lease: leaseOverClient(client, makeSandboxRef()),
            defaultCwd: DEFAULT_CWD,
            workspaceFilesystem: createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(base, id)) }),
            mutator: createWorkspaceMutator({ workspaceRoot, analysisId: ANALYSIS, workingDir }),
            records: createDecisionRecordStore({ resolveWorkspaceRoot: (id) => Promise.resolve(join(base, id)), writePrefix: workingDir }),
        });
        return { tool, client };
    }

    function hostRecordPath(): string {
        return join(stepDecisionRecordDir({ workspaceRoot: join(base, ANALYSIS), runId: "run-abc", stepId: "step1" }), "decision_record_de.json");
    }

    /** A record with a host copy, as `knowledge_template` writes it: the same bytes in the step and on the host. */
    async function writeHeldRecord(content: string): Promise<void> {
        await mkdir(stepDecisionRecordDir({ workspaceRoot: join(base, ANALYSIS), runId: "run-abc", stepId: "step1" }), { recursive: true });
        await writeFile(hostRecordPath(), content);
        await writeFile(join(stepDir(), "output", "decision_record_de.json"), content);
    }

    function asRecord(value: unknown): Record<string, unknown> {
        const record = parseUnknownRecord(value);
        if (record === undefined) throw new Error("the decision record is no object");
        return record;
    }

    async function record(): Promise<Record<string, unknown>> {
        return asRecord(parseJsonAs(await readFile(join(stepDir(), "output", "decision_record_de.json"), "utf8"), z.json()));
    }

    it("notes a script that changed since its record before the command runs, and leaves an unchanged one alone", async () => {
        const written = "ALPHA <- 0.05\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), written);
        await writeFile(join(stepDir(), "output", "decision_record_de.json"), JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }));
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();

        // Unchanged: the record stays as it is.
        await awaitOk(tool.execute({ command: ["Rscript", "scripts/de.R"] }, ctx));
        expect((await record()).unvetted_edits).toEqual([]);
        expect(client.execs).toHaveLength(1);

        // Changed by a path no file tool recorded: the note lands before the run, with the digest of the bytes that run.
        const changed = "ALPHA <- 0.5\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), changed);
        await awaitOk(tool.execute({ command: ["Rscript", "scripts/de.R", "--verbose"] }, ctx));
        const noted = await record();
        expect(noted.unvetted_edits).toEqual([
            { path: `${DEFAULT_CWD}/scripts/de.R`, note: "the script changed by a path no file tool recorded, before it ran", sha256: scriptSha256(changed) },
        ]);
        expect(client.execs).toHaveLength(2);

        // A second run of the same bytes notes nothing more: the last note is the expected digest now.
        await awaitOk(tool.execute({ command: ["Rscript", `${DEFAULT_CWD}/scripts/de.R`] }, ctx));
        const unvetted = (await record()).unvetted_edits;
        if (!isUnknownArray(unvetted)) throw new Error("expected the unvetted edits array");
        expect(unvetted).toHaveLength(1);
        // A record with no host copy stays in the step: a file in the step never becomes a host record.
        expect(existsSync(hostRecordPath())).toBe(false);
    });

    it("writes the copy of a record in the step again from the host copy when a command removed it, and reports it", async () => {
        const written = "ALPHA <- 0.05\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), written);
        const held = `${JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }, null, 2)}\n`;
        await writeHeldRecord(held);
        rmSync(join(stepDir(), "output", "decision_record_de.json"));
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ command: ["Rscript", "scripts/de.R"] }, ctx))._unsafeUnwrap();

        expect(out).toMatchObject({ status: "ok", decision_records_restored: [`${DEFAULT_CWD}/output/decision_record_de.json`] });
        // The copy is the host copy again, and the two copies then take the run of the script.
        const run = { exit_code: 0, sha256: scriptSha256(written), invocation: "test-tool-call" };
        expect(await record()).toEqual({ written_sha256: scriptSha256(written), unvetted_edits: [], runs: [run] });
        expect(await readFile(join(stepDir(), "output", "decision_record_de.json"), "utf8")).toBe(await readFile(hostRecordPath(), "utf8"));
        expect(client.execs).toHaveLength(1);

        // The copy is back, thus the next run reports nothing.
        const again = (await tool.execute({ command: ["Rscript", "scripts/de.R"] }, ctx))._unsafeUnwrap();
        expect("decision_records_restored" in again).toBe(false);
    });

    it("reads the host copy of a record, and not a copy in the step that a command changed", async () => {
        const written = "ALPHA <- 0.05\n";
        const changed = "ALPHA <- 0.5\n";
        await writeHeldRecord(`${JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }, null, 2)}\n`);
        // The copy in the step claims the changed bytes as the render, thus the change would hide behind it.
        await writeFile(join(stepDir(), "output", "decision_record_de.json"), JSON.stringify({ written_sha256: scriptSha256(changed), unvetted_edits: [] }));
        await writeFile(join(stepDir(), "scripts", "de.R"), changed);
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ command: ["Rscript", "scripts/de.R"] }, ctx))._unsafeUnwrap();

        expect(out).toMatchObject({ decision_records_restored: [`${DEFAULT_CWD}/output/decision_record_de.json`] });
        const host = await readFile(hostRecordPath(), "utf8");
        expect(asRecord(parseJsonAs(host, z.json())).unvetted_edits).toEqual([
            { path: `${DEFAULT_CWD}/scripts/de.R`, note: "the script changed by a path no file tool recorded, before it ran", sha256: scriptSha256(changed) },
        ]);
        expect(asRecord(parseJsonAs(host, z.json())).written_sha256).toBe(scriptSha256(written));
        expect(await readFile(join(stepDir(), "output", "decision_record_de.json"), "utf8")).toBe(host);
    });

    it("notes a change in the host copy when a symlink stands in place of the copy in the step", async () => {
        const written = "ALPHA <- 0.05\n";
        const changed = "ALPHA <- 0.5\n";
        await writeHeldRecord(`${JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }, null, 2)}\n`);
        await writeFile(join(stepDir(), "output", "decoy.json"), "kept");
        rmSync(join(stepDir(), "output", "decision_record_de.json"));
        await symlink("decoy.json", join(stepDir(), "output", "decision_record_de.json"));
        await writeFile(join(stepDir(), "scripts", "de.R"), changed);
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();

        await awaitOk(tool.execute({ command: ["Rscript", "scripts/de.R"] }, ctx));

        expect(asRecord(parseJsonAs(await readFile(hostRecordPath(), "utf8"), z.json())).unvetted_edits).toEqual([
            { path: `${DEFAULT_CWD}/scripts/de.R`, note: "the script changed by a path no file tool recorded, before it ran", sha256: scriptSha256(changed) },
        ]);
        expect(await readFile(join(stepDir(), "output", "decoy.json"), "utf8")).toBe("kept");
        expect(client.execs).toHaveLength(1);
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
        expect(client.execs).toHaveLength(1);
        // The record of another step is outside the writable prefix: the mutator refused the note, and the record is untouched.
        expect(asRecord(parseJsonAs(await readFile(join(other, "output", "decision_record_de.json"), "utf8"), z.json())).unvetted_edits).toEqual([]);
    });

    it("runs a changed script of another step and writes neither copy of the record of that step", async () => {
        const other = join(base, ANALYSIS, "runs", "run-abc", "step0");
        const otherHost = join(stepDecisionRecordDir({ workspaceRoot: join(base, ANALYSIS), runId: "run-abc", stepId: "step0" }), "decision_record_de.json");
        const held = `${JSON.stringify({ written_sha256: scriptSha256("ALPHA <- 1\n"), unvetted_edits: [] }, null, 2)}\n`;
        await mkdir(join(other, "scripts"), { recursive: true });
        await mkdir(join(other, "output"), { recursive: true });
        await mkdir(join(otherHost, ".."), { recursive: true });
        await writeFile(join(other, "scripts", "de.R"), "ALPHA <- 2\n");
        await writeFile(join(other, "output", "decision_record_de.json"), held);
        await writeFile(otherHost, held);
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ command: ["Rscript", `/${ANALYSIS}/runs/run-abc/step0/scripts/de.R`] }, ctx))._unsafeUnwrap();

        expect(out.status).toBe("ok");
        expect(client.execs).toHaveLength(1);
        // The record of another step is outside the write prefix of this one: its host copy and its copy stay as they are.
        expect(await readFile(otherHost, "utf8")).toBe(held);
        expect(await readFile(join(other, "output", "decision_record_de.json"), "utf8")).toBe(held);
    });

    it("notes a changed script that a shell line runs, in each form of the line", async () => {
        const written = "ALPHA <- 0.05\n";
        const changed = "ALPHA <- 0.5\n";
        const lines: readonly (readonly string[])[] = [
            ["Rscript scripts/de.R > output/log.txt 2>&1"],
            ["cd scripts && Rscript de.R"],
            ["(Rscript 'scripts/de.R'); echo done"],
            ["bash", "-lc", "Rscript scripts/de.R | tee output/log.txt"],
            ["Rscript", "--file=scripts/de.R"],
        ];
        for (const command of lines) {
            await writeFile(join(stepDir(), "scripts", "de.R"), changed);
            await writeFile(
                join(stepDir(), "output", "decision_record_de.json"),
                JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }),
            );
            const { tool, client } = buildTool();
            const { ctx } = makeToolContext();
            await awaitOk(tool.execute({ command: [...command] }, ctx));
            expect((await record()).unvetted_edits, command.join(" ")).toEqual([
                {
                    path: `${DEFAULT_CWD}/scripts/de.R`,
                    note: "the script changed by a path no file tool recorded, before it ran",
                    sha256: scriptSha256(changed),
                },
            ]);
            // The command runs as the model sent it.
            expect(presentAt(client.execs, 0).request.command).toEqual([...command]);
        }
    });

    it("resolves a path of a shell line against the directory after a cd and against the cwd of the command", () => {
        expect(scriptPathsOf(["cd scripts && Rscript de.R"], "/an/step")).toEqual(["/an/step/scripts/de.R", "/an/step/de.R"]);
        // A subshell ends the move, thus the second script resolves against the two directories.
        expect(scriptPathsOf(["(cd a && python x.py); python scripts/y.py"], "/an/step")).toEqual([
            "/an/step/a/x.py",
            "/an/step/x.py",
            "/an/step/a/scripts/y.py",
            "/an/step/scripts/y.py",
        ]);
        // A second cd after a subshell starts from the cwd of the command, and the paths hold that script.
        expect(scriptPathsOf(["(cd scripts && Rscript a.R); cd scripts && Rscript b.R"], "/an/step")).toContain("/an/step/scripts/b.R");
        // A target that the shell expands moves nothing.
        expect(scriptPathsOf(["cd $OUT && Rscript de.R"], "/an/step")).toEqual(["/an/step/de.R"]);
        // An element of a direct argv is one path, also with a space in it.
        expect(scriptPathsOf(["Rscript", "my scripts/de.R"], "/an/step")).toEqual(["/an/step/my scripts/de.R", "/an/step/scripts/de.R"]);
        expect(scriptPathsOf(["ls", "-la"], "/an/step")).toEqual([]);
        // A command names a small number of scripts, and the check has a bound.
        const many = Array.from({ length: 40 }, (_, i) => `s${String(i)}.R`).join(" ");
        expect(scriptPathsOf([many], "/an/step")).toHaveLength(16);
        // The bound is for the words of a line. An element that is a path always gets its check, also after a long element.
        expect(scriptPathsOf(["env", `FILES=${many}`, "Rscript", "scripts/de.R"], "/an/step")).toContain("/an/step/scripts/de.R");
    });

    it("writes a run entry in both copies of the record after the command, with the exit code and the digest that ran", async () => {
        const written = "ALPHA <- 0.05\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), written);
        await writeHeldRecord(`${JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }, null, 2)}\n`);
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        const out = (await tool.execute({ command: ["Rscript scripts/de.R > output/log.txt"] }, ctx))._unsafeUnwrap();

        const run = { exit_code: 0, sha256: scriptSha256(written), invocation: "test-tool-call" };
        expect((await record()).runs).toEqual([run]);
        expect(asRecord(parseJsonAs(await readFile(hostRecordPath(), "utf8"), z.json())).runs).toEqual([run]);
        // The two copies are the same bytes, thus the next command reports no restored record.
        expect(await readFile(hostRecordPath(), "utf8")).toBe(await readFile(join(stepDir(), "output", "decision_record_de.json"), "utf8"));
        expect(out).not.toHaveProperty("decision_records_restored");
        // The host does a tool call again after a recovery, and the command ran one time: no second entry.
        await awaitOk(tool.execute({ command: ["Rscript scripts/de.R > output/log.txt"] }, ctx));
        expect((await record()).runs).toEqual([run]);
        const again = (await tool.execute({ command: ["Rscript", "scripts/de.R"] }, { ...ctx, invocationId: "call-2" }))._unsafeUnwrap();
        expect(again).not.toHaveProperty("decision_records_restored");
        expect((await record()).runs).toEqual([run, { ...run, invocation: "call-2" }]);
        expect((await record()).unvetted_edits).toEqual([]);

        // Two commands of one script that end together: each note reads the record and then writes it, in order.
        await Promise.all(
            ["call-3", "call-4", "call-5"].map((invocationId) => tool.execute({ command: ["Rscript", "scripts/de.R"] }, { ...ctx, invocationId })),
        );
        expect((await record()).runs).toHaveLength(5);
    });

    it("writes the run of a changed script with the digest of the bytes that ran, after the change note", async () => {
        const written = "ALPHA <- 0.05\n";
        const changed = "ALPHA <- 0.5\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), changed);
        await writeHeldRecord(`${JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }, null, 2)}\n`);
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        await awaitOk(tool.execute({ command: ["Rscript", "scripts/de.R"] }, ctx));

        const held = await record();
        expect(held.unvetted_edits).toHaveLength(1);
        expect(held.runs).toEqual([{ exit_code: 0, sha256: scriptSha256(changed), invocation: "test-tool-call" }]);
    });

    it("writes no run entry for a command that reads the script as data", async () => {
        const written = "ALPHA <- 0.05\n";
        await writeFile(join(stepDir(), "scripts", "de.R"), written);
        await writeHeldRecord(`${JSON.stringify({ written_sha256: scriptSha256(written), unvetted_edits: [] }, null, 2)}\n`);
        const { tool } = buildTool();
        const { ctx } = makeToolContext();

        for (const command of [
            ["cat", "scripts/de.R"],
            ["cat scripts/de.R | head"],
            ["wc", "-l", "scripts/de.R"],
            // A pipe ends with the exit code of `tee`, thus it proves no run that ended well.
            ["Rscript scripts/de.R | tee output/log.txt"],
        ]) {
            await awaitOk(tool.execute({ command }, ctx));
        }

        expect(await record()).not.toHaveProperty("runs");
    });

    it("tells a script that the command runs from a script that the command reads", () => {
        const cwd = "/an/step";
        const de = "/an/step/scripts/de.R";
        for (const command of [
            ["Rscript", "scripts/de.R"],
            ["Rscript", "--vanilla", "scripts/de.R"],
            ["/usr/bin/Rscript", "scripts/de.R"],
            ["scripts/de.R"],
            ["Rscript scripts/de.R"],
            ["Rscript scripts/de.R > output/log.txt 2>&1"],
            ["Rscript --vanilla scripts/de.R"],
            ["Rscript scripts/de.R>output/log.txt"],
            ["Rscript scripts/de.R 2> output/err.txt"],
            ["Rscript scripts/de.R --input data/counts.csv >> output/log.txt"],
            ["cd scripts && Rscript de.R"],
            ["mkdir -p output && Rscript scripts/de.R > output/log.txt"],
        ]) {
            expect(runScriptPathsOf(command, cwd), command.join(" ")).toEqual([de]);
        }
        // A `2>&1` that touches a directory name is part of no word that the host can tell: no path, and not the wrong script.
        expect(runScriptPathsOf(["cd scripts2>&1 && Rscript de.R"], cwd)).toEqual([]);
        expect(runScriptPathsOf(["cd scripts&&Rscript de.R"], cwd)).toEqual([]);
        // A rendered script can have a name with no extension. The runner names it, and the digest check reads it also.
        expect(runScriptPathsOf(["Rscript", "scripts/fit"], cwd)).toEqual(["/an/step/scripts/fit"]);
        expect(scriptPathsOf(["Rscript scripts/fit > output/log.txt"], cwd)).toEqual(["/an/step/scripts/fit"]);
        // A cd of the chain moves the script: the script of the cwd did not run.
        expect(runScriptPathsOf(["cd output && Rscript scripts/de.R"], cwd)).toEqual(["/an/step/output/scripts/de.R"]);
        // In each of these forms the exit code is not the exit code of the script, or the script does not run.
        for (const command of [
            ["cat", "scripts/de.R"],
            ["cat scripts/de.R"],
            ["cp scripts/de.R scripts/copy.R"],
            ["python", "scripts/own.py", "scripts/de.R"],
            ["Rscript scripts/de.R | tee output/log.txt"],
            ["echo 'Rscript scripts/de.R'"],
            ["true || Rscript scripts/de.R"],
            ["Rscript scripts/de.R; echo done"],
            ["Rscript scripts/de.R && echo done"],
            ["Rscript scripts/de.R &"],
            ["(Rscript scripts/de.R)"],
            ["bash", "-lc", "Rscript scripts/de.R"],
            ["time", "Rscript", "scripts/de.R"],
            ["Rscript -e \"source('scripts/de.R')\""],
            ["echo $(Rscript scripts/de.R)"],
            // A mode of the runner that ends with exit code 0 and runs nothing.
            ["Rscript", "--version", "scripts/de.R"],
            ["bash -n scripts/de.R"],
            ["node", "--check", "scripts/de.R"],
            // A cd that the host cannot resolve, and a word that is no command.
            ["cd ~ && Rscript scripts/de.R"],
            ["echo 2>&1 scripts/de.R extra && true"],
            // An input redirect: the shell runs the other script.
            ["python < scripts/de.R scripts/other.py"],
            // A command of the chain that ends the shell before the script.
            ["exit 0 && Rscript scripts/de.R"],
            ["exec true && Rscript scripts/de.R"],
            // R reads its options after the file also, thus `R` is no runner here.
            ["R", "--vanilla", "-f", "scripts/de.R", "--version"],
            ["Rscript", "-e", "1", "scripts/de.R"],
            // `--file=` is an option of R, and an option after it can stop the run.
            ["Rscript", "--file=scripts/de.R", "--version"],
        ]) {
            expect(runScriptPathsOf(command, cwd), command.join(" ")).not.toContain(de);
            // The digest check before the run still reads the script.
            expect(scriptPathsOf(command, cwd), command.join(" ")).toContain(de);
        }
    });

    it("runs a script without a record, and a command without a script, with no record read", async () => {
        await writeFile(join(stepDir(), "scripts", "own.R"), "x <- 1\n");
        const { tool, client } = buildTool();
        const { ctx } = makeToolContext();
        const out = (await tool.execute({ command: ["Rscript", "scripts/own.R"] }, ctx))._unsafeUnwrap();
        expect(out.status).toBe("ok");
        await awaitOk(tool.execute({ command: ["ls", "-la"] }, ctx));
        expect(client.execs).toHaveLength(2);
    });
});

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
