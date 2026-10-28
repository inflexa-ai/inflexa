import { describe, expect, it } from "bun:test";
import { inProcessSubAgent } from "../../../loop/sub-agent.js";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { okAsync } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger } from "../../../__tests__/setup/logger.js";
import type { ToolOutputStore } from "../../../loop/tool-output.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall } from "../../../testing.js";
import type { ToolContext } from "../../define-tool.js";
import { buildResearchPrompt, createGenerateAnalogyReportTool } from "../generate-analogy-report.js";
import { presentAt } from "../../../lib/present.js";
import { AnalogyReportSchema } from "../../../contracts/analogy-report.js";
import { analogicalReasonerPrompt } from "../../../prompts/analogical-reasoner.js";

const EXTRACTION = {
    problemSummary: "Source problem summary.",
    problemObjects: [{ name: "X", role: "input" }],
    problemRelations: ["X drives Y"],
    keyTerms: ["term"],
};

const ANALOGY = {
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
};

const PROBLEM = { ...EXTRACTION, plannedAnalogies: [{ analogyTitle: ANALOGY.analogyTitle, targetDomain: ANALOGY.targetDomain }] };

const VALID_ENVELOPE = { schemaVersion: "1", ...EXTRACTION, analogies: [ANALOGY] };

const REASONER_TOOLS = ["search_semantic_scholar", "search_arxiv", "search_github_repos", "pubmed", "record_problem", "record_analogy", "report_blocker"];

const BIO_KEYS = { drugbank: "", disgenet: "", epaCcte: "" };

const IterationEventSchema = z.object({
    type: z.literal("iteration"),
    source: z.object({ agentId: z.string(), callPath: z.array(z.string()), invocationId: z.string().optional() }),
});

const ExtractionFailedSchema = z.object({ schemaVersion: z.literal("1"), error: z.object({ kind: z.literal("extraction-failed"), message: z.string() }) });

const ErrorTextSchema = z.object({ type: z.literal("error-text"), value: z.string() });

function ctxFor(emitted: unknown[] = []): ToolContext {
    return {
        invocationId: "tool-call-test",
        session: makeSession({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        }),
        signal: new AbortController().signal,
        emit: (event) => {
            emitted.push(event);
        },
    };
}

/** One round that records the problem and its one planned analogy, which ends the run. */
const recordAll = (id: string) => callTools(toolCall(`${id}p`, "record_problem", PROBLEM), toolCall(`${id}a`, "record_analogy", ANALOGY));

const done = reply([text("Done.")]);

const toolNamesOf = (call: LanguageModelV4CallOptions): string[] => (call.tools ?? []).map((tool) => tool.name);

/** The output of the result of one tool call, as the request sent it to the model. */
function toolResultIn(call: LanguageModelV4CallOptions, toolCallId: string): unknown {
    for (const message of call.prompt) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
            if (part.type === "tool-result" && part.toolCallId === toolCallId) return part.output;
        }
    }
    return undefined;
}

describe("generateAnalogyReport sub-agent tool", () => {
    it("assembles the recorded parts into the report, ends the run when each planned analogy has a record, and runs on a derived session", async () => {
        const { provider, calls } = scriptedModel([recordAll("t1")]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const emitted: unknown[] = [];
        const ctx = ctxFor(emitted);
        const result = (await tool.execute({ problem: "Diagnose oscillation in a pathway." }, ctx))._unsafeUnwrap();

        expect(result).toEqual(VALID_ENVELOPE);
        expect(calls).toHaveLength(1);
        expect(toolNamesOf(presentAt(calls, 0))).toEqual(REASONER_TOOLS);

        // Child loop ran on a Session derived via forSubAgent — callPath
        // extended, agentId flipped.
        const iterations = emitted.flatMap((event) => {
            const parsed = IterationEventSchema.safeParse(event);
            return parsed.success ? [parsed.data] : [];
        });
        expect(presentAt(iterations, 0).source).toEqual({
            agentId: "analogical-reasoner",
            callPath: ["conversation-agent", "analogical-reasoner"],
            invocationId: "tool-call-test",
        });

        // Parent session untouched.
        expect(ctx.session.provenance.agentId).toBe("conversation-agent");
        expect(ctx.session.provenance.callPath).toEqual(["conversation-agent"]);
    });

    it("declares read_tool_output after the search tools and before the terminal tools when it has a tool output store", async () => {
        const { provider, calls } = scriptedModel([recordAll("t1")]);
        const toolOutputStore: ToolOutputStore = { put: () => okAsync(undefined), get: () => okAsync(null) };
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS, toolOutputStore }, inProcessSubAgent);

        (await tool.execute({ problem: "Diagnose oscillation in a pathway." }, ctxFor()))._unsafeUnwrap();

        expect(toolNamesOf(presentAt(calls, 0))).toEqual([
            "search_semantic_scholar",
            "search_arxiv",
            "search_github_repos",
            "pubmed",
            "read_tool_output",
            "record_problem",
            "record_analogy",
            "report_blocker",
        ]);
    });

    it("gives a planned analogy with no record as not loaded, and keeps the analogies that arrived", async () => {
        const planned = { ...PROBLEM, plannedAnalogies: [...PROBLEM.plannedAnalogies, { analogyTitle: "Rerouting in a network", targetDomain: "networking" }] };
        const { provider } = scriptedModel([callTools(toolCall("p", "record_problem", planned), toolCall("a", "record_analogy", ANALOGY)), done]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = AnalogyReportSchema.parse((await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap());

        expect(result.analogies).toEqual([
            ANALOGY,
            {
                targetDomain: "networking",
                analogyTitle: "Rerouting in a network",
                objectMappings: [],
                sharedRelations: "",
                coverage: "not_loaded",
                solutions: [],
            },
        ]);
    });

    it("keeps the last record of an analogy title", async () => {
        const revised = { ...ANALOGY, sharedRelations: "The revised relation." };
        const planned = { ...PROBLEM, plannedAnalogies: [...PROBLEM.plannedAnalogies, { analogyTitle: "Later", targetDomain: "ecology" }] };
        const { provider } = scriptedModel([
            callTools(toolCall("p", "record_problem", planned), toolCall("a1", "record_analogy", ANALOGY)),
            callTools(toolCall("a2", "record_analogy", revised)),
            done,
        ]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = AnalogyReportSchema.parse((await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap());

        expect(result.analogies[0]?.sharedRelations).toBe("The revised relation.");
    });

    it("gives the extraction-failed envelope with the reason of a blocker as its message", async () => {
        const { provider, calls } = scriptedModel([callTools(toolCall("b1", "report_blocker", { reason: "The problem statement is empty." })), done]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = (await tool.execute({ problem: "?" }, ctxFor()))._unsafeUnwrap();

        expect(result).toEqual({ schemaVersion: "1", error: { kind: "extraction-failed", message: "The problem statement is empty." } });
        // A blocker is an outcome, thus no salvage request follows.
        expect(calls).toHaveLength(2);
    });

    it("keeps the report when the run also records a blocker, in either order", async () => {
        const blocker = toolCall("b1", "report_blocker", { reason: "cannot extract" });
        const problem = toolCall("p", "record_problem", PROBLEM);
        const analogy = toolCall("a", "record_analogy", ANALOGY);

        for (const round of [
            [blocker, problem, analogy],
            [problem, analogy, blocker],
        ]) {
            const { provider } = scriptedModel([callTools(...round), done]);
            const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

            const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap();

            expect(result).toEqual(VALID_ENVELOPE);
        }
    });

    it("salvages a run that ends on prose, and the mask of the salvage lets only the terminal tools run", async () => {
        const { provider, calls } = scriptedModel([
            reply([text("## Analogy report\n\nSome free-text prose...")]),
            callTools(toolCall("s1", "search_arxiv", { query: "adaptive control" })),
            recordAll("t1"),
            done,
        ]);
        const logger = createCapturingLogger();
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS, logger }, inProcessSubAgent);

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap();

        expect(result).toEqual(VALID_ENVELOPE);
        expect(calls).toHaveLength(4);
        // Each salvage request declares the tools of the first run.
        for (const request of calls.slice(1)) {
            expect(toolNamesOf(request)).toEqual(REASONER_TOOLS);
        }
        expect(toolResultIn(presentAt(calls, 2), "s1")).toEqual({
            type: "error-text",
            value: JSON.stringify({
                error: "The tool search_arxiv is not available for this request, thus it did not run. The tools that can run now: record_problem, record_analogy, report_blocker.",
                retryable: false,
            }),
        });
        // The warn of the salvage reaches the logger of the tool.
        const salvage = logger.records.filter((r) => r.level === "warn" && r.msg.includes("salvaging"));
        expect(salvage).toHaveLength(1);
        expect(presentAt(salvage, 0).fields).toMatchObject({ agentId: "analogical-reasoner" });
    });

    it("gives the extraction-failed envelope when the salvage also records no outcome, and makes no conversion call", async () => {
        const prose = reply([text("Still prose, no report.")]);
        const { provider, calls } = scriptedModel([prose, prose]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = ExtractionFailedSchema.parse((await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap());

        expect(result.error.message).toContain("submitted no report and no blocker");
        // The run and its one salvage request: no third request converts the prose.
        expect(calls).toHaveLength(2);
    });

    it("names the content filter of the provider when a filter stop leaves no report", async () => {
        const filtered = reply([text("The analogy of")], "content-filter");
        const { provider } = scriptedModel([filtered, filtered]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = ExtractionFailedSchema.parse((await tool.execute({ problem: "Bacteria survive an antibiotic." }, ctxFor()))._unsafeUnwrap());

        expect(result.error.message).toContain("content filter");
    });

    it("gives the extraction-failed envelope when the loop throws", async () => {
        const { provider } = scriptedModel([{ fail: new Error("the endpoint is down") }]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = ExtractionFailedSchema.parse((await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap());

        expect(result.error.message).toContain("Analogy research failed");
        expect(result.error.message).toContain("the endpoint is down");
    });

    it("gives an invalid analogy its issues, and accepts a second record", async () => {
        const { solutions: _dropped, ...withoutSolutions } = ANALOGY;
        const { provider, calls } = scriptedModel([
            callTools(toolCall("p", "record_problem", PROBLEM), toolCall("a1", "record_analogy", withoutSolutions)),
            callTools(toolCall("a2", "record_analogy", ANALOGY)),
        ]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap();

        expect(result).toEqual(VALID_ENVELOPE);
        expect(calls).toHaveLength(2);
        const rejected = ErrorTextSchema.parse(toolResultIn(presentAt(calls, 1), "a1"));
        expect(rejected.value).toContain("input validation failed");
        expect(rejected.value).toContain("solutions");
    });

    it("refuses a placeholder blocker reason, and the run continues to the report", async () => {
        const { provider, calls } = scriptedModel([callTools(toolCall("b1", "report_blocker", { reason: "TBD" })), recordAll("t1")]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);

        const result = (await tool.execute({ problem: "Diagnose oscillation." }, ctxFor()))._unsafeUnwrap();

        expect(result).toEqual(VALID_ENVELOPE);
        const refused = ErrorTextSchema.parse(toolResultIn(presentAt(calls, 1), "b1"));
        expect(refused.value).toContain("input validation failed");
    });

    it("rejects empty problem at the input-schema boundary", () => {
        const { provider } = scriptedModel([]);
        const tool = createGenerateAnalogyReportTool({ provider, model: "claude-test", bioKeys: BIO_KEYS }, inProcessSubAgent);
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

describe("the shape of the report lives in the schema", () => {
    it("the schema describes the solution fields, and the prompt holds no JSON example", () => {
        const schema = JSON.stringify(z.toJSONSchema(AnalogyReportSchema));

        expect(schema).toContain("How the method transfers back to the source problem.");
        expect(schema).toContain("The exact title as the search result gives it.");
        expect(analogicalReasonerPrompt).not.toContain('"schemaVersion"');
    });
});
