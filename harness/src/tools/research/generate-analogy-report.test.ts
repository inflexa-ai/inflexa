import { describe, expect, it } from "bun:test";
import type { ToolResultPart } from "ai";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import type { ChatRequest } from "../../providers/types.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "../../loop/__fixtures__/scripted-provider.js";
import type { ToolContext } from "../define-tool.js";
import { buildResearchPrompt, createGenerateAnalogyReportTool } from "./generate-analogy-report.js";

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

/** The tools of each request of the reasoner: the search tools, then the two terminal tools. */
const REASONER_TOOLS = ["search_semantic_scholar", "search_arxiv", "search_github_repos", "pubmed", "submit_analogy_report", "report_blocker"];

const BIO_KEYS = { drugbank: "", disgenet: "", epaCcte: "" };

const ctxFor = (sessionAgentId = "conversation-agent"): ToolContext => ({
    session: makeSession({
        agentId: sessionAgentId,
        callPath: [sessionAgentId],
    }),
    signal: new AbortController().signal,
    emit: () => {},
    runStep: (_name, fn) => fn(),
});

const submitReport = (id: string, report: unknown) => makeMessage([toolUseBlock(id, "submit_analogy_report", report)], "tool_use");

/** The tool result of one call in the messages of a request. */
function toolResultIn(request: ChatRequest, toolCallId: string): ToolResultPart | undefined {
    return request.messages
        .flatMap((message) => (message.role === "tool" ? message.content : []))
        .find((part): part is ToolResultPart => part.type === "tool-result" && part.toolCallId === toolCallId);
}

describe("generateAnalogyReport sub-agent tool", () => {
    it("returns the submitted report, and the provider gets no call after the submit", async () => {
        const provider = scriptedProvider([submitReport("t1", VALID_ENVELOPE)]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS });

        const ctx = ctxFor();
        const result = (await tool.execute({ problem: "Diagnose oscillation in a pathway." }, ctx))._unsafeUnwrap();

        expect(result).toEqual(VALID_ENVELOPE);
        // The terminal tool ends the loop itself: no call follows the submit.
        expect(provider.calls).toHaveLength(1);
        // The search tools come first, and the two terminal tools come last.
        expect(Object.keys(provider.calls[0]!.tools)).toEqual(REASONER_TOOLS);

        // Child loop ran on a Session derived via forSubAgent — callPath
        // extended, agentId flipped.
        const childSession = provider.sessions[0]!;
        expect(childSession.provenance.agentId).toBe("analogical-reasoner");
        expect(childSession.provenance.callPath).toEqual(["conversation-agent", "analogical-reasoner"]);

        // Parent session untouched.
        expect(ctx.session.provenance.agentId).toBe("conversation-agent");
        expect(ctx.session.provenance.callPath).toEqual(["conversation-agent"]);
    });

    it("gives the extraction-failed envelope with the reason of a blocker as its message", async () => {
        const provider = scriptedProvider([makeMessage([toolUseBlock("b1", "report_blocker", { reason: "The problem statement is empty." })], "tool_use")]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS });

        const result = (await tool.execute({ problem: "?" }, ctxFor()))._unsafeUnwrap();

        expect(result).toEqual({ schemaVersion: "1", error: { kind: "extraction-failed", message: "The problem statement is empty." } });
        expect(provider.calls).toHaveLength(1);
    });

    it("keeps the report when one round records a report and a blocker, in either order", async () => {
        const blocker = toolUseBlock("b1", "report_blocker", { reason: "cannot extract" });
        const report = toolUseBlock("t1", "submit_analogy_report", VALID_ENVELOPE);

        for (const round of [
            [blocker, report],
            [report, blocker],
        ]) {
            const provider = scriptedProvider([makeMessage(round, "tool_use")]);
            const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS });

            const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap();

            expect(result).toEqual(VALID_ENVELOPE);
        }
    });

    it("salvages a run that ends on prose, and the mask of the salvage lets only the two terminal tools run", async () => {
        const provider = scriptedProvider([
            // The first run ends on prose, with no outcome.
            makeMessage([textBlock("## Analogy report\n\nSome free-text prose...")], "end_turn"),
            // The salvage: a search call, which the mask refuses, then the submit.
            makeMessage([toolUseBlock("s1", "search_arxiv", { query: "adaptive control" })], "tool_use"),
            submitReport("t1", VALID_ENVELOPE),
        ]);
        const logger = createCapturingLogger();
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS, logger });

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap();

        expect(result).toEqual(VALID_ENVELOPE);
        expect(provider.calls).toHaveLength(3);
        // Each salvage request declares the tools of the first run.
        for (const request of provider.calls.slice(1)) {
            expect(Object.keys(request.tools)).toEqual(REASONER_TOOLS);
        }
        const refusal = toolResultIn(provider.calls[2]!, "s1");
        expect(refusal?.output).toEqual({
            type: "error-text",
            value: JSON.stringify({
                error: "The tool search_arxiv is not available for this request, thus it did not run. The tools that can run now: submit_analogy_report, report_blocker.",
                retryable: false,
            }),
        });
        // The warn of the salvage reaches the logger of the tool.
        const salvage = logger.records.filter((r) => r.level === "warn" && r.msg.includes("salvaging"));
        expect(salvage).toHaveLength(1);
        expect(salvage[0]!.fields).toMatchObject({ agentId: "analogical-reasoner" });
    });

    it("gives the extraction-failed envelope when the salvage also records no outcome", async () => {
        const provider = scriptedProvider(() => makeMessage([textBlock("Still prose, no report.")], "end_turn"));
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS });

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap() as {
            schemaVersion: "1";
            error: { kind: string; message: string };
        };

        expect(result.error.kind).toBe("extraction-failed");
        expect(result.error.message).toContain("submitted no report and no blocker");
        // The first run and one salvage request. No conversion call follows.
        expect(provider.calls).toHaveLength(2);
    });

    it("gives an invalid report an input validation error, and accepts a second submit", async () => {
        const { analogies: _dropped, ...withoutAnalogies } = VALID_ENVELOPE;
        const provider = scriptedProvider([submitReport("t1", withoutAnalogies), submitReport("t2", VALID_ENVELOPE)]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS });

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap();

        expect(result).toEqual(VALID_ENVELOPE);
        expect(provider.calls).toHaveLength(2);
        const rejected = toolResultIn(provider.calls[1]!, "t1");
        expect(rejected?.output.type).toBe("error-text");
        expect(JSON.stringify(rejected?.output)).toContain("input validation failed");
    });

    it("rejects empty problem at the input-schema boundary", async () => {
        const provider = scriptedProvider([]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS });
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
