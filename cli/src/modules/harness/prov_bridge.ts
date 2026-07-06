import type { ArtifactRegistrationInput, ArtifactRegistry, ExternalRegistrationResult, RunProvenanceEvent } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { ProvFileRef, ProvStepRef, ProvUsedInputRef } from "../../types/prov.ts";
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
// The step-lifecycle split: this adapter emits FILE and USED-INPUT events only. Step activities
// (`prov.step_completed`) come from the harness's scheduler settlement via `createRunProvenanceEmitter`
// below — registration is skipped entirely for a step with an empty reconciled manifest and never
// reached by a failed step, so it is NOT the site that observes every executed step.

/**
 * The bus-adapter {@link ArtifactRegistry} — translates one step's registration into one
 * `prov.file_written` per manifest entry plus one `prov.input_used` per tracked input read, and
 * returns the deterministic file QNames so the harness can cross-reference its local ledger into the
 * signed document. It does NOT emit `prov.step_completed` (see the module note on the split).
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
 *  3. Tracked input refs (`getTrackedInputs()`) carry container-absolute paths (`/{resourceId}/…`).
 *     The step's own outputs re-surface as `source: "artifacts"` and are skipped (mirroring
 *     `fillInputHashesFromDisk`'s reconcile-time skip); the rest strip the mount prefix to
 *     analysis-relative — a `source: "prior"` read then keys onto the SAME file QName the producing
 *     run emitted, chaining lineage across runs for free.
 */
export function createBusArtifactRegistry(): ArtifactRegistry {
    return {
        register: async (input: ArtifactRegistrationInput): Promise<ExternalRegistrationResult> => {
            // One actor stamp for the whole step — `systemActor()` is pure over pkg version + build
            // commit, so a single value across the step's events is identical to re-reading per event.
            const actor = systemActor();
            const step: ProvStepRef = { runId: input.runId, stepId: input.stepId };

            // The collector keys its records by STEP-relative output path — the same shape the manifest
            // entry arrives in — so the producer join happens on the raw `entry.path`, before scoping.
            const producerByPath = new Map<string, ProvFileRef["producer"]>();
            for (const rec of input.collector.getRecords()) {
                producerByPath.set(rec.outputPath, rec.producer.type);
            }

            const registered: ExternalRegistrationResult["registered"] = [];
            const failed: ExternalRegistrationResult["failed"] = [];

            for (const entry of input.artifacts) {
                const path = `runs/${input.runId}/${input.stepId}/${entry.path}`;

                // Reconcile rehashes every surviving entry from disk, so a missing/empty hash past that
                // point is an attestation invariant violation, not a routine case — report it as a
                // registration failure (fail-fast) rather than emit a file we cannot content-attest.
                if (!entry.hash) {
                    failed.push({ path, error: `missing content hash for ${path} — reconcile guarantees one, so its absence is an upstream defect` });
                    continue;
                }

                // Fallback to "command": an observed sandbox write with no in-process producer record
                // (inotify-only observation) is by construction a command effect, not a file-tool write.
                const producer = producerByPath.get(entry.path) ?? "command";
                const file: ProvFileRef = { path, hash: entry.hash, size: entry.size, producer };
                // Emitting at REGISTRATION (not at sandbox write time) mirrors the reference
                // implementation (Cortex `registerStepArtifacts` → Nexus structured payload):
                // registration is the attestation boundary — reconcile has just rehashed the
                // surviving bytes from disk, whereas write-TIME observations are collector-internal
                // because frame-time hashes are racy and write-then-delete leaves phantoms. This
                // event covers step OUTPUTS only (Nexus: output files + generation edges); input
                // reads ride `prov.input_used` below (Nexus: `type:"input"` references + used
                // edges) and are never `file_written`.
                Bus.emit("inflexa", { type: "prov.file_written", analysisId: input.resourceId, actor, file, step });
                registered.push({ path, externalId: fileQName(file) });
            }

            // Container-absolute input paths (`/{resourceId}/…`) strip to analysis-relative so a prior
            // read lands in the producing file's QName space (see fact #3).
            const inputPrefix = `/${input.resourceId}/`;
            for (const ref of input.collector.getTrackedInputs()) {
                // The step's own outputs re-surface here as reads; skip them, mirroring reconcile's skip.
                const source = ref.source;
                if (source === "artifacts") continue;

                const path = ref.path.startsWith(inputPrefix) ? ref.path.slice(inputPrefix.length) : ref.path;

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
