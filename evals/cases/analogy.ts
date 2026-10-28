/**
 * The decision cases of the analogical reasoner that `generate_analogy_report` runs.
 *
 * The message of each case is the brief that the tool composes. Each search tool gives the papers of a small set whose
 * keywords the query holds, thus a grader can tell a title that a search returned from a title that the reasoner made
 * up. The record tools are real: their input schemas check each part of the report.
 */

import { buildResearchPrompt } from "@inflexa-ai/harness/tools/research/generate-analogy-report.js";
import { z } from "zod";

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import { REAL_TOOL, type ToolScript } from "../lib/agent.js";
import { all, callsAny, type EvalCase, type Grader } from "../lib/case.js";

type Paper = { readonly title: string; readonly url: string; readonly abstract: string };

const PAPERS: readonly Paper[] = [
    {
        title: "Fault-tolerant control systems: an overview of redundancy and reconfiguration",
        url: "https://www.semanticscholar.org/paper/ftc-redundancy",
        abstract: "Reconfigurable control keeps a plant on its setpoint when an actuator fails, by switching the load to redundant actuators.",
    },
    {
        title: "Resilience of complex networks to targeted node removal",
        url: "https://www.semanticscholar.org/paper/network-resilience",
        abstract:
            "Scale-free networks keep their function under random failure, and degree-targeted attacks break them; rerouting through parallel paths restores flow.",
    },
    {
        title: "Integrated pest management and the evolution of insecticide resistance",
        url: "https://www.semanticscholar.org/paper/ipm-resistance",
        abstract: "Rotations and mixtures of insecticides with different targets delay resistance in pest populations.",
    },
    {
        title: "Adaptive traffic rerouting under link failures in software-defined networks",
        url: "https://arxiv.org/abs/2305.12345",
        abstract: "When a link fails, the controller reroutes flows through alternate paths within milliseconds, which keeps the throughput.",
    },
];

const TITLES = new Set(PAPERS.map((paper) => paper.title));

/** The words that make a search find a paper, by its URL. */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
    "https://www.semanticscholar.org/paper/ftc-redundancy": ["control", "redundan", "fault", "reconfigur", "actuator", "feedback"],
    "https://www.semanticscholar.org/paper/network-resilience": ["network", "resilien", "robust", "node", "attack", "interdiction", "flow", "cut"],
    "https://www.semanticscholar.org/paper/ipm-resistance": ["pest", "resistance", "insecticide", "rotation", "mixture", "combination", "ecolog", "evolution"],
    "https://arxiv.org/abs/2305.12345": ["rout", "link", "traffic", "network", "failover", "path", "flow"],
};

/** The papers whose keywords the query holds. A query that names none of them finds nothing, as a real search can. */
function papersFor(input: unknown): readonly Paper[] {
    const query = String(parseUnknownRecord(input)?.query ?? "").toLowerCase();
    return PAPERS.filter((paper) => (KEYWORDS[paper.url] ?? []).some((keyword) => query.includes(keyword)));
}

const SEMANTIC_SCHOLAR: ToolScript = (input) => ({
    ok: {
        success: true,
        papers: papersFor(input).map((paper) => ({ id: paper.url, title: paper.title, abstract: paper.abstract, year: 2019, url: paper.url, authors: [] })),
    },
});

const ARXIV: ToolScript = (input) => ({
    ok: {
        success: true,
        papers: papersFor(input).map((paper) => ({
            id: paper.url,
            title: paper.title,
            abstract: paper.abstract,
            authors: [],
            published: "2019-06-01",
            categories: ["eess.SY"],
            url: paper.url,
        })),
    },
});

const ANALOGY_TOOLS: Readonly<Record<string, ToolScript>> = {
    search_semantic_scholar: SEMANTIC_SCHOLAR,
    search_arxiv: ARXIV,
    pubmed: {
        ok: {
            totalFound: 1,
            results: [
                {
                    pmid: "29662146",
                    title: "Mechanisms of resistance to kinase inhibitors in cancer",
                    journal: "Nature Reviews Cancer",
                    year: "2018",
                    authors: "Doe J",
                },
            ],
        },
    },
    search_github_repos: { ok: { success: true, repos: [] } },
    record_problem: REAL_TOOL,
    record_analogy: REAL_TOOL,
    report_blocker: REAL_TOOL,
};

const AnalogyViewSchema = z.object({
    targetDomain: z.string(),
    analogyTitle: z.string(),
    solutions: z.array(z.object({ title: z.string(), sources: z.array(z.object({ title: z.string() })) })),
});

/**
 * The accepted analogy records hold at least two analogies outside biology and medicine, and each cited source title
 * is a title that a search returned, verbatim. The last accepted record of a title counts, as in the assembly of the
 * report.
 */
const crossDomainCited: Grader = (trial) => {
    const byTitle = new Map<string, z.infer<typeof AnalogyViewSchema>>();
    for (const call of trial.calls) {
        if (call.tool !== "record_analogy" || call.ok !== true) continue;
        const parsed = AnalogyViewSchema.safeParse(call.input);
        if (parsed.success) byTitle.set(parsed.data.analogyTitle, parsed.data);
    }
    const analogies = [...byTitle.values()];
    if (!trial.calls.some((call) => call.tool === "record_problem" && call.ok === true)) {
        return { pass: false, detail: `no accepted record_problem (calls: ${trial.calls.map((call) => call.tool).join(", ")})` };
    }
    const domains = analogies.map((analogy) => analogy.targetDomain);
    const inSource = domains.filter((domain) => /biolog|medic|oncolog|cancer|clinical/i.test(domain));
    if (analogies.length < 2 || inSource.length > 0) return { pass: false, detail: `domains: ${domains.join("; ") || "none"}` };
    const cited = analogies.flatMap((analogy) => analogy.solutions.flatMap((solution) => solution.sources.map((source) => source.title)));
    if (cited.length === 0) return { pass: false, detail: `${String(analogies.length)} analogies with no cited source` };
    const invented = cited.filter((title) => !TITLES.has(title));
    return invented.length === 0
        ? { pass: true, detail: `${String(analogies.length)} analogies, ${String(cited.length)} cited sources, each returned by a search` }
        : { pass: false, detail: `titles that no search returned: ${invented.join("; ")}` };
};

const ANALOGY: Pick<EvalCase, "agent" | "tools" | "maxSteps"> = { agent: "analogy", tools: ANALOGY_TOOLS, maxSteps: 12 };

export const analogyCases: readonly EvalCase[] = [
    {
        id: "analogy-cross-domain",
        set: "dev",
        source: "analogical reasoner prompt: analogies come from other domains, and each cited title comes from a search",
        user: buildResearchPrompt({
            problem: "A tumor keeps growing after a kinase inhibitor shuts down its main growth signaling pathway, because parallel pathways take over.",
            numDomains: 2,
            solutionsPerDomain: 1,
        }),
        ...ANALOGY,
        grade: all(callsAny(["search_semantic_scholar", "search_arxiv"]), crossDomainCited),
    },
    {
        id: "analogy-cross-domain-held-out",
        set: "held-out",
        source: "paraphrase of analogy-cross-domain",
        user: buildResearchPrompt({
            problem: "Bacteria survive an antibiotic that blocks one metabolic enzyme, because a redundant enzyme does the same work.",
            numDomains: 2,
            solutionsPerDomain: 1,
        }),
        ...ANALOGY,
        grade: all(callsAny(["search_semantic_scholar", "search_arxiv"]), crossDomainCited),
    },
];
