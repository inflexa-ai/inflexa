/**
 * generateAnalogyReport — cross-domain analogy report as a sub-agent tool.
 *
 * An inline harness `AgentDefinition` (mirroring `createLiteratureReviewerTool`)
 * driven by `runAgent`. The inner research agent runs Phase 1 extraction +
 * Phase 2 cross-domain search; the wrapper parses + schema-validates the text
 * output; on parse failure a single-shot conversion call (no tools) transforms
 * raw markdown into a valid envelope; on hard failure an `extraction-failed`
 * error envelope surfaces — the frontend never has to render raw prose.
 *
 * One provider serves both the research agent and the conversion retry.
 * The harness Anthropic provider silently drops `temperature` on 4.7+
 * models (`gatePerCallOverrides`), so a Sonnet-vs-Opus split for the
 * conversion path is unnecessary here — the wrapper's parse + validate +
 * error-envelope cascade is the real correctness guarantee.
 */

import { ok } from "neverthrow";
import { z } from "zod";

import { AnalogicalReasonerOutputSchema, type AnalogicalReasonerOutput } from "@inflexa-ai/harness/contracts/analogy-report.js";

import { analogicalReasonerPrompt } from "../../prompts/analogical-reasoner.js";
import { forSubAgent } from "../../auth/types.js";
import { unwrapOrThrow } from "../../lib/result.js";
import { finalText, runAgent } from "../../loop/run-agent.js";
import { passthroughStep } from "../../loop/run-step.js";
import type { AgentDefinition } from "../../loop/types.js";
import type { ChatProvider } from "../../providers/types.js";
import { defineTool, type Tool } from "../define-tool.js";

// Cross-domain search tools the analogical-reasoner uses.
import { searchSemanticScholarTool } from "./search-semantic-scholar.js";
import { searchArxivTool } from "./search-arxiv.js";
import { createSearchGithubReposTool } from "./search-github-repos.js";

// Biology literature — reused for analogies that land back in biology.
import { createNcbiTools, type BioToolKeys } from "../bio/keys.js";

/** Sub-agent identity — appended to `callPath`, set as `agentId`. */
const AGENT_ID = "analogical-reasoner";

/** Tool-call budget for the inner research agent. */
const RESEARCH_MAX_ITERATIONS = 40;

export const generateAnalogyReportInputSchema = z.object({
    problem: z
        .string()
        .min(1)
        .describe(
            "The scientific problem in natural language. The single most important " +
                "field — describes what the user is trying to do and the system-level " +
                "constraints. Keep it focused; the inner agent reads this verbatim.",
        ),
    context: z
        .string()
        .optional()
        .describe(
            "Optional supporting context: data profile excerpt, prior findings, " +
                "experimental design notes, user constraints. Keep under ~500 tokens. " +
                "Do NOT paste full files — the inner agent does not need them.",
        ),
    numDomains: z.number().int().min(2).max(5).optional().describe("How many cross-domain analogies to extract. Defaults to 3."),
    solutionsPerDomain: z.number().int().min(1).max(5).optional().describe("How many real, cited solutions to surface per analogy. Defaults to 3."),
    preferredDomains: z
        .array(z.string())
        .optional()
        .describe("Soft preferences for analogy domains (e.g., " + '`["control_theory", "ecology"]`). The agent treats these as hints, ' + "not constraints."),
    excludeDomains: z
        .array(z.string())
        .optional()
        .describe(
            "Hard exclusions — domains the agent must avoid. Use to force a " +
                'cross-domain search (e.g., `["biology"]` when the source problem is ' +
                "biological).",
        ),
});

export type GenerateAnalogyReportInput = z.infer<typeof generateAnalogyReportInputSchema>;

/**
 * Render the structured input as a brief that maps 1-to-1 to the
 * `analogical-reasoner` prompt's "Inputs you may see in the brief" section.
 * Exported for unit testing.
 */
export function buildResearchPrompt(input: GenerateAnalogyReportInput): string {
    const lines: string[] = ["## Problem", input.problem];

    if (input.context) {
        lines.push("", "## Context", input.context);
    }

    const knobs: string[] = [];
    if (input.numDomains !== undefined) {
        knobs.push(`- numDomains: ${input.numDomains}`);
    }
    if (input.solutionsPerDomain !== undefined) {
        knobs.push(`- solutionsPerDomain: ${input.solutionsPerDomain}`);
    }
    if (input.preferredDomains && input.preferredDomains.length > 0) {
        knobs.push(`- preferredDomains: ${input.preferredDomains.join(", ")}`);
    }
    if (input.excludeDomains && input.excludeDomains.length > 0) {
        knobs.push(`- excludeDomains: ${input.excludeDomains.join(", ")}`);
    }
    if (knobs.length > 0) {
        lines.push("", "## Knobs", ...knobs);
    }

    return lines.join("\n");
}

/**
 * Conversion prompt the retry uses when the inner research agent's output
 * is not valid JSON. Quotes the raw output verbatim and asks for a strict
 * AnalogyReportSchema-shaped object back. No tools — single shot.
 */
function buildConversionPrompt(rawOutput: string): string {
    return [
        "Convert the analogical-reasoner output below into a single JSON",
        "object matching the AnalogyReport schema. Return ONLY raw JSON — no",
        "prose, no markdown fences, no commentary, no apology. The first",
        "character of your response must be `{`. The final character must be `}`.",
        "",
        "## Required shape (AnalogyReportSchema)",
        "",
        "```json",
        "{",
        '  "schemaVersion": "1",',
        '  "problemSummary": "1-2 sentence summary of the source problem.",',
        '  "problemObjects": [{ "name": "...", "role": "..." }],',
        '  "problemRelations": ["short bullet phrase", "..."],',
        '  "keyTerms": ["term1", "term2"],',
        '  "analogies": [',
        "    {",
        '      "targetDomain": "control_theory",',
        '      "analogyTitle": "Adaptive control of an unseen plant",',
        '      "objectMappings": [{ "source": "...", "target": "...", "rationale": "..." }],',
        '      "sharedRelations": "...",',
        '      "coverage": "available",',
        '      "solutions": [',
        "        {",
        '          "title": "Method or paper title (verbatim from input)",',
        '          "sourceDomain": "control_theory",',
        '          "description": "2-3 sentences.",',
        '          "keyConcepts": ["..."],',
        '          "relevance": "How this transfers back to the source problem.",',
        '          "sources": [{ "url": "https://...", "title": "Exact paper title" }],',
        '          "githubRepos": []',
        "        }",
        "      ]",
        "    }",
        "  ]",
        "}",
        "```",
        "",
        "## Field rules",
        "",
        "- Preserve every analogy, object mapping, shared relation, solution, and",
        "  citation that appears in the input. Do not invent content.",
        "- Each analogy needs `coverage`:",
        "  - `available` when the input lists concrete solutions for it,",
        "  - `queried_no_data` when the input says searches returned no usable results,",
        "  - `search_failed` when the input says the search tool errored out,",
        "  - `not_loaded` when the input says the analogy was skipped (budget).",
        "  When `coverage` is not `available`, `solutions` must be `[]`.",
        "- Each `solutions[].sources[]` entry needs a valid `url` (http/https)",
        "  AND a `title`. If a paper is mentioned without a URL, omit that source.",
        "- `githubRepos` must always be an array (use `[]` when not mentioned).",
        "- If the input has no extractable analogy content at all (pure apology,",
        "  empty, off-topic), return the envelope with `analogies: []`. The",
        "  wrapper translates that into an error envelope.",
        "",
        "--- INPUT ---",
        rawOutput,
        "--- END INPUT ---",
    ].join("\n");
}

export interface GenerateAnalogyReportDeps {
    /** The LLM seam the child loop runs on. */
    readonly provider: ChatProvider;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /** API keys for the bio/chem + GitHub data sources the reasoner searches. */
    readonly bioKeys: BioToolKeys;
}

/** Build the `generate_analogy_report` delegation tool bound to its provider. */
export function createGenerateAnalogyReportTool(deps: GenerateAnalogyReportDeps): Tool {
    const ncbi = createNcbiTools(deps.bioKeys);
    const reasonerTools: readonly Tool[] = [
        searchSemanticScholarTool,
        searchArxivTool,
        createSearchGithubReposTool({ githubToken: deps.bioKeys.github }),
        ncbi.searchPubMed,
        ncbi.getArticleDetails,
        ncbi.getArticleFullText,
    ];

    const agent: AgentDefinition = {
        id: AGENT_ID,
        systemPrompt: analogicalReasonerPrompt,
        model: deps.model,
        tools: reasonerTools,
        maxIterations: RESEARCH_MAX_ITERATIONS,
    };

    return defineTool({
        id: "generate_analogy_report",
        description:
            "Generate a cross-domain analogy report for an open-ended scientific " +
            "problem. Pass the user's problem as a single field plus optional " +
            "context (data profile excerpts, prior findings) and knobs (domain " +
            "counts, preferred/excluded domains). Returns a structured " +
            "AnalogyReport envelope — analogies with object mappings, shared " +
            "relations, and cited solutions from other domains. The UI renders " +
            "the envelope as an inline card; reach for this tool whenever the " +
            "user is in exploratory or hypothesis-generation mode.",
        inputSchema: generateAnalogyReportInputSchema,
        execute: async (input, ctx) => {
            const childSession = forSubAgent(ctx.session, AGENT_ID);

            // Phase 1+2: drive the research agent over the cross-domain toolset.
            let rawText: string;
            try {
                const { messages: transcript } = await runAgent(agent, [{ role: "user", content: buildResearchPrompt(input) }], childSession, {
                    provider: deps.provider,
                    signal: ctx.signal,
                    emit: ctx.emit,
                    runStep: passthroughStep,
                });
                rawText = finalText(transcript);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return ok({
                    schemaVersion: "1",
                    error: {
                        kind: "extraction-failed",
                        message: `Analogy research failed: ${message}`.slice(0, 240),
                    },
                } satisfies AnalogicalReasonerOutput);
            }

            // Fast path: the agent emitted valid JSON matching the schema.
            const directParse = tryParseEnvelope(rawText);
            if (directParse.ok) return ok(directParse.value);

            // Slow path: a single-shot conversion call (no tools) transforms the
            // raw output into a valid envelope. The harness anthropic provider
            // silently drops `temperature` on 4.7+ models, so an explicit
            // Sonnet-vs-Opus split is unnecessary — the parse+validate+envelope
            // cascade below is the real safety net.
            try {
                const reply = unwrapOrThrow(
                    await deps.provider.chat(
                        {
                            tools: {},
                            toolChoice: "none",
                            system:
                                "You convert an analogical-reasoner's free-text output " +
                                "into a strict AnalogyReportSchema JSON envelope. You " +
                                "preserve information faithfully and never invent content. " +
                                "You return ONLY raw JSON — no prose, no markdown fences, " +
                                "no commentary.",
                            messages: [{ role: "user", content: buildConversionPrompt(rawText) }],
                        },
                        childSession,
                        ctx.signal,
                    ),
                );

                const content = reply.message.content;
                const convertedText =
                    typeof content === "string"
                        ? content
                        : content
                              .filter((b): b is { type: "text"; text: string } & typeof b => b.type === "text")
                              .map((b) => b.text)
                              .join("");

                const parse = tryParseEnvelope(convertedText);
                if (!parse.ok) return ok(buildExtractionFailedEnvelope());

                // If the conversion model produced an error envelope verbatim,
                // surface it (it knows something we don't about the input).
                if ("error" in parse.value) return ok(parse.value);

                // Empty `analogies: []` means the input had no extractable content
                // (apology, off-topic) — surface as extraction-failed.
                if (parse.value.analogies.length === 0) {
                    return ok(buildExtractionFailedEnvelope());
                }

                return ok(parse.value);
            } catch {
                return ok(buildExtractionFailedEnvelope());
            }
        },
    });
}

/** Single source of truth for the wrapper's terminal "could not recover" envelope. */
function buildExtractionFailedEnvelope(): AnalogicalReasonerOutput {
    return {
        schemaVersion: "1",
        error: {
            kind: "extraction-failed",
            message: "The analogical reasoner returned malformed output that could not " + "be recovered. Try narrowing the problem statement.",
        },
    };
}

interface ParseSuccess {
    ok: true;
    value: AnalogicalReasonerOutput;
}

interface ParseFailure {
    ok: false;
    reason: "not-json" | "schema-mismatch";
}

/**
 * Trim leading whitespace and strip a single wrapping ```json fence before
 * parsing — the inner agent's prompt forbids code fences but a relaxed
 * parse here avoids burning a conversion retry on trivial slips. Beyond
 * that, no salvaging. Exported for unit testing.
 */
export function tryParseEnvelope(raw: string): ParseSuccess | ParseFailure {
    const stripped = stripFence(raw);
    let candidate: unknown;
    try {
        candidate = JSON.parse(stripped);
    } catch {
        return { ok: false, reason: "not-json" };
    }
    const result = AnalogicalReasonerOutputSchema.safeParse(candidate);
    if (!result.success) return { ok: false, reason: "schema-mismatch" };
    return { ok: true, value: result.data };
}

function stripFence(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("```")) return trimmed;
    return trimmed.replace(/^```(?:json)?\s*\n/i, "").replace(/\n```\s*$/i, "");
}
