import { describe, expect, it } from "bun:test";
import { resolve as resolvePath, sep } from "node:path";

import { resolveForWrite, resolveWorkspacePath, stepWritePrefix } from "./paths.js";

const SESSIONS = "/var/sessions";
const ANALYSIS = "analysis-001";
const ROOT = resolvePath(SESSIONS, ANALYSIS);
const STEP_DIR = stepWritePrefix({
    sessionsBasePath: SESSIONS,
    analysisId: ANALYSIS,
    runId: "run-abc",
    stepId: "step-1",
});

describe("resolveWorkspacePath", () => {
    it("resolves an analysis-relative path under the analysis root", () => {
        const r = resolveWorkspacePath({
            sessionsBasePath: SESSIONS,
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
            sessionsBasePath: SESSIONS,
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
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: "/analysis-002/data/inputs/secret.csv",
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects ../ traversal that escapes the analysis tree", () => {
        const r = resolveWorkspacePath({
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: "../analysis-002/secret.csv",
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects /{analysisId}/../{other}/... after-strip traversal", () => {
        const r = resolveWorkspacePath({
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/../analysis-002/secret.csv`,
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects /etc/passwd-style system paths", () => {
        const r = resolveWorkspacePath({
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: "/etc/passwd",
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects empty path and embedded NUL", () => {
        expect(
            resolveWorkspacePath({
                sessionsBasePath: SESSIONS,
                analysisId: ANALYSIS,
                path: "",
            }).kind,
        ).toBe("out_of_scope");
        expect(
            resolveWorkspacePath({
                sessionsBasePath: SESSIONS,
                analysisId: ANALYSIS,
                path: "data/\0nope",
            }).kind,
        ).toBe("out_of_scope");
    });

    it("resolves a relative path against workingDir (frame-local)", () => {
        const r = resolveWorkspacePath({
            sessionsBasePath: SESSIONS,
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
            sessionsBasePath: SESSIONS,
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
            sessionsBasePath: SESSIONS,
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
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/runs/run-abc/step-1`,
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("ok");
    });

    it("rejects an absolute in-tree path outside workingDir as out_of_prefix", () => {
        const r = resolveForWrite({
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: `/${ANALYSIS}/data/inputs/x.csv`,
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("out_of_prefix");
    });

    it("rejects a write under another run's step tree as out_of_prefix", () => {
        const r = resolveForWrite({
            sessionsBasePath: SESSIONS,
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
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: "../../../../analysis-002/secret.csv",
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("out_of_scope");
    });

    it("rejects an in-tree `..` that stays in the analysis tree as out_of_prefix", () => {
        const r = resolveForWrite({
            sessionsBasePath: SESSIONS,
            analysisId: ANALYSIS,
            path: "../../analysis-002/secret.csv",
            workingDir: STEP_DIR,
        });
        expect(r.kind).toBe("out_of_prefix");
    });
});

describe("stepWritePrefix", () => {
    it("composes /{sessionsBase}/{analysisId}/runs/{runId}/{stepId}", () => {
        expect(
            stepWritePrefix({
                sessionsBasePath: SESSIONS,
                analysisId: ANALYSIS,
                runId: "run-abc",
                stepId: "step-1",
            }),
        ).toBe(ROOT + sep + ["runs", "run-abc", "step-1"].join(sep));
    });
});
