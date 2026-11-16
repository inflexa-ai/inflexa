import { describe, expect, test } from "bun:test";

import { callTools, reply, scriptedModel, text, toolCall } from "@inflexa-ai/harness/testing.js";

import { evalAgents } from "../lib/agent.js";
import type { TemplateContract, TemplateSource } from "@inflexa-ai/harness/tools/knowledge/client.js";

import { blockerSays, hasFileNamed, never, ranTemplate, type EvalCase } from "../lib/case.js";
import { runTrial } from "../lib/run.js";
import { workingDirOf, type SandboxSetup } from "../lib/sandbox.js";

const agents = evalAgents();

const SETUP: SandboxSetup = {
    agentId: "analyst",
    stepId: "T1S1",
    files: { "data/inputs/f-counts/counts.tsv": "gene\tT1\tC1\nTP53\t10\t3\n" },
    packages: [{ name: "pandas", version: "2.2.3", track: "python" }],
    exec: [({ argv }) => (argv[0] === "echo" ? { exitCode: 0, stdout: "hi", writes: { "output/echo.txt": "hi\n" } } : undefined)],
};

function sandboxCase(grade: EvalCase["grade"]): EvalCase {
    return { id: "sandbox-unit", set: "dev", agent: "sandbox", source: "unit", user: "Run the DE.", sandbox: SETUP, maxSteps: 6, grade };
}

describe("a sandbox trial", () => {
    test("writes into the tree of the trial, answers an exec from the rules, and checks an import against the lock", async () => {
        const model = scriptedModel([
            callTools(toolCall("c0", "acquire_sandbox", { cpu: 2, memoryGb: 8 })),
            callTools(toolCall("c1", "write_file", { path: "scripts/de.py", content: "import pandas\nimport pydeseq2\n" })),
            callTools(toolCall("c2", "execute_command", { command: ["python", "scripts/de.py"] })),
            callTools(toolCall("c3", "execute_command", { command: ["echo hi"] })),
            callTools(toolCall("c4", "execute_command", { command: ["samtools", "view", "x.bam"] })),
            callTools(toolCall("c5", "report_blocker", { reason: "pydeseq2 is not in the farm" })),
            reply([text("unreachable")]),
        ]);

        const result = await runTrial(sandboxCase(hasFileNamed("echo.txt")), { agents, provider: model.provider, trialTimeoutMs: 10_000 });

        expect(result).toMatchObject({ kind: "graded", pass: true, files: ["output/echo.txt", "scripts/de.py"], unscripted: ["samtools view x.bam"] });
        expect(model.calls).toHaveLength(6);
        const python = model.calls[3]?.prompt.at(-1);
        expect(JSON.stringify(python)).toContain("No module named 'pydeseq2'");
    });

    test("a blocker ends the trial, and a grader reads its reason", async () => {
        const model = scriptedModel([
            callTools(toolCall("c1", "report_blocker", { reason: "The count matrix is absent; only FASTQ files are present." })),
            reply([text("unreachable")]),
        ]);

        const result = await runTrial(sandboxCase(blockerSays(["count matrix"])), { agents, provider: model.provider, trialTimeoutMs: 10_000 });

        expect(result).toMatchObject({ kind: "graded", pass: true });
        expect(model.calls).toHaveLength(1);
    });

    test("answers each command of a shell line, and keeps a separator inside quotes in its word", async () => {
        const model = scriptedModel([
            callTools(toolCall("c0", "acquire_sandbox", { cpu: 2, memoryGb: 8 })),
            callTools(toolCall("c1", "execute_command", { command: ['ls /analysis-001/data/inputs; python -c "import pandas; print(1)" && echo hi | wc -l'] })),
            reply([text("done")]),
        ]);

        const result = await runTrial(sandboxCase(hasFileNamed("echo.txt")), { agents, provider: model.provider, trialTimeoutMs: 10_000 });

        expect(result).toMatchObject({ kind: "graded", pass: true });
        expect("unscripted" in result ? result.unscripted : undefined).toBeUndefined();
        expect(JSON.stringify(model.calls[2]?.prompt.at(-1))).toContain("f-counts");
    });

    test("the working directory of a step is under the run of the trial", () => {
        expect(workingDirOf(SETUP)).toBe("/analysis-001/runs/run-001/T1S1/work");
    });

    test("a template step renders its template through the source of the setup and runs the script through the rules", async () => {
        const contract: TemplateContract = {
            id: "tpl-echo",
            version: "1.0.0",
            label: "Echo",
            method: "M-0001",
            language: "python",
            parameters: [{ name: "counts_path", type: "string", description: "The counts", adaptable: true, local: true, required: true }],
            outputs: [],
        };
        const source: Partial<TemplateSource> = {
            contract: () => Promise.resolve(contract),
            render: () =>
                Promise.resolve({
                    ok: true as const,
                    snapshot: { date: "2026-10-01", digest: "sha256:unit" },
                    template: { id: "tpl-echo", version: "1.0.0", label: "Echo", method: { id: "M-0001", label: "Echo" }, language: "python" },
                    script: "import pandas\nCOUNTS = {{counts_path}}\n",
                    slots: [{ name: "counts_path", source: "local", adaptable: true, lines: [] }],
                    local_slots: ["counts_path"],
                    environment: { match: "exact" },
                    syntax: { status: "ok" },
                    outputs: [],
                }),
        };
        const template = { step: { ref: "tpl-echo@1.0.0" }, source };
        const model = scriptedModel([
            callTools(toolCall("c0", "acquire_sandbox", { cpu: 2, memoryGb: 8 })),
            callTools(toolCall("c1", "run_template", { slots: { counts_path: "/analysis-001/data/inputs/f-counts/counts.tsv" } })),
            reply([text("Done.")]),
        ]);
        const templateCase: EvalCase = { ...sandboxCase(ranTemplate), sandbox: { ...SETUP, template } };

        const result = await runTrial(templateCase, { agents, provider: model.provider, trialTimeoutMs: 10_000 });

        expect(JSON.stringify(model.calls[0]?.tools ?? [])).toContain("run_template");
        expect(result).toMatchObject({ kind: "graded", pass: true, detail: "ran /analysis-001/runs/run-001/T1S1/work/tpl-echo.py with exit code 0" });
    });

    test("an open step declares no run_template", async () => {
        const model = scriptedModel([reply([text("Done.")])]);

        const result = await runTrial(sandboxCase(never(["run_template"])), { agents, provider: model.provider, trialTimeoutMs: 10_000 });

        expect(JSON.stringify(model.calls[0]?.tools ?? [])).not.toContain("run_template");
        expect(result).toMatchObject({ kind: "graded", pass: true });
    });
});
