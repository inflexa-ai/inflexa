/**
 * The cases of the run synthesizer. A case gives the narrative of the plan and the step summaries, which the run
 * gives as the first message. The synthesizer reads the files of the run only where a summary is thin.
 */

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import { REAL_TOOL, type ToolScript } from "../lib/agent.js";
import { all, callsAny, never, submits, type EvalCase } from "../lib/case.js";

/**
 * The tools that put the content of a file into the context. A case where the summaries suffice grades that none of
 * them runs. A listing or the data profile is a cheap orientation, thus it does not count.
 */
const CONTENT_READS = ["read_file", "grep", "read_table", "read_pdf"];

const PUBMED = {
    ok: {
        totalFound: 1,
        results: [{ pmid: "31501552", title: "Interferon signaling in fibroblasts", journal: "Immunity", year: "2019", authors: "Doe J" }],
    },
};

/** A scripted read of one file: the content of `files` at the asked path, else not found. */
function readFileOf(files: Readonly<Record<string, string>>): ToolScript {
    return (input) => {
        const path = String(parseUnknownRecord(input)?.path ?? "");
        const hit = Object.entries(files).find(([name]) => path.endsWith(name));
        return hit === undefined ? { ok: { status: "not_found", path } } : { ok: { status: "ok", path, mode: "full", content: hit[1] } };
    };
}

/** A scripted read of one table: the rows of `tables` at the asked path, else an error. */
function readTableOf(tables: Readonly<Record<string, readonly Record<string, string | number>[]>>): ToolScript {
    return (input) => {
        const path = String(parseUnknownRecord(input)?.path ?? "");
        const hit = Object.entries(tables).find(([name]) => path.endsWith(name));
        if (hit === undefined) return { error: `${path} does not exist` };
        const rows = hit[1];
        return { ok: { path, columns: Object.keys(rows[0] ?? {}), rowCount: rows.length, rows } };
    };
}

const FGSEA_ROWS = [
    { pathway: "HALLMARK_INTERFERON_GAMMA_RESPONSE", NES: 2.41, padj: 0.000001 },
    { pathway: "HALLMARK_INTERFERON_ALPHA_RESPONSE", NES: 2.27, padj: 0.000004 },
    { pathway: "HALLMARK_INFLAMMATORY_RESPONSE", NES: 1.83, padj: 0.002 },
    { pathway: "HALLMARK_OXIDATIVE_PHOSPHORYLATION", NES: -1.91, padj: 0.001 },
];
const FGSEA_CSV = ["pathway,NES,padj", ...FGSEA_ROWS.map((r) => `${r.pathway},${String(r.NES)},${String(r.padj)}`)].join("\n");

const MARKER_ROWS = [
    { cluster: 4, gene: "MKI67", avg_log2FC: 3.1, p_val_adj: 1e-40 },
    { cluster: 4, gene: "TOP2A", avg_log2FC: 2.9, p_val_adj: 1e-35 },
    { cluster: 4, gene: "CENPF", avg_log2FC: 2.4, p_val_adj: 1e-30 },
];
const MARKER_CSV = [
    "cluster,gene,avg_log2FC,p_val_adj",
    ...MARKER_ROWS.map((r) => `${String(r.cluster)},${r.gene},${String(r.avg_log2FC)},${String(r.p_val_adj)}`),
].join("\n");

function tools(
    files: Readonly<Record<string, string>>,
    tables: Readonly<Record<string, readonly Record<string, string | number>[]>>,
): Readonly<Record<string, ToolScript>> {
    return { pubmed: PUBMED, read_file: readFileOf(files), read_table: readTableOf(tables), submit_synthesis: REAL_TOOL, report_blocker: REAL_TOOL };
}

const BULK_NARRATIVE = "Compare treated and control fibroblasts. Find the pathways that the treatment changes, and interpret them.";
const SC_NARRATIVE = "Cluster the PBMC cells of the tumor samples, and say which cell state each new cluster is.";

export const synthesisCases: readonly EvalCase[] = [
    {
        id: "synthesis-reads-a-thin-summary",
        set: "dev",
        agent: "synthesis",
        source: "synthesis prompt: read a file of the run where a summary points to a table and does not give its result",
        user: "",
        synthesis: {
            narrative: BULK_NARRATIVE,
            summaries: [
                {
                    stepId: "T1S1",
                    agentId: "bulk-transcriptomics-agent",
                    markdown:
                        "## Differential expression\n\nPyDESeq2, treated vs control, 4 samples in each group. 412 genes at padj < 0.05 (238 up, 174 down). Results: `runs/run-001/T1S1/output/de_results.csv`.",
                },
                {
                    stepId: "T1S2",
                    agentId: "enrichment-agent",
                    markdown:
                        "## Enrichment\n\nfgsea over the Hallmark sets on the ranking of T1S1. 9 sets at padj < 0.05. The table is `runs/run-001/T1S2/output/fgsea_hallmark.csv`.",
                },
            ],
        },
        tools: tools({ "fgsea_hallmark.csv": FGSEA_CSV }, { "fgsea_hallmark.csv": FGSEA_ROWS }),
        maxSteps: 12,
        grade: all(callsAny(["read_file", "read_table", "grep"]), submits("submit_synthesis", ["interferon"])),
    },
    {
        id: "synthesis-trusts-a-full-summary",
        set: "dev",
        agent: "synthesis",
        source: "synthesis prompt: the step summaries come first, thus a complete summary needs no read",
        user: "",
        synthesis: {
            narrative: BULK_NARRATIVE,
            summaries: [
                {
                    stepId: "T1S1",
                    agentId: "bulk-transcriptomics-agent",
                    markdown:
                        "## Differential expression\n\nPyDESeq2, treated vs control, 4 samples in each group. 412 genes at padj < 0.05 (238 up, 174 down).",
                },
                {
                    stepId: "T1S2",
                    agentId: "enrichment-agent",
                    markdown:
                        "## Enrichment\n\nfgsea over the Hallmark sets. Up: interferon gamma response (NES 2.41, padj 1e-6), interferon alpha response (NES 2.27), inflammatory response (NES 1.83). Down: oxidative phosphorylation (NES -1.91, padj 0.001).",
                },
            ],
        },
        tools: tools({ "fgsea_hallmark.csv": FGSEA_CSV }, { "fgsea_hallmark.csv": FGSEA_ROWS }),
        maxSteps: 12,
        grade: all(callsAny(["submit_synthesis"]), never(CONTENT_READS)),
    },
    {
        id: "synthesis-reads-a-thin-summary-held-out",
        set: "held-out",
        agent: "synthesis",
        source: "paraphrase of synthesis-reads-a-thin-summary",
        user: "",
        synthesis: {
            narrative: SC_NARRATIVE,
            summaries: [
                {
                    stepId: "T1S1",
                    agentId: "single-cell-agent",
                    markdown:
                        "## Clustering\n\nLeiden at resolution 0.8 gave 9 clusters over 18,204 cells. Cluster 4 is new against the reference atlas. Its marker genes are in `runs/run-001/T1S1/output/markers_cluster4.csv`.",
                },
            ],
        },
        tools: tools({ "markers_cluster4.csv": MARKER_CSV }, { "markers_cluster4.csv": MARKER_ROWS }),
        maxSteps: 12,
        grade: all(callsAny(["read_file", "read_table", "grep"]), submits("submit_synthesis", ["prolif"])),
    },
    {
        id: "synthesis-trusts-a-full-summary-held-out",
        set: "held-out",
        agent: "synthesis",
        source: "paraphrase of synthesis-trusts-a-full-summary",
        user: "",
        synthesis: {
            narrative: SC_NARRATIVE,
            summaries: [
                {
                    stepId: "T1S1",
                    agentId: "single-cell-agent",
                    markdown:
                        "## Clustering\n\nLeiden at resolution 0.8 gave 9 clusters over 18,204 cells. Cluster 4 is new against the reference atlas. Its top markers are MKI67 (log2FC 3.1), TOP2A (2.9), and CENPF (2.4), all at adjusted p < 1e-30: a proliferating state.",
                },
            ],
        },
        tools: tools({ "markers_cluster4.csv": MARKER_CSV }, { "markers_cluster4.csv": MARKER_ROWS }),
        maxSteps: 12,
        grade: all(callsAny(["submit_synthesis"]), never(CONTENT_READS)),
    },
];
