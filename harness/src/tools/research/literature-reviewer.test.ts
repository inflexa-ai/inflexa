import { describe, expect, it } from "bun:test";

import { makeSession } from "../../providers/__fixtures__/session.js";
import { makeMessage, scriptedProvider, textBlock } from "../../loop/__fixtures__/scripted-provider.js";
import type { ToolContext } from "../define-tool.js";
import { createLiteratureReviewerTool } from "./literature-reviewer.js";

describe("literatureReviewer sub-agent tool", () => {
    it("runs runAgent on a derived child Session and surfaces the report", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("Evidence report: BRCA1 is a tumour suppressor.")], "end_turn")]);
        const tool = createLiteratureReviewerTool({
            provider,
            model: "claude-test",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
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

        // The child ran the literature-reviewer agent (its prompt + 10 tools).
        expect(provider.calls[0]!.tools).toHaveLength(10);

        // The child transcript is not exposed — only the report leaves the tool.
        expect(Object.keys(result)).toEqual(["report"]);
    });
});
