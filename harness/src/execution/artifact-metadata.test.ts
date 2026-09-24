import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import { okAsync } from "neverthrow";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import type { AgentSession } from "../auth/types.js";
import type { LlmUsageRecord } from "../billing/usage-recorder.js";
import { isSyntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
import type { AgentDefinition } from "../loop/types.js";
import type { ChatProvider, ChatRequest, ChatResponse } from "../providers/types.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { makeMessage, textBlock, toolUseBlock } from "../loop/__fixtures__/scripted-provider.js";
import type { Tool } from "../tools/define-tool.js";
import { createFileMetadataCell, createSubmitFileMetadataTool } from "../tools/sandbox/submit-file-metadata.js";
import { createGrepTool, createReadFileTool } from "../tools/workspace/index.js";
import { createWorkspaceFilesystem } from "../workspace/filesystem.js";

import { generateFileMetadata, type ArtifactForMetadata, type GenerateFileMetadataOptions } from "./artifact-metadata.js";

interface RecordedCall {
    readonly req: ChatRequest;
}

/**
 * Scripted `ChatProvider` that returns one Message per call, in order.
 * `chatStream` is never exercised.
 */
function makeProvider(responses: readonly ChatResponse[]): {
    provider: ChatProvider;
    calls: RecordedCall[];
} {
    const calls: RecordedCall[] = [];
    let i = 0;
    const provider: ChatProvider = {
        capabilities: { toolCalling: true },
        chat(req) {
            // Snapshot messages: the loop mutates its working array in place.
            calls.push({ req: { ...req, messages: [...req.messages] } });
            const r = responses[i++];
            if (!r) throw new Error(`scripted provider exhausted at call ${i}`);
            return okAsync(r);
        },
        chatStream() {
            throw new Error("not used");
        },
    };
    return { provider, calls };
}

/** An assistant turn that calls `submit_file_metadata` with `files`. */
function submitCall(id: string, files: unknown[]): ChatResponse {
    return makeMessage([toolUseBlock(id, "submit_file_metadata", { files })], "tool_use");
}

/** A terminal assistant text turn (the model stops calling tools). */
function stopTurn(text = "done"): ChatResponse {
    return makeMessage([textBlock(text)], "end_turn");
}

/** An assistant turn that calls `read_file` on a path. */
function readFileCall(id: string, path: string): ChatResponse {
    return makeMessage([toolUseBlock(id, "read_file", { path })], "tool_use");
}

function desc(path: string, over: Record<string, unknown> = {}) {
    return { path, description: `desc ${path}`, dataType: "csv", format: "csv", ...over };
}

const ARTIFACTS_3: ArtifactForMetadata[] = [
    { dbPath: "p/a.csv", displayPath: "a.csv" },
    { dbPath: "p/b.csv", displayPath: "b.csv" },
    { dbPath: "p/c.csv", displayPath: "c.csv" },
];

const TRANSCRIPT: ModelMessage[] = [
    { role: "user", content: "Produce a count matrix under output/." },
    { role: "assistant", content: [{ type: "text", text: "Wrote the count matrix." }] },
];

/** A step agent with `tools`, then the output tool bound to the returned cell. */
function stepAgent(tools: readonly Tool[] = []): Pick<GenerateFileMetadataOptions, "agent" | "cell"> {
    const cell = createFileMetadataCell();
    const agent: AgentDefinition = {
        id: "test-step-agent",
        systemPrompt: "You are a test step agent.",
        model: "claude-opus-4-7",
        tools: [...tools, createSubmitFileMetadataTool(cell)],
        maxIterations: 30,
    };
    return { agent, cell };
}

/** The options of one run of the describer over `artifacts`, with the default step agent. */
function options(
    provider: ChatProvider,
    artifacts: readonly ArtifactForMetadata[],
    over: Partial<GenerateFileMetadataOptions> = {},
): GenerateFileMetadataOptions {
    return {
        provider,
        session: makeSession(),
        artifacts,
        resourceId: "r-1",
        transcript: TRANSCRIPT,
        ...stepAgent(),
        ...over,
    };
}

describe("generateFileMetadata", () => {
    it("returns empty result for empty input without calling the provider", async () => {
        const { provider, calls } = makeProvider([]);
        const out = await generateFileMetadata(options(provider, []));
        expect(out).toEqual({ indexed: 0, entries: [], messages: [] });
        expect(calls).toHaveLength(0);
    });

    it("describes every file in one submit call, keyed by path", async () => {
        const { provider } = makeProvider([submitCall("t1", [desc("a.csv"), desc("b.csv"), desc("c.csv")]), stopTurn()]);
        const out = await generateFileMetadata(options(provider, ARTIFACTS_3));
        expect(out.indexed).toBe(3);
        expect(out.entries).toHaveLength(3);
        expect(out.entries[0]).toMatchObject({
            dbPath: "p/a.csv",
            description: "desc a.csv",
            metadata: { dataType: "csv", format: "csv" },
        });
        expect(out.entries[2]!.dbPath).toBe("p/c.csv");
    });

    it("continues the conversation of the step agent and returns only the messages of the exchange", async () => {
        const { provider, calls } = makeProvider([submitCall("t1", [desc("a.csv"), desc("b.csv"), desc("c.csv")]), stopTurn()]);
        const step = stepAgent();

        const out = await generateFileMetadata(options(provider, ARTIFACTS_3, step));

        const first = calls[0]!.req;
        expect(first.system).toMatchObject({ content: "You are a test step agent." });
        expect(Object.keys(first.tools)).toEqual(step.agent.tools.map((t) => t.id));
        expect(JSON.stringify(first.messages.slice(0, TRANSCRIPT.length))).toBe(JSON.stringify(TRANSCRIPT));
        expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(isSyntheticUserMessage(out.messages[0]!)).toBe(true);
        expect(String(out.messages[0]!.content)).toContain("- b.csv");
    });

    it("matches descriptions to files by PATH, not array position", async () => {
        // Returned in reverse order — positional matching would misalign every
        // file; path keying attaches each description to the correct artifact.
        const { provider } = makeProvider([submitCall("t1", [desc("c.csv"), desc("a.csv"), desc("b.csv")]), stopTurn()]);
        const out = await generateFileMetadata(options(provider, ARTIFACTS_3));
        const byPath = new Map(out.entries.map((e) => [e.dbPath, e.description]));
        expect(byPath.get("p/a.csv")).toBe("desc a.csv");
        expect(byPath.get("p/b.csv")).toBe("desc b.csv");
        expect(byPath.get("p/c.csv")).toBe("desc c.csv");
    });

    it("rejects hallucinated paths and lets the model correct on a later call", async () => {
        const { provider, calls } = makeProvider([
            // First call: two real, one invented path → unknownPaths + remaining.
            submitCall("t1", [desc("a.csv"), desc("b.csv"), desc("ghost.csv")]),
            // Second call: the missing real file.
            submitCall("t2", [desc("c.csv")]),
            stopTurn(),
        ]);
        const out = await generateFileMetadata(options(provider, ARTIFACTS_3));
        expect(out.indexed).toBe(3);
        expect(out.entries.map((e) => e.dbPath).sort()).toEqual(["p/a.csv", "p/b.csv", "p/c.csv"]);
        // The first tool_result must report the bad path so the model can fix it.
        const toolResult = JSON.stringify(calls[1]!.req.messages.at(-1));
        expect(toolResult).toContain("ghost.csv");
        expect(toolResult).toContain("c.csv");
    });

    it("falls back deterministically for files the model never describes", async () => {
        const { provider } = makeProvider([
            submitCall("t1", [desc("a.csv")]),
            // Model stops without covering b.csv / c.csv.
            stopTurn(),
        ]);
        const out = await generateFileMetadata(options(provider, ARTIFACTS_3));
        // Every file still produces an entry; only one was model-described.
        expect(out.entries).toHaveLength(3);
        expect(out.indexed).toBe(1);
        const b = out.entries.find((e) => e.dbPath === "p/b.csv")!;
        expect(b.description).toContain("b.csv");
        expect(b.description).toContain("automated description unavailable");
        expect(b.metadata).toMatchObject({ format: "csv" });
    });

    it("includes size in the fallback description when provided", async () => {
        const { provider } = makeProvider([stopTurn()]);
        const out = await generateFileMetadata(options(provider, [{ dbPath: "p/x.csv", displayPath: "output/x.csv", sizeBytes: 2048 }]));
        expect(out.indexed).toBe(0);
        expect(out.entries[0]!.description).toContain("2048 bytes");
    });

    it("merges extraMetadata into described and fallback entries alike", async () => {
        const { provider } = makeProvider([submitCall("t1", [desc("a.csv")]), stopTurn()]);
        const out = await generateFileMetadata(options(provider, ARTIFACTS_3, { extraMetadata: { source_run: "run-001", source_step: "step-001" } }));
        for (const entry of out.entries) {
            expect(entry.metadata.source_run).toBe("run-001");
            expect(entry.metadata.source_step).toBe("step-001");
        }
    });

    it("reads a persisted file via read_file and still describes every file losslessly", async () => {
        const base = await mkdtemp(join(tmpdir(), "artifact-meta-"));
        const stepDir = join(base, "analysis-001", "runs", "run-1", "step-1");
        const outDir = join(stepDir, "output");
        await mkdir(outDir, { recursive: true });
        await writeFile(join(outDir, "a.csv"), "gene,count\nTP53,42\n");
        const fs = createWorkspaceFilesystem({ resolveWorkspaceRoot: (id) => join(base, id) });

        const { provider, calls } = makeProvider([
            // Inspect the real file before describing.
            readFileCall("r1", "output/a.csv"),
            // Then submit metadata for a.csv only — b.csv/c.csv fall back.
            submitCall("t1", [desc("output/a.csv")]),
            stopTurn(),
        ]);

        const artifacts: ArtifactForMetadata[] = [
            { dbPath: "p/a.csv", displayPath: "output/a.csv" },
            { dbPath: "p/b.csv", displayPath: "output/b.csv" },
            { dbPath: "p/c.csv", displayPath: "output/c.csv" },
        ];

        const out = await generateFileMetadata(
            options(provider, artifacts, { resourceId: "analysis-001", ...stepAgent([createReadFileTool(fs, stepDir), createGrepTool(fs, stepDir)]) }),
        );

        // Lossless: one entry per input artifact even though only a.csv was described.
        expect(out.entries).toHaveLength(3);
        expect(out.indexed).toBe(1);
        // The read_file tool_result carried the real file contents to the model.
        const afterRead = JSON.stringify(calls[1]!.req.messages);
        expect(afterRead).toContain("TP53");
        // Undescribed files still get a deterministic fallback (lossless guarantee).
        const b = out.entries.find((e) => e.dbPath === "p/b.csv")!;
        expect(b.description).toContain("automated description unavailable");
    });

    it("falls back for all files when the model never calls the tool", async () => {
        const { provider } = makeProvider([stopTurn("I cannot help")]);
        const out = await generateFileMetadata(options(provider, ARTIFACTS_3));
        expect(out.indexed).toBe(0);
        expect(out.entries).toHaveLength(3);
        expect(out.entries.every((e) => e.description.includes("unavailable"))).toBe(true);
    });

    it("gives the fallback to each file with no provider call when the step agent has no output tool", async () => {
        const { provider, calls } = makeProvider([]);
        const logger = createCapturingLogger();
        const agent: AgentDefinition = {
            id: "test-step-agent",
            systemPrompt: "You are a test step agent.",
            model: "claude-opus-4-7",
            tools: [],
            maxIterations: 30,
        };

        const out = await generateFileMetadata(options(provider, ARTIFACTS_3, { agent, logger }));

        expect(calls).toHaveLength(0);
        expect(out.indexed).toBe(0);
        expect(out.messages).toEqual([]);
        expect(out.entries.map((e) => e.dbPath)).toEqual(["p/a.csv", "p/b.csv", "p/c.csv"]);
        expect(out.entries.every((e) => e.description.includes("automated description unavailable"))).toBe(true);
        const warns = logger.records.filter((r) => r.level === "warn");
        expect(warns).toHaveLength(1);
        expect(warns[0]!.fields).toMatchObject({ agentId: "test-step-agent", artifactCount: 3 });
    });

    it("records each call under the accounting id file-metadata-describer and the step of the session", async () => {
        const { provider } = makeProvider([
            { ...submitCall("t1", [desc("a.csv"), desc("b.csv"), desc("c.csv")]), usage: { inputTokens: 10, outputTokens: 2 } },
            stopTurn(),
        ]);
        const records: LlmUsageRecord[] = [];
        const session: AgentSession = { ...makeSession(), runFrame: { runId: "run-1", stepId: "T1S1" } };

        await generateFileMetadata(
            options(provider, ARTIFACTS_3, {
                session,
                usageRecorder: {
                    record: (record) => {
                        records.push(record);
                        return okAsync(undefined);
                    },
                },
            }),
        );

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ agentId: "file-metadata-describer", runId: "run-1", stepId: "T1S1" });
        expect(records[0]!.recordKey.endsWith(":file-metadata:llm-0")).toBe(true);
    });
});
