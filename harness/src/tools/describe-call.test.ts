/**
 * One assertion per shipped `describeCall`, on the exact string it produces.
 *
 * The strings are what a user reads in place of a bare tool name, so they are
 * pinned here rather than left to drift. Each tool is constructed with whatever
 * deps it needs — the hook is pure and never touches them, which is the point.
 */

import { describe, expect, it } from "bun:test";

import { normalizeDetail } from "../loop/tool-detail.js";
import { createExecuteAnalysisTool } from "./execute-analysis.js";
import { createPubMedTool } from "./bio/pubmed.js";
import { searchGeneTool } from "./bio/search-gene.js";
import { showUserTool } from "./display/show-user.js";
import { createUpdateWorkingMemoryTool } from "./memory/update-working-memory.js";
import { createGeneratePlanTool } from "./research/generate-plan.js";
import { createInspectDataProfileTool } from "./research/inspect-data-profile.js";
import { createInspectRunTool } from "./research/inspect-run.js";
import { createResolveCitationTool } from "./research/resolve-citation.js";
import { createListAvailablePackagesTool } from "./sandbox/list-available-packages.js";
import { createListAvailableRefsTool } from "./sandbox/list-available-refs.js";
import { createEditFileTool } from "./workspace/edit-file.js";
import { createExecuteCommandTool } from "./workspace/execute-command.js";
import { createGrepTool } from "./workspace/grep.js";
import { createListFilesTool } from "./workspace/list-files.js";
import { createReadFileTool } from "./workspace/read-file.js";
import { showFileTool } from "./workspace/show-file.js";
import { createShowPlanTool } from "./workspace/show-plan.js";
import { createWorkspaceSearchTool } from "./workspace/workspace-search.js";
import { createWriteFileTool } from "./workspace/write-file.js";
import type { Tool } from "./define-tool.js";

/** A dep bag no hook ever reads. */
const unused = {} as never;

/** Run a tool's hook, asserting it declares one. */
function describeCall(tool: Tool, input: unknown): string {
    expect(tool.describeCall).toBeDefined();
    return tool.describeCall!(input);
}

describe("describeCall — conversation roster", () => {
    it("update_working_memory names the operation and section", () => {
        const tool = createUpdateWorkingMemoryTool(unused, unused);

        expect(describeCall(tool, { section: "goal", text: "characterize the cohort" })).toBe("set goal");
        expect(describeCall(tool, { section: "hypothesis", text: "batch effect drives PC1" })).toBe("add hypothesis");
        expect(describeCall(tool, { section: "finding", operation: "revise", id: "f-3", text: "revised" })).toBe("revise finding f-3");
        expect(describeCall(tool, { section: "constraint", operation: "retire", id: "c-1" })).toBe("retire constraint c-1");
    });

    it("workspace_search names the query, and the type filter when set", () => {
        const tool = createWorkspaceSearchTool(unused, unused);

        expect(describeCall(tool, { query: "differential expression results", limit: 8 })).toBe("differential expression results");
        expect(describeCall(tool, { query: "qc metrics", type: "summary", limit: 8 })).toBe("qc metrics (summary)");
    });

    it("grep names the pattern and the tree it searches", () => {
        const tool = createGrepTool(unused, "/a/runs/r1/s1");

        expect(describeCall(tool, { pattern: "TP53", path: "output" })).toBe("TP53 in output");
        // Neither field alone identifies the call: one pattern over two trees, and two patterns over
        // one tree, are both ordinary sequences a reader has to tell apart.
        expect(describeCall(tool, { pattern: "TP53", path: "data/inputs" })).not.toBe(describeCall(tool, { pattern: "TP53", path: "output" }));
        expect(describeCall(tool, { pattern: "BRCA1", path: "output" })).not.toBe(describeCall(tool, { pattern: "TP53", path: "output" }));
    });

    it("list_files names the directory", () => {
        const tool = createListFilesTool(unused, "/a/runs/r1/s1");

        expect(describeCall(tool, { path: "runs/r1/step-2/output" })).toBe("runs/r1/step-2/output");
    });

    it("read_file names the path, plus the head or tail window", () => {
        const tool = createReadFileTool(unused, "/a/runs/r1/s1");

        expect(describeCall(tool, { path: "output/summary.md" })).toBe("output/summary.md");
        expect(describeCall(tool, { path: "data/inputs/x.csv", headLines: 20 })).toBe("data/inputs/x.csv (first 20 lines)");
        expect(describeCall(tool, { path: "logs/run.log", tailLines: 50 })).toBe("logs/run.log (last 50 lines)");
    });

    it("inspect_run names the run, or the list page", () => {
        const tool = createInspectRunTool(unused);

        expect(describeCall(tool, { runId: "run-7a2f" })).toBe("run-7a2f");
        expect(describeCall(tool, {})).toBe("run list (page 1)");
        expect(describeCall(tool, { page: 3 })).toBe("run list (page 3)");
    });

    it("resolve_citation names the citation it verifies", () => {
        const tool = createResolveCitationTool(unused);

        expect(describeCall(tool, { citation: "doi:10.1000/example" })).toBe("verify doi:10.1000/example");
        // The metadata fields are comparison inputs, not the subject of the call.
        expect(describeCall(tool, { citation: "Watson & Crick 1953", year: 1953, venue: "Nature" })).toBe("verify Watson & Crick 1953");
    });

    it("pubmed names the subject each action acts on", () => {
        const tool = createPubMedTool({ ncbiApiKey: "k" });

        expect(describeCall(tool, { action: "search", query: "BRCA1 resistance" })).toBe("search BRCA1 resistance");
        expect(describeCall(tool, { action: "details", pmids: ["1", "2", "3"] })).toBe("details for 3 articles");
        expect(describeCall(tool, { action: "details", pmids: ["1"] })).toBe("details for 1 article");
        expect(describeCall(tool, { action: "fulltext", pmcId: "PMC1234567" })).toBe("fulltext PMC1234567");
    });

    it("search_gene names the symbols", () => {
        expect(describeCall(searchGeneTool, { symbols: ["BRCA1", "TP53"], species: "homo_sapiens" })).toBe("BRCA1, TP53");
    });

    // A batch this size joins to well over the 120-character cap. Left to the cap, the string
    // arrives ending mid-symbol — a fragment that reads as a real gene and says nothing about how
    // many were dropped. The count leads instead, so the sample after it can be trimmed harmlessly.
    it("search_gene counts a large batch rather than letting the cap sever a symbol", () => {
        const symbols = Array.from({ length: 60 }, (_, i) => `GENE${i}`);

        const detail = describeCall(searchGeneTool, { symbols, species: "homo_sapiens" });

        expect(detail).toBe("60 genes: GENE0, GENE1, GENE2, GENE3, GENE4, GENE5, GENE6, GENE7, …");
        expect(normalizeDetail(detail)).toBe(detail);
    });

    it("execute_analysis names the mode and what it runs", () => {
        const tool = createExecuteAnalysisTool({
            pool: unused,
            executeAnalysisWorkflow: unused,
            runAuthorizer: unused,
            runLauncher: unused,
            utilityProvider: unused,
            utilityModel: "test-model",
        });

        expect(describeCall(tool, { mode: "plan", planId: "plan-42" })).toBe("plan plan-42");
        expect(describeCall(tool, { mode: "adhoc", request: "compare cluster 3 against cluster 5" })).toBe("ad hoc: compare cluster 3 against cluster 5");
    });

    it("inspect_data_profile names the scope, and the page of the file records", () => {
        const tool = createInspectDataProfileTool(unused);

        // Both fields are defaulted inside `execute`, so the call that names none
        // is the common one. A hook without the defaults describes it as nothing.
        expect(describeCall(tool, {})).toBe("overview");
        expect(describeCall(tool, { scope: "files" })).toBe("files (page 1)");
        expect(describeCall(tool, { scope: "files", page: 3 })).toBe("files (page 3)");
        // `page` acts on the file records only, the same as in `execute`.
        expect(describeCall(tool, { page: 3 })).toBe("overview");
    });

    it("generate_plan names the research question", () => {
        const tool = createGeneratePlanTool(unused);

        expect(describeCall(tool, { researchQuestion: "which genes drive resistance in cluster 3" })).toBe("which genes drive resistance in cluster 3");
    });

    it("list_available_refs names the subtree it inspects, and marks a filter over it", () => {
        const tool = createListAvailableRefsTool(unused);

        expect(describeCall(tool, {})).toBe("full reference store");
        expect(describeCall(tool, { path: "managed/collectri" })).toBe("managed/collectri");
        expect(describeCall(tool, { category: "msigdb" })).toBe("msigdb");
        // A bare needle reads as a path, thus a search-only call marks the filter.
        expect(describeCall(tool, { query: "regulon" })).toBe('matching "regulon"');
        // `execute` resolves `path ?? category`, thus the path wins over the category.
        expect(describeCall(tool, { path: "managed/collectri", category: "msigdb" })).toBe("managed/collectri");
        // `query` narrows the named subtree; the detail names both halves, so the
        // filter no longer hides behind the target. A word joins them, because a
        // separator glyph is the vocabulary of a host.
        expect(describeCall(tool, { category: "msigdb", query: "hallmark" })).toBe('msigdb matching "hallmark"');
        expect(describeCall(tool, { path: "human", query: "kinase" })).toBe('human matching "kinase"');
        // A blank value is no filter and no target inside `execute`, thus the
        // detail names the browse that actually happens.
        expect(describeCall(tool, { query: "   " })).toBe("full reference store");
        expect(describeCall(tool, { path: "" })).toBe("full reference store");
        // A blank path still suppresses the category, exactly as `execute` does.
        expect(describeCall(tool, { path: "", category: "msigdb" })).toBe("full reference store");
    });

    // The emit-site cap cuts the tail. Left to it, a runaway needle loses the quote
    // that closes its own mark, and a runaway path (the schema admits 4096 bytes)
    // takes the whole line and drops the filter with no trace. Both halves are
    // bounded here instead, thus each one reaches a reader and each marks its cut.
    it("list_available_refs bounds each half, so the cap severs neither the mark nor the filter", () => {
        const tool = createListAvailableRefsTool(unused);

        const longNeedle = describeCall(tool, { query: "k".repeat(40) });
        expect(longNeedle).toBe(`matching "${"k".repeat(31)}…"`);
        expect(normalizeDetail(longNeedle)).toBe(longNeedle);

        const longTarget = describeCall(tool, { path: "p".repeat(200), query: "kinase" });
        expect(longTarget).toBe(`${"p".repeat(101)}… matching "kinase"`);
        expect(normalizeDetail(longTarget)).toBe(longTarget);

        // Both halves at once — the worst case, and still one code point inside the cap.
        const both = describeCall(tool, { path: "p".repeat(200), query: "k".repeat(40) });
        expect(both).toBe(`${"p".repeat(75)}… matching "${"k".repeat(31)}…"`);
        expect(Array.from(both)).toHaveLength(120);
        expect(normalizeDetail(both)).toBe(both);
    });

    it("list_available_packages names the presence check before any filter", () => {
        const tool = createListAvailablePackagesTool(unused);

        expect(describeCall(tool, {})).toBe("full package list");
        expect(describeCall(tool, { names: ["Seurat", "scanpy"] })).toBe("Seurat, scanpy");
        // A bare needle reads as a package name, thus a search marks the filter.
        expect(describeCall(tool, { query: "seurat" })).toBe('matching "seurat"');
        expect(describeCall(tool, { language: "python" })).toBe("python packages");
        expect(describeCall(tool, { query: "umap", language: "r" })).toBe('matching "umap" (r)');
        // `queryPackages` returns on `names` before it reads `query` or `language`.
        expect(describeCall(tool, { names: ["Seurat"], query: "umap", language: "r" })).toBe("Seurat");
        // An empty array is not a presence check, and `execute` lists the store.
        expect(describeCall(tool, { names: [], language: "r" })).toBe("r packages");
        // `queryPackages` trims the needle and filters on nothing when it is
        // blank, thus a blank query never names the call.
        expect(describeCall(tool, { query: "  ", language: "r" })).toBe("r packages");
        expect(describeCall(tool, { query: "" })).toBe("full package list");
    });

    // A needle the cap cuts loses the quote that closes its mark. The bound is the
    // hook's, thus the marked form is always whole and the qualifier keeps its place.
    it("list_available_packages bounds the needle, so the mark always closes", () => {
        const tool = createListAvailablePackagesTool(unused);

        const detail = describeCall(tool, { query: "s".repeat(40), language: "r" });

        expect(detail).toBe(`matching "${"s".repeat(31)}…" (r)`);
        expect(normalizeDetail(detail)).toBe(detail);
    });

    it("show_plan names the plan", () => {
        const tool = createShowPlanTool(unused);

        expect(describeCall(tool, { planId: "pln-1a2b3c4d", title: "Revised plan" })).toBe("pln-1a2b3c4d");
    });

    it("show_file names the one file, or counts the group", () => {
        expect(describeCall(showFileTool, { files: [{ path: "runs/run-abc/step-1/figures/volcano.png" }] })).toBe("runs/run-abc/step-1/figures/volcano.png");
        expect(
            describeCall(showFileTool, {
                title: "QC figures",
                files: [{ path: "figures/a.png" }, { path: "figures/b.png" }, { path: "figures/c.png" }],
            }),
        ).toBe("3 files");
    });

    it("show_user names the kind, plus the title when the call carries one", () => {
        expect(describeCall(showUserTool, { kind: "markdown", body: "## Results" })).toBe("markdown");
        expect(describeCall(showUserTool, { kind: "echart", title: "PCA by batch", spec: {} })).toBe("echart: PCA by batch");
    });
});

describe("describeCall — sandbox mutate surface", () => {
    it("write_file names the path and never the content", () => {
        const tool = createWriteFileTool({ mutator: unused });

        expect(describeCall(tool, { path: "output/result.csv", content: "gene,logfc\nBRCA1,2.4" })).toBe("output/result.csv");
    });

    it("edit_file names the path", () => {
        const tool = createEditFileTool({ mutator: unused, workspaceFilesystem: unused, workingDir: "/a/runs/r1/s1" });

        expect(describeCall(tool, { path: "scripts/run.py", old_string: "a", new_string: "b", replace_all: false })).toBe("scripts/run.py");
    });

    it("execute_command names the script token, else the joined argv", () => {
        const tool = createExecuteCommandTool({
            sandboxClient: unused,
            sandbox: unused,
            workflowId: "wf-1",
            stepId: "s1",
            nextFunctionId: () => "1",
            deadlineMs: () => 0,
            defaultCwd: "/a/runs/r1/s1",
        });

        expect(describeCall(tool, { command: ["python", "scripts/run.py"] })).toBe("scripts/run.py");
        expect(describeCall(tool, { command: ["Rscript", "analysis/fit.R", "--seed", "7"] })).toBe("analysis/fit.R");
        expect(describeCall(tool, { command: ["ls", "-la"] })).toBe("ls -la");
    });
});
