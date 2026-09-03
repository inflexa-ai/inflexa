/**
 * Reconcile content-attests inputs (see the artifact-manifest spec): the path-only provenance frame
 * leaves every input ref hashless; reconcile fills the hash from the immutable
 * on-disk bytes, and drops from lineage every ref it cannot hash — a directory,
 * a resolution outside the analysis tree, a path that is not there — so no
 * hashless edge is ever registered and no step dies over one.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metrics } from "@opentelemetry/api";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { __resetReconcileMetricsForTest } from "../lib/metrics.js";
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
        // The other bound: a frame report naming somewhere outside the mount
        // entirely — a hook that failed to filter, e.g. a leaked stdlib read.
        // `feedExecFrame` keeps such a path verbatim on the ref, so reconcile
        // sees the real name and reaches the same verdict as the workspace-root
        // bound: out of scope, not drift.
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
                    reads: [{ path: "/etc/passwd", layers: ["preload"] }],
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

    test("does not attest an output entry whose symlink escapes the tree, and the run continues", async () => {
        // The sandbox can plant `output/leak.csv -> <outside secret>`; the lexical
        // step-root bound passes (the string is in-bounds), so only the realpath
        // classification keeps the escaping bytes out of the attested manifest.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        const logger = createCapturingLogger();
        try {
            const secret = join(sessionPath, "outside-secret.txt");
            await writeFile(secret, "PRIVATE KEY\n");
            await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
            await writeFile(join(root, "runs/run-001/de/output/result.csv"), "result\n1\n");
            await symlink(secret, join(root, "runs/run-001/de/output/leak.csv"));

            const collector = new ProvenanceCollector({ stepId: "de", runId: "run-001" });
            feedExecFrame({
                collector,
                mountRoot: `/${RID}`,
                command: ["python3", "scripts/de.py"],
                exitCode: 0,
                durationMs: 100,
                provenance: {
                    disabled: false,
                    reads: [],
                    writes: [
                        { path: `/${RID}/runs/run-001/de/output/result.csv`, layers: ["inotify"] },
                        { path: `/${RID}/runs/run-001/de/output/leak.csv`, layers: ["inotify"] },
                    ],
                    deletes: [],
                },
            });
            const manifest: ArtifactManifestEntry[] = [
                { stepId: "de", runId: "run-001", path: "output/result.csv", size: 0, type: "output", hash: "" },
                { stepId: "de", runId: "run-001", path: "output/leak.csv", size: 0, type: "output", hash: "" },
            ];

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

            // The escaping entry is skipped — no hash of the outside bytes is
            // recorded anywhere — while the real output still reconciles.
            expect(result.manifest.map((e) => e.path)).toEqual(["output/result.csv"]);
            const outsideHash = await computeSha256File(secret);
            expect(result.manifest.some((e) => e.hash === outsideHash)).toBe(false);

            const warns = logger.records.filter((r) => r.level === "warn");
            expect(warns).toHaveLength(1);
            expect(warns[0]!.msg).toBe("[reconcile-manifest] skipping symlink-escape entry");
            expect(warns[0]!.fields).toMatchObject({ path: "output/leak.csv" });
            // A skip is not a failure: the reconcile completes without an error.
            expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("drops an input whose symlink escapes the tree from lineage", async () => {
        // Same hole on the input side: the tracked read names an in-tree path,
        // but the path is a symlink to an outside file, so hashing through it
        // would attest outside bytes as this analysis's lineage.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        const logger = createCapturingLogger();
        const upstreamRel = "runs/run-001/qc/output/qc.csv";
        try {
            const secret = join(sessionPath, "outside-secret.txt");
            await writeFile(secret, "PRIVATE KEY\n");
            await mkdir(join(root, "runs/run-001/qc/output"), { recursive: true });
            await symlink(secret, join(root, upstreamRel));
            await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
            await writeFile(join(root, "runs/run-001/de/output/result.csv"), "result\n1\n");

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

            // The step survives; the escaping ref leaves the tracked inputs and
            // every record, so registration never sees the outside bytes' edge.
            expect(result.manifest).toHaveLength(1);
            expect(collector.getTrackedInputs()).toEqual([]);
            expect(collector.getRecords().flatMap((r) => r.inputs)).toHaveLength(0);

            const warns = logger.records.filter((r) => r.level === "warn");
            expect(warns).toHaveLength(1);
            expect(warns[0]!.msg).toBe("[reconcile-manifest] dropping out-of-tree input from lineage");
            expect(warns[0]!.fields).toMatchObject({ path: `/${RID}/${upstreamRel}`, boundSite: "realpath" });
            expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("drops an input that is not present at reconcile instead of failing the step", async () => {
        const { sessionPath, root, upstreamRel, collector, manifest } = await setup({ writeUpstream: false });
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

            // The step's own output still reconciles, and the unhashable ref
            // leaves both the tracked inputs and every record that cited it —
            // registration never sees a hashless edge.
            expect(result.manifest).toHaveLength(1);
            expect(collector.getTrackedInputs().some((r) => r.path === `/${RID}/${upstreamRel}`)).toBe(false);
            expect(collector.getRecords().flatMap((r) => r.inputs)).toHaveLength(0);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("names the dropped input and its drop site in the log", async () => {
        // A dropped edge is invisible by nature — the lineage graph simply lacks
        // it — so this record is the only account of which input the step lost
        // and why. It is also how a reader tells a noisy capture layer from an
        // artifact that genuinely vanished under the step.
        const { sessionPath, root, upstreamRel, collector, manifest } = await setup({ writeUpstream: false });
        const logger = createCapturingLogger();
        try {
            await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
                logger,
            });

            const warns = logger.records.filter((r) => r.level === "warn");
            expect(warns).toHaveLength(1);
            expect(warns[0]!.msg).toBe("[reconcile-manifest] dropping input not present at reconcile from lineage");
            expect(warns[0]!.fields).toMatchObject({
                // Which step, which input, and how it was classified — the read's
                // `source` is what says whether the step ever declared this input.
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                path: `/${RID}/${upstreamRel}`,
                source: "upstream",
                dropSite: "input-enoent",
            });
            expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("a traceback's source-file probe under an upstream step does not fail the step", async () => {
        // The reported failure, end to end. The step ran a script living in its
        // upstream's `scripts/` directory; the script died with an uncaught
        // pandas KeyError, and CPython's traceback printer looked for the Cython
        // source of the frame by probing "<entry>/hashtable_class_helper.pxi"
        // for every sys.path entry — sys.path[0] being that same directory. The
        // Python audit hook fires before the open, so the failed probe was
        // reported as a read; the path classifies `upstream` (a declared
        // dependency), which is attested. The step had already finished its work
        // when reconcile killed it over a file that never existed.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        const logger = createCapturingLogger();
        const phantomRel = "runs/run-001/qc/scripts/hashtable_class_helper.pxi";
        const scriptRel = "runs/run-001/qc/scripts/qc.py";
        try {
            await mkdir(join(root, "runs/run-001/qc/scripts"), { recursive: true });
            await writeFile(join(root, scriptRel), "import pandas as pd\n");
            await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
            await writeFile(join(root, "runs/run-001/de/output/result.csv"), "result\n1\n");

            const collector = new ProvenanceCollector({ stepId: "de", runId: "run-001", dependsOn: ["qc"] });
            feedExecFrame({
                collector,
                mountRoot: `/${RID}`,
                command: ["python3", `/${RID}/${scriptRel}`],
                exitCode: 1,
                durationMs: 100,
                provenance: {
                    disabled: false,
                    reads: [
                        { path: `/${RID}/${scriptRel}`, layers: ["python"] },
                        { path: `/${RID}/${phantomRel}`, layers: ["python"] },
                    ],
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

            expect(result.manifest).toHaveLength(1);
            // The probe is gone; the real read of the script it was probing for
            // survives, attested.
            const tracked = collector.getTrackedInputs();
            expect(tracked.map((r) => r.path)).toEqual([`/${RID}/${scriptRel}`]);
            expect(tracked[0]!.hash).toBe(await computeSha256File(join(root, scriptRel)));
            expect(logger.records.filter((r) => r.level === "error")).toHaveLength(0);
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

describe("reconcileManifestWithDisk — undeclared sibling reads", () => {
    test("a vanished undeclared sibling read does not fail the step", async () => {
        // The reported failure: a concurrently-running step wrote a scratch file,
        // this step's capture layer observed it, and the writer deleted it before
        // reconcile. Refusing the edge at classification is what leaves nothing
        // here to attest — reconcile fails a step only over a *tracked* input.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        const outRel = "output/result.csv";
        try {
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
                    // `norm` is not declared, and its scratch file was never written
                    // to this tree — exactly the state reconcile would have hit.
                    reads: [{ path: `/${RID}/runs/run-001/norm/output/_scratch.csv`, layers: ["inotify"] }],
                    writes: [{ path: `/${RID}/runs/run-001/de/${outRel}`, layers: ["inotify"] }],
                    deletes: [],
                },
            });

            const manifest: ArtifactManifestEntry[] = [{ stepId: "de", runId: "run-001", path: outRel, size: 0, type: "output", hash: "" }];

            const result = await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
            });

            expect(collector.getTrackedInputs()).toEqual([]);
            expect(result.manifest).toHaveLength(1);
            expect(result.manifest[0]!.hash).not.toBe("");
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });

    test("the same read, if tracked, is dropped at reconcile — the refusal is what avoids the edge", async () => {
        // Guards the test above from passing vacuously: force the ref into the
        // collector the way an admissible classification would, and it reaches
        // reconcile, which drops it and says so. Refusing at classification is
        // what keeps the edge from ever being asserted; reconcile is the backstop
        // that keeps an asserted-then-vanished one from being registered.
        const sessionPath = await mkdtemp(join(tmpdir(), "cortex-reconcile-"));
        const root = join(sessionPath, RID);
        const outRel = "output/result.csv";
        const scratchRel = "runs/run-001/norm/output/_scratch.csv";
        const logger = createCapturingLogger();
        try {
            await mkdir(join(root, "runs/run-001/de/output"), { recursive: true });
            await writeFile(join(root, "runs/run-001/de", outRel), "result\n1\n");

            const collector = new ProvenanceCollector({ stepId: "de", runId: "run-001", dependsOn: ["qc"] });
            collector.trackInputAccess(`/${RID}`, scratchRel, null, {
                source: "upstream",
                stepId: "norm",
                runId: "run-001",
            });

            const manifest: ArtifactManifestEntry[] = [{ stepId: "de", runId: "run-001", path: outRel, size: 0, type: "output", hash: "" }];

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
            expect(collector.getTrackedInputs()).toEqual([]);
            const warns = logger.records.filter((r) => r.level === "warn");
            expect(warns).toHaveLength(1);
            expect(warns[0]!.fields).toMatchObject({ path: `/${RID}/${scratchRel}`, dropSite: "input-enoent" });
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
        }
    });
});

describe("reconcileManifestWithDisk — metric labels", () => {
    test("the two reconcile counters carry agent_id (and reason), never step_id", async () => {
        // A per-step label multiplies the series count without bound; the
        // counters stay at one series per agent (per reason).
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const provider = new MeterProvider({
            readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 })],
        });
        metrics.setGlobalMeterProvider(provider);
        __resetReconcileMetricsForTest();

        // A phantom manifest entry (never written) drops one manifest entry, and
        // the absent upstream input drops one lineage input with reason `missing`.
        const { sessionPath, root, collector, manifest } = await setup({ writeUpstream: false });
        try {
            manifest.push({ stepId: "de", runId: "run-001", path: "output/phantom.csv", size: 0, type: "output", hash: "" });
            await reconcileManifestWithDisk({
                workspaceRoot: root,
                resourceId: RID,
                runId: "run-001",
                stepId: "de",
                agentId: "agent-x",
                manifest,
                collector,
            });

            await provider.forceFlush();
            const exported = exporter
                .getMetrics()
                .flatMap((rm) => rm.scopeMetrics)
                .flatMap((sm) => sm.metrics);
            const dropped = exported.find((m) => m.descriptor.name === "cortex.artifact.reconcile.dropped");
            const inputDropped = exported.find((m) => m.descriptor.name === "cortex.artifact.reconcile.input_dropped");

            expect(dropped?.dataPoints.map((p) => p.attributes)).toEqual([{ agent_id: "agent-x" }]);
            expect(inputDropped?.dataPoints.map((p) => p.attributes)).toEqual([{ agent_id: "agent-x", reason: "missing" }]);
        } finally {
            await rm(sessionPath, { recursive: true, force: true });
            await provider.shutdown();
            metrics.disable();
            __resetReconcileMetricsForTest();
        }
    });
});
