import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { ModelMessage } from "ai";

import { toProviderError } from "../providers/errors.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../providers/types.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { makeMessage, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import { createWorkspaceFilesystem, type WorkspaceFilesystem } from "../workspace/filesystem.js";

import { generateStepSummary } from "./step-summary.js";

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

const TRANSCRIPT: ModelMessage[] = [
    { role: "user", content: "Analyze the count matrix at data/inputs/counts.csv." },
    {
        role: "assistant",
        content: [{ type: "text", text: "I will compute differential expression." }],
    },
];

const ARTIFACT_PATHS = ["output/de-results.csv", "figures/volcano.png", "scripts/de.py"];

const COMMON = {
    modelId: "claude-opus-4-7",
    artifactPaths: ARTIFACT_PATHS,
    workspaceFs: NOOP_FS,
    workingDir: "/sessions/analysis-001/runs/run-1/step-1",
    stepId: "step-1",
    agentId: "bulk-transcriptomics-agent",
    runId: "run-1",
} as const;

describe("generateStepSummary", () => {
    it("returns { stepId, agentId, markdown } on a final text turn", async () => {
        const { provider } = makeProvider([textMessage("# Results\n\n- DE genes: 42")]);
        const out = await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            ...COMMON,
        });
        expect(out).toEqual({
            stepId: "step-1",
            agentId: "bulk-transcriptomics-agent",
            markdown: "# Results\n\n- DE genes: 42",
        });
    });

    it("carries the supplied transcript verbatim into the loop's first turn", async () => {
        const { provider, calls } = makeProvider([textMessage("summary")]);
        await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            ...COMMON,
        });
        const sent = calls[0]!.req.messages!;
        // Transcript prefix (2 messages) + the appended summary user prompt (1).
        expect(sent).toHaveLength(3);
        expect(sent[0]).toEqual(TRANSCRIPT[0]!);
        expect(sent[1]).toEqual(TRANSCRIPT[1]!);
    });

    it("appends the artifact list to the user prompt", async () => {
        const { provider, calls } = makeProvider([textMessage("summary")]);
        await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            ...COMMON,
        });
        const allMessages = calls[0]!.req.messages!;
        const last = allMessages[allMessages.length - 1] as { content: string };
        for (const path of ARTIFACT_PATHS) {
            expect(last.content).toContain(path);
        }
    });

    it("reads a persisted output file and grounds the summary in its contents", async () => {
        const base = await mkdtemp(join(tmpdir(), "step-summary-"));
        const outDir = join(base, "analysis-001", "runs", "run-1", "step-1", "output");
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "de-results.csv"), "gene,log2fc,padj\nTP53,2.3,0.001\nMYC,-1.8,0.004\n");
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(base, id) });

        // Loop: read the persisted file, then write the summary using its contents.
        const { provider, calls } = makeProvider([readFileCall("t1", "output/de-results.csv"), textMessage("# DE\n\n- 2 significant genes: TP53, MYC")]);

        const out = await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            modelId: "claude-opus-4-7",
            artifactPaths: ["output/de-results.csv"],
            workspaceFs: fs,
            workingDir: join(base, "analysis-001", "runs", "run-1", "step-1"),
            stepId: "step-1",
            agentId: "bulk-transcriptomics-agent",
            runId: "run-1",
        });

        expect(out?.markdown).toContain("TP53");
        // The second LLM turn must have seen the actual file contents in the
        // tool_result the loop fed back.
        const secondReq = calls[1]!.req;
        const wire = JSON.stringify(secondReq.messages);
        expect(wire).toContain("TP53");
        expect(wire).toContain("0.001");
    });

    it("produces an honest no-output summary for an empty-artifact step (no fabrication)", async () => {
        // No artifacts: the model must state plainly that no outputs were produced,
        // never read a file, and never synthesize a result.
        const { provider, calls } = makeProvider([textMessage("This step produced no output files.")]);
        const out = await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            modelId: "claude-opus-4-7",
            artifactPaths: [],
            workspaceFs: NOOP_FS,
            workingDir: "/sessions/analysis-001/runs/run-1/step-1",
            stepId: "step-1",
            agentId: "bulk-transcriptomics-agent",
            runId: "run-1",
        });
        expect(out?.markdown).toContain("no output files");
        // The prompt must signal the empty state to the model.
        const prompt = calls[0]!.req.messages!.at(-1) as { content: string };
        expect(prompt.content).toContain("none");
    });

    it("returns undefined and does not throw when the provider throws", async () => {
        const { provider } = makeProvider([new Error("upstream 500")]);
        const out = await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            ...COMMON,
        });
        expect(out).toBeUndefined();
    });

    it("returns undefined when the final turn has no text content", async () => {
        const reply = makeMessage([], "end_turn");
        const { provider } = makeProvider([reply]);
        const out = await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            ...COMMON,
        });
        expect(out).toBeUndefined();
    });

    it("returns undefined for whitespace-only markdown", async () => {
        const { provider } = makeProvider([textMessage("   \n  \n")]);
        const out = await generateStepSummary({
            provider,
            session: makeSession(),
            messages: TRANSCRIPT,
            ...COMMON,
        });
        expect(out).toBeUndefined();
    });

    it("drops a trailing assistant tool_use round from the transcript before sending", async () => {
        const trailingToolUse: ModelMessage[] = [
            ...TRANSCRIPT,
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Let me look up the gene." },
                    {
                        type: "tool-call",
                        toolCallId: "tu_1",
                        toolName: "search_gene",
                        input: { q: "TP53" },
                    },
                ],
            },
        ];
        const { provider, calls } = makeProvider([textMessage("summary")]);
        await generateStepSummary({
            provider,
            session: makeSession(),
            messages: trailingToolUse,
            ...COMMON,
        });
        const sent = calls[0]!.req.messages!;
        // Trailing partial assistant round was dropped; original 2 + 1 summary user.
        expect(sent).toHaveLength(3);
    });
});
