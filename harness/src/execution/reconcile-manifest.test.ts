/**
 * Reconcile content-attests inputs (see the artifact-manifest spec): the path-only provenance frame
 * leaves every input ref hashless; reconcile fills the hash from the immutable
 * on-disk bytes, and fails fast when an attested input is missing.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
