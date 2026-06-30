/**
 * `FilesystemArtifactRegistry` — the harness's (cloud-free) `ArtifactRegistry`
 * adapter.
 *
 * Instead of registering provenance with an external ledger, it writes a local
 * provenance index file under the step directory:
 *
 *   {sessionPath}/{resourceId}/runs/{runId}/{stepId}/provenance-index.json
 *
 * The index records the step's registered artifacts (analysis-scoped paths +
 * hashes) and the tracked inputs/outputs captured by the `ProvenanceCollector`,
 * so a local embedder (the CLI) retains a queryable lineage record with no
 * cloud dependency. Re-registration merges by output path (latest wins).
 *
 * It returns no external ids — the local `cortex_artifacts` ledger is the only
 * identity store in the cloud-free configuration.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runStepDir } from "../workspace/paths.js";
import type { ArtifactRegistry, ArtifactRegistrationInput, ExternalRegistrationResult } from "./artifact-registry.js";
import type { AgentSession } from "../auth/types.js";

export interface FilesystemArtifactRegistryDeps {
    /** Base path holding per-analysis session directories. */
    sessionPath: string;
}

/** One registered artifact in the local index. */
export interface FilesystemArtifactEntry {
    /** Analysis-scoped path (`runs/{runId}/{stepId}/...`). */
    path: string;
    hash: string;
    size: number;
    type: string;
}

/** One tracked output's lineage in the local index. */
export interface FilesystemLineageRecord {
    outputPath: string;
    outputHash: string;
    producer: string;
    scriptPath: string | null;
    inputs: Array<{ path: string; hash: string; source: string }>;
}

/** Shape of the persisted provenance index file. */
export interface FilesystemProvenanceIndex {
    resourceId: string;
    runId: string;
    stepId: string;
    updatedAt: string;
    artifacts: FilesystemArtifactEntry[];
    inputs: Array<{ path: string; hash: string; source: string }>;
    lineage: FilesystemLineageRecord[];
}

function indexPath(sessionPath: string, input: ArtifactRegistrationInput): string {
    return join(sessionPath, runStepDir(input.resourceId, input.runId, input.stepId), "provenance-index.json");
}

async function readIndex(path: string): Promise<FilesystemProvenanceIndex | null> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as FilesystemProvenanceIndex;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        // Corrupt/partial index (e.g. crash mid-write) → treat as absent and rebuild.
        if (err instanceof SyntaxError) return null;
        throw err;
    }
}

/** Merge two keyed lists, latest (incoming) winning per key. */
function mergeBy<T>(prior: T[], incoming: T[], key: (t: T) => string): T[] {
    const byKey = new Map<string, T>();
    for (const item of prior) byKey.set(key(item), item);
    for (const item of incoming) byKey.set(key(item), item);
    return [...byKey.values()];
}

export function createFilesystemArtifactRegistry(deps: FilesystemArtifactRegistryDeps): ArtifactRegistry {
    const { sessionPath } = deps;

    return {
        async register(input: ArtifactRegistrationInput, _session: AgentSession): Promise<ExternalRegistrationResult> {
            const { runId, stepId, artifacts, collector } = input;

            if (artifacts.length === 0) {
                return { registered: [], failed: [], failedCount: 0 };
            }

            const dbPathPrefix = `runs/${runId}/${stepId}/`;
            const entries: FilesystemArtifactEntry[] = artifacts.map((a) => ({
                path: `${dbPathPrefix}${a.path}`,
                hash: a.hash ?? "",
                size: a.size,
                type: a.type,
            }));

            const inputs = collector.getTrackedInputs().map((i) => ({
                path: i.path,
                hash: i.hash,
                source: i.source,
            }));

            const lineage: FilesystemLineageRecord[] = collector.getRecords().map((r) => ({
                outputPath: r.outputPath,
                outputHash: r.outputHash,
                producer: r.producer.type,
                scriptPath: r.scriptPath,
                inputs: r.inputs.map((i) => ({ path: i.path, hash: i.hash, source: i.source })),
            }));

            const path = indexPath(sessionPath, input);
            const prior = await readIndex(path);

            const merged: FilesystemProvenanceIndex = {
                resourceId: input.resourceId,
                runId,
                stepId,
                updatedAt: new Date().toISOString(),
                artifacts: mergeBy(prior?.artifacts ?? [], entries, (e) => e.path),
                inputs: mergeBy(prior?.inputs ?? [], inputs, (i) => i.path),
                lineage: mergeBy(prior?.lineage ?? [], lineage, (l) => l.outputPath),
            };

            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, JSON.stringify(merged, null, 2));

            // No external identity store in the cloud-free configuration.
            return { registered: [], failed: [], failedCount: 0 };
        },

        // Bytes already live in the local session tree — nothing to upload.
        async sync(): Promise<void> {},
    };
}
