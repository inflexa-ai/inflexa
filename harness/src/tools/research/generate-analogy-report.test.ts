import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import type { LlmUsageRecord } from "../../billing/usage-recorder.js";
import type { AgentRunUsage } from "../../loop/metrics.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { makeMessage, scriptedProvider, textBlock } from "../../loop/__fixtures__/scripted-provider.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import { buildResearchPrompt, createGenerateAnalogyReportTool, tryParseEnvelope } from "./generate-analogy-report.js";

const VALID_ENVELOPE = {
    schemaVersion: "1",
    problemSummary: "Source problem summary.",
    problemObjects: [{ name: "X", role: "input" }],
    problemRelations: ["X drives Y"],
    keyTerms: ["term"],
    analogies: [
        {
            targetDomain: "control_theory",
            analogyTitle: "Adaptive control of an unseen plant",
            objectMappings: [{ source: "X", target: "plant", rationale: "Same hidden dynamics." }],
            sharedRelations: "Both involve unknown dynamics under feedback.",
            coverage: "available" as const,
            solutions: [
                {
                    title: "Adaptive control paper title",
                    sourceDomain: "control_theory",
                    description: "A 2-3 sentence description.",
                    keyConcepts: ["adaptation"],
                    relevance: "Maps back to the source problem.",
                    sources: [{ url: "https://example.com/paper", title: "Paper title" }],
                    githubRepos: [],
                },
            ],
        },
    ],
};

const ctxFor = (sessionAgentId = "conversation-agent"): ToolContext => ({
    session: makeSession({
        agentId: sessionAgentId,
        callPath: [sessionAgentId],
    }),
    signal: new AbortController().signal,
    emit: () => {},
    runStep: (_name, fn) => fn(),
});

describe("generateAnalogyReport sub-agent tool", () => {
    it("returns the parsed envelope on the fast (research-only) path", async () => {
        const provider = scriptedProvider([makeMessage([textBlock(JSON.stringify(VALID_ENVELOPE))], "end_turn")]);
        const tool = createGenerateAnalogyReportTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        });

        const ctx = ctxFor();
        const result = (await tool.execute({ problem: "Diagnose oscillation in a pathway." }, ctx))._unsafeUnwrap() as typeof VALID_ENVELOPE;

        expect(result.analogies).toHaveLength(1);
        expect(result.analogies[0]!.targetDomain).toBe("control_theory");

        // Child loop ran on a Session derived via forSubAgent — callPath
        // extended, agentId flipped.
        const childSession = provider.sessions[0]!;
        expect(childSession.provenance.agentId).toBe("analogical-reasoner");
        expect(childSession.provenance.callPath).toEqual(["conversation-agent", "analogical-reasoner"]);

        // Parent session untouched.
        expect(ctx.session.provenance.agentId).toBe("conversation-agent");
        expect(ctx.session.provenance.callPath).toEqual(["conversation-agent"]);

        // Tool roster: 4 (3 cross-domain + the consolidated `pubmed` tool).
        expect(Object.keys(provider.calls[0]!.tools)).toHaveLength(4);

        // Only one provider call — fast path skipped the conversion retry.
        expect(provider.calls).toHaveLength(1);
    });

    it("runs the conversion retry when the research output is not valid JSON", async () => {
        const provider = scriptedProvider([
            // Research agent returns markdown prose — not parseable.
            makeMessage([textBlock("## Analogy report\n\nSome free-text prose...")], "end_turn"),
            // Conversion call returns a valid envelope.
            makeMessage([textBlock(JSON.stringify(VALID_ENVELOPE))], "end_turn"),
        ]);
        const tool = createGenerateAnalogyReportTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        });

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap() as typeof VALID_ENVELOPE;

        expect(result.analogies).toHaveLength(1);
        expect(provider.calls).toHaveLength(2);

        // Conversion call: no tools, system prompt is the conversion instruction.
        const conversionCall = provider.calls[1]!;
        expect(conversionCall.tools).toEqual({});
    });

    it("surfaces an extraction-failed envelope when conversion also fails", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("Garbled prose.")], "end_turn"), makeMessage([textBlock("still not JSON")], "end_turn")]);
        const tool = createGenerateAnalogyReportTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        });

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap() as {
            schemaVersion: "1";
            error: { kind: string; message: string };
        };

        expect(result.error.kind).toBe("extraction-failed");
    });

    it("surfaces extraction-failed when conversion emits empty analogies", async () => {
        const provider = scriptedProvider([
            makeMessage([textBlock("Apology — no analogies.")], "end_turn"),
            makeMessage(
                [
                    textBlock(
                        JSON.stringify({
                            schemaVersion: "1",
                            problemSummary: "Source problem.",
                            problemObjects: [],
                            problemRelations: [],
                            keyTerms: [],
                            analogies: [],
                        }),
                    ),
                ],
                "end_turn",
            ),
        ]);
        const tool = createGenerateAnalogyReportTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        });

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap() as {
            schemaVersion: "1";
            error: { kind: string; message: string };
        };

        expect(result.error.kind).toBe("extraction-failed");
    });

    it("accounts the conversion call under its own key, and folds each call into the turn total", async () => {
        const provider = scriptedProvider([
            // The research agent returns prose, thus the conversion call runs.
            makeMessage([textBlock("## Analogy report\n\nSome free-text prose...")], "end_turn", { inputTokens: 100, outputTokens: 10 }),
            makeMessage([textBlock(JSON.stringify(VALID_ENVELOPE))], "end_turn", { inputTokens: 20, outputTokens: 5 }),
        ]);
        const records: LlmUsageRecord[] = [];
        const tool = createGenerateAnalogyReportTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            usageRecorder: {
                record: (record) => {
                    records.push(record);
                    return okAsync(undefined);
                },
            },
        });
        const turnUsage: AgentRunUsage = {};
        const { ctx } = makeToolContext();
        const stepCtx: ToolContext = { ...ctx, session: { ...ctx.session, runFrame: { runId: "run-1", stepId: "step-1" } }, turnUsage };

        (await tool.execute({ problem: "Diagnose oscillation." }, stepCtx))._unsafeUnwrap();

        const conversion = records.filter((record) => record.recordKey.endsWith(":analogy-conversion"));
        expect(conversion).toHaveLength(1);
        expect(conversion[0]).toMatchObject({ agentId: "analogical-reasoner", runId: "run-1", stepId: "step-1", usage: { inputTokens: 20, outputTokens: 5 } });
        // The research loop names its calls `llm-{n}` under the same frame and
        // call path, thus only the call name keeps the two keys apart.
        const researchKeys = records.filter((record) => record !== conversion[0]).map((record) => record.recordKey);
        expect(researchKeys).toEqual(["run-1:step-1:conversation-agent>analogical-reasoner:test-tool-call:llm-0"]);
        expect(conversion[0]!.recordKey).toBe("run-1:step-1:conversation-agent>analogical-reasoner:test-tool-call:analogy-conversion");
        expect(turnUsage).toEqual({ inputTokens: 120, outputTokens: 15 });
    });

    it("logs a recorder err of the conversion call at the error level, and still returns the envelope", async () => {
        const provider = scriptedProvider([
            makeMessage([textBlock("## Analogy report\n\nSome free-text prose...")], "end_turn"),
            makeMessage([textBlock(JSON.stringify(VALID_ENVELOPE))], "end_turn", { inputTokens: 20, outputTokens: 5 }),
        ]);
        const logger = createCapturingLogger();
        const tool = createGenerateAnalogyReportTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            usageRecorder: { record: () => errAsync({ reason: "ledger offline" }) },
            logger,
        });
        const { ctx } = makeToolContext();

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctx))._unsafeUnwrap() as typeof VALID_ENVELOPE;
        // The notice helper logs when the result of the recorder arrives, on a later turn of the event loop.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(result.analogies).toHaveLength(1);
        const failures = logger.records.filter((record) => record.level === "error" && record.fields["notice"] === "UsageRecorder.record");
        expect(failures.map((record) => record.fields["reason"])).toEqual(["ledger offline"]);
    });

    it("rejects empty problem at the input-schema boundary", async () => {
        const provider = scriptedProvider([]);
        const tool = createGenerateAnalogyReportTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
        });
        const parse = tool.inputSchema.safeParse({ problem: "" });
        expect(parse.success).toBe(false);
    });
});

describe("buildResearchPrompt", () => {
    it("renders required + optional knobs in the documented order", () => {
        const prompt = buildResearchPrompt({
            problem: "Why is signal X oscillating?",
            context: "Time-course profile shows period ~30 min.",
            numDomains: 3,
            solutionsPerDomain: 2,
            preferredDomains: ["control_theory"],
            excludeDomains: ["biology"],
        });
        expect(prompt).toContain("## Problem\nWhy is signal X oscillating?");
        expect(prompt).toContain("## Context\nTime-course profile");
        expect(prompt).toContain("- numDomains: 3");
        expect(prompt).toContain("- solutionsPerDomain: 2");
        expect(prompt).toContain("- preferredDomains: control_theory");
        expect(prompt).toContain("- excludeDomains: biology");
    });

    it("omits the Context section and Knobs section when both are absent", () => {
        const prompt = buildResearchPrompt({ problem: "Just the problem." });
        expect(prompt).toBe("## Problem\nJust the problem.");
    });
});

describe("tryParseEnvelope", () => {
    it("parses a clean JSON envelope", () => {
        const r = tryParseEnvelope(JSON.stringify(VALID_ENVELOPE));
        expect(r.ok).toBe(true);
    });

    it("strips a single wrapping ```json fence", () => {
        const fenced = "```json\n" + JSON.stringify(VALID_ENVELOPE) + "\n```";
        const r = tryParseEnvelope(fenced);
        expect(r.ok).toBe(true);
    });

    it("rejects non-JSON with not-json reason", () => {
        const r = tryParseEnvelope("not JSON at all");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("not-json");
    });

    it("rejects JSON that fails schema validation", () => {
        const r = tryParseEnvelope(JSON.stringify({ schemaVersion: "1" }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("schema-mismatch");
    });
});
