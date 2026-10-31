import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions, LanguageModelV4ToolResultPart } from "@ai-sdk/provider";
import { referencedToolOutput } from "../../lib/test/text-shapes.js";
import { ok, okAsync } from "neverthrow";
import type { ModelMessage } from "ai";
import { z } from "zod";

import type { KeptToolOutput, ToolOutputStore } from "../../loop/tool-output.js";
import type { AgentDefinition } from "../../loop/types.js";
import type { ChatProvider } from "../../providers/types.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptedReply } from "../../testing.js";
import { defineTool, type Tool } from "../../tools/define-tool.js";
import { createReadToolOutputTool } from "../../tools/read-tool-output.js";
import { createGrepTool, createReadFileTool } from "../../tools/workspace/index.js";
import { createWorkspaceFilesystem, type WorkspaceFilesystem } from "../../workspace/filesystem.js";

import { generateStepSummary, type GenerateStepSummaryOptions } from "../step-summary.js";
import { presentAt, presentFind } from "../../lib/present.js";

/** The text of the last message of a request, which is the summary request of the harness. */
function lastTextOf(call: LanguageModelV4CallOptions): string {
    const last = call.prompt.at(-1);
    if (last?.role !== "user") throw new Error("expected a user message");
    return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function textMessage(value: string): ScriptedReply {
    return reply([text(value)]);
}

function readFileCall(id: string, path: string): ScriptedReply {
    return callTools(toolCall(id, "read_file", { path }));
}

/** Fake fs whose readFile is never expected to fire — for the no-read paths. */
const NOOP_FS: WorkspaceFilesystem = {
    readFile() {
        return okAsync({ kind: "not_found" });
    },
    readBytes() {
        return okAsync({ kind: "not_found" });
    },
    list() {
        return okAsync({ kind: "not_found" });
    },
    stat() {
        return okAsync({ kind: "not_found" });
    },
};

const STEP_DIR = "/sessions/analysis-001/runs/run-1/step-1";

const TRANSCRIPT: ModelMessage[] = [
    { role: "user", content: "Analyze the count matrix at data/inputs/counts.csv." },
    {
        role: "assistant",
        content: [{ type: "text", text: "I will compute differential expression." }],
    },
];

const METADATA_MESSAGES: ModelMessage[] = [
    { role: "user", content: "Describe the output files." },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "m1", toolName: "submit_file_metadata", input: { files: [] } }] },
    {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "m1", toolName: "submit_file_metadata", output: { type: "json", value: { accepted: true } } }],
    },
    { role: "assistant", content: [{ type: "text", text: "Described." }] },
];

const ARTIFACT_PATHS = ["output/de-results.csv", "figures/volcano.png", "scripts/de.py"];

function stepAgent(fs: WorkspaceFilesystem, stepDir: string, extra: readonly Tool[] = []): AgentDefinition {
    return {
        id: "bulk-transcriptomics-agent",
        systemPrompt: "You are a test step agent.",
        model: "claude-opus-4-7",
        tools: [createReadFileTool(fs, stepDir), createGrepTool(fs, stepDir), ...extra],
        maxIterations: 30,
    };
}

function options(provider: ChatProvider, over: Partial<GenerateStepSummaryOptions> = {}): GenerateStepSummaryOptions {
    return {
        provider,
        session: makeSession(),
        agent: stepAgent(NOOP_FS, STEP_DIR),
        conversation: TRANSCRIPT,
        artifactPaths: ARTIFACT_PATHS,
        stepId: "step-1",
        agentId: "bulk-transcriptomics-agent",
        runId: "run-1",
        ...over,
    };
}

function toolResults(call: LanguageModelV4CallOptions): LanguageModelV4ToolResultPart[] {
    return call.prompt.flatMap((m) => (m.role === "tool" ? m.content : [])).flatMap((part) => (part.type === "tool-result" ? [part] : []));
}

describe("generateStepSummary", () => {
    it("returns { stepId, agentId, markdown } on a final text turn", async () => {
        const { provider } = scriptedModel([textMessage("# Results\n\n- DE genes: 42")]);
        const out = await generateStepSummary(options(provider));
        expect(out).toEqual({
            stepId: "step-1",
            agentId: "bulk-transcriptomics-agent",
            markdown: "# Results\n\n- DE genes: 42",
        });
    });

    it("declares the tools of the agent, and its messages start with the transcript and the metadata messages", async () => {
        const { provider, calls } = scriptedModel([textMessage("summary")]);
        const agent = stepAgent(NOOP_FS, STEP_DIR);
        const conversation = [...TRANSCRIPT, ...METADATA_MESSAGES];

        await generateStepSummary(options(provider, { agent, conversation }));

        const request = presentAt(calls, 0);
        expect(request.prompt[0]).toMatchObject({ role: "system", content: "You are a test step agent." });
        expect(request.tools?.map((t) => t.name)).toEqual(agent.tools.map((t) => t.id));
        expect(request.prompt.slice(1, 1 + conversation.length)).toMatchObject([
            { role: "user", content: [{ type: "text", text: "Analyze the count matrix at data/inputs/counts.csv." }] },
            { role: "assistant", content: [{ type: "text", text: "I will compute differential expression." }] },
            { role: "user", content: [{ type: "text", text: "Describe the output files." }] },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "m1", toolName: "submit_file_metadata", input: { files: [] } }] },
            {
                role: "tool",
                content: [{ type: "tool-result", toolCallId: "m1", toolName: "submit_file_metadata", output: { type: "json", value: { accepted: true } } }],
            },
            { role: "assistant", content: [{ type: "text", text: "Described." }] },
        ]);
        // The system prompt, the conversation, then the summary request.
        expect(request.prompt).toHaveLength(1 + conversation.length + 1);
    });

    it("appends the artifact list to the summary request", async () => {
        const { provider, calls } = scriptedModel([textMessage("summary")]);
        await generateStepSummary(options(provider));
        const last = lastTextOf(presentAt(calls, 0));
        for (const path of ARTIFACT_PATHS) {
            expect(last).toContain(path);
        }
    });

    it("reads a persisted output file and grounds the summary in its contents", async () => {
        const base = await mkdtemp(join(tmpdir(), "step-summary-"));
        const stepDir = join(base, "analysis-001", "runs", "run-1", "step-1");
        const outDir = join(stepDir, "output");
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "de-results.csv"), "gene,log2fc,padj\nTP53,2.3,0.001\nMYC,-1.8,0.004\n");
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(base, id)) });

        const { provider, calls } = scriptedModel([readFileCall("t1", "output/de-results.csv"), textMessage("# DE\n\n- 2 significant genes: TP53, MYC")]);

        const out = await generateStepSummary(options(provider, { agent: stepAgent(fs, stepDir), artifactPaths: ["output/de-results.csv"] }));

        expect(out?.markdown).toContain("TP53");
        // The second request must have seen the actual file contents in the
        // tool_result the loop fed back.
        const wire = JSON.stringify(presentAt(calls, 1).prompt);
        expect(wire).toContain("TP53");
        expect(wire).toContain("0.001");
    });

    it("refuses a call of write_file with the error of the mask, and read_file of the same reply runs", async () => {
        const base = await mkdtemp(join(tmpdir(), "step-summary-mask-"));
        const stepDir = join(base, "analysis-001", "runs", "run-1", "step-1");
        await mkdir(join(stepDir, "output"), { recursive: true });
        await writeFile(join(stepDir, "output", "de-results.csv"), "gene,padj\nTP53,0.001\n");
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(base, id)) });
        const target = join(stepDir, "output", "notes.md");
        const writeProbe = defineTool({
            id: "write_file",
            description: "Write a file.",
            inputSchema: z.object({ path: z.string(), content: z.string() }),
            view: "none",
            describeCall: "none",
            execute: async ({ content }) => {
                await writeFile(target, content);
                return ok({ written: true });
            },
        });
        const { provider, calls } = scriptedModel([
            callTools(toolCall("r1", "read_file", { path: "output/de-results.csv" }), toolCall("w1", "write_file", { path: "output/notes.md", content: "x" })),
            textMessage("# DE\n\n- TP53"),
        ]);

        const out = await generateStepSummary(options(provider, { agent: stepAgent(fs, stepDir, [writeProbe]) }));

        expect(out?.markdown).toContain("TP53");
        const [read, write] = toolResults(presentAt(calls, 1));
        expect(JSON.stringify(read?.output)).toContain("TP53");
        expect(write?.output.type).toBe("error-text");
        expect(JSON.stringify(write?.output)).toContain("The tool write_file is not available for this request");
        expect(JSON.stringify(write?.output)).toContain("The tools that can run now: read_file, grep, read_tool_output.");
        expect(
            await access(target).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
    });

    it("reads the rest of a long read_file result with read_tool_output, in the store of its options", async () => {
        const base = await mkdtemp(join(tmpdir(), "step-summary-long-"));
        const stepDir = join(base, "analysis-001", "runs", "run-1", "step-1");
        await mkdir(join(stepDir, "output"), { recursive: true });
        await writeFile(join(stepDir, "output", "long.txt"), "x".repeat(90_000));
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => Promise.resolve(join(base, id)) });
        const kept: KeptToolOutput[] = [];
        const store: ToolOutputStore = {
            put: (output) => {
                kept.push(output);
                return okAsync(undefined);
            },
            get: (analysisId, ref) => okAsync(kept.find((k) => k.analysisId === analysisId && k.ref === ref) ?? null),
        };
        const { provider, calls } = scriptedModel([
            readFileCall("r1", "output/long.txt"),
            (call) => {
                const found = presentFind(toolResults(call), (r) => r.toolCallId === "r1");
                const outputValue = "value" in found.output ? found.output.value : undefined;
                if (typeof outputValue !== "string") throw new Error("expected a string read output");
                const ref = referencedToolOutput(outputValue);
                if (ref === undefined) throw new Error("the reference marker is absent from the read output");
                return callTools(toolCall("k1", "read_tool_output", { ref, offset: 60_000 }));
            },
            textMessage("# Long\n\n- all read"),
        ]);

        const out = await generateStepSummary(
            options(provider, { agent: stepAgent(fs, stepDir, [createReadToolOutputTool(store)]), artifactPaths: ["output/long.txt"], toolOutputStore: store }),
        );

        expect(out?.markdown).toContain("all read");
        expect(kept).toHaveLength(1);
        const page = toolResults(presentAt(calls, 2)).find((r) => r.toolCallId === "k1");
        if (page === undefined) throw new Error("page is absent");
        expect(page.output.type).toBe("json");
        if (page.output.type !== "json") throw new Error("expected the json output arm");
        expect(page.output.value).toMatchObject({ status: "ok", offset: 60_000 });
    });

    it("produces an honest no-output summary for an empty-artifact step (no fabrication)", async () => {
        // No artifacts: the model must state plainly that no outputs were produced,
        // never read a file, and never synthesize a result.
        const { provider, calls } = scriptedModel([textMessage("This step produced no output files.")]);
        const out = await generateStepSummary(options(provider, { artifactPaths: [] }));
        expect(out?.markdown).toContain("no output files");
        // The request must signal the empty state to the model.
        expect(lastTextOf(presentAt(calls, 0))).toContain("none");
    });

    it("returns undefined and does not throw when the provider throws", async () => {
        const { provider } = scriptedModel([{ fail: new Error("upstream 500") }]);
        const out = await generateStepSummary(options(provider));
        expect(out).toBeUndefined();
    });

    it("returns undefined when the final turn has no text content", async () => {
        const { provider } = scriptedModel([reply([])]);
        const out = await generateStepSummary(options(provider));
        expect(out).toBeUndefined();
    });

    it("returns undefined for whitespace-only markdown", async () => {
        const { provider } = scriptedModel([textMessage("   \n  \n")]);
        const out = await generateStepSummary(options(provider));
        expect(out).toBeUndefined();
    });
});
