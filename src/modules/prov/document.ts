import { randomUUIDv7 } from "bun";
import { type Result, ok, err } from "neverthrow";
import { ProvDocument, type BuiltinProvFormat } from "@inflexa-ai/tsprov";
import type { Analysis } from "../../types/analysis.ts";
import type { ProvActor, ProvInputRef } from "../../types/prov.ts";
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

// Each append function mints a fresh activity, stamps it at append time (the action's occurrence),
// and declares the agent. The analysis subject is assumed already present (declared by
// freshDocument or carried in the deserialized document). Shared preamble lives in startAction.

function startAction(
    doc: ProvDocument,
    analysisId: string,
    activityType: string,
    actor: ProvActor,
): { analysisQn: string; actionQn: string; time: string; agentQn: string } {
    const analysisQn = analysisQName(analysisId);
    const actionQn = `${NS_PREFIX}:action-${randomUUIDv7()}`;
    const time = new Date().toISOString();
    const agentQn = appendAgent(doc, actor);
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
        return loadDocument(analysis, json)
            .map((doc) => doc.unified().serialize(format))
            .mapErr((e): DbError => ({ type: "query_failed", op: "serializeProvenance:deserialize", cause: e.cause }));
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
