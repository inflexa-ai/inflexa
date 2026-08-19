import { describe, expect, it } from "bun:test";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { makeMessage, scriptedProvider, textBlock } from "../../loop/__fixtures__/scripted-provider.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import type { ToolContext } from "../define-tool.js";
import { createLiteratureReviewerTool } from "./literature-reviewer.js";
import { unusedCitationResolver } from "../../citations/__fixtures__/resolver.js";
import { literatureReviewerPrompt } from "../../prompts/literature-reviewer.js";

describe("literatureReviewer sub-agent tool", () => {
    it("runs runAgent on a derived child Session and surfaces the report", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("Evidence report: BRCA1 is a tumour suppressor.")], "end_turn")]);
        const tool = createLiteratureReviewerTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            citationResolver: unusedCitationResolver,
        });

        const parentSession = makeSession({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });
        const emitted: unknown[] = [];
        const ctx: ToolContext = {
            session: parentSession,
            signal: new AbortController().signal,
            emit: (event) => {
                emitted.push(event);
            },
            runStep: (_name, fn) => fn(),
        };

        const result = (await tool.execute({ brief: "Investigate BRCA1." }, ctx))._unsafeUnwrap() as { report: string };

        // The child's final report is surfaced as the tool result.
        expect(result.report).toBe("Evidence report: BRCA1 is a tumour suppressor.");

        // The child loop ran on a Session derived via forSubAgent:
        // agentId flipped, callPath extended.
        const childSession = provider.sessions[0]!;
        expect(childSession.provenance.agentId).toBe("literature-reviewer");
        expect(childSession.provenance.callPath).toEqual(["conversation-agent", "literature-reviewer"]);

        // The parent Session is untouched.
        expect(parentSession.provenance.agentId).toBe("conversation-agent");
        expect(parentSession.provenance.callPath).toEqual(["conversation-agent"]);

        // The child ran the literature-reviewer agent: its own research tool set,
        // and nothing of the parent's (no planning, no workspace mutate surface).
        expect(Object.keys(provider.calls[0]!.tools).sort()).toEqual([
            "drug_gene_interactions",
            "gene_preclinical_profile",
            "lookup_annotation",
            "pubmed",
            "resolve_citation",
            "search_gene",
            "search_interactions",
        ]);

        // The child transcript is not exposed — only the report leaves the tool.
        expect(Object.keys(result)).toEqual(["report"]);
    });

    it("returns an error, not an empty report, when the child run ends without a final text", async () => {
        // A terminal reply with no text block ends the child loop, and the
        // transcript then holds no report. The tool must surface that as an
        // error that names the finish reason, not as `ok({ report: "" })`.
        const provider = scriptedProvider([makeMessage([], "end_turn")]);
        const tool = createLiteratureReviewerTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            citationResolver: unusedCitationResolver,
        });

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
