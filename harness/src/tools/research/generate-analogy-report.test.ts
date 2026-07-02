import { describe, expect, it } from "bun:test";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { makeMessage, scriptedProvider, textBlock } from "../../loop/__fixtures__/scripted-provider.js";
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

        // Tool roster: 6 (3 cross-domain + 3 biology literature).
        expect(Object.keys(provider.calls[0]!.tools)).toHaveLength(6);

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
