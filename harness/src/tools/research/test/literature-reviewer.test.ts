import { describe, expect, it } from "bun:test";
import { inProcessSubAgent } from "../../../loop/sub-agent.js";
import { okAsync } from "neverthrow";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { z } from "zod";

import type { ToolOutputStore } from "../../../loop/tool-output.js";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { makeSession } from "../../../providers/__fixtures__/session.js";
import { reply, scriptedModel, text } from "../../../testing.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import type { ToolContext } from "../../define-tool.js";
import { createLiteratureReviewerTool } from "../literature-reviewer.js";
import { unusedCitationResolver } from "../../../citations/__fixtures__/resolver.js";
import { literatureReviewerPrompt } from "../../../prompts/literature-reviewer.js";
import { presentAt } from "../../../lib/present.js";

const IterationEventSchema = z.object({
    type: z.literal("iteration"),
    source: z.object({ agentId: z.string(), callPath: z.array(z.string()), invocationId: z.string().optional() }),
});

const toolNamesOf = (call: LanguageModelV4CallOptions): string[] => (call.tools ?? []).map((tool) => tool.name);

describe("literatureReviewer sub-agent tool", () => {
    it("runs the child loop on a derived child Session and surfaces the report", async () => {
        const { provider, calls } = scriptedModel([reply([text("Evidence report: BRCA1 is a tumour suppressor.")])]);
        const tool = createLiteratureReviewerTool(
            {
                provider,
                model: "claude-test",
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                citationResolver: unusedCitationResolver,
            },
            inProcessSubAgent,
        );

        const parentSession = makeSession({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });
        const emitted: unknown[] = [];
        const ctx: ToolContext = {
            invocationId: "tool-call-test",
            session: parentSession,
            signal: new AbortController().signal,
            emit: (event) => {
                emitted.push(event);
            },
        };

        const result = parseUnknownRecord((await tool.execute({ brief: "Investigate BRCA1." }, ctx))._unsafeUnwrap());
        if (!result || !("report" in result)) throw new Error("expected a report");

        // The child's final report is surfaced as the tool result.
        expect(result.report).toBe("Evidence report: BRCA1 is a tumour suppressor.");

        // The child loop ran on a Session derived via forSubAgent: its events
        // carry the flipped agentId and the extended callPath.
        const iterations = emitted.flatMap((event) => {
            const parsed = IterationEventSchema.safeParse(event);
            return parsed.success ? [parsed.data] : [];
        });
        expect(iterations).toHaveLength(1);
        expect(presentAt(iterations, 0).source).toMatchObject({
            agentId: "literature-reviewer",
            callPath: ["conversation-agent", "literature-reviewer"],
            invocationId: "tool-call-test",
        });

        // The parent Session is untouched.
        expect(parentSession.provenance.agentId).toBe("conversation-agent");
        expect(parentSession.provenance.callPath).toEqual(["conversation-agent"]);

        // The child ran the literature-reviewer agent: its own research tool set,
        // and nothing of the parent's (no planning, no workspace mutate surface).
        expect(toolNamesOf(presentAt(calls, 0)).sort()).toEqual([
            "drug_gene_interactions",
            "gene_preclinical_profile",
            "lookup_annotation",
            "pubmed",
            "resolve_citation",
            "search_gene",
            "search_interactions",
            "search_protein",
        ]);

        // The child transcript is not exposed — only the report leaves the tool.
        expect(Object.keys(result)).toEqual(["report"]);
    });

    it("declares read_tool_output after the lookup tools when it has a tool output store", async () => {
        const { provider, calls } = scriptedModel([reply([text("Evidence report.")])]);
        const toolOutputStore: ToolOutputStore = { put: () => okAsync(undefined), get: () => okAsync(null) };
        const tool = createLiteratureReviewerTool(
            {
                provider,
                model: "claude-test",
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                citationResolver: unusedCitationResolver,
                toolOutputStore,
            },
            inProcessSubAgent,
        );

        (await tool.execute({ brief: "Investigate BRCA1." }, makeToolContext().ctx))._unsafeUnwrap();

        expect(toolNamesOf(presentAt(calls, 0))).toEqual([
            "search_gene",
            "search_protein",
            "lookup_annotation",
            "search_interactions",
            "pubmed",
            "resolve_citation",
            "drug_gene_interactions",
            "gene_preclinical_profile",
            "read_tool_output",
        ]);
    });

    it("returns an error, not an empty report, when the child run ends without a final text", async () => {
        // A terminal reply with no text block ends the child loop, and the
        // transcript then holds no report. The tool must surface that as an
        // error that names the finish reason, not as `ok({ report: "" })`.
        const { provider } = scriptedModel([reply([])]);
        const tool = createLiteratureReviewerTool(
            {
                provider,
                model: "claude-test",
                bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
                citationResolver: unusedCitationResolver,
            },
            inProcessSubAgent,
        );

        const { ctx } = makeToolContext();
        const outcome = await tool.execute({ brief: "Investigate BRCA1." }, ctx);

        expect(outcome.isErr()).toBe(true);
        const error = outcome._unsafeUnwrapErr();
        expect(error.error).toContain("no report");
        expect(error.error).toContain("stop");
        expect(error.retryable).toBe(true);
    });

    it("distinguishes citation discovery from verification without collapsing uncertainty", () => {
        expect(literatureReviewerPrompt).toContain("not topical discovery");
        expect(literatureReviewerPrompt).toContain("`inconclusive` is not `not_found`");
        expect(literatureReviewerPrompt).toContain("unavailable authority is not proof of fabrication");
        expect(literatureReviewerPrompt).toContain("Never describe a weak candidate, partial coverage, or an unavailable source as proof");
    });
});
