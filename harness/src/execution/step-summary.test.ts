import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { errAsync, ok, okAsync } from "neverthrow";
import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";

import type { AgentDefinition } from "../loop/types.js";
import { toProviderError } from "../providers/errors.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../providers/types.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { makeMessage, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { createGrepTool, createReadFileTool } from "../tools/workspace/index.js";
import { createWorkspaceFilesystem, type WorkspaceFilesystem } from "../workspace/filesystem.js";

import { generateStepSummary, type GenerateStepSummaryOptions } from "./step-summary.js";

interface RecordedCall {
    readonly req: ChatRequest;
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

/** The messages of a file-metadata exchange that ran before the summary. */
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

/** A step agent with the declared read tools of a real one, over `fs` and `stepDir`, plus `extra`. */
function stepAgent(fs: WorkspaceFilesystem, stepDir: string, extra: readonly Tool[] = []): AgentDefinition {
    return {
        id: "bulk-transcriptomics-agent",
        systemPrompt: "You are a test step agent.",
        model: "claude-opus-4-7",
        tools: [createReadFileTool(fs, stepDir), createGrepTool(fs, stepDir), ...extra],
        maxIterations: 30,
    };
}

/** The options of one summary over the default conversation and agent. */
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

        const request = calls[0]!.req;
        expect(request.system).toMatchObject({ content: "You are a test step agent." });
        expect(Object.keys(request.tools)).toEqual(agent.tools.map((t) => t.id));
        expect(JSON.stringify(request.messages.slice(0, conversation.length))).toBe(JSON.stringify(conversation));
        // The conversation, then the summary request.
        expect(request.messages).toHaveLength(conversation.length + 1);
    });

    it("appends the artifact list to the summary request", async () => {
        const { provider, calls } = makeProvider([textMessage("summary")]);
        await generateStepSummary(options(provider));
        const last = calls[0]!.req.messages.at(-1) as { content: string };
        for (const path of ARTIFACT_PATHS) {
            expect(last.content).toContain(path);
        }
    });

    it("reads a persisted output file and grounds the summary in its contents", async () => {
        const base = await mkdtemp(join(tmpdir(), "step-summary-"));
        const stepDir = join(base, "analysis-001", "runs", "run-1", "step-1");
        const outDir = join(stepDir, "output");
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "de-results.csv"), "gene,log2fc,padj\nTP53,2.3,0.001\nMYC,-1.8,0.004\n");
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(base, id) });

        // Continuation: read the persisted file, then write the summary using its contents.
        const { provider, calls } = makeProvider([readFileCall("t1", "output/de-results.csv"), textMessage("# DE\n\n- 2 significant genes: TP53, MYC")]);

        const out = await generateStepSummary(options(provider, { agent: stepAgent(fs, stepDir), artifactPaths: ["output/de-results.csv"] }));

        expect(out?.markdown).toContain("TP53");
        // The second request must have seen the actual file contents in the
        // tool_result the loop fed back.
        const wire = JSON.stringify(calls[1]!.req.messages);
        expect(wire).toContain("TP53");
        expect(wire).toContain("0.001");
    });

    it("refuses a call of write_file with the error of the mask, and read_file of the same reply runs", async () => {
        const base = await mkdtemp(join(tmpdir(), "step-summary-mask-"));
        const stepDir = join(base, "analysis-001", "runs", "run-1", "step-1");
        await mkdir(join(stepDir, "output"), { recursive: true });
        await writeFile(join(stepDir, "output", "de-results.csv"), "gene,padj\nTP53,0.001\n");
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(base, id) });
        const target = join(stepDir, "output", "notes.md");
        // A write tool with the id of the real one, thus only the mask stands between the call and the disk.
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
        const [read, write] = toolResults(calls[1]!.req);
        expect(JSON.stringify(read!.output)).toContain("TP53");
        expect(write!.output.type).toBe("error-text");
        expect(JSON.stringify(write!.output)).toContain("The tool write_file is not available for this request");
        expect(
            await access(target).then(
                () => true,
                () => false,
            ),
        ).toBe(false);
    });

    it("produces an honest no-output summary for an empty-artifact step (no fabrication)", async () => {
        // No artifacts: the model must state plainly that no outputs were produced,
        // never read a file, and never synthesize a result.
        const { provider, calls } = makeProvider([textMessage("This step produced no output files.")]);
        const out = await generateStepSummary(options(provider, { artifactPaths: [] }));
        expect(out?.markdown).toContain("no output files");
        // The request must signal the empty state to the model.
        const prompt = calls[0]!.req.messages.at(-1) as { content: string };
        expect(prompt.content).toContain("none");
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
