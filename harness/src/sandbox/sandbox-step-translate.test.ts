import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../tools/define-tool.js";
import { createDetailResolver } from "../tools/detail-resolver.js";
import { createEditFileTool } from "../tools/workspace/edit-file.js";
import { createWriteFileTool } from "../tools/workspace/write-file.js";
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
    // The real sandbox mutate tools, so this covers the hooks a step actually calls.
    const resolveDetail = createDetailResolver([
        createWriteFileTool({ mutator: {} as never }),
        createEditFileTool({ mutator: {} as never, workspaceFilesystem: {} as never, workingDir: "/a/runs/r1/s1" }),
        // Deliberately NOT a real tool id. The fallback needs a hookless tool to exercise, and
        // borrowing a shipped name would assert that tool is hookless — a claim that goes stale the
        // moment it gains one, while the test keeps passing on the fabricated stand-in.
        defineTool({
            id: "hookless_probe",
            description: "Declares no hook, so the fallback is what it exercises.",
            inputSchema: z.object({ dir: z.string() }),
            execute: async () => ok({}),
        }),
    ]);

    it("phrases a call as the tool's name plus its own hook's description", () => {
        expect(activityForTool("write_file", { path: "scripts/run.py", content: "" }, resolveDetail)).toBe("write_file scripts/run.py");
        expect(activityForTool("edit_file", { path: "output/sub/result.csv", old_string: "a", new_string: "b" }, resolveDetail)).toBe(
            "edit_file output/sub/result.csv",
        );
    });

    // This phrase renders alone, with no tool name beside it — so a bare detail would make a write and
    // an edit of the same path indistinguishable, which is the very confusion the hook exists to end.
    it("keeps a write and an edit of the same path apart", () => {
        const path = { path: "output/result.csv" };
        const write = activityForTool("write_file", { ...path, content: "" }, resolveDetail);
        const edit = activityForTool("edit_file", { ...path, old_string: "a", new_string: "b" }, resolveDetail);
        expect(write).not.toBe(edit);
    });

    it("names the tool when it declares no hook", () => {
        expect(activityForTool("hookless_probe", { dir: "output" }, resolveDetail)).toBe("hookless_probe");
    });

    it("names the tool when no resolver is supplied at all", () => {
        expect(activityForTool("write_file", { path: "scripts/run.py" })).toBe("write_file");
        expect(activityForTool("list_available_packages")).toBe("list_available_packages");
    });

    it("names the tool for a call the resolver cannot describe", () => {
        // Absent from the supplied list.
        expect(activityForTool("execute_command", { command: ["python", "run.py"] }, resolveDetail)).toBe("execute_command");
        // Present, but the input does not satisfy its schema.
        expect(activityForTool("write_file", { pathname: "scripts/run.py" }, resolveDetail)).toBe("write_file");
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
