/**
 * Unit test for the cloud-free `FilesystemArtifactRegistry` adapter: it writes a
 * local provenance index capturing the step's registered artifacts + tracked
 * lineage, returns a success result with no external ids, and merges on
 * re-registration. No DB, no external artifact store.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProvenanceCollector } from "../provenance/collector.js";
import { feedExecFrame } from "../provenance/exec-frame.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { AgentSession } from "../auth/types.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import { createFilesystemArtifactRegistry, type FilesystemProvenanceIndex } from "./filesystem-artifact-registry.js";

// The filesystem adapter ignores the session; a minimal valid one suffices.
const session: AgentSession = {
    identity: { user: "u-1" },
    scope: { kind: "analysis", analysisId: "a1" },
    provenance: { agentId: "x", callPath: ["x"] },
    auth: makeLocalAuth(),
};

function buildCollector(): ProvenanceCollector {
    const collector = new ProvenanceCollector({ stepId: "tmm", runId: "run-001" });
    collector.setInputFileIdMap(new Map([["data/inputs/Lab/counts.csv", "uuid-1"]]));
    feedExecFrame({
        collector,
        mountRoot: "/a1",
        command: ["python3", "scripts/tmm.py"],
        exitCode: 0,
        durationMs: 900,
        provenance: {
            disabled: false,
            reads: [{ path: "/a1/data/inputs/Lab/counts.csv", layers: ["python"] }],
            writes: [{ path: "/a1/runs/run-001/tmm/output/tmm.csv", layers: ["inotify"] }],
            deletes: [],
        },
    });
    return collector;
}

const artifacts: ArtifactManifestEntry[] = [
    { stepId: "tmm", runId: "run-001", path: "scripts/tmm.py", size: 200, type: "script", hash: "h1" },
    { stepId: "tmm", runId: "run-001", path: "output/tmm.csv", size: 4096, type: "output", hash: "h2" },
];

describe("FilesystemArtifactRegistry", () => {
    test("writes a provenance index and returns success with no external ids", async () => {
        const sessionPath = await mkdtemp(join(tmpdir(), "fs-registry-"));
        const registry = createFilesystemArtifactRegistry({ sessionPath });

        const result = await registry.register(
            {
                resourceId: "a1",
                runId: "run-001",
                stepId: "tmm",
                artifacts,
                collector: buildCollector(),
            },
            session,
        );

        expect(result.registered).toEqual([]);
        expect(result.failed).toEqual([]);
        expect(result.failedCount).toBe(0);

        const indexFile = join(sessionPath, "a1", "runs", "run-001", "tmm", "provenance-index.json");
        const index = JSON.parse(await readFile(indexFile, "utf8")) as FilesystemProvenanceIndex;

        expect(index.resourceId).toBe("a1");
        expect(index.runId).toBe("run-001");
        expect(index.stepId).toBe("tmm");

        // Artifacts are recorded with analysis-scoped paths.
        const paths = index.artifacts.map((a) => a.path).sort();
        expect(paths).toEqual(["runs/run-001/tmm/output/tmm.csv", "runs/run-001/tmm/scripts/tmm.py"]);

        // The data input is tracked.
        expect(index.inputs.some((i) => i.path.includes("counts.csv"))).toBe(true);

        // Lineage captures the command output with its input edge.
        const out = index.lineage.find((l) => l.outputPath.endsWith("output/tmm.csv"));
        expect(out?.producer).toBe("command");
        expect(out?.inputs.some((i) => i.path.includes("counts.csv"))).toBe(true);
    });

    test("empty manifest is a no-op", async () => {
        const sessionPath = await mkdtemp(join(tmpdir(), "fs-registry-"));
        const registry = createFilesystemArtifactRegistry({ sessionPath });

        const result = await registry.register(
            {
                resourceId: "a1",
                runId: "run-001",
                stepId: "tmm",
                artifacts: [],
                collector: new ProvenanceCollector({ stepId: "tmm", runId: "run-001" }),
            },
            session,
        );

        expect(result).toEqual({ registered: [], failed: [], failedCount: 0 });
    });

    test("re-registration merges artifacts by path", async () => {
        const sessionPath = await mkdtemp(join(tmpdir(), "fs-registry-"));
        const registry = createFilesystemArtifactRegistry({ sessionPath });

        await registry.register(
            {
                resourceId: "a1",
                runId: "run-001",
                stepId: "tmm",
                artifacts,
                collector: buildCollector(),
            },
            session,
        );
        await registry.register(
            {
                resourceId: "a1",
                runId: "run-001",
                stepId: "tmm",
                artifacts: [{ stepId: "tmm", runId: "run-001", path: "output/extra.csv", size: 10, type: "output", hash: "h4" }],
                collector: buildCollector(),
            },
            session,
        );

        const indexFile = join(sessionPath, "a1", "runs", "run-001", "tmm", "provenance-index.json");
        const index = JSON.parse(await readFile(indexFile, "utf8")) as FilesystemProvenanceIndex;
        const paths = index.artifacts.map((a) => a.path).sort();
        expect(paths).toEqual(["runs/run-001/tmm/output/extra.csv", "runs/run-001/tmm/output/tmm.csv", "runs/run-001/tmm/scripts/tmm.py"]);
    });
});
