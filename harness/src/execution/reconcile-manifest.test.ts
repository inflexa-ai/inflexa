/**
 * Reconcile content-attests inputs (see the artifact-manifest spec): the path-only provenance frame
 * leaves every input ref hashless; reconcile fills the hash from the immutable
 * on-disk bytes, and fails fast when an attested input is missing.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { ProvenanceCollector } from "../provenance/collector.js";
import { feedExecFrame } from "../provenance/exec-frame.js";
import { reconcileManifestWithDisk } from "./reconcile-manifest.js";
import { computeSha256File } from "../lib/fs-helpers.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";

const RID = "a1";

/** Lay out a session tree with a prior step's output (the upstream input) and
 *  the current step's output, then drive a collector frame over them. */
async function setup(opts: { writeUpstream: boolean }) {
    const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
    const root = join(sessionPath, RID);
    const upstreamRel = "runs/run-001/qc/output/qc.csv";
    const outRel = "output/result.csv";

    if (opts.writeUpstream) {
        await mkdir(join(root, "runs/run-001/qc/output"), { recursive: true });
        await writeFile(join(root, upstreamRel), "gene,count\nTP53,42\n");
    }
    await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
    await writeFile(join(root, "runs/run-001/de", outRel), "result\n1\n");

    const collector = new ProvenanceCollector({ stepId: "de", runId: "run-001", dependsOn: ["qc"] });
    feedExecFrame({
        collector,
        mountRoot: `/${RID}`,
        command: ["python3", "scripts/de.py"],
        exitCode: 0,
        durationMs: 100,
        provenance: {
            disabled: false,
            reads: [{ path: `/${RID}/${upstreamRel}`, layers: ["python"] }],
            writes: [{ path: `/${RID}/runs/run-001/de/${outRel}`, layers: ["inotify"] }],
            deletes: [],
        },
    });

    const manifest: ArtifactManifestEntry[] = [{ stepId: "de", runId: "run-001", path: outRel, size: 0, type: "output", hash: "" }];

    return { sessionPath, root, upstreamRel, collector, manifest };
}

describe("reconcileManifestWithDisk — input content attestation", () => {
    test("fills the upstream input hash from disk (immutable bytes the step read)", async () => {
        const { sessionPath, root, upstreamRel, collector, manifest } = await setup({ writeUpstream: true });
        try {
            const expected = await computeSha256File(join(root, upstreamRel));

            await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
            });

            const upstream = collector.getTrackedInputs().find((r) => r.source === "upstream");
            expect(upstream?.hash).toBe(expected);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("drops a directory read from lineage instead of failing the step", async () => {
        // Reproduces the staging failure: a command that lists a mounted directory
        // (e.g. `list.files("/a1/data")`) gets the dir tracked as an input by the
        // inotify frame. A directory is not a content-attestable file artifact, so
        // reconcile must drop it — not throw.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        try {
            await mkdir(join(root, "data"), { recursive: true });
            await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
            await writeFile(join(root, "runs/run-001/de/output/result.csv"), "result\n1\n");

            const collector = new ProvenanceCollector({ stepId: "de", runId: "run-001" });
            feedExecFrame({
                collector,
                mountRoot: `/${RID}`,
                command: ["Rscript", "scripts/de.R"],
                exitCode: 0,
                durationMs: 100,
                provenance: {
                    disabled: false,
                    reads: [{ path: `/${RID}/data`, layers: ["inotify"] }],
                    writes: [{ path: `/${RID}/runs/run-001/de/output/result.csv`, layers: ["inotify"] }],
                    deletes: [],
                },
            });
            const manifest: ArtifactManifestEntry[] = [{ stepId: "de", runId: "run-001", path: "output/result.csv", size: 0, type: "output", hash: "" }];

            const result = await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
            });

            expect(result.manifest).toHaveLength(1);
            // The directory ref is gone from both the tracked inputs and any record.
            expect(collector.getTrackedInputs().some((r) => r.path === `/${RID}/data`)).toBe(false);
            const recordInputs = collector.getRecords().flatMap((r) => r.inputs);
            expect(recordInputs.some((i) => i.path === `/${RID}/data`)).toBe(false);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("drops a read resolving outside the analysis tree instead of failing the step", async () => {
        // The field failure this behaviour exists for: a capture layer reported a
        // read of `/{RID}/..` — the container root, since the tree mounts at
        // `/{RID}` — which maps to a host path ABOVE the workspace root. It is not
        // attestable and not this analysis's lineage, but it is not drift either:
        // throwing here killed a whole enrichment run in the field.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        const logger = createCapturingLogger();
        try {
            await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
            await writeFile(join(root, "runs/run-001/de/output/result.csv"), "result\n1\n");

            const collector = new ProvenanceCollector({ stepId: "de", runId: "run-001" });
            feedExecFrame({
                collector,
                mountRoot: `/${RID}`,
                command: ["python3", "scripts/enrich.py"],
                exitCode: 0,
                durationMs: 100,
                provenance: {
                    disabled: false,
                    reads: [{ path: `/${RID}/..`, layers: ["preload"] }],
                    writes: [{ path: `/${RID}/runs/run-001/de/output/result.csv`, layers: ["inotify"] }],
                    deletes: [],
                },
            });
            const manifest: ArtifactManifestEntry[] = [{ stepId: "de", runId: "run-001", path: "output/result.csv", size: 0, type: "output", hash: "" }];

            const result = await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
                logger,
            });

            // The step survives and its real output still reconciles.
            expect(result.manifest).toHaveLength(1);
            // The out-of-tree ref is gone from both the tracked inputs and any record.
            expect(collector.getTrackedInputs().some((r) => r.path === `/${RID}/..`)).toBe(false);
            expect(
                collector
                    .getRecords()
                    .flatMap((r) => r.inputs)
                    .some((i) => i.path === `/${RID}/..`),
            ).toBe(false);

            // Dropping lineage is never silent — the warn names the ref and the bound.
            const warns = logger.records.filter((r) => r.level === "warn");
            expect(warns).toHaveLength(1);
            expect(warns[0]!.msg).toBe("[reconcile-manifest] dropping out-of-tree input from lineage");
            expect(warns[0]!.fields).toMatchObject({
                runId: "run-001",
                stepId: "de",
                path: `/${RID}/..`,
                boundSite: "workspace-root",
            });
            // A drop is not a failure: nothing is logged at error.
            expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("drops a read that never names the mount root (container-prefix bound)", async () => {
        // The other bound: a path that is not under `/{RID}` at all, so it cannot
        // even be mapped onto the host tree. Same verdict as the workspace-root
        // bound — out of scope, not drift.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        const logger = createCapturingLogger();
        try {
            await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
            await writeFile(join(root, "runs/run-001/de/output/result.csv"), "result\n1\n");

            const collector = new ProvenanceCollector({ stepId: "de", runId: "run-001" });
            // `feedExecFrame` strips the mount prefix, so an absolute path outside the
            // mount survives verbatim onto the ref — drive the collector directly to
            // get one, exactly as a leaked stdlib read would arrive.
            collector.trackInputAccess("/etc", "passwd", null);
            const manifest: ArtifactManifestEntry[] = [{ stepId: "de", runId: "run-001", path: "output/result.csv", size: 0, type: "output", hash: "" }];

            const result = await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
                logger,
            });

            expect(result.manifest).toHaveLength(1);
            expect(collector.getTrackedInputs().some((r) => r.path === "/etc/passwd")).toBe(false);

            const warns = logger.records.filter((r) => r.level === "warn");
            expect(warns).toHaveLength(1);
            expect(warns[0]!.fields).toMatchObject({ path: "/etc/passwd", boundSite: "container-prefix" });
            expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("throws when an attested input is missing at reconcile (fail-fast)", async () => {
        const { sessionPath, root, collector, manifest } = await setup({ writeUpstream: false });
        try {
            await expect(
                reconcileManifestWithDisk({
                    workspaceRoot: root,
                    resourceId: RID,
                    runId: "run-001",
                    stepId: "de",
                    agentId: "agent-x",
                    manifest,
                    collector,
                }),
            ).rejects.toThrow(/cannot attest input/);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("names the unattestable input and its throw site in the log", async () => {
        // The regression this change exists for: a step failed this way repeatedly
        // in the field and the operator log said nothing, because the throw was
        // console.error'd (discarded by the host) and the raised message is scrubbed
        // downstream. The record below is the ONLY account of which input died.
        const { sessionPath, root, upstreamRel, collector, manifest } = await setup({ writeUpstream: false });
        const logger = createCapturingLogger();
        try {
            await expect(
                reconcileManifestWithDisk({
                    workspaceRoot: root,
                    resourceId: RID,
                    runId: "run-001",
                    stepId: "de",
                    agentId: "agent-x",
                    manifest,
                    collector,
                    logger,
                }),
            ).rejects.toThrow();

            const errors = logger.records.filter((r) => r.level === "error");
            expect(errors).toHaveLength(1);
            expect(errors[0]!.msg).toBe("[reconcile-manifest] cannot attest input — not present at reconcile");
            expect(errors[0]!.fields).toMatchObject({
                // Which step died, which input, and how it was classified — the read's
                // `source` is what says whether the step ever declared this input.
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                path: `/${RID}/${upstreamRel}`,
                source: "upstream",
                throwSite: "input-enoent",
            });
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("stays silent when no logger is wired, without failing the reconcile", async () => {
        const { sessionPath, root, collector, manifest } = await setup({ writeUpstream: true });
        try {
            const result = await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
            });
            expect(result.manifest).toHaveLength(1);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });
});
