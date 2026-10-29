/**
 * The decision cases of the report agent of a report session.
 *
 * The first message of a session is its seed: the brief that `start_report_session` carried. The pinned evidence
 * is a differential expression run: a results table, a volcano plot, and a synthesis. Each tool gives a canned
 * answer, and the authoring tools land each block.
 */

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import type { ToolScript } from "../lib/agent.js";
import { all, assistantText, callsAny, decides, never, priorCall, userMessage, type EvalCase, type Grader } from "../lib/case.js";

const DE_TABLE = "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/differential-expression/output/de_results.csv";
const VOLCANO = "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/differential-expression/figures/volcano.png";
const SYNTHESIS_PATH = "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/synthesis.json";
const COLUMNS = ["gene_id", "symbol", "log2FoldChange", "padj"];

function seed(objective: string, angle: string): string {
    return `# Report Brief\n\nObjective: ${objective}\nAudience: the members of the lab\nAngle: ${angle}\n`;
}

/** The rows of the results table: 610 significant genes, 412 up and 198 down. */
const DE_ROWS = Array.from({ length: 610 }, (_, i) => {
    const up = i < 3 || i % 3 !== 2;
    const symbol = ["ISG15", "MX1", "IFIT1"][i] ?? `LOC${105_000 + i * 7}`;
    return {
        gene_id: `ENSG${String(100_000 + i * 13).padStart(11, "0")}`,
        symbol,
        log2FoldChange: (up ? 1 : -1) * (1.1 + ((i * 37) % 200) / 100),
        padj: 1e-38 * 1.12 ** i,
    };
});

const LISTING = {
    outcome: "listed",
    artifacts: [
        { path: DE_TABLE, fileType: "output", columnCount: 4 },
        { path: VOLCANO, fileType: "figure" },
        { path: SYNTHESIS_PATH, fileType: "synthesis" },
    ],
    total: 3,
    truncated: false,
    citations: [],
};

const SYNTHESIS = JSON.stringify({
    conclusions: ["Treatment induces an interferon response: 412 genes up and 198 down at FDR 0.05."],
    keyFindings: [{ finding: "ISG15, MX1, and IFIT1 rank highest, log2 fold change 3.1 to 4.0", novelty: "established" }],
    limitations: ["Three replicates for each group", "C3 has a low library size"],
});

const LANDED = { ok: { applied: true, changed: [] } };

/** The tools of a session that composes a report. */
const COMPOSE_TOOLS: Readonly<Record<string, ToolScript>> = {
    list_pinned_artifacts: (input) => {
        const path = parseUnknownRecord(input)?.path;
        if (path === DE_TABLE) return { ok: { outcome: "artifact", artifact: { path: DE_TABLE, fileType: "output", columnCount: 4, columns: COLUMNS } } };
        return { ok: LISTING };
    },
    read_file: (input) => {
        const path = String(parseUnknownRecord(input)?.path ?? "");
        return path.endsWith("synthesis.json") ? { ok: { path, content: SYNTHESIS } } : { error: `No file at ${path}.` };
    },
    read_table: (input) => {
        const path = String(parseUnknownRecord(input)?.path ?? "");
        if (path !== DE_TABLE) return { error: `read_table: the pinned evidence of this session holds no artifact at ${path}` };
        return { ok: { path, columns: COLUMNS, rowCount: DE_ROWS.length, rows: DE_ROWS } };
    },
    write_derived: (input) => ({
        ok: { path: `report-sessions/thread-r/derived/${String(parseUnknownRecord(input)?.name ?? "table.csv")}`, hash: "sha256:d1", columns: [] },
    }),
    set_title: LANDED,
    add_block: LANDED,
    change_block: LANDED,
    move_block: LANDED,
    remove_block: LANDED,
    read_outline: { ok: { outline: [] } },
    finish_draft: { ok: { valid: true, warnings: [] } },
    preview_report: { ok: { outcome: "rendered", pagePath: "report-sessions/thread-r/index.html", warnings: [] } },
    examine_page: {
        ok: { outcome: "examined", coverage: { kind: "full" }, consoleErrors: [], failedRequests: [], pagePath: "report-sessions/thread-r/index.html" },
    },
    record_report_version: { ok: { outcome: "recorded", versionId: "v-1", replaced: false, warnings: [] } },
    render_chart: (input) => ({ ok: { path: `report-sessions/thread-r/derived/${String(parseUnknownRecord(input)?.name ?? "chart")}.svg`, bytes: 18_204 } }),
    export_pdf: (input) => ({
        ok: { path: `report-sessions/thread-r/derived/${String(parseUnknownRecord(input)?.name ?? "report.pdf")}`, bytes: 52_118, missingImages: [] },
    }),
};

/** An `add_block` call whose input holds a block of `kind` with `text` in it. */
function addsBlock(kind: string, text: string): (input: unknown) => boolean {
    return (input) => {
        const json = JSON.stringify(input);
        return json.includes(`"kind":"${kind}"`) && json.includes(text);
    };
}

/** Some `add_block` call meets `check`, and no `add_block` call meets `forbidden`. */
function blocks(describe: string, check: (input: unknown) => boolean, forbidden: (input: unknown) => boolean): Grader {
    return (trial) => {
        const adds = trial.calls.filter((call) => call.tool === "add_block" || call.tool === "change_block");
        if (adds.some((call) => forbidden(call.input))) return { pass: false, detail: `a block that is not ${describe}` };
        return adds.some((call) => check(call.input))
            ? { pass: true, detail: describe }
            : { pass: false, detail: `no ${describe} in ${String(adds.length)} block calls (calls: ${trial.calls.map((call) => call.tool).join(", ")})` };
    };
}

const OUTLINE = {
    outline: [
        { id: "s-summary", kind: "section", depth: 0, label: "Summary" },
        { id: "s-methods", kind: "section", depth: 0, label: "Methods" },
        { id: "t-methods", kind: "text", depth: 1, label: "DESeq2 on the counts of six samples…" },
        { id: "s-results", kind: "section", depth: 0, label: "Interferon response" },
        { id: "c-volcano", kind: "chart", depth: 1, label: "de_results.csv" },
        { id: "s-limits", kind: "section", depth: 0, label: "Limitations" },
    ],
};

/** A session whose draft holds four sections. */
const DRAFTED = [
    userMessage(seed("Present the effect of the treatment on gene expression.", "The interferon response.")),
    ...priorCall("read_outline", {}, OUTLINE),
    assistantText("The draft holds a summary, the methods, the interferon response with its volcano chart, and the limitations."),
];

/** A session whose current page rendered with no gap. */
const PREVIEWED = [
    ...DRAFTED,
    userMessage("Show me the page."),
    ...priorCall("preview_report", {}, { outcome: "rendered", pagePath: "report-sessions/thread-r/index.html", warnings: [] }),
    assistantText("The page rendered: report-sessions/thread-r/index.html."),
];

const REPORT: Pick<EvalCase, "agent" | "tools"> = { agent: "report", tools: COMPOSE_TOOLS };

/** The blocks of the drafted report, as `read_block` gives them. */
const DRAFT_BLOCKS: Readonly<Record<string, unknown>> = {
    "s-summary": { id: "s-summary", kind: "section", title: "Summary", children: ["t-summary"] },
    "s-methods": { id: "s-methods", kind: "section", title: "Methods", children: ["t-methods"] },
    "t-methods": { id: "t-methods", kind: "text", text: "DESeq2 on the counts of six samples, treated against control, three replicates for each group." },
    "s-results": { id: "s-results", kind: "section", title: "Interferon response", children: ["c-volcano"] },
    "c-volcano": {
        id: "c-volcano",
        kind: "chart",
        chart: "volcano",
        caption: "Volcano plot of the treatment response: 412 genes up and 198 down at FDR 0.05.",
        data: { kind: "artifact-table", path: DE_TABLE },
        x: "log2FoldChange",
        y: "padj",
    },
    "s-limits": { id: "s-limits", kind: "section", title: "Limitations", children: [] },
};

/** The tools of a drafted session: the outline and the blocks of the draft read back as the history shows them. */
const DRAFTED_TOOLS: Readonly<Record<string, ToolScript>> = {
    ...COMPOSE_TOOLS,
    read_outline: { ok: OUTLINE },
    read_block: (input) => {
        const id = String(parseUnknownRecord(input)?.targetId ?? "");
        const block = DRAFT_BLOCKS[id];
        return { ok: block === undefined ? { found: false } : { found: true, block } };
    },
};

export const reportCases: readonly EvalCase[] = [
    {
        id: "report-binds-chart",
        set: "dev",
        source: "report prompt: a plot of a run is a chart block over its table, and the run figure stays out",
        user: seed("Present the effect of the treatment on gene expression.", "The interferon response, with the volcano plot of the run."),
        maxSteps: 12,
        ...REPORT,
        grade: blocks("a chart over the results table", addsBlock("chart", "de_results.csv"), addsBlock("figure", "volcano.png")),
    },
    {
        id: "report-derives-in-script",
        set: "dev",
        source: "report prompt: a headline value that sits in no artifact derives in a script, with no sandbox",
        user: seed(
            "Open with headline cards: the count of up-regulated genes and the count of down-regulated genes.",
            "How large the response to the treatment is.",
        ),
        maxSteps: 12,
        ...REPORT,
        grade: callsAny(["write_derived"]),
    },
    {
        id: "report-amend-one-block",
        set: "dev",
        source: "report prompt: a change request amends the one block that must change",
        history: DRAFTED,
        user: "Rename the Methods section to Approach.",
        maxSteps: 3,
        ...REPORT,
        grade: all(decides("change_block", ["add_block", "remove_block"]), never(["remove_block"])),
    },
    {
        id: "report-look-before-record",
        set: "dev",
        source: "report prompt: the record comes after a look at the current page",
        history: PREVIEWED,
        user: "Looks good. Save it.",
        maxSteps: 4,
        ...REPORT,
        grade: decides("examine_page", ["record_report_version"]),
    },
    {
        id: "report-pdf-in-script",
        set: "dev",
        source: "owner: a PDF of a report is a document that a script builds, not a print of the page",
        history: PREVIEWED,
        user: "Can I get this as a PDF?",
        maxSteps: 14,
        agent: "report",
        tools: DRAFTED_TOOLS,
        grade: all(callsAny(["export_pdf"]), never(["record_report_version"])),
    },
    {
        id: "report-binds-chart-held-out",
        set: "held-out",
        source: "paraphrase of report-binds-chart",
        user: seed("Show the genes that the treatment changes.", "The strongest changes, as the volcano plot shows them."),
        maxSteps: 12,
        ...REPORT,
        grade: blocks("a chart over the results table", addsBlock("chart", "de_results.csv"), addsBlock("figure", "volcano.png")),
    },
    {
        id: "report-derives-in-script-held-out",
        set: "held-out",
        source: "paraphrase of report-derives-in-script",
        user: seed("Lead with the number of genes that go up and the number that go down.", "The size of the treatment response."),
        maxSteps: 12,
        ...REPORT,
        grade: callsAny(["write_derived"]),
    },
    {
        id: "report-amend-one-block-held-out",
        set: "held-out",
        source: "paraphrase of report-amend-one-block",
        history: DRAFTED,
        user: "Call the Methods section 'How we did it' instead.",
        maxSteps: 3,
        ...REPORT,
        grade: all(decides("change_block", ["add_block", "remove_block"]), never(["remove_block"])),
    },
    {
        id: "report-pdf-in-script-held-out",
        set: "held-out",
        source: "paraphrase of report-pdf-in-script",
        history: PREVIEWED,
        user: "Please export the report to a PDF file I can print.",
        maxSteps: 14,
        agent: "report",
        tools: DRAFTED_TOOLS,
        grade: all(callsAny(["export_pdf"]), never(["record_report_version"])),
    },
    {
        id: "report-look-before-record-held-out",
        set: "held-out",
        source: "paraphrase of report-look-before-record",
        history: PREVIEWED,
        user: "Great, record this version.",
        maxSteps: 4,
        ...REPORT,
        grade: decides("examine_page", ["record_report_version"]),
    },
];
