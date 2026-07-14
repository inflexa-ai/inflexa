/**
 * literatureReviewer — a sub-agent packaged as a loop-driving tool.
 *
 * The conversation agent delegates batch literature/biology research by
 * calling this tool. `execute` derives a child `Session` (`forSubAgent`)
 * and runs `runAgent` over a focused literature-reviewer agent: a research
 * brief in, a structured evidence report out. The child's transcript is
 * ephemeral — it lives only for this call and is never persisted (see the harness-thread-store spec).
 *
 * This is the whole of sub-agent delegation in the harness. There is no
 * `agents: {}` config, no `messageFilter`, no `stripParentToolParts`: the
 * child cannot see the parent's tool history because it is simply handed
 * none — only the brief. The child loop uses `passthroughStep` because the
 * entire tool call is one step in the parent loop (PR #3 caches it whole,
 * so the child never replays).
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { finalText, runAgent } from "../../loop/run-agent.js";
import { passthroughStep } from "../../loop/run-step.js";
import type { AgentDefinition } from "../../loop/types.js";
import { literatureReviewerPrompt } from "../../prompts/literature-reviewer.js";
import { composeSystemPrompt } from "../../agents/system-prompt.js";
import { forSubAgent } from "../../auth/types.js";
import { type ChatProvider } from "../../providers/types.js";
import { defineTool, type Tool } from "../define-tool.js";
import { createNcbiTools, type BioToolKeys } from "../bio/keys.js";
import { getImpcKoProfileTool } from "../bio/get-impc-ko-profile.js";
import { lookupGoTermTool } from "../bio/lookup-go-term.js";
import { searchBgeeExpressionTool } from "../bio/search-bgee-expression.js";
import { searchDgidbTool } from "../bio/search-dgidb.js";
import { searchGeneTool } from "../bio/search-gene.js";
import { searchInteractionsTool } from "../bio/search-interactions.js";
import { searchPathwayTool } from "../bio/search-pathway.js";

/** Sub-agent identity — appended to `callPath`, set as `agentId`. */
const AGENT_ID = "literature-reviewer";

/** Multi-tool research budget — search → read → synthesize over many genes. */
const REVIEWER_MAX_ITERATIONS = 30;

export interface LiteratureReviewerDeps {
    /** The LLM seam the child loop runs on. */
    readonly provider: ChatProvider;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /** API keys for the bio/chem data sources the reviewer searches. */
    readonly bioKeys: BioToolKeys;
}

/** Build the `literature_reviewer` delegation tool bound to its provider. */
export function createLiteratureReviewerTool(deps: LiteratureReviewerDeps): Tool {
    const ncbi = createNcbiTools(deps.bioKeys);
    const reviewerTools: readonly Tool[] = [
        searchGeneTool,
        searchPathwayTool,
        lookupGoTermTool,
        searchInteractionsTool,
        ncbi.pubmed,
        searchDgidbTool,
        searchBgeeExpressionTool,
        getImpcKoProfileTool,
    ];

    const agent: AgentDefinition = {
        id: AGENT_ID,
        systemPrompt: composeSystemPrompt(literatureReviewerPrompt),
        model: deps.model,
        tools: reviewerTools,
        maxIterations: REVIEWER_MAX_ITERATIONS,
    };

    return defineTool({
        id: "literature_reviewer",
        description:
            "Delegate batch literature/biology research: looking up multiple " +
            "genes or pathways, validating findings against published knowledge, " +
            "or building evidence profiles. Pass a self-contained brief — the " +
            "reviewer has no access to this conversation. Returns a structured " +
            "evidence report. Do NOT delegate simple single-gene lookups; handle " +
            "those directly with your own bio-lookup tools.",
        inputSchema: z.object({
            brief: z
                .string()
                .min(1)
                .describe(
                    "A self-contained research brief: the genes, pathways, or " +
                        "biological features to investigate and the experimental " +
                        "context. The reviewer sees only this — include everything it needs.",
                ),
        }),
        execute: async ({ brief }, ctx) => {
            const { messages: transcript } = await runAgent(agent, [{ role: "user", content: brief }], forSubAgent(ctx.session, AGENT_ID), {
                provider: deps.provider,
                signal: ctx.signal,
                emit: ctx.emit,
                runStep: passthroughStep,
            });
            return ok({ report: finalText(transcript) });
        },
    });
}
