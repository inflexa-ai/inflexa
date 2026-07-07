import type { ArtifactRegistrationInput, ArtifactRegistry, ExternalRegistrationResult, RunProvenanceEvent } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { ProvCommandInputRef, ProvCommandRef, ProvFileKey, ProvFileRef, ProvStepRef, ProvUsedInputRef } from "../../types/prov.ts";
import { fileQName } from "../prov/document.ts";
import { systemActor } from "../prov/prov.ts";

// The cli↔harness provenance bridge: the two halves that connect the harness's execution machinery
// to the cli's signed provenance ledger, kept together because both translate harness execution
// facts into `prov.*` bus events and nothing else. The recorder (`modules/prov/prov.ts`) subscribes
// to those events and appends to the in-memory tsprov document.
//
// This module is the ONLY place a run-engine artifact/input observation crosses into the cli's
// provenance vocabulary. It imports nothing DB-related: it only emits bus events, so it satisfies
// the `ArtifactRegistry` seam's "MUST NOT touch cortex_artifacts" contract by construction — the
// harness owns that local-ledger write AROUND this seam, and writes the returned `externalId` back
// onto its row itself.
//
// The step-lifecycle split: this adapter emits COMMAND, FILE, and USED-INPUT events — the finer-grained
// command lineage plus per-file generations and per-input reads. Step activities (`prov.step_completed`)
// come from the harness's scheduler settlement via `createRunProvenanceEmitter` below — registration is
// skipped entirely for a step with an empty reconciled manifest and never reached by a failed step, so
// it is NOT the site that observes every executed step.
//
// Producer grouping (design D5): the manifest entries are partitioned by their collector record's
// `producer` OBJECT reference (mirroring the reference implementation's per-execution grouping) into
// command/file-tool groups, with entries that have no record forming the LEAF bucket. The partition is
// exclusive by construction — a single record lookup decides each entry's bucket — which keeps a file
// from ever accruing two generation authorities (a command activity AND its step). Each group emits one
// `prov.command_executed` followed by its `prov.file_written` events with `generation: "command"`; leaf
// files emit `generation: "step"`, so the produced-vs-leaf decision rides the file event and the
// recorder never infers it across events. Files, command-scoped inputs, and command activities all
// originate here; step lifecycle stays at the scheduler.

// A collector record (`getRecords()` element), its `producer` object (the grouping key), and its
// per-command `inputs` — derived off the already-imported `ArtifactRegistrationInput` because the
// harness barrel does not re-export `ProvenanceRecord`/`Producer`/`InputRef`. Deriving pins the bridge
// to the exact seam shape without reaching for a fragile deep-subpath import.
type CollectorRecord = ReturnType<ArtifactRegistrationInput["collector"]["getRecords"]>[number];
type CollectorProducer = CollectorRecord["producer"];
type CollectorInputRef = CollectorRecord["inputs"][number];
type ManifestEntry = ArtifactRegistrationInput["artifacts"][number];

/**
 * Strip the container mount prefix `/{resourceId}/` off a collector-recorded path, yielding its
 * analysis-relative form; a path not under that mount (already analysis-rooted, or otherwise) passes
 * through unchanged. Container reads and the recorded script line all arrive mount-absolute, so this is
 * the single normalization every path crosses before it seeds — or resolves against — a file QName.
 */
function stripContainerPrefix(path: string, resourceId: string): string {
    const prefix = `/${resourceId}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Scope a collector-recorded script path into the analysis-scoped file-QName space the group's outputs
 * live in, so the document builder can resolve it against an already-registered output/input entity.
 * `inferScriptPath` (harness collector) records whatever token the command line carried — a
 * container-absolute `/{resourceId}/…`, an already analysis-rooted `runs/…`/`data/…`, or (the common
 * case, since the sandbox cwd is the step write dir) a step-relative `scripts/foo.py`. Strip the
 * container prefix, then prefix a step-relative remainder with `runs/{runId}/{stepId}/`; a path already
 * rooted at a resource-tree dir passes through. Need not be exhaustive: an unresolvable result simply
 * fails to match in the builder, which skips it rather than minting a dangling entity.
 */
function scopeScriptPath(scriptPath: string, resourceId: string, runId: string, stepId: string): string {
    const stripped = stripContainerPrefix(scriptPath, resourceId);
    const analysisRooted = stripped.startsWith("runs/") || stripped.startsWith("data/") || stripped.startsWith("dataprofile/");
    return analysisRooted ? stripped : `runs/${runId}/${stepId}/${stripped}`;
}

/**
 * Map one command's per-command reads to command-scoped {@link ProvCommandInputRef}s in the shared
 * file-QName space (design D4). `data`/`upstream`/`prior` reads pass through with their `/{resourceId}/`
 * mount prefix stripped to analysis-relative; a hash-less such ref is SKIPPED silently — it is attested
 * upstream and the step-level `prov.input_used` loop is the site that reports it in `failed`, so failing
 * it here too would double-count. An `"artifacts"`-source read is the step's OWN prior output — the
 * intra-step chain signal the step-level registry drops as noise: it is stripped to its analysis-scoped
 * `runs/{runId}/{stepId}/…` form and included as `source: "step"` ONLY when that path names a file THIS
 * registration produces. The edge is keyed on the SURVIVING output hash (`producedHashByPath`), NOT the
 * read's own `ref.hash`: the collector is last-write-wins per path, so a self-read recorded against an
 * earlier revision of the file (or with no hash at all — `fillInputHashesFromDisk` skips artifacts
 * reads) would otherwise point its `used` edge at a `(path, hash)` entity this registration never
 * registers. Resolving to the registered hash makes the edge land on a real entity by construction; a
 * read of a written-then-deleted phantom (path absent from the map) is dropped. Deduped by
 * `(path, hash)` so a repeated open or a script re-read collapses to one edge.
 */
function toCommandInputs(reads: readonly CollectorInputRef[], resourceId: string, producedHashByPath: ReadonlyMap<string, string>): ProvCommandInputRef[] {
    const seen = new Set<string>();
    const inputs: ProvCommandInputRef[] = [];
    for (const ref of reads) {
        const path = stripContainerPrefix(ref.path, resourceId);
        if (ref.source === "artifacts") {
            // Key the self-read on the entity THIS registration will register (surviving output hash),
            // not the replay/rewrite-fragile read-time hash — see the JSDoc.
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
 * execution facts (`command`/`args`/`exitCode`/`durationMs`), the scoped `scriptPath`, the group's
 * analysis-scoped `(path, hash)` outputs, and its command-scoped inputs; a `file_tool` producer carries
 * only the tool name and outputs (agent-authored content has no reads, by construction). The producer's
 * observation `timestamp` is NEVER forwarded — it is re-minted on every DBOS replay and would poison the
 * document's replay-idempotency if it leaked into an identifier or formal position (design D1).
 */
function toCommandRef(
    record: CollectorRecord,
    outputs: ProvFileKey[],
    resourceId: string,
    runId: string,
    stepId: string,
    producedHashByPath: ReadonlyMap<string, string>,
): ProvCommandRef {
    const producer = record.producer;
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
 * The bus-adapter {@link ArtifactRegistry} — translates one step's registration into, per producer group,
 * one `prov.command_executed` followed by that group's `prov.file_written` events (`generation:
 * "command"`), then the leaf bucket's `prov.file_written` events (`generation: "step"`), then one
 * `prov.input_used` per tracked non-`"artifacts"` read. It returns the deterministic file QNames so the
 * harness can cross-reference its local ledger into the signed document, and does NOT emit
 * `prov.step_completed` (see the module note on the split and the producer grouping).
 *
 * Three seam-contract facts shape the behavior:
 *
 *  1. The harness's post-step pipeline fails a step ONLY when `failedCount > 0`
 *     (`execution/post-step-pipeline.ts`). So a hash-less entry OR a hash-less input ref reported in
 *     `failed` will fail the step — which is intended (fail-fast attestation), because reconcile
 *     rehashes entries and `fillInputHashesFromDisk` attests every input, so a missing hash is an
 *     upstream defect that must surface, not be papered over with a sentinel.
 *  2. The harness writes each `registered[].externalId` back onto its `cortex_artifacts` row keyed
 *     by `registered[].path`, and it only matches rows it upserted under the analysis-scoped path
 *     `runs/{runId}/{stepId}/…` (`execution/artifact-registration.ts`). The manifest entries arrive
 *     STEP-relative (`output/results.csv`), so `path` is prefixed to that analysis-scoped form here —
 *     otherwise the write-back silently no-ops and two steps writing the same relative path would
 *     collide onto one file entity. The same analysis-scoped path seeds the file QName, so the
 *     event, the QName, and the write-back key are one string. Inputs are READS, not registered
 *     artifacts — they carry no `externalId` and never enter `registered`.
 *  3. Tracked input refs (`getTrackedInputs()`) and record inputs carry container-absolute paths
 *     (`/{resourceId}/…`). The step's own outputs re-surface as `source: "artifacts"` — skipped by the
 *     step-level registry (mirroring `fillInputHashesFromDisk`'s reconcile-time skip) but RESOLVED to a
 *     command-scoped `source: "step"` input; the rest strip the mount prefix to analysis-relative — a
 *     `source: "prior"` read then keys onto the SAME file QName the producing run emitted, chaining
 *     lineage across runs for free.
 */
export function createBusArtifactRegistry(): ArtifactRegistry {
    return {
        register: async (input: ArtifactRegistrationInput): Promise<ExternalRegistrationResult> => {
            // One actor stamp for the whole step — `systemActor()` is pure over pkg version + build
            // commit, so a single value across the step's events is identical to re-reading per event.
            const actor = systemActor();
            const step: ProvStepRef = { runId: input.runId, stepId: input.stepId };
            // Manifest entries + collector output records both key on the STEP-relative path; scope to the
            // analysis-scoped form for the event, the QName seed, and the ledger write-back key (fact #2).
            const scopePath = (relativePath: string): string => `runs/${input.runId}/${input.stepId}/${relativePath}`;

            // The collector keys its records by STEP-relative output path — the same shape the manifest
            // entry arrives in — so the record lookup happens on the raw `entry.path`, before scoping.
            const recordByPath = new Map<string, CollectorRecord>();
            for (const rec of input.collector.getRecords()) recordByPath.set(rec.outputPath, rec);

            // The analysis-scoped path → surviving content hash of every file entity this registration
            // WILL register — the map an intra-step `"artifacts"` self-read resolves against (design D4),
            // keying its `used` edge onto the hash actually registered rather than the read's own. Hash-
            // less entries are excluded: they fail below and never register an entity, so a read of one
            // finds no key and is dropped rather than dangling.
            const producedHashByPath = new Map<string, string>();
            for (const entry of input.artifacts) if (entry.hash) producedHashByPath.set(scopePath(entry.path), entry.hash);

            // Partition (design D5): one lookup per entry buckets it by its record's `producer` OBJECT, or
            // into the leaf bucket when it has no record. Exclusive by construction — this single get()
            // decides — so a file can never land in both a command group and the leaf bucket (which would
            // write two `wasGeneratedBy` edges for one entity). Insertion order is preserved for emission.
            const groups = new Map<CollectorProducer, { record: CollectorRecord; entries: ManifestEntry[] }>();
            const leaves: ManifestEntry[] = [];
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

            // Attest one manifest entry to a `ProvFileRef`, or record a fail-fast rejection and return
            // null. Reconcile rehashes every surviving entry from disk, so a missing/empty hash past that
            // point is an attestation-invariant violation, not a routine case. The producer joins from the
            // entry's record; a leaf (no record) falls back to "command" — an observed sandbox write with
            // no in-process producer record (inotify-only observation) is by construction a command effect.
            const attest = (entry: ManifestEntry): ProvFileRef | null => {
                const path = scopePath(entry.path);
                if (!entry.hash) {
                    failed.push({ path, error: `missing content hash for ${path} — reconcile guarantees one, so its absence is an upstream defect` });
                    return null;
                }
                return { path, hash: entry.hash, size: entry.size, producer: recordByPath.get(entry.path)?.producer.type ?? "command" };
            };

            // Per producer group, in declaration-before-reference order: one `prov.command_executed`, then
            // that group's `prov.file_written` events flagged `generation: "command"` — their generation
            // edge is the command activity's, not the step's.
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
                Bus.emit("inflexa", { type: "prov.command_executed", analysisId: input.resourceId, actor, step, command });
                for (const file of files) {
                    Bus.emit("inflexa", { type: "prov.file_written", analysisId: input.resourceId, actor, file, step, generation: "command" });
                    registered.push({ path: file.path, externalId: fileQName(file) });
                }
            }

            // Leaf bucket: an observed write with no in-process producer record — no command activity, so
            // its generation edge falls to the step activity (`generation: "step"`, today's fallback path).
            for (const entry of leaves) {
                const file = attest(entry);
                if (file === null) continue;
                Bus.emit("inflexa", { type: "prov.file_written", analysisId: input.resourceId, actor, file, step, generation: "step" });
                registered.push({ path: file.path, externalId: fileQName(file) });
            }

            // Step-level attested-input registry: container-absolute reads strip to analysis-relative so a
            // prior read lands in the producing file's QName space (fact #3); the step's own `"artifacts"`
            // reads are skipped, and a hash-less ref fails the step.
            for (const ref of input.collector.getTrackedInputs()) {
                // The step's own outputs re-surface here as reads; skip them, mirroring reconcile's skip.
                const source = ref.source;
                if (source === "artifacts") continue;

                const path = stripContainerPrefix(ref.path, input.resourceId);

                // `fillInputHashesFromDisk` fails the step on an unattestable input, so a hash-less ref
                // here is an upstream defect — fail registration rather than record a non-attested read.
                if (!ref.hash) {
                    failed.push({
                        path,
                        error: `missing content hash for input ${path} — fillInputHashesFromDisk attests every input upstream, so its absence is an upstream defect`,
                    });
                    continue;
                }

                const usedInput: ProvUsedInputRef = { path, hash: ref.hash, source, ...(ref.fileId !== undefined ? { fileId: ref.fileId } : {}) };
                Bus.emit("inflexa", { type: "prov.input_used", analysisId: input.resourceId, actor, step, input: usedInput });
            }

            return { registered, failed, failedCount: failed.length };
        },
        // No-op: the artifact bytes already live on the host session tree, so there is nothing to push
        // to permanent storage (the managed adapter uploads them; the local host does not).
        sync: async (): Promise<void> => {},
    };
}

/**
 * Realize the harness's optional `emitProvenance` dep as bus emission: map each of the three
 * run-lifecycle arms onto a `prov.*` event stamped with the system actor (cli version + commit).
 * This is the site that emits `prov.step_completed` (from the scheduler-settlement `step_completed`
 * arm — the only place every EXECUTED step is observed), NOT the artifact registry above.
 *
 * The harness-supplied `analysisId` passes through unchanged — it equals the cli `analysisId` by the
 * trigger contract, and the recorder silently drops unknown ids. Every timestamp (`atMs`,
 * `durationMs`) passes THROUGH from the event — the harness read them from its checkpointed clock
 * (`DBOS.now()`), replay-stable — so this mapping NEVER reads a clock; doing so would diverge across
 * replays and defeat the merge. The mapping is fire-and-forget; the harness guards the call site so a
 * throw here never fails the run.
 */
export function createRunProvenanceEmitter(): (event: RunProvenanceEvent) => void {
    return (event: RunProvenanceEvent): void => {
        switch (event.type) {
            case "run_started":
                Bus.emit("inflexa", {
                    type: "prov.run_started",
                    analysisId: event.analysisId,
                    actor: systemActor(),
                    run: { runId: event.runId, planSummary: event.planSummary, startedAtMs: event.atMs },
                });
                return;
            case "step_completed":
                Bus.emit("inflexa", {
                    type: "prov.step_completed",
                    analysisId: event.analysisId,
                    actor: systemActor(),
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
                Bus.emit("inflexa", {
                    type: "prov.run_completed",
                    analysisId: event.analysisId,
                    actor: systemActor(),
                    outcome: { runId: event.runId, status: event.status, completedAtMs: event.atMs, durationMs: event.durationMs },
                });
                return;
            default: {
                // Exhaustiveness: a new RunProvenanceEvent variant must add its mapping here.
                const never: never = event;
                throw new Error(`unhandled run provenance event: ${JSON.stringify(never)}`);
            }
        }
    };
}
