/**
 * Report Builder Agent — in-process templating agent (no sandbox).
 *
 * Authors HTML reports via Jinja2 templating. Runs in the Cortex Node
 * process — file IO is in-process via the `versionFs` tool roster, rendering
 * is Node-side via Nunjucks (`build_report` tool), and visual validation
 * uses headless Chrome via the `preview_snapshot` tool.
 *
 * The agent receives a complete brief from iterate-report's pre-flight
 * (assets staged, columns parsed, sections fully composed) and has no
 * discovery surface — its workspace is rooted at the version directory.
 *
 * NOT a sandbox-agent catalog member (per design Decision #2 — not
 * plannable). The full tool roster is constructed inside the runner so
 * each tool shares the runner's closure-captured outcome state and
 * preview-dir paths; this factory just packages the result into a plain
 * `AgentDefinition`.
 */

import type { AgentDefinition } from "../loop/types.js";
import type { Tool } from "../tools/define-tool.js";
import { reportBuilderPrompt } from "../prompts/report-builder.js";
import { composeSystemPrompt } from "./system-prompt.js";

export const REPORT_BUILDER_AGENT_ID = "report-builder";

/** Runaway guard — Jinja recovery may take several build/edit cycles. */
const REPORT_BUILDER_MAX_ITERATIONS = 75;

export interface CreateReportBuilderAgentDeps {
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /**
     * Full tool roster — the 4 custom report tools plus the in-process
     * versionFs surface, all constructed inside the runner so they close
     * over the iteration's outcome state and preview-dir paths.
     */
    readonly tools: readonly Tool[];
}

export function createReportBuilderAgent(deps: CreateReportBuilderAgentDeps): AgentDefinition {
    return {
        id: REPORT_BUILDER_AGENT_ID,
        systemPrompt: composeSystemPrompt(reportBuilderPrompt),
        model: deps.model,
        tools: deps.tools,
        maxIterations: REPORT_BUILDER_MAX_ITERATIONS,
    };
}
