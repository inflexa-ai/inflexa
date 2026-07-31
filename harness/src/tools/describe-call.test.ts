/**
 * One assertion per shipped `describeCall`, on the exact string it produces.
 *
 * The strings are what a user reads in place of a bare tool name, so they are
 * pinned here rather than left to drift. Each tool is constructed with whatever
 * deps it needs — the hook is pure and never touches them, which is the point.
 */

import { describe, expect, it } from "bun:test";

import { createExecuteAnalysisTool } from "./execute-analysis.js";
import { createPubMedTool } from "./bio/pubmed.js";
import { searchGeneTool } from "./bio/search-gene.js";
import { createUpdateWorkingMemoryTool } from "./memory/update-working-memory.js";
import { createInspectRunTool } from "./research/inspect-run.js";
import { createEditFileTool } from "./workspace/edit-file.js";
import { createExecuteCommandTool } from "./workspace/execute-command.js";
import { createReadFileTool } from "./workspace/read-file.js";
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
