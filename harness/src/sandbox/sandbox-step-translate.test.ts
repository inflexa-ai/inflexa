import { describe, expect, it } from "bun:test";

import { activityForTool, applyTreeDelta, sandboxTreeDelta, stepPartId } from "./sandbox-step-translate.js";

describe("stepPartId", () => {
    it("pins the id shape the run-stream fold reconciles on", () => {
        expect(stepPartId("step-activity", "run-1", "qc")).toBe("step-activity-run-1-qc");
        expect(stepPartId("step-file-tree", "run-1", "qc")).toBe("step-file-tree-run-1-qc");
        expect(stepPartId("step-summary", "run-1", "qc")).toBe("step-summary-run-1-qc");
        expect(stepPartId("step-output", "run-1", "qc")).toBe("step-output-run-1-qc");
        expect(stepPartId("step-blocked", "run-1", "qc")).toBe("step-blocked-run-1-qc");
    });

    it("gives every step of a run its own id, and every run its own", () => {
        expect(stepPartId("step-activity", "run-1", "qc")).not.toBe(stepPartId("step-activity", "run-1", "cluster"));
        expect(stepPartId("step-activity", "run-1", "qc")).not.toBe(stepPartId("step-activity", "run-2", "qc"));
    });

    it("keeps the two reconciling kinds of one step apart", () => {
        expect(stepPartId("step-activity", "run-1", "qc")).not.toBe(stepPartId("step-file-tree", "run-1", "qc"));
    });

    it("is a pure function of its three arguments", () => {
        expect(stepPartId("step-activity", "data-profile", "profile")).toBe(stepPartId("step-activity", "data-profile", "profile"));
        expect(stepPartId("step-activity", "data-profile", "profile")).toBe("step-activity-data-profile-profile");
    });
});

describe("activityForTool", () => {
    it("maps known sandbox tools to friendly live labels", () => {
        expect(activityForTool("execute_command")).toBe("Running script");
        expect(activityForTool("write_file")).toBe("Writing file");
        expect(activityForTool("read_file")).toBe("Reading file");
    });

    it("falls back to the raw name for an unknown tool", () => {
        expect(activityForTool("list_available_packages")).toBe("Running list_available_packages");
    });

    it("appends the file name (not the path) for path-bearing tools", () => {
        expect(activityForTool("write_file", { path: "scripts/run.py" })).toBe("Writing file run.py");
        expect(activityForTool("edit_file", { path: "output/sub/result.csv" })).toBe("Editing file result.csv");
        expect(activityForTool("read_file", { path: "data/inputs/x.h5ad" })).toBe("Reading file x.h5ad");
    });

    it("names the script token from an execute_command argv", () => {
        expect(activityForTool("execute_command", { command: ["python", "scripts/run.py"] })).toBe("Running script run.py");
        expect(activityForTool("execute_command", { command: ["Rscript", "analysis/fit.R"] })).toBe("Running script fit.R");
    });

    it("keeps the bare label when no file name is derivable", () => {
        expect(activityForTool("execute_command", { command: ["ls", "-la"] })).toBe("Running script");
        expect(activityForTool("write_file", {})).toBe("Writing file");
        expect(activityForTool("grep", { pattern: "foo" })).toBe("Searching files");
    });
});

describe("sandboxTreeDelta", () => {
    const part = (event: unknown) => ({ type: "data-sandbox-event", data: { execId: "e", event } });

    it("extracts the tree from a file-tree sandbox event", () => {
        const tree = { added: ["output/a.csv"], modified: [], removed: [] };
        expect(sandboxTreeDelta(part({ kind: "file-tree", tree }))).toEqual(tree);
    });

    it("returns null for non-file-tree sandbox events and other parts", () => {
        expect(sandboxTreeDelta(part({ kind: "phase" }))).toBeNull();
        expect(sandboxTreeDelta(part({ kind: "file-tree" }))).toBeNull(); // no tree
        expect(sandboxTreeDelta({ type: "data-step-activity" })).toBeNull();
    });
});

describe("applyTreeDelta", () => {
    it("folds added/modified/removed deltas across execs into one cumulative set", () => {
        const files = new Set<string>();
        // exec 1 writes two files
        applyTreeDelta(files, { added: ["scripts/run.R", "output/a.csv"] });
        // exec 2 modifies one, adds a log, removes a temp
        applyTreeDelta(files, {
            added: ["logs/run.log", "tmp/scratch"],
            modified: ["output/a.csv"],
        });
        applyTreeDelta(files, { removed: ["tmp/scratch"] });

        expect([...files].sort()).toEqual(["logs/run.log", "output/a.csv", "scripts/run.R"]);
    });
});
