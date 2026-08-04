import type { ArtifactRegistrationInput, ArtifactRegistry, ExternalRegistrationResult } from "../../execution/artifact-registry.js";
import type { RunProvenanceEvent } from "../../workflows/execute-analysis.js";
import type { ArtifactManifestEntry } from "../../schemas/artifact-manifest.js";
import type { InputRef, Producer, ProvenanceRecord } from "../types.js";
import type { ProvDocumentModel } from "./document.js";
import type {
    ProvActor,
    ProvCommandInputRef,
    ProvCommandRef,
    ProvEvent,
    ProvFileKey,
    ProvFileRef,
    ProvModelId,
    ProvStepRef,
    ProvUsedInputRef,
} from "./types.js";

// The execution↔recorder provenance bridges: the two halves that connect the harness's execution
// machinery to the recorder's event vocabulary. This module is the ONLY place a run-engine
// artifact/input observation crosses into that vocabulary. It emits through the injected `emit`
// function and touches no storage, so the registry half satisfies the `ArtifactRegistry` seam's
// "MUST NOT touch cortex_artifacts" contract by construction — the harness owns that local-ledger
// write AROUND the seam, and writes the returned `externalId` back onto its row itself.
//
// The step-lifecycle split: the registry bridge emits COMMAND, FILE, and USED-INPUT events — the
// finer-grained command lineage plus per-file generations and per-input reads. Step activities
// (`step_completed`) come from the scheduler settlement via `createRunProvenanceEmitter` —
// registration is skipped entirely for a step with an empty reconciled manifest and never reached
// by a failed step, so it is NOT the site that observes every executed step.
//
// Producer grouping: the manifest entries are partitioned by their collector record's `producer`
// OBJECT reference into command/file-tool groups, with entries that have no record forming the
// LEAF bucket. The partition is exclusive by construction — a single record lookup decides each
// entry's bucket — which keeps a file from ever accruing two generation authorities (a command
// activity AND its step). Each group emits one `command_executed` followed by its `file_written`
// events with `generation: "command"`; leaf files emit `generation: "step"`, so the
// produced-vs-leaf decision rides the file event and the recorder never infers it across events.

export interface ProvBridgeDeps {
    /** Where events go — `recorder.record`, or a host transport that ends there. */
    readonly emit: (event: ProvEvent) => void;
    /** The responsible agent for execution records — the host's system actor. */
    readonly actor: () => ProvActor;
    /**
     * The id of the model driving the step agent — resolved at composition, so stamping the
     * construction-time id on every `command_executed` is exactly "the model this run's steps ran
     * on". It rides the event so the recorder never infers it across events; a host that swaps
     * models live rebuilds the bridge with the new id (in-flight work keeps its emitters).
     */
    readonly model: ProvModelId;
    /**
     * The SAME document model the recorder appends with — `externalId` values are its `fileQName`
     * derivations, so the returned identifiers always match the recorded document.
     */
    readonly documentModel: ProvDocumentModel;
}

/**
 * Strip the container mount prefix `/{resourceId}/` off a collector-recorded path, yielding its
 * analysis-relative form; a path not under that mount passes through unchanged. Container reads
 * and the recorded script line all arrive mount-absolute, so this is the single normalization
 * every path crosses before it seeds — or resolves against — a file QName.
 */
function stripContainerPrefix(path: string, resourceId: string): string {
    const prefix = `/${resourceId}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Scope a collector-recorded script path into the analysis-scoped file-QName space the group's
 * outputs live in. `inferScriptPath` records whatever token the command line carried — a
 * container-absolute `/{resourceId}/…`, an already analysis-rooted `runs/…`/`data/…`, or (the
 * common case, since the sandbox cwd is the step write dir) a step-relative `scripts/foo.py`.
 * Need not be exhaustive: an unresolvable result simply fails to match in the builder, which
 * skips it rather than minting a dangling entity.
 */
function scopeScriptPath(scriptPath: string, resourceId: string, runId: string, stepId: string): string {
    const stripped = stripContainerPrefix(scriptPath, resourceId);
    const analysisRooted = stripped.startsWith("runs/") || stripped.startsWith("data/") || stripped.startsWith("dataprofile/");
    return analysisRooted ? stripped : `runs/${runId}/${stepId}/${stripped}`;
}

/**
 * Map one command's per-command reads to command-scoped {@link ProvCommandInputRef}s in the shared
 * file-QName space. `data`/`upstream`/`prior` reads pass through with their `/{resourceId}/` mount
 * prefix stripped; a hash-less such ref is SKIPPED silently — the step-level `input_used` loop is
 * the site that reports it in `failed`, so failing it here too would double-count. An
 * `"artifacts"`-source read is the step's OWN prior output — the intra-step chain signal the
 * step-level registry drops as noise: it is included as `source: "step"` ONLY when its path names
 * a file THIS registration produces, keyed on the SURVIVING output hash (`producedHashByPath`),
 * NOT the read's own `ref.hash` — the collector is last-write-wins per path, so a self-read
 * recorded against an earlier revision would otherwise point its `used` edge at a `(path, hash)`
 * entity this registration never registers. Deduped by `(path, hash)`.
 */
function toCommandInputs(reads: readonly InputRef[], resourceId: string, producedHashByPath: ReadonlyMap<string, string>): ProvCommandInputRef[] {
    const seen = new Set<string>();
    const inputs: ProvCommandInputRef[] = [];
    for (const ref of reads) {
        const path = stripContainerPrefix(ref.path, resourceId);
        if (ref.source === "artifacts") {
            const producedHash = producedHashByPath.get(path);
            if (producedHash === undefined) continue;
            const dedupKey = `${path}|${producedHash}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            inputs.push({ path, hash: producedHash, source: "step", ...(ref.fileId !== undefined ? { fileId: ref.fileId } : {}) });
            continue;
        }
        const dedupKey = `${path}|${ref.hash}`;
        if (!ref.hash || seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        inputs.push({ path, hash: ref.hash, source: ref.source, ...(ref.fileId !== undefined ? { fileId: ref.fileId } : {}) });
    }
    return inputs;
}

/**
 * Build the {@link ProvCommandRef} for one producer group. A `command` producer carries the full
 * execution facts, the scoped `scriptPath`, the group's analysis-scoped `(path, hash)` outputs,
 * and its command-scoped inputs; a `file_tool` producer carries only the tool name and outputs.
 * The producer's observation `timestamp` is NEVER forwarded — it is re-minted on every DBOS replay
 * and would poison the document's replay-idempotency if it leaked into an identifier or formal
 * position.
 */
function toCommandRef(
    record: ProvenanceRecord,
    outputs: ProvFileKey[],
    resourceId: string,
    runId: string,
    stepId: string,
    producedHashByPath: ReadonlyMap<string, string>,
): ProvCommandRef {
    const producer: Producer = record.producer;
    if (producer.type === "file_tool") return { kind: "file_tool", tool: producer.tool, outputs };
    const scriptPath = record.scriptPath !== null ? scopeScriptPath(record.scriptPath, resourceId, runId, stepId) : undefined;
    return {
        kind: "command",
        command: producer.command,
        ...(producer.args !== undefined ? { args: producer.args } : {}),
        exitCode: producer.exitCode,
        ...(producer.durationMs !== undefined ? { durationMs: producer.durationMs } : {}),
        ...(scriptPath !== undefined ? { scriptPath } : {}),
        outputs,
        inputs: toCommandInputs(record.inputs, resourceId, producedHashByPath),
    };
}

/**
 * The recorder-adapter {@link ArtifactRegistry} — translates one step's registration into, per
 * producer group, one `command_executed` followed by that group's `file_written` events
 * (`generation: "command"`), then the leaf bucket's `file_written` events (`generation: "step"`),
 * then one `input_used` per tracked non-`"artifacts"` read. It returns the deterministic file
 * QNames as `externalId` so the local ledger gains a stable cross-reference into the signed
 * document, and does NOT emit `step_completed` (see the module note on the split).
 *
 * Three seam-contract facts shape the behavior:
 *
 *  1. The post-step pipeline fails a step ONLY when `failedCount > 0`. So a hash-less entry OR a
 *     hash-less input ref reported in `failed` will fail the step — which is intended (fail-fast
 *     attestation): reconcile rehashes entries and `fillInputHashesFromDisk` attests every input,
 *     so a missing hash is an upstream defect that must surface, not be papered over.
 *  2. The harness writes each `registered[].externalId` back onto its `cortex_artifacts` row keyed
 *     by `registered[].path`, and it only matches rows upserted under the analysis-scoped path
 *     `runs/{runId}/{stepId}/…`. The manifest entries arrive STEP-relative, so `path` is prefixed
 *     to that analysis-scoped form here — the event, the QName, and the write-back key are one
 *     string. Inputs are READS, not registered artifacts — they never enter `registered`.
 *  3. Tracked input refs and record inputs carry container-absolute paths (`/{resourceId}/…`).
 *     The step's own outputs re-surface as `source: "artifacts"` — skipped by the step-level
 *     registry but RESOLVED to a command-scoped `source: "step"` input; the rest strip the mount
 *     prefix — a `source: "prior"` read then keys onto the SAME file QName the producing run
 *     emitted, chaining lineage across runs for free.
 */
export function createProvenanceArtifactRegistry(deps: ProvBridgeDeps): ArtifactRegistry {
    const { emit, model, documentModel } = deps;
    return {
        register: async (input: ArtifactRegistrationInput): Promise<ExternalRegistrationResult> => {
            // One actor stamp for the whole step — the actor derivation is stable within a step,
            // so a single value across the step's events is identical to re-reading per event.
            const actor = deps.actor();
            const step: ProvStepRef = { runId: input.runId, stepId: input.stepId };
            // Manifest entries + collector output records both key on the STEP-relative path; scope
            // to the analysis-scoped form for the event, the QName seed, and the write-back key.
            const scopePath = (relativePath: string): string => `runs/${input.runId}/${input.stepId}/${relativePath}`;

            const recordByPath = new Map<string, ProvenanceRecord>();
            for (const rec of input.collector.getRecords()) recordByPath.set(rec.outputPath, rec);

            // The analysis-scoped path → surviving content hash of every file entity this
            // registration WILL register — the map an intra-step `"artifacts"` self-read resolves
            // against. Hash-less entries are excluded: they fail below and never register an
            // entity, so a read of one finds no key and is dropped rather than dangling.
            const producedHashByPath = new Map<string, string>();
            for (const entry of input.artifacts) if (entry.hash) producedHashByPath.set(scopePath(entry.path), entry.hash);

            // Partition: one lookup per entry buckets it by its record's `producer` OBJECT, or into
            // the leaf bucket when it has no record. Exclusive by construction, so a file can never
            // land in both a command group and the leaf bucket (which would write two
            // `wasGeneratedBy` edges for one entity). Insertion order is preserved for emission.
            const groups = new Map<Producer, { record: ProvenanceRecord; entries: ArtifactManifestEntry[] }>();
            const leaves: ArtifactManifestEntry[] = [];
            for (const entry of input.artifacts) {
                const rec = recordByPath.get(entry.path);
                if (rec === undefined) {
                    leaves.push(entry);
                    continue;
                }
                const group = groups.get(rec.producer);
                if (group !== undefined) group.entries.push(entry);
                else groups.set(rec.producer, { record: rec, entries: [entry] });
            }

            const registered: ExternalRegistrationResult["registered"] = [];
            const failed: ExternalRegistrationResult["failed"] = [];

            // Attest one manifest entry to a `ProvFileRef`, or record a fail-fast rejection and
            // return null. Reconcile rehashes every surviving entry from disk, so a missing/empty
            // hash past that point is an attestation-invariant violation. The producer joins from
            // the entry's record; a leaf (no record) falls back to "command" — an observed sandbox
            // write with no in-process producer record is by construction a command effect.
            const attest = (entry: ArtifactManifestEntry): ProvFileRef | null => {
                const path = scopePath(entry.path);
                if (!entry.hash) {
                    failed.push({ path, error: `missing content hash for ${path} — reconcile guarantees one, so its absence is an upstream defect` });
                    return null;
                }
                return { path, hash: entry.hash, size: entry.size, producer: recordByPath.get(entry.path)?.producer.type ?? "command" };
            };

            // Per producer group, in declaration-before-reference order: one `command_executed`,
            // then that group's `file_written` events flagged `generation: "command"`.
            for (const { record, entries } of groups.values()) {
                const files: ProvFileRef[] = [];
                for (const entry of entries) {
                    const file = attest(entry);
                    if (file !== null) files.push(file);
                }
                // A group whose every output failed attestation has no entity to anchor a command
                // activity's generation edges — skip it rather than mint a zero-output command.
                if (files.length === 0) continue;

                const outputs: ProvFileKey[] = files.map((f) => ({ path: f.path, hash: f.hash }));
                const command = toCommandRef(record, outputs, input.resourceId, input.runId, input.stepId, producedHashByPath);
                emit({ type: "command_executed", analysisId: input.resourceId, actor, step, command, model });
                for (const file of files) {
                    emit({ type: "file_written", analysisId: input.resourceId, actor, file, step, generation: "command" });
                    registered.push({ path: file.path, externalId: documentModel.fileQName(file) });
                }
            }

            // Leaf bucket: an observed write with no in-process producer record — no command
            // activity, so its generation edge falls to the step activity.
            for (const entry of leaves) {
                const file = attest(entry);
                if (file === null) continue;
                emit({ type: "file_written", analysisId: input.resourceId, actor, file, step, generation: "step" });
                registered.push({ path: file.path, externalId: documentModel.fileQName(file) });
            }

            // Step-level attested-input registry: container-absolute reads strip to
            // analysis-relative so a prior read lands in the producing file's QName space; the
            // step's own `"artifacts"` reads are skipped, and a hash-less ref fails the step.
            for (const ref of input.collector.getTrackedInputs()) {
                const source = ref.source;
                if (source === "artifacts") continue;

                const path = stripContainerPrefix(ref.path, input.resourceId);

                if (!ref.hash) {
                    failed.push({
                        path,
                        error: `missing content hash for input ${path} — fillInputHashesFromDisk attests every input upstream, so its absence is an upstream defect`,
                    });
                    continue;
                }

                const usedInput: ProvUsedInputRef = { path, hash: ref.hash, source, ...(ref.fileId !== undefined ? { fileId: ref.fileId } : {}) };
                emit({ type: "input_used", analysisId: input.resourceId, actor, step, input: usedInput });
            }

            return { registered, failed, failedCount: failed.length };
        },
        // No byte movement here: recording is this registry's whole job. A host that also syncs
        // artifact bytes composes this bridge with its own registry at the composition root.
        sync: async (): Promise<void> => {},
    };
}

/**
 * Realize the harness's optional `emitProvenance` dep: map each of the three run-lifecycle arms
 * onto a recorder event stamped with the host's system actor. This is the site that emits
 * `step_completed` (from the scheduler settlement — the only place every EXECUTED step is
 * observed), NOT the artifact registry above. `model` stamps `step_completed` only — the run arms
 * carry no model because model association is scoped to the step and command activities the model
 * drove.
 *
 * Every timestamp (`atMs`, `durationMs`) passes THROUGH from the event — the harness read them
 * from its checkpointed clock (`DBOS.now()`), replay-stable — so this mapping NEVER reads a
 * clock; doing so would diverge across replays and defeat the merge. The mapping is
 * fire-and-forget; the harness guards the call site so a throw here never fails the run.
 */
export function createRunProvenanceEmitter(deps: Pick<ProvBridgeDeps, "emit" | "actor" | "model">): (event: RunProvenanceEvent) => void {
    const { emit, actor, model } = deps;
    return (event: RunProvenanceEvent): void => {
        switch (event.type) {
            case "run_started":
                emit({
                    type: "run_started",
                    analysisId: event.analysisId,
                    actor: actor(),
                    run: { runId: event.runId, planSummary: event.planSummary, startedAtMs: event.atMs },
                });
                return;
            case "step_completed":
                emit({
                    type: "step_completed",
                    analysisId: event.analysisId,
                    actor: actor(),
                    model,
                    outcome: {
                        runId: event.runId,
                        stepId: event.stepId,
                        status: event.status,
                        completedAtMs: event.atMs,
                        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
                    },
                });
                return;
            case "run_completed":
                emit({
                    type: "run_completed",
                    analysisId: event.analysisId,
                    actor: actor(),
                    outcome: { runId: event.runId, status: event.status, completedAtMs: event.atMs, durationMs: event.durationMs },
                });
                return;
            default: {
                const never: never = event;
                throw new Error(`unhandled run provenance event: ${JSON.stringify(never)}`);
            }
        }
    };
}
