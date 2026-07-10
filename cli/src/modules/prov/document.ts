import { randomUUIDv7 } from "bun";
import { type Result, ok, err } from "neverthrow";
import { ProvDocument, type BuiltinProvFormat, type UnifiedOptions } from "@inflexa-ai/tsprov";
import type { Analysis } from "../../types/analysis.ts";
import type {
    ProvActor,
    ProvInputRef,
    ProvModelId,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepRef,
    ProvStepOutcome,
    ProvUsedInputRef,
    ProvFileRef,
    ProvFileKey,
    ProvCommandRef,
} from "../../types/prov.ts";
import type { IdOrName } from "../../lib/types.ts";
import type { DbError } from "../../db/errors.ts";
import { getAnalysisProvenance, findAnalysesByRef } from "../../db/primary_query.ts";

// The tsprov-facing layer: seeding, appending to, and serializing an analysis's PROV document. The
// `@inflexa-ai/tsprov` dependency is confined to this file — the recorder (`prov.ts`) and the export
// action drive provenance through these functions, so a tsprov fault is contained to provenance.
//
// The document is built INCREMENTALLY (one append per recorded action) rather than projected in a
// batch: it lives in memory while an analysis is open and is reloaded from its serialized form on
// reopen. Records that recur across actions (the same agent, the same input across add+remove) are
// deliberately NOT de-duplicated at append time — tsprov's `_idMap` tolerates duplicate identifiers
// and the caller collapses them with `unified()` at serialize time (see prov.ts flush + B decision).

/** The namespace every inflexa-minted PROV identifier lives under. */
const NS_PREFIX = "inflexa";
const NS_URI = "https://inflexa.ai/prov#";

/**
 * The merge policy every persist/export `unified()` uses: LAST-write-wins. A DBOS recovery replay
 * re-emits byte-identical execution records (times are checkpointed `DBOS.now()` reads), so last==first
 * and they dedupe; a budget-pause that later RESUMES to completion re-declares the run/step activity
 * with a genuinely newer terminal outcome, which must SUPERSEDE the earlier one. `formalAttributeConflict:
 * "last"` resolves the formal `prov:endTime`; `singleValued` extends the same last-wins to the custom
 * terminal attributes, which would otherwise union into a contradictory multi-value (`["canceled",
 * "completed"]`). Kept in one place so the flush (prov.ts) and the export path below agree on the survivor.
 */
export const PROV_UNIFY_OPTIONS: UnifiedOptions = {
    formalAttributeConflict: "last",
    singleValued: [`${NS_PREFIX}:status`, `${NS_PREFIX}:durationMs`],
};

/** Replace every character a PROV qualified-name localpart disallows, so any string can seed an identifier. */
function qnameSafe(s: string): string {
    return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** The analysis's PROV subject-entity QName — the document's subject, related to by every action. */
function analysisQName(analysisId: string): string {
    return `${NS_PREFIX}:analysis-${analysisId}`;
}

/** A stable input-entity QName keyed by (source anchor, path), so an add and its later removal touch the same entity. */
function inputQName(input: ProvInputRef): string {
    const key = `${input.anchorId ?? ""}|${input.path}`;
    return `${NS_PREFIX}:input-${Bun.hash(key).toString(36)}`;
}

/** Declare (re-declare) the responsible agent on `doc`, returning its QName. Re-declaration is fine — `unified()` collapses it later. */
function appendAgent(doc: ProvDocument, actor: ProvActor): string {
    switch (actor.kind) {
        case "user": {
            const qn = `${NS_PREFIX}:agent-user-${qnameSafe(actor.email)}`;
            doc.agent(qn, { "prov:type": "prov:Person", "inflexa:email": actor.email });
            return qn;
        }
        case "anonymous": {
            const qn = `${NS_PREFIX}:agent-anonymous`;
            doc.agent(qn, { "prov:type": "prov:Person", "prov:label": "Anonymous user" });
            return qn;
        }
        case "system": {
            const qn = `${NS_PREFIX}:agent-system`;
            doc.agent(qn, {
                "prov:type": "prov:SoftwareAgent",
                "prov:label": "inflexa cli",
                "inflexa:version": actor.version,
                "inflexa:commit": actor.commit,
            });
            return qn;
        }
        default: {
            // Exhaustiveness: a new actor kind must declare its agent here.
            const never: never = actor;
            throw new Error(`unhandled actor kind: ${String(never)}`);
        }
    }
}

/** Declare (re-declare) an input entity on `doc`, returning its QName. */
function appendInput(doc: ProvDocument, input: ProvInputRef): string {
    const qn = inputQName(input);
    doc.entity(qn, { "prov:type": "inflexa:Input", "inflexa:path": input.path, "inflexa:isDir": input.isDir });
    return qn;
}

/** A fresh provenance document for an analysis: the namespace plus the subject entity. Actions append onto this; reopening deserializes the stored form instead. */
export function freshDocument(analysis: Analysis): ProvDocument {
    const doc = new ProvDocument();
    doc.addNamespace(NS_PREFIX, NS_URI);
    doc.entity(analysisQName(analysis.id), { "prov:type": "inflexa:Analysis", "inflexa:name": analysis.name, "inflexa:slug": analysis.slug });
    return doc;
}

/** Reconstruct an analysis's live document from its stored PROV-JSON, or seed a fresh one when nothing is stored yet. */
export function loadDocument(analysis: Analysis, storedJson: string | null): Result<ProvDocument, { type: "prov_corrupt"; cause: unknown }> {
    if (!storedJson) return ok(freshDocument(analysis));
    try {
        return ok(ProvDocument.deserialize(storedJson, "json"));
    } catch (cause) {
        return err({ type: "prov_corrupt" as const, cause });
    }
}

// The analysis-lifecycle builders (create / add-input / remove-input) each mint a fresh action
// activity stamped at append time — one distinct activity per genuinely distinct user action. The
// execution builders (run / step / file) instead key off deterministic QNames so DBOS workflow
// re-execution on recovery re-emits the same records and unified() dedups them; they share only the
// preamble below and never mint a random-UUID action (which would defeat that idempotency). The
// analysis subject is assumed already present (declared by freshDocument or the deserialized doc).

/**
 * The preamble every builder shares: declare (re-declare) the responsible agent and stamp the
 * occurrence time, returning the analysis subject QName alongside. It mints NO activity — the
 * caller owns its own node (a deterministic execution QName, or `startAction`'s random action).
 */
function recordPreamble(doc: ProvDocument, analysisId: string, actor: ProvActor): { analysisQn: string; agentQn: string; time: string } {
    const analysisQn = analysisQName(analysisId);
    const time = new Date().toISOString();
    const agentQn = appendAgent(doc, actor);
    return { analysisQn, agentQn, time };
}

function startAction(
    doc: ProvDocument,
    analysisId: string,
    activityType: string,
    actor: ProvActor,
): { analysisQn: string; actionQn: string; time: string; agentQn: string } {
    const { analysisQn, agentQn, time } = recordPreamble(doc, analysisId, actor);
    const actionQn = `${NS_PREFIX}:action-${randomUUIDv7()}`;
    doc.activity(actionQn, time, time, { "prov:type": activityType });
    doc.wasAssociatedWith(actionQn, agentQn);
    return { analysisQn, actionQn, time, agentQn };
}

/** Append the PROV records for an analysis creation: the subject was generated by and attributed to the actor. */
export function appendCreation(doc: ProvDocument, analysisId: string, actor: ProvActor): void {
    const { analysisQn, actionQn, time, agentQn } = startAction(doc, analysisId, "inflexa:CreateAnalysis", actor);
    doc.wasGeneratedBy(analysisQn, actionQn, time);
    doc.wasAttributedTo(analysisQn, agentQn);
}

/** Append the PROV records for an input addition: the action used the input, and the analysis derives from it. */
export function appendInputAdded(doc: ProvDocument, analysisId: string, actor: ProvActor, input: ProvInputRef, derivedFromAnalysisId: string | null): void {
    const { analysisQn, actionQn, time, agentQn } = startAction(doc, analysisId, "inflexa:AddInput", actor);
    const inputQn = appendInput(doc, input);
    doc.used(actionQn, inputQn, time);
    doc.wasAttributedTo(inputQn, agentQn);
    doc.wasDerivedFrom(analysisQn, inputQn);
    if (derivedFromAnalysisId) doc.wasDerivedFrom(inputQn, analysisQName(derivedFromAnalysisId));
}

/** Append the PROV records for an input removal: the input was invalidated by the action. */
export function appendInputRemoved(doc: ProvDocument, analysisId: string, actor: ProvActor, input: ProvInputRef): void {
    const { actionQn, time } = startAction(doc, analysisId, "inflexa:RemoveInput", actor);
    const inputQn = appendInput(doc, input);
    doc.wasInvalidatedBy(inputQn, actionQn, time);
}

// The execution builders below use content-deterministic QNames (not random per-event ids) so a run
// completing on a later boot's DBOS recovery re-emits identical records, and unified() collapses the
// re-emission to one record set per QName. Runs and steps are PROV activities; files are entities.
//
// The RELATIONS these builders emit carry deterministic identifiers too — a subtler requirement than
// the element QNames. unified() dedups by identifier ONLY: an anonymous relation never enters
// tsprov's `_idMap` (verified against bundle.ts `unifiedRecords`/`addRecordInternal`), so a
// re-emitted anonymous relation DUPLICATES instead of merging, even when byte-identical. Each id is
// derived from the relation's FULL formal endpoint tuple — the run/step/file key, plus a hash of the
// AGENT QName for agent-bearing relations (whose agent endpoint can differ when a recovery re-derives
// the actor, e.g. across a cli upgrade). Keying on less than the full tuple would let two same-id
// records disagree on a formal endpoint and re-trigger unified()'s single-value throw — the failure
// class `occurrenceTime` guards against. The `time` argument is omitted from every identified
// relation for that same reason: two same-id relations with differing formal times throw on merge,
// and the occurrence times already live on the run/step activities — so re-emission merges cleanly
// (identical formals → tsprov keeps one).

/** The run-activity QName — one activity per run regardless of how many events reference it (start + completion re-declare the same id). */
function runQName(runId: string): string {
    return `${NS_PREFIX}:run-${runId}`;
}

/** The step-activity QName, keyed by `(runId, stepId)` so each step is a distinct activity a file generation can reference. */
function stepQName(step: ProvStepRef): string {
    return `${NS_PREFIX}:step-${step.runId}-${step.stepId}`;
}

// These digests are PROV QName IDENTITY derivations over domain tuples, not content
// hashing — `lib/hash.ts` owns generic content hashes (`sha256File`); these values are
// meaningless outside this module's QName scheme, so they stay beside the QName builders
// that consume them (see `fileDigest` for why the shared derivation must not drift).

/**
 * The `(path, content hash)` digest that suffixes the file entity's QName. Factored out because a
 * file's execution relations (`gen`/`attr`/`deriv` ids below) reuse this exact suffix, so the two
 * derivations stay in one place — the file QName and its relation ids never drift apart. Typed on
 * the structural `(path, hash)` pick, not `ProvFileRef`, so an INPUT read (`ProvUsedInputRef`, which
 * carries no size/producer) keys into the same space as the output it reads — that shared key is
 * what merges a `source: "prior"` read onto its producing file's entity under `unified()`.
 */
function fileDigest(file: Pick<ProvFileRef, "path" | "hash">): string {
    return Bun.hash(`${file.path}|${file.hash}`).toString(36);
}

/** A short stable hash of an agent QName, folded into an agent-bearing relation's id (see the execution-builders note). */
function agentDigest(agentQn: string): string {
    return Bun.hash(agentQn).toString(36);
}

/**
 * The model-agent QName, keyed by the verbatim model id — one agent per distinct id, nothing else
 * in the identity (the id is opaque; see {@link ProvModelId}). Exported (like {@link fileQName} /
 * {@link commandQName}) so the builder's tests reference the one canonical derivation rather than
 * duplicating this hash and risking drift.
 */
export function modelAgentQName(model: ProvModelId): string {
    return `${NS_PREFIX}:agent-model-${Bun.hash(model).toString(36)}`;
}

/**
 * Declare (re-declare) the model agent for `model` — the LLM that reasoned about a model-driven
 * activity — plus its delegation to the event's responsible agent, plus its association with the
 * driven activity. The association id is `{assocIdBase}-{agentDigest(modelQn)}` — the SAME base the
 * caller's actor association uses, disambiguated by the agent digest — owned here so the "two
 * associations share one id template" invariant that makes re-emission dedup work lives in one
 * place, not in per-caller copies. The delegation reads `actedOnBehalfOf(model, responsible)`: the
 * CLI is the agent the user directed; the model acted on its behalf. Its id is keyed on both agent
 * digests (activity-independent — the delegation holds for the pair, not per activity), so
 * re-declaration across activities and DBOS re-execution collapses under `unified()`. A recovery
 * boot that auto-resolves a DIFFERENT default model re-emits under a second agent + delegation —
 * the same honest-drift semantics the agent-digest fold already accepts for a cli upgrade mid-run.
 */
function appendModelAgent(doc: ProvDocument, model: ProvModelId, responsibleQn: string, activityQn: string, assocIdBase: string): void {
    const qn = modelAgentQName(model);
    doc.agent(qn, {
        // Both types deliberately: `prov:SoftwareAgent` places it in PROV's agent taxonomy,
        // `inflexa:Model` marks WHAT KIND of software agent (tsprov attributes are multi-valued).
        // The id is the agent's ONLY identity attribute — provenance stays model-agnostic by
        // carrying no provider/vendor vocabulary of its own (see {@link ProvModelId}).
        "prov:type": ["prov:SoftwareAgent", `${NS_PREFIX}:Model`],
        "prov:label": model,
        "inflexa:model": model,
    });
    doc.actedOnBehalfOf(qn, responsibleQn, undefined, `${NS_PREFIX}:delegation-${agentDigest(qn)}-${agentDigest(responsibleQn)}`);
    doc.wasAssociatedWith(activityQn, qn, undefined, `${assocIdBase}-${agentDigest(qn)}`);
}

/**
 * The file-entity QName, keyed by `(path, content hash)` so re-writing identical bytes to a path
 * dedups to one entity. Exported because the harness bridge (`prov_bridge.ts`) returns this same
 * QName as the artifact's `externalId`, giving the harness's local `cortex_artifacts` row a stable
 * cross-reference into the signed document — so the derivation must live in one place, not be
 * duplicated at the bridge. Typed on the `(path, hash)` pick so both an output and an input read of
 * the same bytes resolve to one QName.
 */
export function fileQName(file: Pick<ProvFileRef, "path" | "hash">): string {
    return `${NS_PREFIX}:file-${fileDigest(file)}`;
}

/**
 * The digest that keys a command group — a `Bun.hash` over the group's per-output `(path, hash)`
 * digests, SORTED and joined with `|`. It suffixes both the command-activity QName and every
 * command-relation id, so re-emission of the same group lands on the same identifiers and `unified()`
 * collapses it. Factored beside {@link commandQName} so the group key has one derivation.
 */
function commandGroupDigest(outputs: ProvFileKey[]): string {
    return Bun.hash(outputs.map(fileDigest).sort().join("|")).toString(36);
}

/**
 * The command-activity QName — `inflexa:cmd-{runId}-{stepId}-{digest(sorted output (path,hash) pairs)}`.
 *
 * The group is keyed by its OUTPUT SET, deliberately NOT by the producer's object identity or its
 * observation timestamp (design D1). A DBOS workflow re-execution rebuilds the collector and mints
 * fresh `Producer` objects with fresh timestamps, so neither is replay-stable; the surviving output
 * set IS, because the upstream collector is last-write-wins per output path — after collapse every
 * output path has exactly one producer, so two surviving groups within one step cannot share an output
 * path (collision-free) and re-registration reproduces the identical set (stable). Rejected keying on
 * `(command, args)`: the same command line can run twice in one step with different surviving outputs.
 *
 * Exported (like {@link fileQName}) so callers that must name the command activity — the builder's own
 * tests — reference the one canonical derivation rather than duplicating this hash and risking drift.
 */
export function commandQName(step: ProvStepRef, outputs: ProvFileKey[]): string {
    return `${NS_PREFIX}:cmd-${step.runId}-${step.stepId}-${commandGroupDigest(outputs)}`;
}

/**
 * The occurrence time to stamp into an execution activity's `startTime`/`endTime` slot: the wall
 * clock the first time, but `undefined` once that slot is already populated under this QName.
 *
 * tsprov's `unified()` THROWS ("Cannot have more than one value for attribute prov:startTime")
 * when it merges two same-QName activities that set the same single-valued formal time attribute to
 * *different* values — verified against `@inflexa-ai/tsprov`. DBOS re-executes the workflow body on
 * recovery, so each execution builder can be invoked twice for one logical event with a *fresh*
 * observer clock; a naive re-stamp would therefore crash the flush's `unified()`. Omitting the
 * already-recorded time keeps re-emission's record mergeable (the surviving activity retains the
 * first-recorded time). This realizes the design's replay-idempotency goal, which the D4 record
 * shape alone does not: the shape (activity with a start/end time) is preserved; only the *source*
 * of the value is made idempotent. The durable alternative is a tsprov change making formal times
 * last-write-wins on merge (tsprov is first-party) instead of throwing; until that lands, this
 * keep-first guard is the local workaround and lives here.
 */
function occurrenceTime(doc: ProvDocument, activityQn: string, slot: "prov:startTime" | "prov:endTime", now: string): string | undefined {
    for (const rec of doc.getRecord(activityQn)) {
        if (rec.getAttribute(slot).length > 0) return undefined;
    }
    return now;
}

/**
 * Append the run-start records: a run activity opened with a start time, associated with the actor's
 * agent, and `used`-linked to the analysis entity. It deliberately does NOT re-generate the analysis
 * — `appendCreation` is the analysis's single generation, and a second `wasGeneratedBy` would violate
 * PROV generation-uniqueness (and compound on every run).
 */
export function appendRunStarted(doc: ProvDocument, analysisId: string, actor: ProvActor, run: ProvRunRef): void {
    const { analysisQn, agentQn } = recordPreamble(doc, analysisId, actor);
    const rQn = runQName(run.runId);
    // Formal start time is the ISO of the harness-observed `startedAtMs`, NOT the append-time wall
    // clock — so the recorded boundary is the true workflow start even when the flush-surviving
    // observation is a later recovery boot. `occurrenceTime` stays as defense in depth: the payload
    // ms is replay-identical, so it no-ops here and only guards a hypothetical upstream writer defect.
    const startTime = new Date(run.startedAtMs).toISOString();
    doc.activity(rQn, occurrenceTime(doc, rQn, "prov:startTime", startTime), undefined, {
        "prov:type": "inflexa:Run",
        "inflexa:runId": run.runId,
        ...(run.planSummary ? { "inflexa:planSummary": run.planSummary } : {}),
    });
    doc.wasAssociatedWith(rQn, agentQn, undefined, `${NS_PREFIX}:assoc-run-${run.runId}-${agentDigest(agentQn)}`);
    doc.used(rQn, analysisQn, undefined, `${NS_PREFIX}:used-run-${run.runId}`);
}

/**
 * Append the run-completion records: the SAME run-activity QName re-declared with an end time and
 * outcome attributes. unified() merges the start-time and end-time records into one activity — this
 * is never a same-QName `entity` (which would collide with the activity and be PROV-invalid).
 */
export function appendRunCompleted(doc: ProvDocument, analysisId: string, actor: ProvActor, outcome: ProvRunOutcome): void {
    // `analysisId` and `actor` are genuinely unused here, by design — not a lapse to clean
    // up. (a) All five execution builders take the same `(doc, analysisId, actor, payload)`
    // shape because the recorder's `onEvent` switch (`prov.ts`) dispatches them uniformly —
    // that signature is the recorder's contract, not each builder's own need. (b) Completion
    // is the one builder that appends no agent- or analysis-referencing record: it only
    // re-declares the run activity's end time + status onto a QName whose `wasAssociatedWith`
    // (agent) and `used` (run → analysis) edges `appendRunStarted` already wrote, so touching
    // them here would add nothing `unified()` keeps. (c) Both stay because any future
    // completion-side edge (an `actedOnBehalfOf`, an end trigger) needs them, and dropping
    // them would ripple through the uniform dispatch for zero gain.
    const rQn = runQName(outcome.runId);
    // End time / status / duration are written DIRECTLY, with NO first-wins `occurrenceTime` guard: a
    // budget-pause that later resumes to completion re-declares this activity with a genuinely newer
    // terminal outcome, and that outcome must SUPERSEDE the earlier one. The flush/export `unified()`
    // resolves the re-declaration last-write-wins ({@link PROV_UNIFY_OPTIONS}) — so a DBOS recovery
    // replay (identical values) still dedupes to one, while a resume's newer values win. Completion
    // adds no agent/analysis edge (those were declared at run start), so there is no preamble here.
    const endTime = new Date(outcome.completedAtMs).toISOString();
    doc.activity(rQn, undefined, endTime, {
        "inflexa:status": outcome.status,
        ...(outcome.durationMs !== undefined ? { "inflexa:durationMs": outcome.durationMs } : {}),
    });
}

/**
 * Append the step-completion records: a step activity closed with an end time and terminal status,
 * `wasInformedBy` its run activity, and associated with BOTH the actor's agent and the model agent
 * (the step is model-driven; recording which model reasoned about it is the point of the model
 * agent). The step is an activity
 * (not an entity) so a file's `wasGeneratedBy` can validly reference it. Takes the settlement
 * {@link ProvStepOutcome} — every EXECUTED step settles here (registration is skipped for
 * zero-artifact steps and never reached by failed ones), so `inflexa:status` records whether it
 * completed, failed, or was canceled. The two association ids share one template and differ in the
 * agent digest, so they coexist on the activity and each dedups on re-emission.
 */
export function appendStepCompleted(doc: ProvDocument, analysisId: string, actor: ProvActor, outcome: ProvStepOutcome, model: ProvModelId): void {
    const { agentQn } = recordPreamble(doc, analysisId, actor);
    const rQn = runQName(outcome.runId);
    const sQn = stepQName(outcome);
    // End time / status / duration written directly (no first-wins `occurrenceTime`): a resumed step
    // supersedes its earlier canceled settlement, resolved last-write-wins at the flush (see
    // appendRunCompleted / {@link PROV_UNIFY_OPTIONS}). `prov:type`/`runId`/`stepId` are stable across
    // re-emits and dedupe.
    const endTime = new Date(outcome.completedAtMs).toISOString();
    doc.activity(sQn, undefined, endTime, {
        "prov:type": "inflexa:Step",
        "inflexa:runId": outcome.runId,
        "inflexa:stepId": outcome.stepId,
        "inflexa:status": outcome.status,
        ...(outcome.durationMs !== undefined ? { "inflexa:durationMs": outcome.durationMs } : {}),
    });
    doc.wasInformedBy(sQn, rQn, `${NS_PREFIX}:informed-${outcome.runId}-${outcome.stepId}`);
    const assocIdBase = `${NS_PREFIX}:assoc-step-${outcome.runId}-${outcome.stepId}`;
    doc.wasAssociatedWith(sQn, agentQn, undefined, `${assocIdBase}-${agentDigest(agentQn)}`);
    appendModelAgent(doc, model, agentQn, sQn, assocIdBase);
}

/**
 * Append a command execution's records — the finer-grained lineage the step level cannot express: a
 * command (or file-tool) activity, `wasInformedBy` its step, `wasAssociatedWith` the actor's agent
 * AND the model agent (mirroring {@link appendStepCompleted} — the command is what the model's step
 * actually executed), a
 * `used` edge per command-scoped input (including the script when it resolves), and — the load-bearing
 * move — `wasGeneratedBy(output, command)` per output. The command is the GENERATION AUTHORITY for its
 * outputs: it writes each `gen-{fileDigest}` edge under the SAME id `appendFileWritten` would have used
 * for the step-level edge, so a produced file (whose `appendFileWritten` is told `generation: "command"`
 * and skips its own gen edge) ends up with exactly ONE generation record — this activity's. No formal
 * times: only a replay-unstable observation timestamp exists at this seam (design D1/D3), so ordering
 * rides the `wasInformedBy` edge to the step, which carries the replay-stable settlement times.
 *
 * The activity QName and every relation id are keyed by the group's output-set digest (see
 * {@link commandQName}), so two commands in one step never collide and a DBOS re-execution's
 * re-emission dedups under `unified()`.
 */
export function appendCommandExecuted(
    doc: ProvDocument,
    analysisId: string,
    actor: ProvActor,
    step: ProvStepRef,
    command: ProvCommandRef,
    model: ProvModelId,
): void {
    const { agentQn } = recordPreamble(doc, analysisId, actor);
    const sQn = stepQName(step);
    const groupDigest = commandGroupDigest(command.outputs);
    const cmdQn = commandQName(step, command.outputs);

    // Per-kind attributes; args are joined into one string (the same lossy-but-faithful shape Cortex
    // ships). No formal start/end time — the only timestamp at this seam is replay-unstable.
    const attributes =
        command.kind === "command"
            ? {
                  "prov:type": "inflexa:Command",
                  "inflexa:command": command.command,
                  ...(command.args ? { "inflexa:args": command.args.join(" ") } : {}),
                  "inflexa:exitCode": command.exitCode,
                  ...(command.durationMs !== undefined ? { "inflexa:durationMs": command.durationMs } : {}),
              }
            : { "prov:type": "inflexa:FileToolWrite", "inflexa:tool": command.tool };
    doc.activity(cmdQn, undefined, undefined, attributes);
    doc.wasInformedBy(cmdQn, sQn, `${NS_PREFIX}:informed-cmd-${step.runId}-${step.stepId}-${groupDigest}`);
    const assocIdBase = `${NS_PREFIX}:assoc-cmd-${step.runId}-${step.stepId}-${groupDigest}`;
    doc.wasAssociatedWith(cmdQn, agentQn, undefined, `${assocIdBase}-${agentDigest(agentQn)}`);
    appendModelAgent(doc, model, agentQn, cmdQn, assocIdBase);

    // Generation authority for each output — SAME `gen-{fileDigest}` id the step-level edge uses, so a
    // file entity can never accrue two generation records (the bridge's produced-vs-leaf partition is
    // exclusive; this is the produced side, `appendFileWritten("step")` is the leaf side).
    for (const output of command.outputs) {
        doc.wasGeneratedBy(fileQName(output), cmdQn, undefined, `${NS_PREFIX}:gen-${fileDigest(output)}`);
    }

    // Only a `command` kind reads inputs; a `file_tool` write is agent-authored content with none.
    if (command.kind === "command") {
        // Every command-scoped `used` id is keyed on (command group + the read entity's `(path,hash)`
        // digest). This is deliberate: when the script below resolves to an entity already among these
        // inputs, its `used` edge gets the SAME id and merges — the command reads one entity once.
        const usedId = (key: ProvFileKey): string => `${NS_PREFIX}:used-cmd-${step.runId}-${step.stepId}-${groupDigest}-${fileDigest(key)}`;
        for (const input of command.inputs) {
            doc.used(cmdQn, fileQName(input), undefined, usedId(input));
        }
        // The script edge (Cortex's `scriptIndex` analogue): the ref carries only `scriptPath`, no hash,
        // so recover the hash by matching the path against a `(path,hash)` pair we already hold — the
        // group's own outputs or its inputs (an intra-step read of a script an earlier file-tool wrote
        // surfaces here as an input). If it matches NEITHER, skip the edge rather than mint an
        // unkeyable, dangling entity — an unresolvable script contributes no `used` edge.
        if (command.scriptPath !== undefined) {
            const scriptKey = command.outputs.find((o) => o.path === command.scriptPath) ?? command.inputs.find((i) => i.path === command.scriptPath);
            if (scriptKey) doc.used(cmdQn, fileQName(scriptKey), undefined, usedId(scriptKey));
        }
    }
}

/**
 * Append the file-write records: a file entity, attributed to the actor's agent, and `wasDerivedFrom`
 * the analysis entity — the coarse lineage edge (no per-input derivation edges in this cut). The
 * step-level `wasGeneratedBy(file, step)` is written ONLY when `generation === "step"`: a LEAF file
 * (no producing command activity — e.g. an inotify-only observation) whose best available attestation
 * is "the step produced it somehow". A PRODUCED file (`generation === "command"`) receives its
 * generation edge exclusively from {@link appendCommandExecuted}, under the same `gen-{fileDigest}` id —
 * so exactly ONE generation edge exists per file entity regardless of which authority wrote it.
 */
export function appendFileWritten(
    doc: ProvDocument,
    analysisId: string,
    actor: ProvActor,
    file: ProvFileRef,
    step: ProvStepRef,
    generation: "command" | "step",
): void {
    const { analysisQn, agentQn } = recordPreamble(doc, analysisId, actor);
    const sQn = stepQName(step);
    const suffix = fileDigest(file);
    const fQn = fileQName(file);
    doc.entity(fQn, {
        "prov:type": "inflexa:File",
        "inflexa:path": file.path,
        "inflexa:hash": file.hash,
        "inflexa:size": file.size,
        "inflexa:producer": file.producer,
    });
    if (generation === "step") doc.wasGeneratedBy(fQn, sQn, undefined, `${NS_PREFIX}:gen-${suffix}`);
    doc.wasAttributedTo(fQn, agentQn, `${NS_PREFIX}:attr-${suffix}-${agentDigest(agentQn)}`);
    doc.wasDerivedFrom(fQn, analysisQn, undefined, undefined, undefined, `${NS_PREFIX}:deriv-${suffix}`);
}

/**
 * Append the input-read records: an entity for the file the step consumed, `used` by the reading
 * step activity. The entity is keyed in the SAME `(path, hash)` space as outputs (via {@link fileQName}),
 * which is the load-bearing choice — a `source: "prior"` read of `runs/{priorRun}/{step}/output/x.csv`
 * resolves to the very QName that file's `appendFileWritten` generated, so `unified()` merges the two
 * and the cross-run derivation chain (prior step → file → this step) falls out with no extra modeling.
 *
 * It records only the input-side attributes (`inflexa:path/hash/source`, and `inflexa:fileId` when the
 * harness resolved one); a prior read's merged entity also carries the producing side's
 * `prov:type`/`size`/`producer`, which are multi-valued and union cleanly. A `source: "data"` or
 * cross-analysis read has no `wasGeneratedBy` in this document — valid PROV (an entity may exist
 * without a recorded generation). The `used` edge carries a deterministic id over its full endpoint
 * tuple (step key + the file's `(path, hash)` digest) and NO formal time, mirroring the file relations.
 */
export function appendInputUsed(doc: ProvDocument, analysisId: string, actor: ProvActor, step: ProvStepRef, input: ProvUsedInputRef): void {
    // Called for its agent-declaration side effect only (the `used` edge and the input entity carry
    // no agent, per the spec) — so the responsible agent is present even if this input read is the
    // first execution record recorded. Its wall-clock `time` is deliberately discarded: no formal
    // position on these records reads the clock.
    recordPreamble(doc, analysisId, actor);
    const sQn = stepQName(step);
    const eQn = fileQName(input);
    doc.entity(eQn, {
        "inflexa:path": input.path,
        "inflexa:hash": input.hash,
        "inflexa:source": input.source,
        ...(input.fileId !== undefined ? { "inflexa:fileId": input.fileId } : {}),
    });
    doc.used(sQn, eQn, undefined, `${NS_PREFIX}:used-input-${step.runId}-${step.stepId}-${fileDigest(input)}`);
}

/**
 * Serialize an analysis's provenance for export. For JSON format, returns the **exact stored bytes**
 * from the DB column — the same bytes the chain hash was computed over, so the export is verifiable
 * against the sidecar. For other formats (PROV-N), deserializes and re-serializes into the target
 * format; this is a lossy conversion that cannot be verified against the chain hash (which is
 * always over the JSON form).
 */
export function serializeProvenance(analysis: Analysis, format: BuiltinProvFormat): Result<string, DbError> {
    return getAnalysisProvenance(analysis.id).andThen((json): Result<string, DbError> => {
        if (format === "json" && json !== null) return ok(json);
        return (
            loadDocument(analysis, json)
                // Same last-write-wins merge as the flush ({@link PROV_UNIFY_OPTIONS}), so the export and
                // the signed column resolve any re-emitted record to the same survivor. A conflict never
                // throws, so a writer defect can never make an analysis permanently un-exportable.
                .map((doc) => doc.unified(PROV_UNIFY_OPTIONS).serialize(format))
                .mapErr((e): DbError => ({ type: "query_failed", op: "serializeProvenance:deserialize", cause: e.cause }))
        );
    });
}

/**
 * Resolve an id-or-name ref to one analysis for export, via the db resolver (id-first ordering) —
 * keeping ref resolution inside the prov module so `export.ts` need not import `analysis`'s own
 * `findAnalysis`. `null` when none match.
 */
export function findAnalysisForProv(ref: IdOrName): Result<Analysis | null, DbError> {
    return findAnalysesByRef(ref).map((rows) => rows[0] ?? null);
}
