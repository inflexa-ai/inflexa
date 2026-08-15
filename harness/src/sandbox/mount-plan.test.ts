/**
 * Pure unit tests for the shared mount model — path computation, the
 * writable subdir list, the K8s subPath strings, and the libs-enabled
 * vs libs-unset env split.
 */

import { describe, expect, test } from "bun:test";

import { buildMountPlan, buildSessionSubPaths, sandboxWriteTail, STEP_SUBDIRS } from "./mount-plan.js";

const COORDS = { analysisId: "an-1", runId: "run-1", stepId: "step-a" };

/** A declared write tail, in the shape the session derivation gives. */
const TAIL = "report-sessions/thread-1/derived";

describe("buildMountPlan", () => {
    test("computes container paths from coordinates", () => {
        const plan = buildMountPlan(COORDS, { libs: true, refs: true });
        expect(plan.readonlyTreePath).toBe("/an-1");
        expect(plan.writableStepPath).toBe("/an-1/runs/run-1/step-a");
        expect(plan.libsPath).toBe("/mnt/libs");
        expect(plan.refsPath).toBe("/mnt/refs");
    });

    test("read-only omits the writable step mount and pins WorkingDir to the RO tree", () => {
        const plan = buildMountPlan({ ...COORDS, readOnly: true }, { libs: true, refs: true });
        expect(plan.writableStepPath).toBeUndefined();
        expect(plan.stepSubdirs).toEqual([]);
        // WorkingDir falls back to the read-only tree root.
        expect(plan.workingDir).toBe("/an-1");
        // The RO tree mount, lib/ref stores, and provenance env are unaffected.
        expect(plan.readonlyTreePath).toBe("/an-1");
        expect(plan.libsPath).toBe("/mnt/libs");
        expect(plan.refsPath).toBe("/mnt/refs");
        expect(plan.env.PROVENANCE_WATCH_DIRS).toBe("/an-1");
    });

    test("writable mode sets WorkingDir to the writable step path", () => {
        const plan = buildMountPlan(COORDS, { libs: false, refs: false });
        expect(plan.workingDir).toBe("/an-1/runs/run-1/step-a");
        expect(plan.writableStepPath).toBe("/an-1/runs/run-1/step-a");
    });

    test("step subdir list is the five artifact dirs", () => {
        const plan = buildMountPlan(COORDS, { libs: false, refs: false });
        expect(plan.stepSubdirs).toEqual(STEP_SUBDIRS);
        expect([...plan.stepSubdirs]).toEqual(["output", "scripts", "figures", "logs", "notebooks"]);
    });

    test("PROVENANCE_WATCH_DIRS is always set to the RO tree", () => {
        const plan = buildMountPlan(COORDS, { libs: false, refs: false });
        expect(plan.env.PROVENANCE_WATCH_DIRS).toBe("/an-1");
    });

    test("libs enabled injects lib-store env", () => {
        const plan = buildMountPlan(COORDS, { libs: true, refs: false });
        expect(plan.env.R_LIBS_SITE).toContain("/mnt/libs/current/r/");
        expect(plan.env.NODE_PATH).toBe("/mnt/libs/current/node/node_modules");
        expect(plan.env.PATH).toContain("/mnt/libs/current/conda/bin");
    });

    test("libs unset omits lib-store env and libsPath", () => {
        const plan = buildMountPlan(COORDS, { libs: false, refs: false });
        expect(plan.libsPath).toBeUndefined();
        expect(plan.env.R_LIBS_SITE).toBeUndefined();
        expect(plan.env.NODE_PATH).toBeUndefined();
        expect(plan.env.PATH).toBeUndefined();
        // Provenance still present even with no stores.
        expect(plan.env.PROVENANCE_WATCH_DIRS).toBe("/an-1");
    });

    test("refs gating is independent of libs", () => {
        const plan = buildMountPlan(COORDS, { libs: false, refs: true });
        expect(plan.refsPath).toBe("/mnt/refs");
        expect(plan.libsPath).toBeUndefined();
        expect(plan.env.R_LIBS_SITE).toBeUndefined();
    });
});

describe("buildSessionSubPaths", () => {
    test("carries no leading slash and nests the step tail under the workspace subPath", () => {
        const subPaths = buildSessionSubPaths(COORDS, "an-1");
        expect(subPaths.ro).toBe("an-1");
        expect(subPaths.rw).toBe("an-1/runs/run-1/step-a");
        // The RW subPath matches the container RW mount path sans leading slash — the two
        // sides of the same directory.
        expect(`/${subPaths.rw}`).toBe(buildMountPlan(COORDS, { libs: false, refs: false }).writableStepPath ?? "");
    });

    test("tracks a workspace root that is NOT laid out as {pvcRoot}/{analysisId}", () => {
        // The whole point of the seam: the container still sees `/an-1`, but the PVC subPath
        // follows wherever the embedder actually put the root.
        const subPaths = buildSessionSubPaths(COORDS, "tenants/acme/projects/rna/an-1");
        expect(subPaths.ro).toBe("tenants/acme/projects/rna/an-1");
        expect(subPaths.rw).toBe("tenants/acme/projects/rna/an-1/runs/run-1/step-a");
    });

    test("read-only omits the writable subPath", () => {
        expect(buildSessionSubPaths({ ...COORDS, readOnly: true }, "an-1").rw).toBeUndefined();
    });

    test("rejects an empty, absolute, or traversing workspace subPath", () => {
        expect(() => buildSessionSubPaths(COORDS, "")).toThrow(/non-empty/);
        expect(() => buildSessionSubPaths(COORDS, "/abs/an-1")).toThrow(/PVC-root-relative/);
        expect(() => buildSessionSubPaths(COORDS, "../escape/an-1")).toThrow(/'\.\.'/);
    });

    test("rejects a crafted `..` runId/stepId in the RW subPath", () => {
        expect(() => buildSessionSubPaths({ ...COORDS, stepId: ".." }, "an-1")).toThrow(/Invalid stepId/);
        expect(() => buildSessionSubPaths({ ...COORDS, runId: ".." }, "an-1")).toThrow(/Invalid runId/);
    });
});

describe("buildMountPlan id validation", () => {
    test("rejects a crafted `..` analysisId/runId/stepId", () => {
        expect(() => buildMountPlan({ ...COORDS, analysisId: ".." }, { libs: false, refs: false })).toThrow(/Invalid analysisId/);
        expect(() => buildMountPlan({ ...COORDS, stepId: ".." }, { libs: false, refs: false })).toThrow(/Invalid stepId/);
        expect(() => buildMountPlan({ ...COORDS, runId: ".." }, { libs: false, refs: false })).toThrow(/Invalid runId/);
    });
});

describe("the declared write tail", () => {
    test("takes the place of the step tail as the one writable mount", () => {
        const plan = buildMountPlan({ ...COORDS, writableTail: TAIL }, { libs: true, refs: true });
        expect(plan.writableStepPath).toBe(`/an-1/${TAIL}`);
        // The working directory is the write mount, thus a script writes beside where it stands.
        expect(plan.workingDir).toBe(`/an-1/${TAIL}`);
        // A declared tail is one directory, thus the host pre-creates no artifact subdirectory under it.
        expect(plan.stepSubdirs).toEqual([]);
        // The read-only tree and the two stores are untouched by the tail.
        expect(plan.readonlyTreePath).toBe("/an-1");
        expect(plan.libsPath).toBe("/mnt/libs");
        expect(plan.refsPath).toBe("/mnt/refs");
        expect(plan.env.PROVENANCE_WATCH_DIRS).toBe("/an-1");
        // The step tail of the coordinates reaches no mount.
        expect(plan.writableStepPath).not.toContain("runs/run-1/step-a");
    });

    test("nests under the workspace subPath on the PVC side", () => {
        const subPaths = buildSessionSubPaths({ ...COORDS, writableTail: TAIL }, "tenants/acme/an-1");
        expect(subPaths.ro).toBe("tenants/acme/an-1");
        expect(subPaths.rw).toBe(`tenants/acme/an-1/${TAIL}`);
        // The RW subPath matches the container RW mount path sans leading slash — the two sides of the
        // same directory.
        expect(`/an-1/${subPaths.rw!.slice("tenants/acme/an-1/".length)}`).toBe(
            buildMountPlan({ ...COORDS, writableTail: TAIL }, { libs: false, refs: false }).writableStepPath,
        );
    });

    test("refuses a tail beside read-only, because the two state opposite things", () => {
        expect(() => buildMountPlan({ ...COORDS, writableTail: TAIL, readOnly: true }, { libs: false, refs: false })).toThrow(/read-only sandbox cannot/);
        expect(() => buildSessionSubPaths({ ...COORDS, writableTail: TAIL, readOnly: true }, "an-1")).toThrow(/read-only sandbox cannot/);
        expect(() => sandboxWriteTail({ ...COORDS, writableTail: TAIL, readOnly: true })).toThrow(/read-only sandbox cannot/);
    });

    test("refuses an empty, absolute, or traversing tail", () => {
        for (const tail of ["", "/abs/derived", "../escape", "report-sessions/../../etc", "report-sessions//derived", "derived/"]) {
            expect(() => buildMountPlan({ ...COORDS, writableTail: tail }, { libs: false, refs: false })).toThrow(/Invalid writableTail/);
        }
    });

    test("refuses a tail segment that carries a shell-hostile character", () => {
        expect(() => buildMountPlan({ ...COORDS, writableTail: "report-sessions/thread 1/derived" }, { libs: false, refs: false })).toThrow(
            /Invalid writableTail/,
        );
        expect(() => buildMountPlan({ ...COORDS, writableTail: "report-sessions/a\0b/derived" }, { libs: false, refs: false })).toThrow(/Invalid writableTail/);
    });

    test("keeps the run plan byte-identical when no tail is declared", () => {
        // The run path is the whole reason the field is optional: an absent tail must give exactly the plan
        // of a step, field for field.
        const stepPlan = buildMountPlan(COORDS, { libs: true, refs: true });
        expect(stepPlan).toEqual({
            readonlyTreePath: "/an-1",
            writableStepPath: "/an-1/runs/run-1/step-a",
            workingDir: "/an-1/runs/run-1/step-a",
            libsPath: "/mnt/libs",
            refsPath: "/mnt/refs",
            stepSubdirs: STEP_SUBDIRS,
            env: stepPlan.env,
        });
        expect(buildSessionSubPaths(COORDS, "an-1")).toEqual({ ro: "an-1", rw: "an-1/runs/run-1/step-a" });
    });
});

describe("sandboxWriteTail", () => {
    test("gives the step tail with its five subdirectories when no tail is declared", () => {
        expect(sandboxWriteTail(COORDS)).toEqual({ tail: "runs/run-1/step-a", subdirs: STEP_SUBDIRS });
    });

    test("gives the declared tail with no subdirectory", () => {
        expect(sandboxWriteTail({ ...COORDS, writableTail: TAIL })).toEqual({ tail: TAIL, subdirs: [] });
    });

    test("gives nothing for a read-only sandbox", () => {
        expect(sandboxWriteTail({ ...COORDS, readOnly: true })).toBeUndefined();
    });
});
