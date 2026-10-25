import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { referencedToolOutput } from "../../lib/test/text-shapes.js";
import { errAsync, ok, okAsync } from "neverthrow";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";

import type { KeptToolOutput, ToolOutputStore } from "../../loop/tool-output.js";
import type { AgentDefinition } from "../../loop/types.js";
import { toProviderError } from "../../providers/errors.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../../providers/types.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { makeMessage, textBlock, toolUseBlock } from "../../loop/__fixtures__/scripted-provider.js";
import { defineTool, type Tool } from "../../tools/define-tool.js";
import { createReadToolOutputTool } from "../../tools/read-tool-output.js";
import { createGrepTool, createReadFileTool } from "../../tools/workspace/index.js";
import { createWorkspaceFilesystem, type WorkspaceFilesystem } from "../../workspace/filesystem.js";

import { generateStepSummary, type GenerateStepSummaryOptions } from "../step-summary.js";
import { presentAt, presentFind } from "../../lib/present.js";

type RecordedCall = {
    readonly req: ChatRequest;
};

/** The trailing assistant text the scripted provider answered with; anything else fails the test. */
function lastTextOf(req: ChatRequest): string {
    const last = req.messages.at(-1);
    if (last === undefined || typeof last.content !== "string") throw new Error("expected a text message");
    return last.content;
}

function makeProvider(responses: ReadonlyArray<ChatResponse | Error>): { provider: ChatProvider; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    let i = 0;
    const provider: ChatProvider = {
        capabilities: { toolCalling: true },
        chat(req) {
            // The loop mutates its working `messages` array in place across
            // iterations, so snapshot it at call time before it's appended to.
            calls.push({ req: { ...req, messages: [...req.messages] } });
            const r = responses[i++];
            if (r instanceof Error) return errAsync(toProviderError(r, "test"));
            if (!r) throw new Error(`scripted provider exhausted at call ${i}`);
            return okAsync(r);
        },
        chatStream() {
            throw new Error("not used");
        },
    };
    return { provider, calls };
}

function textMessage(text: string): ChatResponse {
    return makeMessage([textBlock(text)], "end_turn");
}

function readFileCall(id: string, path: string): ChatResponse {
    return makeMessage([toolUseBlock(id, "read_file", { path })], "tool_use");
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

function toolResults(request: ChatRequest): ToolResultPart[] {
    return request.messages.flatMap((m) => (m.role === "tool" ? m.content : [])).filter((part): part is ToolResultPart => part.type === "tool-result");
}

describe("generateStepSummary", () => {
    it("returns { stepId, agentId, markdown } on a final text turn", async () => {
        const { provider } = makeProvider([textMessage("# Results\n\n- DE genes: 42")]);
        const out = await generateStepSummary(options(provider));
        expect(out).toEqual({
            stepId: "step-1",
            agentId: "bulk-transcriptomics-agent",
            markdown: "# Results\n\n- DE genes: 42",
        });
    });

    it("declares the tools of the agent, and its messages start with the transcript and the metadata messages, byte-identical", async () => {
        const { provider, calls } = makeProvider([textMessage("summary")]);
        const agent = stepAgent(NOOP_FS, STEP_DIR);
        const conversation = [...TRANSCRIPT, ...METADATA_MESSAGES];

        await generateStepSummary(options(provider, { agent, conversation }));

        const request = presentAt(calls, 0).req;
        expect(request.system).toMatchObject({ content: "You are a test step agent." });
        expect(Object.keys(request.tools)).toEqual(agent.tools.map((t) => t.id));
        expect(JSON.stringify(request.messages.slice(0, conversation.length))).toBe(JSON.stringify(conversation));
        // The conversation, then the summary request.
        expect(request.messages).toHaveLength(conversation.length + 1);
    });

    it("appends the artifact list to the summary request", async () => {
        const { provider, calls } = makeProvider([textMessage("summary")]);
        await generateStepSummary(options(provider));
        const last = lastTextOf(presentAt(calls, 0).req);
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
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: async (id) => join(base, id) });

        const { provider, calls } = makeProvider([readFileCall("t1", "output/de-results.csv"), textMessage("# DE\n\n- 2 significant genes: TP53, MYC")]);

        const out = await generateStepSummary(options(provider, { agent: stepAgent(fs, stepDir), artifactPaths: ["output/de-results.csv"] }));

        expect(out?.markdown).toContain("TP53");
        // The second request must have seen the actual file contents in the
        // tool_result the loop fed back.
        const wire = JSON.stringify(presentAt(calls, 1).req.messages);
        expect(wire).toContain("TP53");
        expect(wire).toContain("0.001");
    });

    it("refuses a call of write_file with the error of the mask, and read_file of the same reply runs", async () => {
        const base = await mkdtemp(join(tmpdir(), "step-summary-mask-"));
        const stepDir = join(base, "analysis-001", "runs", "run-1", "step-1");
        await mkdir(join(stepDir, "output"), { recursive: true });
        await writeFile(join(stepDir, "output", "de-results.csv"), "gene,padj\nTP53,0.001\n");
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: async (id) => join(base, id) });
        const target = join(stepDir, "output", "notes.md");
        const writeProbe = defineTool({
            id: "write_file",
            description: "Write a file.",
            inputSchema: z.object({ path: z.string(), content: z.string() }),
            describeCall: "none",
            execute: async ({ content }) => {
                await writeFile(target, content);
                return ok({ written: true });
            },
        });
        const { provider, calls } = makeProvider([
            makeMessage(
                [
                    toolUseBlock("r1", "read_file", { path: "output/de-results.csv" }),
                    toolUseBlock("w1", "write_file", { path: "output/notes.md", content: "x" }),
                ],
                "tool_use",
            ),
            textMessage("# DE\n\n- TP53"),
        ]);

        const out = await generateStepSummary(options(provider, { agent: stepAgent(fs, stepDir, [writeProbe]) }));

        expect(out?.markdown).toContain("TP53");
        const [read, write] = toolResults(presentAt(calls, 1).req);
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
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: async (id) => join(base, id) });
        const kept: KeptToolOutput[] = [];
        const store: ToolOutputStore = {
            put: (output) => {
                kept.push(output);
                return okAsync(undefined);
            },
            get: (analysisId, ref) => okAsync(kept.find((k) => k.analysisId === analysisId && k.ref === ref) ?? null),
        };
        const requests: ChatRequest[] = [];
        const provider: ChatProvider = {
            capabilities: { toolCalling: true },
            chat(req) {
                requests.push({ ...req, messages: [...req.messages] });
                if (requests.length === 1) return okAsync(readFileCall("r1", "output/long.txt"));
                if (requests.length === 2) {
                    const found = presentFind(toolResults(req), (r) => r.toolCallId === "r1");
                    const outputValue = "value" in found.output ? found.output.value : undefined;
                    if (typeof outputValue !== "string") throw new Error("expected a string read output");
                    const ref = referencedToolOutput(outputValue);
                    if (ref === undefined) throw new Error("the reference marker is absent from the read output");
                    return okAsync(makeMessage([toolUseBlock("k1", "read_tool_output", { ref, offset: 60_000 })], "tool_use"));
                }
                return okAsync(textMessage("# Long\n\n- all read"));
            },
            chatStream() {
                throw new Error("not used");
            },
        };

        const out = await generateStepSummary(
            options(provider, { agent: stepAgent(fs, stepDir, [createReadToolOutputTool(store)]), artifactPaths: ["output/long.txt"], toolOutputStore: store }),
        );

        expect(out?.markdown).toContain("all read");
        expect(kept).toHaveLength(1);
        const page = toolResults(presentAt(requests, 2)).find((r) => r.toolCallId === "k1");
        if (page === undefined) throw new Error("page is absent");
        expect(page.output.type).toBe("json");
        if (page.output.type !== "json") throw new Error("expected the json output arm");
        expect(page.output.value).toMatchObject({ status: "ok", offset: 60_000 });
    });

    it("produces an honest no-output summary for an empty-artifact step (no fabrication)", async () => {
        // No artifacts: the model must state plainly that no outputs were produced,
        // never read a file, and never synthesize a result.
        const { provider, calls } = makeProvider([textMessage("This step produced no output files.")]);
        const out = await generateStepSummary(options(provider, { artifactPaths: [] }));
        expect(out?.markdown).toContain("no output files");
        // The request must signal the empty state to the model.
        expect(lastTextOf(presentAt(calls, 0).req)).toContain("none");
    });

    it("returns undefined and does not throw when the provider throws", async () => {
        const { provider } = makeProvider([new Error("upstream 500")]);
        const out = await generateStepSummary(options(provider));
        expect(out).toBeUndefined();
    });

    it("returns undefined when the final turn has no text content", async () => {
        const reply = makeMessage([], "end_turn");
        const { provider } = makeProvider([reply]);
        const out = await generateStepSummary(options(provider));
        expect(out).toBeUndefined();
    });

    it("returns undefined for whitespace-only markdown", async () => {
        const { provider } = makeProvider([textMessage("   \n  \n")]);
        const out = await generateStepSummary(options(provider));
        expect(out).toBeUndefined();
    });
});
