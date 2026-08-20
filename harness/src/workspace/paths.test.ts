import { describe, expect, it } from "bun:test";
import { resolve as resolvePath, sep } from "node:path";

import {
    assertSafeId,
    assertSafeTail,
    reportSessionDir,
    resolveForWrite,
    resolveWorkspacePath,
    stepWritePrefix,
    tailWritePrefix,
    toAnalysisRootPath,
    toSandboxPath,
} from "./paths.js";

const SESSIONS = "/var/sessions";
const ANALYSIS = "analysis-001";
const ROOT = resolvePath(SESSIONS, ANALYSIS);
const STEP_DIR = stepWritePrefix({
    workspaceRoot: ROOT,
    runId: "run-abc",
    stepId: "step-1",
});

describe("resolveWorkspacePath", () => {
    it("resolves an analysis-relative path under the analysis root", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "data/inputs/x.csv",
        });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.absolute).toBe(ROOT + sep + "data" + sep + "inputs" + sep + "x.csv");
            expect(r.relative).toBe("data/inputs/x.csv".split("/").join(sep));
        }
    });

    it("strips a leading /{analysisId}/ prefix", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/runs/run-abc/step-1/output/r.csv`,
        });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.absolute).toBe(ROOT + sep + ["runs", "run-abc", "step-1", "output", "r.csv"].join(sep));
        }
    });

    it("rejects /{otherAnalysis}/... — single-chokepoint cross-analysis guard", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "/analysis-002/data/inputs/secret.csv",
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects ../ traversal that escapes the analysis tree", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "../analysis-002/secret.csv",
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects /{analysisId}/../{other}/... after-strip traversal", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/../analysis-002/secret.csv`,
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects /etc/passwd-style system paths", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "/etc/passwd",
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects empty path and embedded NUL", () => {
        expect(
            resolveWorkspacePath({
                workspaceRoot: ROOT,
                analysisId: ANALYSIS,
                path: "",
            }).kind,
        ).toBe("out_of_scope");
        expect(
            resolveWorkspacePath({
                workspaceRoot: ROOT,
                analysisId: ANALYSIS,
                path: "data/\0nope",
            }).kind,
        ).toBe("out_of_scope");
    });

    it("resolves a relative path against workingDir (frame-local)", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "output/x.csv",
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.absolute).toBe(STEP_DIR + sep + "output" + sep + "x.csv");
            // relative is always analysis-root-relative
            expect(r.relative).toBe(["runs", "run-abc", "step-1", "output", "x.csv"].join(sep));
        }
    });

    it("ignores workingDir for an absolute /{analysisId}/... path (frame-independent)", () => {
        const r = resolveWorkspacePath({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/data/inputs/x.csv`,
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.absolute).toBe(ROOT + sep + ["data", "inputs", "x.csv"].join(sep));
            expect(r.relative).toBe(["data", "inputs", "x.csv"].join(sep));
        }
    });
});

describe("resolveForWrite", () => {
    it("accepts a relative path that resolves into workingDir", () => {
        const r = resolveForWrite({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "output/result.csv",
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("ok");
        if (r.kind === "ok") {
            expect(r.absolute).toBe(STEP_DIR + sep + "output" + sep + "result.csv");
            expect(r.relative).toBe(["runs", "run-abc", "step-1", "output", "result.csv"].join(sep));
        }
    });

    it("accepts workingDir itself as in-prefix", () => {
        const r = resolveForWrite({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/runs/run-abc/step-1`,
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("ok");
    });

    it("rejects an absolute in-tree path outside workingDir as out_of_prefix", () => {
        const r = resolveForWrite({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/data/inputs/x.csv`,
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("out_of_prefix");
    });

    it("rejects a write under another run's step tree as out_of_prefix", () => {
        const r = resolveForWrite({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/runs/run-other/step-1/output/x.csv`,
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("out_of_prefix");
    });

    it("rejects a `..` escape from the analysis tree as out_of_scope", () => {
        // STEP_DIR is sessions/analysis-001/runs/run-abc/step-1; four `..` reach
        // the analysis root and a fifth escapes it into a sibling analysis.
        const r = resolveForWrite({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "../../../../analysis-002/secret.csv",
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects an in-tree `..` that stays in the analysis tree as out_of_prefix", () => {
        const r = resolveForWrite({
            workspaceRoot: ROOT,
            analysisId: ANALYSIS,
            path: "../../analysis-002/secret.csv",
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("out_of_prefix");
    });
});

describe("stepWritePrefix", () => {
    it("composes {workspaceRoot}/runs/{runId}/{stepId}", () => {
        expect(
            stepWritePrefix({
                workspaceRoot: ROOT,
                runId: "run-abc",
                stepId: "step-1",
            }),
        ).toBe(ROOT + sep + ["runs", "run-abc", "step-1"].join(sep));
    });

    it("rejects a `..` stepId before it becomes a host path", () => {
        // An LLM-authored plan step id of ".." would otherwise climb `runs/{runId}`
        // into a sibling run's tree (the finding this guard closes).
        expect(() => stepWritePrefix({ workspaceRoot: ROOT, runId: "run-abc", stepId: ".." })).toThrow(/Invalid stepId/);
        expect(() => stepWritePrefix({ workspaceRoot: ROOT, runId: "..", stepId: "step-1" })).toThrow(/Invalid runId/);
    });
});

describe("assertSafeId", () => {
    it("accepts UUID-shaped and dashed/dotted ids", () => {
        expect(() => assertSafeId("01890f2a-7c3e-7abc-9def-000000000000", "runId")).not.toThrow();
        expect(() => assertSafeId("data-profile", "stepId")).not.toThrow();
        expect(() => assertSafeId("v1.2", "id")).not.toThrow();
    });

    it("rejects the pure-dot segments the charset otherwise admits", () => {
        expect(() => assertSafeId(".", "stepId")).toThrow(/Invalid stepId/);
        expect(() => assertSafeId("..", "stepId")).toThrow(/Invalid stepId/);
    });

    it("rejects a slash or NUL", () => {
        expect(() => assertSafeId("a/b", "stepId")).toThrow(/Invalid stepId/);
        expect(() => assertSafeId("a\0b", "stepId")).toThrow(/Invalid stepId/);
    });
});

describe("reportSessionDir", () => {
    it("separates the directory of one thread from the directory of another", () => {
        expect(reportSessionDir("thread-a")).toBe("report-sessions/thread-a");
        expect(reportSessionDir("thread-b")).toBe("report-sessions/thread-b");
        expect(reportSessionDir("thread-a")).not.toBe(reportSessionDir("thread-b"));
    });

    it("gives the workspace-root-relative form", () => {
        // A host joins the form onto the root that it resolves. A leading slash makes
        // `join` give an absolute path, thus the form carries no leading slash.
        expect(reportSessionDir("thread-a").startsWith("/")).toBe(false);
        expect(reportSessionDir("thread-a").split("/")).toEqual(["report-sessions", "thread-a"]);
    });

    it("rejects a thread id that is not safe", () => {
        expect(() => reportSessionDir("..")).toThrow(/Invalid threadId/);
        expect(() => reportSessionDir("a/b")).toThrow(/Invalid threadId/);
        expect(() => reportSessionDir("a\0b")).toThrow(/Invalid threadId/);
    });
});

describe("assertSafeTail", () => {
    it("gives the segments of a workspace-relative tail", () => {
        expect(assertSafeTail("report-sessions/thread-a/derived")).toEqual(["report-sessions", "thread-a", "derived"]);
        expect(assertSafeTail("derived")).toEqual(["derived"]);
    });

    it("rejects an empty, an absolute, and a traversing tail", () => {
        expect(() => assertSafeTail("")).toThrow(/Invalid writableTail/);
        expect(() => assertSafeTail("/abs/derived")).toThrow(/Invalid writableTail/);
        expect(() => assertSafeTail("../escape")).toThrow(/Invalid writableTail/);
        expect(() => assertSafeTail("a/../../etc")).toThrow(/Invalid writableTail/);
        // An empty segment reaches the same refusal, thus a doubled or a trailing separator is out.
        expect(() => assertSafeTail("a//b")).toThrow(/Invalid writableTail/);
        expect(() => assertSafeTail("a/")).toThrow(/Invalid writableTail/);
    });

    it("rejects a segment that carries a NUL or a space, and it names the label", () => {
        expect(() => assertSafeTail("a\0b/c")).toThrow(/Invalid writableTail/);
        expect(() => assertSafeTail("a b/c", "tail")).toThrow(/Invalid tail/);
    });
});

describe("tailWritePrefix", () => {
    it("joins the validated segments under the workspace root", () => {
        expect(tailWritePrefix({ workspaceRoot: ROOT, tail: "report-sessions/thread-a/derived" })).toBe(
            resolvePath(ROOT, "report-sessions", "thread-a", "derived"),
        );
        // The step tail gives the same path as the step builder, thus one preparation serves both.
        expect(tailWritePrefix({ workspaceRoot: ROOT, tail: "runs/run-abc/step-1" })).toBe(STEP_DIR);
    });

    it("refuses a crafted tail instead of resolving outside the root", () => {
        expect(() => tailWritePrefix({ workspaceRoot: ROOT, tail: "../../etc" })).toThrow(/Invalid writableTail/);
    });
});

describe("toSandboxPath", () => {
    it("maps an in-tree host path onto /{resourceId}/{tail}", () => {
        expect(toSandboxPath(ROOT, ANALYSIS, STEP_DIR)).toBe(`/${ANALYSIS}/runs/run-abc/step-1`);
        expect(toSandboxPath(ROOT, ANALYSIS, ROOT)).toBe(`/${ANALYSIS}`);
    });

    it("throws when the host path escapes the workspace root", () => {
        expect(() => toSandboxPath(ROOT, ANALYSIS, resolvePath(SESSIONS, "analysis-002", "x"))).toThrow(/escapes the workspace root/);
    });
});

describe("toAnalysisRootPath", () => {
    it("roots a stored root-relative path", () => {
        expect(toAnalysisRootPath(ANALYSIS, "data/inputs/x.csv")).toBe(`/${ANALYSIS}/data/inputs/x.csv`);
        expect(toAnalysisRootPath(ANALYSIS, "")).toBe(`/${ANALYSIS}`);
    });

    it("is idempotent on a path that already carries the root", () => {
        const rooted = `/${ANALYSIS}/data/inputs/x.csv`;
        expect(toAnalysisRootPath(ANALYSIS, rooted)).toBe(rooted);
        expect(toAnalysisRootPath(ANALYSIS, toAnalysisRootPath(ANALYSIS, "data/inputs/x.csv"))).toBe(rooted);
        expect(toAnalysisRootPath(ANALYSIS, `/${ANALYSIS}`)).toBe(`/${ANALYSIS}`);
    });

    it("reads the near-misses a model writes as the same file", () => {
        for (const written of ["/data/inputs/x.csv", "./data/inputs/x.csv", "data//inputs/x.csv", "  data/inputs/x.csv  ", "data/./inputs/x.csv"]) {
            expect(toAnalysisRootPath(ANALYSIS, written)).toBe(`/${ANALYSIS}/data/inputs/x.csv`);
        }
    });

    it("keeps the wildcard segments of a kind's glob", () => {
        expect(toAnalysisRootPath(ANALYSIS, "data/inputs/vcf/*.vcf.gz")).toBe(`/${ANALYSIS}/data/inputs/vcf/*.vcf.gz`);
    });

    it("returns a path that climbs above the root unchanged, so the resolver rejects it", () => {
        expect(toAnalysisRootPath(ANALYSIS, "../other/x.csv")).toBe("../other/x.csv");
        expect(resolveWorkspacePath({ workspaceRoot: ROOT, analysisId: ANALYSIS, path: "../other/x.csv" }).kind).toBe("out_of_scope");
    });

    it("gives a path that resolves to the same file from inside a step frame", () => {
        // The defect this guards: a stored root-relative path resolves against the
        // step's working directory, which is not where the file is.
        const stored = "data/inputs/x.csv";
        const frameLocal = resolveWorkspacePath({ workspaceRoot: ROOT, analysisId: ANALYSIS, path: stored, workingDir: STEP_DIR });
        expect(frameLocal.kind === "ok" && frameLocal.relative).not.toBe(stored.split("/").join(sep));

        const rooted = resolveWorkspacePath({ workspaceRoot: ROOT, analysisId: ANALYSIS, path: toAnalysisRootPath(ANALYSIS, stored), workingDir: STEP_DIR });
        expect(rooted.kind).toBe("ok");
        if (rooted.kind === "ok") expect(rooted.relative).toBe(stored.split("/").join(sep));
    });
});
