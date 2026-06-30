/**
 * Step-level provenance collector — tracks inputs consumed and outputs
 * produced within a single workflow step.
 *
 * Integrates with:
 *   - K8sSandbox executeCommand provenance (script reads + writes via inotify)
 *   - Data-mount filesystem write tracking (agent file-tool outputs)
 *
 * Input attribution comes exclusively from sandbox exec inotify (the
 * authoritative record of what computation actually consumed). Agent
 * tool reads are not tracked here — they're exploratory and would
 * pollute the lineage graph.
 */

import type { ArtifactRecord } from "../execution/artifact-record.js";
import type { ProvenanceRecord, InputRef, InputSource, Producer } from "./types.js";

/** A single observed write from the provenance frame.
 *
 * `hash` is left empty by `processProvenanceFrame` — it is the
 * responsibility of `reconcileManifestWithDisk` to populate the hash
 * from disk just before registration, so the registered hash always
 * matches the bytes the storage backend will receive at upload time. Callers that
 * synthesize writes from a context where the bytes are already known
 * and stable (e.g., `recordFileToolWrite` for in-process agent tool
 * writes) may pass a non-empty hash directly.
 */
export interface ObservedWrite {
    /** Analysis-relative path (e.g., "runs/run-001/step-de/output/results.csv") */
    path: string;
    /** SHA-256 hash of the file content. Empty string when deferred to reconcile. */
    hash: string;
    /** File size in bytes. */
    size: number;
}

// ── Script path inference ───────────────────────────────────────────

/** Known interpreter prefixes for script path extraction. */
const SCRIPT_PATTERNS = [/^python3?\s+(.+)$/, /^Rscript\s+(.+)$/, /^bash\s+(.+)$/, /^sh\s+(.+)$/];

/**
 * Attempt to extract the script path from a command string.
 * Returns the first argument that looks like a file path for known interpreters.
 */
function inferScriptPath(command: string, args?: string[]): string | null {
    const fullCommand = args?.length ? `${command} ${args.join(" ")}` : command;

    for (const pattern of SCRIPT_PATTERNS) {
        const match = fullCommand.match(pattern);
        if (match?.[1]) {
            // Take the first token (the script path), ignoring further args
            return match[1].split(/\s+/)[0]!;
        }
    }

    return null;
}

// ── Input classification ────────────────────────────────────────────

/** Explicit classification context for a file read. Callers build this
 *  from StepMetadata instead of the collector parsing paths. */
export interface InputClassificationContext {
    source: InputSource;
    stepId?: string;
    runId?: string;
}

/**
 * Build classification context for a file read using known step metadata.
 *
 * Uses prefix matching against structured metadata — no path segment
 * extraction. The caller knows its own stepId/runId and its upstream
 * dependencies (dependsOn).
 *
 * For prior-run reads (paths under runs/ that don't match own run or
 * any dependsOn entry), this falls back to path extraction. See the
 * detailed comment in the prior-run branch for why and what needs to
 * happen to eliminate it.
 */
export function classifyReadPath(relativePath: string, ownStepId: string, ownRunId: string, dependsOn?: string[]): InputClassificationContext {
    if (relativePath.startsWith("data/") || relativePath.startsWith("dataprofile/")) {
        return { source: "data" };
    }

    // Own artifacts: runs/{ownRunId}/{ownStepId}/...
    const ownPrefix = `runs/${ownRunId}/${ownStepId}/`;
    if (relativePath.startsWith(ownPrefix)) {
        return { source: "artifacts", stepId: ownStepId, runId: ownRunId };
    }

    // Upstream dependencies: runs/{ownRunId}/{depStepId}/...
    if (dependsOn) {
        for (const depStepId of dependsOn) {
            const upstreamPrefix = `runs/${ownRunId}/${depStepId}/`;
            if (relativePath.startsWith(upstreamPrefix)) {
                return { source: "upstream", stepId: depStepId, runId: ownRunId };
            }
        }
    }

    // Same-run sibling step. dependsOn only drives topo-sort ordering, not
    // read authorization, so a read outside dependsOn is still a valid
    // upstream input — just extract the stepId from the path.
    const ownRunPrefix = `runs/${ownRunId}/`;
    if (relativePath.startsWith(ownRunPrefix)) {
        const afterRun = relativePath.slice(ownRunPrefix.length);
        const slashIdx = afterRun.indexOf("/");
        const stepId = slashIdx > 0 ? afterRun.slice(0, slashIdx) : afterRun;
        if (stepId) {
            return { source: "upstream", stepId, runId: ownRunId };
        }
    }

    // ┌──────────────────────────────────────────────────────────────────┐
    // │ PRIOR-RUN FALLBACK — PATH EXTRACTION                            │
    // │                                                                  │
    // │ This is the ONE remaining path-parsing case. It exists because   │
    // │ StepMetadata.sourceRunIds is declared but NEVER POPULATED.       │
    // │                                                                  │
    // │ The infrastructure exists but is disconnected:                   │
    // │   - StepMetadata.sourceRunIds (workspace-profiles.ts:53)         │
    // │     → Declared with comment "not used for mount construction"    │
    // │     → Never set by any caller                                   │
    // │   - execute-analysis.ts:474-487 builds stepMetadata              │
    // │     → Sets dependsOn from step.depends_on                       │
    // │     → Does NOT set sourceRunIds                                  │
    // │   - generatePlan tool (generate-plan.ts:88) has priorRuns input  │
    // │     → Never called with actual prior run data                   │
    // │   - cortex_runs table has all run IDs per analysis               │
    // │     → Never queried to discover prior runs at workflow init      │
    // │   - The PVC mounts everything at /{resourceId}/ so prior run    │
    // │     files are accidentally visible via the filesystem            │
    // │                                                                  │
    // │ TO ELIMINATE THIS FALLBACK:                                      │
    // │   1. In execute-analysis.ts, before running steps:               │
    // │      query cortex_runs for prior run IDs for this analysis       │
    // │   2. Pass them as sourceRunIds in StepMetadata                   │
    // │   3. Thread sourceRunIds through to ProvenanceCollector          │
    // │   4. Add sourceRunIds to classifyReadPath() params               │
    // │   5. Build prefixes: runs/{priorRunId}/ for each prior run      │
    // │   6. Match and extract stepId from known prior run prefixes      │
    // │      (same prefix-matching pattern as dependsOn, no parsing)    │
    // │                                                                  │
    // │ Until then, we extract runId and stepId from the path for        │
    // │ prior-run reads. This is the only place in the provenance        │
    // │ system that does path-segment extraction.                        │
    // └──────────────────────────────────────────────────────────────────┘
    if (relativePath.startsWith("runs/")) {
        const parts = relativePath.split("/");
        const priorRunId = parts[1];
        const priorStepId = parts[2];
        if (priorRunId && priorStepId) {
            return { source: "prior", stepId: priorStepId, runId: priorRunId };
        }
    }

    return { source: "data" };
}

// ── Collector ───────────────────────────────────────────────────────

export interface ProvenanceCollectorOptions {
    stepId: string;
    runId: string;
    /** Step IDs this step depends on (for upstream mount enumeration). */
    dependsOn?: string[];
}

export class ProvenanceCollector {
    readonly stepId: string;
    readonly runId: string;
    readonly dependsOn: string[];
    /** Prefix for converting analysis-relative write paths to step-relative. */
    private readonly stepPrefix: string;
    /**
     * Map from input file relative path (e.g., "inputs/Lab A Storage/trail_0/data.csv")
     * to fileId. Sourced from the data-mount filesystem's inputPathToFileId map
     * (passed by reference, populated lazily during filesystem init).
     */
    private inputFileIdMap?: Map<string, string>;

    /** Tracked reads from read-only mounts, keyed by `mountPath:relativePath`. */
    private readonly inputAccesses = new Map<string, InputRef>();

    /** File tool write records, keyed by output path (relative to /artifacts). */
    private readonly fileToolRecords = new Map<string, ProvenanceRecord>();

    /** Command execution records, keyed by output path (relative to /artifacts). */
    private readonly commandRecords = new Map<string, ProvenanceRecord>();

    constructor(opts: ProvenanceCollectorOptions) {
        this.stepId = opts.stepId;
        this.runId = opts.runId;
        this.dependsOn = opts.dependsOn ?? [];
        this.stepPrefix = `runs/${opts.runId}/${opts.stepId}/`;
    }

    /**
     * Set the input file ID map (passed by reference from the data-mount filesystem).
     * Called after construction when the data mount filesystem is available.
     */
    setInputFileIdMap(map: Map<string, string>): void {
        this.inputFileIdMap = map;
    }

    /**
     * Track a file read from a read-only mount.
     * Called by sandbox exec provenance frame processing.
     *
     * @param mountPath - The workspace mount path (e.g., "/a1/data" or "/a1" for single-mount)
     * @param relativePath - Path relative to the mount root
     * @param hash - SHA-256 hash of the file content, or null if file no longer exists
     * @param context - Explicit classification context from the caller. When provided,
     *   the collector uses it directly instead of classifying from the path.
     */
    trackInputAccess(mountPath: string, relativePath: string, hash: string | null, context?: InputClassificationContext): InputRef {
        const key = `${mountPath}:${relativePath}`;
        const existing = this.inputAccesses.get(key);
        if (existing) return existing;

        // Use explicit context if provided, otherwise fall back to path classification
        const classification = context ?? classifyReadPath(relativePath, this.stepId, this.runId, this.dependsOn);
        const fullPath = `${mountPath}/${relativePath}`;

        // Resolve fileId for data-source inputs via materialized file metadata map
        let fileId: string | undefined;
        if (classification.source === "data" && this.inputFileIdMap) {
            fileId = this.inputFileIdMap.get(relativePath);
        }

        const ref: InputRef = {
            path: fullPath,
            hash: hash ?? "",
            source: classification.source,
            stepId: classification.stepId,
            runId: classification.runId,
            fileId,
        };
        this.inputAccesses.set(key, ref);
        return ref;
    }

    /**
     * Record a file tool write (write_file, append_file, copy_file).
     * Called after the data-mount filesystem records the artifact.
     *
     * File tool writes are agent-authored content — not derived from input
     * files via execution — so no inputs are attributed.
     */
    recordFileToolWrite(artifact: ArtifactRecord): void {
        // Last-write-wins: unlink any command record for this path.
        // Post-step overwrites (e.g., summary generation) replace the command output.
        this.commandRecords.delete(artifact.path);

        const record: ProvenanceRecord = {
            outputPath: artifact.path,
            outputHash: artifact.hash,
            outputSize: artifact.size,
            producer: {
                type: "file_tool",
                tool: artifact.toolName ?? "unknown",
                timestamp: artifact.timestamp,
            },
            inputs: [],

            scriptPath: null,
            stepId: this.stepId,
            runId: this.runId,
        };

        this.fileToolRecords.set(artifact.path, record);
    }

    /**
     * Record outputs from a sandbox command execution.
     * Called after provenance frame processing extracts observed writes.
     *
     * When commandReads is provided, uses those as the inputs for this
     * command's provenance records (per-command scoping). Falls back to
     * snapshotting the global inputAccesses accumulator when not provided.
     */
    recordCommandExecution(
        command: string,
        args: string[],
        exitCode: number,
        durationMs: number,
        writes: ObservedWrite[],
        scriptPath?: string,
        commandReads?: InputRef[],
    ): void {
        const inputs = commandReads ?? Array.from(this.inputAccesses.values());
        const resolvedScript = scriptPath ?? inferScriptPath(command, args);
        const timestamp = new Date().toISOString();

        const producer: Producer = {
            type: "command",
            command,
            args: args.length > 0 ? args : undefined,
            exitCode,
            durationMs,
            timestamp,
        };

        for (const write of writes) {
            // Normalize analysis-relative paths to step-relative so keys match
            // the data-mount filesystem's localArtifacts and the artifact manifest.
            const outputPath = write.path.startsWith(this.stepPrefix) ? write.path.slice(this.stepPrefix.length) : write.path;

            const record: ProvenanceRecord = {
                outputPath,
                outputHash: write.hash,
                outputSize: write.size,
                producer,
                inputs,
                scriptPath: resolvedScript,
                stepId: this.stepId,
                runId: this.runId,
            };

            // Last-write-wins: unlink any file-tool record for this path.
            this.fileToolRecords.delete(outputPath);
            this.commandRecords.set(outputPath, record);
        }
    }

    /**
     * Get provenance inputs classified as `source: "data"` (input files read from /data mount).
     */
    getDataInputs(): InputRef[] {
        return Array.from(this.inputAccesses.values()).filter((ref) => ref.source === "data");
    }

    /**
     * All distinct input refs observed this step, any source. The returned refs
     * are the live objects also held by the per-command records, so repairing a
     * `hash` here (e.g. `reconcileManifestWithDisk` filling read hashes from
     * disk) propagates into the registration payload.
     */
    getTrackedInputs(): InputRef[] {
        return Array.from(this.inputAccesses.values());
    }

    /**
     * Drop an input ref from lineage entirely — removes it from the tracked-input
     * map and from every record's `inputs` array (identity match, since the refs
     * are shared objects). `reconcileManifestWithDisk` calls this for a read that
     * resolves to a directory (e.g. an `ls` / `list.files` of a mount): the
     * inotify frame tracks the open, but a directory is not a content-attestable
     * file artifact and must never reach registration. Mirrors the output-side
     * non-file drop.
     */
    dropInput(ref: InputRef): void {
        for (const [key, val] of this.inputAccesses) {
            if (val === ref) {
                this.inputAccesses.delete(key);
                break;
            }
        }
        const scrub = (rec: ProvenanceRecord): void => {
            if (rec.inputs.some((i) => i === ref)) {
                rec.inputs = rec.inputs.filter((i) => i !== ref);
            }
        };
        for (const rec of this.commandRecords.values()) scrub(rec);
        for (const rec of this.fileToolRecords.values()) scrub(rec);
    }

    /**
     * Get merged, deduplicated provenance records.
     * Command records win over file-tool records for the same output path.
     */
    getRecords(): ProvenanceRecord[] {
        const merged = new Map<string, ProvenanceRecord>(this.fileToolRecords);

        // Command records overwrite file-tool records (command overwrote the file)
        for (const [path, record] of this.commandRecords) {
            merged.set(path, record);
        }

        return Array.from(merged.values());
    }

    /** Remove any record (command or file-tool) for the given output path. */
    removeRecord(path: string): void {
        this.commandRecords.delete(path);
        this.fileToolRecords.delete(path);
    }

    /**
     * Replace the existing record for `record.outputPath` while preserving
     * last-write-wins ordering (command beats file-tool). If a command record
     * exists, the replacement overwrites it; otherwise the file-tool record
     * is overwritten. If neither exists, the replacement is stored as a
     * file-tool record so `getRecords()` surfaces it.
     */
    replaceRecord(record: ProvenanceRecord): void {
        if (this.commandRecords.has(record.outputPath)) {
            this.commandRecords.set(record.outputPath, record);
            return;
        }
        this.fileToolRecords.set(record.outputPath, record);
    }
}
