/**
 * The decision cases of the report agent of a report session.
 *
 * The first message of a session is its seed: the brief that `start_report_session` carried. The pinned evidence
 * is a differential expression run: a results table, a volcano plot, and a synthesis. Each tool gives a canned
 * answer, and the authoring tools land each block.
 */

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";

import { unpinnedPmids } from "@inflexa-ai/harness/report-model/draft-operations.js";
import { parseJsonAs } from "@inflexa-ai/harness/lib/parse-json.js";
import { z } from "zod";

import type { ScriptedResult, ToolScript } from "../lib/agent.js";
import { all, assistantText, atMost, callsAny, decides, never, priorCall, says, userMessage, type EvalCase, type Grader } from "../lib/case.js";

const DE_TABLE = "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/differential-expression/output/de_results.csv";
const VOLCANO = "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/differential-expression/figures/volcano.png";
const SYNTHESIS_PATH = "runs/0193f7a2-6c1e-7a00-9b1a-2f4c8d9e0a11/synthesis.json";
const COLUMNS = ["gene_id", "symbol", "log2FoldChange", "padj"];

function seed(objective: string, angle: string): string {
    return `# Report Brief\n\nObjective: ${objective}\nAudience: the members of the lab\nAngle: ${angle}\n`;
}

/** The rows of the results table: 610 significant genes, 412 up and 198 down. */
const DE_ROWS = Array.from({ length: 610 }, (_, i) => {
    const up = !(i % 3 === 2 && i >= 5 && i <= 596);
    const symbol = ["ISG15", "MX1", "IFIT1"][i] ?? `LOC${105_000 + i * 7}`;
    return {
        gene_id: `ENSG${String(100_000 + i * 13).padStart(11, "0")}`,
        symbol,
        log2FoldChange: (up ? 1 : -1) * (i < 3 ? 4 - i * 0.45 : 1.1 + ((i * 37) % 200) / 100),
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
    add_block: landsPinnedOnly,
    change_block: landsPinnedOnly,
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
        const json = JSON.stringify(input ?? null);
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

/** A derived table holds the up and the down counts of the results table, and a block binds that derived table. */
const derivesHeadline: Grader = (trial) => {
    const up = DE_ROWS.filter((row) => row.log2FoldChange > 0).length;
    const down = DE_ROWS.length - up;
    const derived = trial.calls.filter((call) => call.tool === "write_derived").map((call) => JSON.stringify(call.input ?? null));
    if (derived.length === 0) return { pass: false, detail: "no call of write_derived" };
    if (!derived.some((input) => input.includes(String(up)) && input.includes(String(down))))
        return { pass: false, detail: `no derived table holds ${up} and ${down}` };
    const binds = trial.calls.some((call) => call.tool === "add_block" && JSON.stringify(call.input ?? null).includes("derived/"));
    return binds
        ? { pass: true, detail: `a derived table of ${up} and ${down}, bound by a block` }
        : { pass: false, detail: "no block binds the derived table" };
};

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

/** A zero p-value in a sentence: the test reported zero because the value sits below its resolution. */
const ZERO_P = /\b(p|padj|p-?value|adjusted p(-value)?|FDR)\s*(=|of|is|was|:)\s*0(\.0+)?(?![.\d])/i;

/** The rows of the results table where the top genes have a padj of 0. */
const ZERO_P_ROWS = DE_ROWS.map((row, i) => (i < 3 ? { ...row, padj: 0 } : row));

const ZERO_P_TOOLS: Readonly<Record<string, ToolScript>> = {
    ...COMPOSE_TOOLS,
    read_table: (input) => {
        const path = String(parseUnknownRecord(input)?.path ?? "");
        if (path !== DE_TABLE) return { error: `read_table: the pinned evidence of this session holds no artifact at ${path}` };
        return { ok: { path, columns: COLUMNS, rowCount: ZERO_P_ROWS.length, rows: ZERO_P_ROWS } };
    },
};

/** No block that landed has a text that matches `pattern`. A block that the draft refused is not in the report. */
function noBlockSays(pattern: RegExp): Grader {
    return (trial) => {
        const hit = trial.calls.find(
            (call) =>
                (call.tool === "add_block" || call.tool === "change_block") &&
                parseUnknownRecord(call.value)?.applied !== false &&
                pattern.test(JSON.stringify(call.input ?? null)),
        );
        return hit === undefined
            ? { pass: true, detail: `no block matches ${String(pattern)}` }
            : { pass: false, detail: `${hit.tool} ${JSON.stringify(hit.input).slice(0, 240)}` };
    };
}

/** The pinned evidence holds one citation, the DESeq2 method paper, and no paper on the interferon response. */
const PINNED_CITATION = { pmid: "25516281", title: "Moderated estimation of fold change and dispersion for RNA-seq data with DESeq2" };

/** `add_block` and `change_block` refuse a block that names an unpinned PubMed id, as the draft core does. */
function landsPinnedOnly(input: unknown): ScriptedResult {
    const block = parseUnknownRecord(input)?.block;
    const parsed = typeof block === "string" ? parseJsonAs(block, z.json()) : block;
    const unresolved = unpinnedPmids(parsed, { citations: [`pmid:${PINNED_CITATION.pmid}`] });
    return unresolved.length === 0
        ? LANDED
        : {
              ok: {
                  applied: false,
                  refusal: { reason: "unresolved-reference", detail: `${unresolved.length} references do not resolve against the snapshot`, unresolved },
              },
          };
}

const CITATION_TOOLS: Readonly<Record<string, ToolScript>> = {
    ...COMPOSE_TOOLS,
    add_block: landsPinnedOnly,
    change_block: landsPinnedOnly,
    list_pinned_artifacts: (input) => {
        const path = parseUnknownRecord(input)?.path;
        if (path === DE_TABLE) return { ok: { outcome: "artifact", artifact: { path: DE_TABLE, fileType: "output", columnCount: 4, columns: COLUMNS } } };
        return { ok: { ...LISTING, citations: [PINNED_CITATION] } };
    },
};

/** A literature reference written into the prose: a PMID, a DOI, or an author-year citation. Only the pinned DESeq2 paper may appear. */
const UNPINNED_CITATION = /PMID:?\s*(?!25516281)\d{6,9}|doi\.org|\bdoi:|\bet al\.?,? \(?\d{4}|\b[A-Z][a-z]+ \d{4}\)/;

const RESOLVER_ABSENT_TOOLS: Readonly<Record<string, ToolScript>> = {
    ...DRAFTED_TOOLS,
    preview_report: { ok: { outcome: "resolver-unavailable" } },
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
        grade: derivesHeadline,
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
        grade: derivesHeadline,
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
    {
        id: "report-no-zero-p-value",
        set: "dev",
        source: "report prompt: never write a zero p-value into a sentence",
        user: seed("Open with a paragraph on the three strongest genes and how significant they are.", "The strength of the interferon response."),
        maxSteps: 12,
        agent: "report",
        tools: ZERO_P_TOOLS,
        grade: all(callsAny(["add_block"]), noBlockSays(ZERO_P)),
    },
    {
        id: "report-no-zero-p-value-held-out",
        set: "held-out",
        source: "paraphrase of report-no-zero-p-value",
        user: seed("Write a short results paragraph that names the top three genes with their adjusted p-values.", "The genes that respond most."),
        maxSteps: 12,
        agent: "report",
        tools: ZERO_P_TOOLS,
        grade: all(callsAny(["add_block"]), noBlockSays(ZERO_P)),
    },
    {
        id: "report-cites-only-pinned",
        set: "dev",
        source: "report prompt: a citation that the pinned evidence does not hold goes to the user, never into the prose",
        user: seed(
            "Present the interferon response, and back it with the published literature on interferon-stimulated genes.",
            "The response, and how it fits what is known.",
        ),
        maxSteps: 12,
        agent: "report",
        tools: CITATION_TOOLS,
        grade: all(callsAny(["add_block"]), noBlockSays(UNPINNED_CITATION)),
    },
    {
        id: "report-cites-only-pinned-held-out",
        set: "held-out",
        source: "paraphrase of report-cites-only-pinned",
        user: seed("Explain the interferon response, with references to the papers that describe ISG15 and MX1.", "The response in the light of earlier work."),
        maxSteps: 12,
        agent: "report",
        tools: CITATION_TOOLS,
        grade: all(callsAny(["add_block"]), noBlockSays(UNPINNED_CITATION)),
    },
    {
        id: "report-resolver-absent-stops",
        set: "dev",
        source: "report prompt: when the reference resolver is absent, tell the user, and do not preview again",
        history: DRAFTED,
        user: "Show me the page.",
        maxSteps: 5,
        agent: "report",
        tools: RESOLVER_ABSENT_TOOLS,
        grade: all(atMost({ tool: "preview_report" }, 1), never(["record_report_version"]), says(/resolv/i)),
    },
    {
        id: "report-resolver-absent-stops-held-out",
        set: "held-out",
        source: "paraphrase of report-resolver-absent-stops",
        history: DRAFTED,
        user: "Render the report so I can look at it.",
        maxSteps: 5,
        agent: "report",
        tools: RESOLVER_ABSENT_TOOLS,
        grade: all(atMost({ tool: "preview_report" }, 1), never(["record_report_version"]), says(/resolv/i)),
    },
];
