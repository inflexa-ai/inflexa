/**
 * `knowledge_search` + `knowledge_read` — an agent's access to the knowledge
 * plane (the knowledge-tools spec). Both read through the one resolved
 * `KnowledgeBase` of the composition, and both attach whether or not a source
 * is resolved: an absent source is a data variant, thus the tool surface, the
 * prompts, and the cache-stable tool list never change with the install.
 *
 * Dependency-bearing factory. `onRuleIds` is the citation-set recorder of the
 * planner: each rule identifier a tool returns is recorded, and the grounded
 * plan gate accepts a plan citation only from that set. Other consumers omit
 * it.
 */

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import type { KnowledgeBase, RuleMatch } from "../../knowledge/knowledge-base.js";
import type { RuleRecord } from "../../knowledge/rule-record.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";

const MAX_STATEMENT_CHARS = 400;
const MAX_TOP_K = 25;
const DEFAULT_TOP_K = 10;

export interface KnowledgeToolsDeps {
    /** The resolved knowledge source. Omit when the composition resolved none. */
    readonly knowledge?: KnowledgeBase;
    /** Citation-set recorder — receives each returned rule id. */
    readonly onRuleIds?: (ids: readonly string[]) => void;
    /**
     * Obligation recorder — receives each evaluated match that `knowledge_search`
     * returns. The planner's gate accumulates its reject obligations from this,
     * thus an `applies` verdict a tool surfaces binds exactly like one from the
     * seed-time brief.
     */
    readonly onMatches?: (matches: readonly RuleMatch[]) => void;
}

interface RuleSummary {
    readonly id: string;
    readonly title: string;
    readonly severity: RuleRecord["effect"]["severity"];
    /** `applies` — the rule constrains this dataset. `not_evaluable` — it might, and a fact is unknown. */
    readonly applicability: "applies" | "not_evaluable";
    readonly statement: string;
}

type KnowledgeSearchOutput =
    | { status: "no_knowledge_source" }
    | { status: "no_matches"; corpus: { corpusId: string; version: string } }
    | { status: "ok"; corpus: { corpusId: string; version: string }; matches: RuleSummary[] };

type KnowledgeReadOutput =
    { status: "no_knowledge_source" } | { status: "not_found"; id: string } | { status: "ok"; corpus: { corpusId: string; version: string }; rule: RuleRecord };

const KNOWLEDGE_UNAVAILABLE: ToolError = { error: "the knowledge source failed to answer", retryable: true };

export function createKnowledgeTools(deps: KnowledgeToolsDeps): Tool[] {
    const record = (ids: readonly string[]): void => deps.onRuleIds?.(ids);

    const knowledgeSearch = defineTool({
        id: "knowledge_search",
        description:
            "Search the knowledge plane for the method rules that constrain an analysis. " +
            "Describe the data (omics type, subtype, smallest group size) or give keywords, or both. " +
            "Each match carries a rule id, a severity, and the rule statement — cite the id in a plan " +
            "step's `grounding` when the rule shaped the step. Returns a data variant when no " +
            "knowledge source is installed.",
        inputSchema: z.object({
            query: z.string().optional().describe("Keywords over the rule titles and statements (e.g. 'cutpoint survival')."),
            omicsType: z.string().optional().describe("The data's omics domain (e.g. 'transcriptomics')."),
            omicsSubtype: z.string().optional().describe("The subtype (e.g. 'bulk-rna-seq')."),
            minGroupN: z.number().int().positive().optional().describe("The smallest per-condition sample count, when known."),
            topK: z.number().int().min(1).max(MAX_TOP_K).optional().describe(`Max results. Defaults to ${DEFAULT_TOP_K}.`),
        }),
        describeCall: ({ query, omicsType }) => query ?? omicsType ?? "all rules",
        execute: async (input, ctx): Promise<Result<KnowledgeSearchOutput, ToolError>> => {
            if (deps.knowledge === undefined) {
                return ok({ status: "no_knowledge_source" as const });
            }
            return deps.knowledge
                .findRules(
                    {
                        facts: {
                            ...(input.omicsType !== undefined ? { omicsType: input.omicsType } : {}),
                            ...(input.omicsSubtype !== undefined ? { omicsSubtype: input.omicsSubtype } : {}),
                            ...(input.minGroupN !== undefined ? { minGroupN: input.minGroupN } : {}),
                        },
                        ...(input.query !== undefined ? { text: input.query } : {}),
                        topK: input.topK ?? DEFAULT_TOP_K,
                    },
                    ctx.session,
                )
                .match(
                    (result): Result<KnowledgeSearchOutput, ToolError> => {
                        if (result.matches.length === 0) {
                            return ok({ status: "no_matches" as const, corpus: result.corpus });
                        }
                        record(result.matches.map((m) => m.rule.id));
                        deps.onMatches?.(result.matches);
                        return ok({
                            status: "ok" as const,
                            corpus: result.corpus,
                            matches: result.matches.map((m) => ({
                                id: m.rule.id,
                                title: m.rule.title,
                                severity: m.rule.effect.severity,
                                applicability: m.applicability,
                                statement: m.rule.effect.statement.slice(0, MAX_STATEMENT_CHARS),
                            })),
                        });
                    },
                    (): Result<KnowledgeSearchOutput, ToolError> => err(KNOWLEDGE_UNAVAILABLE),
                );
        },
    });

    const knowledgeRead = defineTool({
        id: "knowledge_read",
        description:
            "Read one full knowledge rule by id (e.g. from knowledge_search or the knowledge brief): " +
            "the conditions, the full statement, the recommendation, and the cited sources with DOI or " +
            "PMID. Unknown ids and an absent knowledge source return data variants.",
        inputSchema: z.object({
            id: z.string().min(1).describe("The rule id, e.g. 'INFLEXA-R-000101'."),
        }),
        describeCall: ({ id }) => id,
        execute: async ({ id }, ctx): Promise<Result<KnowledgeReadOutput, ToolError>> => {
            if (deps.knowledge === undefined) {
                return ok({ status: "no_knowledge_source" as const });
            }
            return deps.knowledge.getRule(id, ctx.session).match(
                (lookup): Result<KnowledgeReadOutput, ToolError> => {
                    if (!lookup.found) return ok({ status: "not_found" as const, id });
                    record([lookup.rule.id]);
                    return ok({ status: "ok" as const, corpus: lookup.corpus, rule: lookup.rule });
                },
                (): Result<KnowledgeReadOutput, ToolError> => err(KNOWLEDGE_UNAVAILABLE),
            );
        },
    });

    return [knowledgeSearch, knowledgeRead];
}
