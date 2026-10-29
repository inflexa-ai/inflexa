import { describe, expect, test } from "bun:test";

import { callTools, reply, scriptedModel, text, toolCall } from "@inflexa-ai/harness/testing.js";

import { evalAgents } from "../lib/agent.js";
import { blockerSays, hasFile, type EvalCase } from "../lib/case.js";
import { runTrial } from "../lib/run.js";
import { workingDirOf, type SandboxSetup } from "../lib/sandbox.js";

const agents = evalAgents();

const SETUP: SandboxSetup = {
    agentId: "bulk-transcriptomics-agent",
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

        const result = await runTrial(sandboxCase(hasFile("output/echo.txt")), { agents, provider: model.provider, trialTimeoutMs: 10_000 });

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

        const result = await runTrial(sandboxCase(hasFile("output/echo.txt")), { agents, provider: model.provider, trialTimeoutMs: 10_000 });

        expect(result).toMatchObject({ kind: "graded", pass: true });
        expect("unscripted" in result ? result.unscripted : undefined).toBeUndefined();
        expect(JSON.stringify(model.calls[2]?.prompt.at(-1))).toContain("f-counts");
    });

    test("the working directory of a step is under the run of the trial", () => {
        expect(workingDirOf(SETUP)).toBe("/analysis-001/runs/run-001/T1S1");
    });
});
