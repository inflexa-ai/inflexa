import { type Result, ok, err } from "neverthrow";
import { ProvDocument, type UnifiedOptions } from "@inflexa-ai/tsprov";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
    ProvActor,
    ProvInputRef,
    ProvModelId,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepRef,
    ProvStepOutcome,
    ProvSubject,
    ProvUsedInputRef,
    ProvFileRef,
    ProvFileKey,
    ProvCommandRef,
    ProvReportBlockRef,
    ProvReportDerivationRef,
    ProvReportPreviewRef,
    ProvReportTitleRef,
    ProvReportVersionRef,
    ProvSessionRef,
} from "./types.js";

// The tsprov-facing layer: seeding, appending to, and serializing an analysis's PROV document.
// The `@inflexa-ai/tsprov` dependency is confined to this file — hosts drive core provenance
// through `applyProvEvent` and extension events through `appendLifecycleAction`, so a tsprov
// fault is contained to provenance.
//
// The document is built INCREMENTALLY (one append per recorded action) rather than projected in a
// batch: it lives in memory while an analysis is open and is reloaded from its serialized form on
// reopen. Records that recur across actions are deliberately NOT de-duplicated at append time —
// tsprov's `_idMap` tolerates duplicate identifiers and the caller collapses them with `unified()`
// at serialize time.

/** The namespace every inflexa-minted PROV identifier lives under. */
const NS_PREFIX = "inflexa";
const NS_URI = "https://inflexa.ai/prov#";

/**
 * The merge policy every persist/export `unified()` uses: LAST-write-wins. A durable recovery
 * replay re-emits byte-identical execution records (times are replay-stable clock reads), so
 * last==first and they dedupe; a budget-pause that later RESUMES to completion re-declares the
 * run/step activity with a genuinely newer terminal outcome, which must SUPERSEDE the earlier one.
 * `formalAttributeConflict: "last"` resolves the formal `prov:endTime`; `singleValued` extends the
 * same last-wins to the custom terminal attributes, which would otherwise union into a
 * contradictory multi-value. Kept in one place so the flush and any export path agree on the
 * survivor.
 */
export const PROV_UNIFY_OPTIONS: UnifiedOptions = {
    formalAttributeConflict: "last",
    singleValued: [`${NS_PREFIX}:status`, `${NS_PREFIX}:durationMs`],
};

/**
 * A short stable digest over an identity string — the derivation every QName suffix and relation
 * id runs through. Injectable because it is IDENTITY-load-bearing: every file/command/agent QName
 * embeds its output, so a producer with existing documents must keep its own function (a host with
 * historical documents injects its historical one) or its identifier space silently forks —
 * re-emission after a change would mint new QNames for the same files and `unified()` would keep
 * both.
 */
export type ProvDigest = (s: string) => string;

/** The default digest: a SHA-256 fold to base36, portable across JS runtimes. */
export function defaultProvDigest(s: string): string {
    // The `@noble/hashes` sha256 is pure JavaScript, thus this module stays free of
    // `node:crypto` and browser bundlers can resolve it. The first 8 digest bytes, read
    // big-endian, give the same fold as before.
    const bytes = sha256(new TextEncoder().encode(s));
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0).toString(36);
}

export interface ProvDocumentModelOptions {
    /** QName digest derivation — see {@link ProvDigest}. Defaults to {@link defaultProvDigest}. */
    readonly digest?: ProvDigest;
    /** Id minter for analysis-lifecycle action activities (one fresh id per genuine user action). */
    readonly mintActionId?: () => string;
    /** Clock for lifecycle-action occurrence times. Defaults to `() => new Date()`; inject a fixed clock for deterministic output. */
    readonly now?: () => Date;
}

/**
 * The in-package model shape: {@link ProvDocumentModel} plus the per-core-event statement builders
 * `applyProvEvent` dispatches. Off the supported surface — a direct-builder producer could drift
 * from the switch's statement choice and order, forking the signed bytes.
 */
export type ProvDocumentModelInternal = ReturnType<typeof buildDocumentModel>;

/**
 * The document model a host holds — the QName derivations, document seed/load, and the
 * `appendLifecycleAction` extension primitive, all sharing one digest. Core statements are
 * produced only through `applyProvEvent`.
 */
export type ProvDocumentModel = Pick<
    ProvDocumentModelInternal,
    | "analysisQName"
    | "inputQName"
    | "runQName"
    | "stepQName"
    | "fileQName"
    | "commandQName"
    | "modelAgentQName"
    | "freshDocument"
    | "loadDocument"
    | "appendLifecycleAction"
>;

/** The host constructor: the full model, typed to the supported {@link ProvDocumentModel} surface. */
export function createProvDocumentModel(options: ProvDocumentModelOptions = {}): ProvDocumentModel {
    return buildDocumentModel(options);
}

/** Replace every character a PROV qualified-name localpart disallows, so any string can seed an identifier. */
function qnameSafe(s: string): string {
    return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Build the full model over one digest derivation — the in-package constructor `applyProvEvent`
 * and the kernel's own tests build against; hosts construct through
 * {@link createProvDocumentModel}. Every QName and relation-id derivation lives here so the file
 * QName a host returns as an artifact `externalId`, the QNames the builders append under, and the
 * relation ids that make re-emission dedupe can never drift apart.
 *
 * The execution builders use content-deterministic QNames (not random per-event ids) so a run
 * completing on a later boot's durable recovery re-emits identical records, and `unified()`
 * collapses the re-emission to one record set per QName. Runs and steps are PROV activities;
 * files are entities.
 *
 * The RELATIONS the builders emit carry deterministic identifiers too — a subtler requirement than
 * the element QNames. `unified()` dedups by identifier ONLY: an anonymous relation never enters
 * tsprov's `_idMap`, so a re-emitted anonymous relation DUPLICATES instead of merging, even when
 * byte-identical. Each id is derived from the relation's FULL formal endpoint tuple — the
 * run/step/file key, plus a hash of the AGENT QName for agent-bearing relations (whose agent
 * endpoint can differ when a recovery re-derives the actor, e.g. across a host upgrade). The
 * `time` argument is omitted from every identified relation: two same-id relations with differing
 * formal times throw on merge, and the occurrence times already live on the run/step activities.
 */
export function buildDocumentModel(options: ProvDocumentModelOptions = {}) {
    const digest = options.digest ?? defaultProvDigest;
    // `globalThis.crypto.randomUUID` exists in browsers and in Node.js — no `node:crypto` import.
    const mintActionId = options.mintActionId ?? ((): string => globalThis.crypto.randomUUID());
    const now = options.now ?? ((): Date => new Date());

    /** The analysis's PROV subject-entity QName — the document's subject, related to by every action. */
    function analysisQName(analysisId: string): string {
        return `${NS_PREFIX}:analysis-${analysisId}`;
    }

    /** A stable input-entity QName keyed by (source anchor, path), so an add and its later removal touch the same entity. */
    function inputQName(input: ProvInputRef): string {
        return `${NS_PREFIX}:input-${digest(`${input.anchorId ?? ""}|${input.path}`)}`;
    }

    /** Declare (re-declare) the responsible agent on `doc`, returning its QName. Re-declaration is fine — `unified()` collapses it later. */
    function appendAgent(doc: ProvDocument, actor: ProvActor): string {
        switch (actor.kind) {
            case "user": {
                const qn = `${NS_PREFIX}:agent-user-${qnameSafe(actor.id)}`;
                doc.agent(qn, {
                    "prov:type": "prov:Person",
                    ...(actor.email !== undefined ? { "inflexa:email": actor.email } : {}),
                });
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
                    "prov:label": actor.label,
                    "inflexa:version": actor.version,
                    ...(actor.commit !== undefined ? { "inflexa:commit": actor.commit } : {}),
                });
                return qn;
            }
            default: {
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

    /** A fresh provenance document for an analysis: the namespace plus the subject entity. */
    function freshDocument(subject: ProvSubject): ProvDocument {
        const doc = new ProvDocument();
        doc.addNamespace(NS_PREFIX, NS_URI);
        doc.entity(analysisQName(subject.analysisId), {
            "prov:type": "inflexa:Analysis",
            ...(subject.name !== undefined ? { "inflexa:name": subject.name } : {}),
            ...(subject.slug !== undefined ? { "inflexa:slug": subject.slug } : {}),
        });
        return doc;
    }

    /** Reconstruct an analysis's live document from its stored PROV-JSON, or seed a fresh one when nothing is stored yet. */
    function loadDocument(subject: ProvSubject, storedJson: string | null): Result<ProvDocument, { type: "prov_corrupt"; cause: unknown }> {
        if (!storedJson) return ok(freshDocument(subject));
        try {
            return ok(ProvDocument.deserialize(storedJson, "json"));
        } catch (cause) {
            return err({ type: "prov_corrupt" as const, cause });
        }
    }

    /**
     * The preamble every builder shares: declare (re-declare) the responsible agent and stamp the
     * occurrence time, returning the analysis subject QName alongside. It mints NO activity — the
     * caller owns its own node.
     */
    function recordPreamble(doc: ProvDocument, analysisId: string, actor: ProvActor): { analysisQn: string; agentQn: string; time: string } {
        const analysisQn = analysisQName(analysisId);
        const time = now().toISOString();
        const agentQn = appendAgent(doc, actor);
        return { analysisQn, agentQn, time };
    }

    // The analysis-lifecycle builders (create / add-input / remove-input) each mint a fresh action
    // activity stamped at append time — one distinct activity per genuinely distinct user action.
    // The execution builders (run / step / file) instead key off deterministic QNames so durable
    // workflow re-execution on recovery re-emits the same records and unified() dedups them.

    /**
     * The generic lifecycle-action primitive: mint a fresh action activity of `activityType`,
     * stamped at the model clock's current time and associated with the actor's agent. The named
     * lifecycle builders below compose it; it is exported so a host can record its OWN lifecycle
     * event kinds (attaching further edges to the returned QNames) with no kernel change.
     */
    function appendLifecycleAction(
        doc: ProvDocument,
        analysisId: string,
        actor: ProvActor,
        activityType: string,
    ): { analysisQn: string; actionQn: string; time: string; agentQn: string } {
        const { analysisQn, agentQn, time } = recordPreamble(doc, analysisId, actor);
        const actionQn = `${NS_PREFIX}:action-${mintActionId()}`;
        doc.activity(actionQn, time, time, { "prov:type": activityType });
        doc.wasAssociatedWith(actionQn, agentQn);
        return { analysisQn, actionQn, time, agentQn };
    }

    /** Append the PROV records for an analysis creation: the subject was generated by and attributed to the actor. */
    function appendCreation(doc: ProvDocument, analysisId: string, actor: ProvActor): void {
        const { analysisQn, actionQn, time, agentQn } = appendLifecycleAction(doc, analysisId, actor, "inflexa:CreateAnalysis");
        doc.wasGeneratedBy(analysisQn, actionQn, time);
        doc.wasAttributedTo(analysisQn, agentQn);
    }

    /** Append the PROV records for an input addition: the action used the input, and the analysis derives from it. */
    function appendInputAdded(doc: ProvDocument, analysisId: string, actor: ProvActor, input: ProvInputRef, derivedFromAnalysisId: string | null): void {
        const { analysisQn, actionQn, time, agentQn } = appendLifecycleAction(doc, analysisId, actor, "inflexa:AddInput");
        const inputQn = appendInput(doc, input);
        doc.used(actionQn, inputQn, time);
        doc.wasAttributedTo(inputQn, agentQn);
        doc.wasDerivedFrom(analysisQn, inputQn);
        if (derivedFromAnalysisId) doc.wasDerivedFrom(inputQn, analysisQName(derivedFromAnalysisId));
    }

    /** Append the PROV records for an input removal: the input was invalidated by the action. */
    function appendInputRemoved(doc: ProvDocument, analysisId: string, actor: ProvActor, input: ProvInputRef): void {
        const { actionQn, time } = appendLifecycleAction(doc, analysisId, actor, "inflexa:RemoveInput");
        const inputQn = appendInput(doc, input);
        doc.wasInvalidatedBy(inputQn, actionQn, time);
    }

    /** The run-activity QName — one activity per run regardless of how many events reference it. */
    function runQName(runId: string): string {
        return `${NS_PREFIX}:run-${runId}`;
    }

    /** The step-activity QName, keyed by `(runId, stepId)` so each step is a distinct activity a file generation can reference. */
    function stepQName(step: ProvStepRef): string {
        return `${NS_PREFIX}:step-${step.runId}-${step.stepId}`;
    }

    /**
     * The `(path, content hash)` digest that suffixes the file entity's QName. Factored out because
     * a file's execution relations (`gen`/`attr`/`deriv` ids below) reuse this exact suffix, so the
     * two derivations stay in one place. Typed on the structural `(path, hash)` pick so an INPUT
     * read keys into the same space as the output it reads — that shared key is what merges a
     * `source: "prior"` read onto its producing file's entity under `unified()`.
     */
    function fileDigest(file: ProvFileKey): string {
        return digest(`${file.path}|${file.hash}`);
    }

    /** A short stable hash of an agent QName, folded into an agent-bearing relation's id. */
    function agentDigest(agentQn: string): string {
        return digest(agentQn);
    }

    /** The model-agent QName, keyed by the vendor-qualified `{provider}/{model}` name — one agent per distinct name. */
    function modelAgentQName(model: ProvModelId): string {
        return `${NS_PREFIX}:agent-model-${digest(model)}`;
    }

    /**
     * Declare (re-declare) the model agent for `model` — the LLM that reasoned about a model-driven
     * activity — plus its delegation to the event's responsible agent, and return its QName. The
     * delegation reads `actedOnBehalfOf(model, responsible)`: the host is the agent the user
     * directed; the model acted on its behalf. Its id is keyed on both agent digests
     * (activity-independent), so re-declaration across activities and durable re-execution
     * collapses under `unified()`. The caller adds the association with its own activity.
     */
    function declareModelAgent(doc: ProvDocument, model: ProvModelId, responsibleQn: string): string {
        const qn = modelAgentQName(model);
        doc.agent(qn, {
            // Both types deliberately: `prov:SoftwareAgent` places it in PROV's agent taxonomy,
            // `inflexa:Model` marks WHAT KIND of software agent (tsprov attributes are multi-valued).
            "prov:type": ["prov:SoftwareAgent", `${NS_PREFIX}:Model`],
            "prov:label": model,
            "inflexa:model": model,
        });
        doc.actedOnBehalfOf(qn, responsibleQn, undefined, `${NS_PREFIX}:delegation-${agentDigest(qn)}-${agentDigest(responsibleQn)}`);
        return qn;
    }

    /**
     * Declare the model agent and associate it with a model-driven EXECUTION activity. The
     * association id is `{assocIdBase}-{agentDigest(modelQn)}` — the SAME base the caller's actor
     * association uses, disambiguated by the agent digest. An execution activity keys on a
     * content-deterministic QName and re-emits on recovery, thus its association needs an
     * identifier to merge.
     */
    function appendModelAgent(doc: ProvDocument, model: ProvModelId, responsibleQn: string, activityQn: string, assocIdBase: string): void {
        const qn = declareModelAgent(doc, model, responsibleQn);
        doc.wasAssociatedWith(activityQn, qn, undefined, `${assocIdBase}-${agentDigest(qn)}`);
    }

    /**
     * Declare the model agent and associate it with a lifecycle ACTION. The association is
     * anonymous, like the actor association `appendLifecycleAction` writes: an action takes a fresh
     * id per act, thus it is never re-emitted and an identifier would dedupe nothing.
     */
    function appendActionModelAgent(doc: ProvDocument, model: ProvModelId, responsibleQn: string, actionQn: string): void {
        doc.wasAssociatedWith(actionQn, declareModelAgent(doc, model, responsibleQn));
    }

    /**
     * The file-entity QName, keyed by `(path, content hash)` so re-writing identical bytes to a
     * path dedups to one entity. Exported because a host can return this same QName as an
     * artifact's `externalId`, giving its local ledger row a stable cross-reference into the signed
     * document — so the derivation must live in one place.
     */
    function fileQName(file: ProvFileKey): string {
        return `${NS_PREFIX}:file-${fileDigest(file)}`;
    }

    /**
     * The digest that keys a command group — a digest over the group's per-output `(path, hash)`
     * digests, SORTED and joined with `|`. It suffixes both the command-activity QName and every
     * command-relation id, so re-emission of the same group lands on the same identifiers.
     */
    function commandGroupDigest(outputs: ProvFileKey[]): string {
        return digest(outputs.map(fileDigest).sort().join("|"));
    }

    /**
     * The command-activity QName — `inflexa:cmd-{runId}-{stepId}-{digest(sorted output (path,hash) pairs)}`.
     *
     * The group is keyed by its OUTPUT SET, deliberately NOT by the producer's object identity or
     * its observation timestamp. A durable workflow re-execution rebuilds the collector and mints
     * fresh producer objects with fresh timestamps, so neither is replay-stable; the surviving
     * output set IS, because the upstream collector is last-write-wins per output path. Rejected
     * keying on `(command, args)`: the same command line can run twice in one step with different
     * surviving outputs.
     */
    function commandQName(step: ProvStepRef, outputs: ProvFileKey[]): string {
        return `${NS_PREFIX}:cmd-${step.runId}-${step.stepId}-${commandGroupDigest(outputs)}`;
    }

    /**
     * The occurrence time to stamp into an execution activity's `startTime`/`endTime` slot: the
     * wall clock the first time, but `undefined` once that slot is already populated under this
     * QName.
     *
     * tsprov's `unified()` THROWS when it merges two same-QName activities that set the same
     * single-valued formal time attribute to *different* values. A durable runtime re-executes the
     * workflow body on recovery, so each execution builder can be invoked twice for one logical
     * event with a *fresh* observer clock; a naive re-stamp would therefore crash the flush's
     * `unified()`. Omitting the already-recorded time keeps re-emission's record mergeable (the
     * surviving activity retains the first-recorded time).
     */
    function occurrenceTime(doc: ProvDocument, activityQn: string, slot: "prov:startTime" | "prov:endTime", now: string): string | undefined {
        for (const rec of doc.getRecord(activityQn)) {
            if (rec.getAttribute(slot).length > 0) return undefined;
        }
        return now;
    }

    /**
     * Append the run-start records: a run activity opened with a start time, associated with the
     * actor's agent, and `used`-linked to the analysis entity. It deliberately does NOT
     * re-generate the analysis — `appendCreation` is the analysis's single generation, and a second
     * `wasGeneratedBy` would violate PROV generation-uniqueness.
     */
    function appendRunStarted(doc: ProvDocument, analysisId: string, actor: ProvActor, run: ProvRunRef): void {
        const { analysisQn, agentQn } = recordPreamble(doc, analysisId, actor);
        const rQn = runQName(run.runId);
        // Formal start time is the ISO of the host-observed `startedAtMs`, NOT the append-time
        // wall clock — so the recorded boundary is the true workflow start even when the
        // flush-surviving observation is a later recovery boot. `occurrenceTime` stays as defense
        // in depth: the payload ms is replay-identical, so it no-ops here and only guards a
        // hypothetical upstream writer defect.
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
     * Append the run-completion records: the SAME run-activity QName re-declared with an end time
     * and outcome attributes. `unified()` merges the start-time and end-time records into one
     * activity.
     *
     * `analysisId` and `actor` are genuinely unused here, by design: all execution builders take
     * the same `(doc, analysisId, actor, payload)` shape because a recorder dispatches them
     * uniformly, and completion is the one builder that appends no agent- or analysis-referencing
     * record — the run's `wasAssociatedWith` and `used` edges were written at run start.
     */
    function appendRunCompleted(doc: ProvDocument, _analysisId: string, _actor: ProvActor, outcome: ProvRunOutcome): void {
        const rQn = runQName(outcome.runId);
        // End time / status / duration are written DIRECTLY, with NO first-wins `occurrenceTime`
        // guard: a budget-pause that later resumes to completion re-declares this activity with a
        // genuinely newer terminal outcome, and that outcome must SUPERSEDE the earlier one — the
        // flush `unified()` resolves the re-declaration last-write-wins ({@link PROV_UNIFY_OPTIONS}).
        const endTime = new Date(outcome.completedAtMs).toISOString();
        doc.activity(rQn, undefined, endTime, {
            "inflexa:status": outcome.status,
            ...(outcome.durationMs !== undefined ? { "inflexa:durationMs": outcome.durationMs } : {}),
        });
    }

    /**
     * Append the step-completion records: a step activity closed with an end time and terminal
     * status, `wasInformedBy` its run activity, and associated with BOTH the actor's agent and the
     * model agent (the step is model-driven; recording which model reasoned about it is the point
     * of the model agent). The step is an activity (not an entity) so a file's `wasGeneratedBy`
     * can validly reference it.
     */
    function appendStepCompleted(doc: ProvDocument, analysisId: string, actor: ProvActor, outcome: ProvStepOutcome, model: ProvModelId): void {
        const { agentQn } = recordPreamble(doc, analysisId, actor);
        const rQn = runQName(outcome.runId);
        const sQn = stepQName(outcome);
        // End time / status / duration written directly (no first-wins guard): a resumed step
        // supersedes its earlier canceled settlement, resolved last-write-wins at the flush.
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
     * Append a command execution's records — the finer-grained lineage the step level cannot
     * express: a command (or file-tool) activity, `wasInformedBy` its step, `wasAssociatedWith` the
     * actor's agent AND the model agent, a `used` edge per command-scoped input (including the
     * script when it resolves), and — the load-bearing move — `wasGeneratedBy(output, command)` per
     * output. The command is the GENERATION AUTHORITY for its outputs: it writes each
     * `gen-{fileDigest}` edge under the SAME id `appendFileWritten` would have used for the
     * step-level edge, so a produced file ends up with exactly ONE generation record — this
     * activity's.
     */
    function appendCommandExecuted(
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

        // The command's script: the ref carries only `scriptPath`, no hash, so recover the hash by
        // matching the path against a `(path,hash)` pair we already hold — the group's own outputs
        // or its inputs. A path matching NEITHER has no `(path, hash)` key, so it can seed no
        // entity and no `used` edge — a hash-less entity would corrupt the shared QName space. But
        // dropping it silently erases that an attribution existed and was lost, so the unresolvable
        // path rides the activity as `inflexa:unresolvedScript`: deterministic from the payload,
        // metadata about the activity, not a node.
        const scriptKey =
            command.kind === "command" && command.scriptPath !== undefined
                ? (command.outputs.find((o) => o.path === command.scriptPath) ?? command.inputs.find((i) => i.path === command.scriptPath))
                : undefined;
        const unresolvedScript = command.kind === "command" && command.scriptPath !== undefined && scriptKey === undefined ? command.scriptPath : undefined;

        // Per-kind attributes; args are joined into one string. No formal start/end time — the only
        // timestamp at this seam is replay-unstable.
        const attributes =
            command.kind === "command"
                ? {
                      "prov:type": "inflexa:Command",
                      "inflexa:command": command.command,
                      ...(command.args !== undefined && command.args.length > 0 ? { "inflexa:args": command.args.join(" ") } : {}),
                      "inflexa:exitCode": command.exitCode,
                      ...(command.durationMs !== undefined ? { "inflexa:durationMs": command.durationMs } : {}),
                      ...(unresolvedScript !== undefined ? { "inflexa:unresolvedScript": unresolvedScript } : {}),
                  }
                : { "prov:type": "inflexa:FileToolWrite", "inflexa:tool": command.tool };
        doc.activity(cmdQn, undefined, undefined, attributes);
        doc.wasInformedBy(cmdQn, sQn, `${NS_PREFIX}:informed-cmd-${step.runId}-${step.stepId}-${groupDigest}`);
        const assocIdBase = `${NS_PREFIX}:assoc-cmd-${step.runId}-${step.stepId}-${groupDigest}`;
        doc.wasAssociatedWith(cmdQn, agentQn, undefined, `${assocIdBase}-${agentDigest(agentQn)}`);
        appendModelAgent(doc, model, agentQn, cmdQn, assocIdBase);

        // Generation authority for each output — SAME `gen-{fileDigest}` id the step-level edge
        // uses, so a file entity can never accrue two generation records (a host's
        // produced-vs-leaf partition is exclusive; this is the produced side).
        for (const output of command.outputs) {
            doc.wasGeneratedBy(fileQName(output), cmdQn, undefined, `${NS_PREFIX}:gen-${fileDigest(output)}`);
        }

        // Only a `command` kind reads inputs; a `file_tool` write is agent-authored content with none.
        if (command.kind === "command") {
            // Every command-scoped `used` id is keyed on (command group + the read entity's
            // `(path,hash)` digest) — when the script resolves to an entity already among these
            // inputs, its `used` edge gets the SAME id and merges: the command reads one entity once.
            const usedId = (key: ProvFileKey): string => `${NS_PREFIX}:used-cmd-${step.runId}-${step.stepId}-${groupDigest}-${fileDigest(key)}`;
            for (const input of command.inputs) {
                doc.used(cmdQn, fileQName(input), undefined, usedId(input));
            }
            if (scriptKey) doc.used(cmdQn, fileQName(scriptKey), undefined, usedId(scriptKey));
        }
    }

    /**
     * Append the file-write records: a file entity, attributed to the actor's agent, and
     * `wasDerivedFrom` the analysis entity — the coarse lineage edge. The step-level
     * `wasGeneratedBy(file, step)` is written ONLY when `generation === "step"`: a LEAF file (no
     * producing command activity) whose best available attestation is "the step produced it
     * somehow". A PRODUCED file (`generation === "command"`) receives its generation edge
     * exclusively from {@link appendCommandExecuted}, under the same `gen-{fileDigest}` id — so
     * exactly ONE generation edge exists per file entity regardless of which authority wrote it.
     */
    function appendFileWritten(
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
     * Append the input-read records: an entity for the file the step consumed, `used` by the
     * reading step activity. The entity is keyed in the SAME `(path, hash)` space as outputs (via
     * {@link fileQName}), which is the load-bearing choice — a `source: "prior"` read of
     * `runs/{priorRun}/{step}/output/x.csv` resolves to the very QName that file's write generated,
     * so `unified()` merges the two and the cross-run derivation chain falls out with no extra
     * modeling. A `source: "data"` or cross-analysis read has no `wasGeneratedBy` in this document
     * — valid PROV (an entity may exist without a recorded generation).
     */
    function appendInputUsed(doc: ProvDocument, analysisId: string, actor: ProvActor, step: ProvStepRef, input: ProvUsedInputRef): void {
        // Called for its agent-declaration side effect only (the `used` edge and the input entity
        // carry no agent) — so the responsible agent is present even if this input read is the
        // first execution record recorded.
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

    // The session and report family: the session start plus the eight acts on a report document.
    // Each act keeps the LIFECYCLE shape — one freshly minted action activity per act, stamped at
    // the model clock — because a host emits these from a live bus, one time, never from a durable
    // replay. Thus a deterministic execution-style QName would buy nothing.

    /** The attribute bag a report act stamps on its action activity — the plain-record form of tsprov's attributes. */
    type ReportActAttributes = Record<string, string | number | boolean | readonly string[]>;

    /** What a mapped act mints, so its arm can hang the edges that only that act wants. */
    type ReportAction = { actionQn: string; agentQn: string; time: string };

    /** The report-entity QName, keyed by the digest of the thread id — one entity per report session. */
    function reportQName(threadId: string): string {
        return `${NS_PREFIX}:report-${digest(threadId)}`;
    }

    /** The report-version-entity QName, keyed by the digest of the version id — one entity per recorded version. */
    function reportVersionQName(versionId: string): string {
        return `${NS_PREFIX}:report-version-${digest(versionId)}`;
    }

    /**
     * Declare (re-declare) the report entity of a thread, and return its QName. Re-declaration is
     * harmless, because `unified()` collapses same-QName entities — and that is what makes the LAZY
     * MINT fall out of the ordinary path: an act whose session start never reached this document
     * declares the entity here, with no parent thread, because only the session start knows one.
     */
    function appendReportEntity(doc: ProvDocument, threadId: string, parentThreadId?: string): string {
        const qn = reportQName(threadId);
        doc.entity(qn, {
            "prov:type": "inflexa:Report",
            "inflexa:threadId": threadId,
            ...(parentThreadId !== undefined ? { "inflexa:parentThreadId": parentThreadId } : {}),
        });
        return qn;
    }

    /**
     * The preamble every report act shares: mint the typed action activity, stamp the data of the
     * act onto it, and record the model that drove it.
     *
     * The attributes land in a SECOND declaration of the freshly minted activity, because
     * `appendLifecycleAction` owns the first one. They carry no formal time: both time slots are
     * stamped already, and a second stamp is a merge hazard for no gain.
     */
    function appendReportAction(
        doc: ProvDocument,
        analysisId: string,
        actor: ProvActor,
        model: ProvModelId,
        activityType: string,
        attributes: ReportActAttributes,
    ): ReportAction {
        const { actionQn, agentQn, time } = appendLifecycleAction(doc, analysisId, actor, activityType);
        doc.activity(actionQn, undefined, undefined, attributes);
        appendActionModelAgent(doc, model, agentQn, actionQn);
        return { actionQn, agentQn, time };
    }

    /**
     * Land one act on the report document it operated on: the action, the report entity of the
     * thread (minted here when it is unseen), and the `used` edge between them. Every act names its
     * thread as an attribute too, thus a reader that walks attributes and a reader that walks edges
     * both find it.
     */
    function appendReportAct(
        doc: ProvDocument,
        analysisId: string,
        actor: ProvActor,
        model: ProvModelId,
        activityType: string,
        threadId: string,
        attributes: ReportActAttributes,
    ): ReportAction {
        const action = appendReportAction(doc, analysisId, actor, model, activityType, { "inflexa:threadId": threadId, ...attributes });
        doc.used(action.actionQn, appendReportEntity(doc, threadId), action.time);
        return action;
    }

    /**
     * Append the records of a started session: the typed action, and — for a report session — the
     * report entity that every later act operates on. A conversation is the session and nothing
     * else, thus only a report session earns an entity.
     *
     * The parent thread rides the action as well as the entity. The entity is where a reader walks
     * the session tree, but only a report session HAS an entity, thus the stamp on the action is
     * what keeps the parent of a conversation session.
     */
    function appendSessionCreated(doc: ProvDocument, analysisId: string, actor: ProvActor, session: ProvSessionRef, model: ProvModelId): void {
        const { threadId, kind, parentThreadId } = session;
        const action = appendReportAction(doc, analysisId, actor, model, "inflexa:CreateSession", {
            "inflexa:threadId": threadId,
            "inflexa:sessionKind": kind,
            ...(parentThreadId !== undefined ? { "inflexa:parentThreadId": parentThreadId } : {}),
        });
        if (kind !== "report") return;
        // The generation edge and the attribution are anonymous, and the generation lands on a fresh
        // action id, thus `unified()` — which dedups by identifier alone — cannot collapse a second
        // copy. Write the pair only on the first declaration of the entity, so a re-emitted session
        // start adds no duplicate. Read the record count BEFORE the declaration below.
        const firstDeclaration = doc.getRecord(reportQName(threadId)).length === 0;
        const reportQn = appendReportEntity(doc, threadId, parentThreadId);
        if (!firstDeclaration) return;
        doc.wasGeneratedBy(reportQn, action.actionQn, action.time);
        doc.wasAttributedTo(reportQn, action.agentQn);
    }

    /** Append the records of one block act. The four acts share one payload, thus they differ only in the activity type they name. */
    function appendReportBlockAct(
        doc: ProvDocument,
        analysisId: string,
        actor: ProvActor,
        block: ProvReportBlockRef,
        model: ProvModelId,
        activityType: string,
    ): void {
        appendReportAct(doc, analysisId, actor, model, activityType, block.threadId, {
            "inflexa:blockId": block.blockId,
            "inflexa:blockKind": block.blockKind,
        });
    }

    /** Append the records of an added block. */
    function appendReportBlockAdded(doc: ProvDocument, analysisId: string, actor: ProvActor, block: ProvReportBlockRef, model: ProvModelId): void {
        appendReportBlockAct(doc, analysisId, actor, block, model, "inflexa:AddReportBlock");
    }

    /** Append the records of a changed block. */
    function appendReportBlockChanged(doc: ProvDocument, analysisId: string, actor: ProvActor, block: ProvReportBlockRef, model: ProvModelId): void {
        appendReportBlockAct(doc, analysisId, actor, block, model, "inflexa:ChangeReportBlock");
    }

    /** Append the records of a removed block. */
    function appendReportBlockRemoved(doc: ProvDocument, analysisId: string, actor: ProvActor, block: ProvReportBlockRef, model: ProvModelId): void {
        appendReportBlockAct(doc, analysisId, actor, block, model, "inflexa:RemoveReportBlock");
    }

    /** Append the records of a moved block. */
    function appendReportBlockMoved(doc: ProvDocument, analysisId: string, actor: ProvActor, block: ProvReportBlockRef, model: ProvModelId): void {
        appendReportBlockAct(doc, analysisId, actor, block, model, "inflexa:MoveReportBlock");
    }

    /** Append the records of a title set on a report document. */
    function appendReportTitleSet(doc: ProvDocument, analysisId: string, actor: ProvActor, title: ProvReportTitleRef, model: ProvModelId): void {
        appendReportAct(doc, analysisId, actor, model, "inflexa:SetReportTitle", title.threadId, { "inflexa:title": title.title });
    }

    /** Append the records of a derivation a report session ran: the output, the script, and the sources it read. */
    function appendReportDerivationRun(doc: ProvDocument, analysisId: string, actor: ProvActor, derivation: ProvReportDerivationRef, model: ProvModelId): void {
        appendReportAct(doc, analysisId, actor, model, "inflexa:RunReportDerivation", derivation.threadId, {
            "inflexa:outputPath": derivation.outputPath,
            "inflexa:outputHash": derivation.outputHash,
            "inflexa:scriptHash": derivation.scriptHash,
            // Each source rides as one `path|hash` value of a repeated attribute. Parallel path and
            // hash attributes would read the same but lose WHICH hash belongs to which path, and a
            // verifier wants that pairing to mount the evidence again.
            ...(derivation.sources.length > 0 ? { "inflexa:source": derivation.sources.map((s) => `${s.path}|${s.hash}`) } : {}),
        });
    }

    /** Append the records of a rendered preview: the page and the draft document it came from. */
    function appendReportPreviewed(doc: ProvDocument, analysisId: string, actor: ProvActor, preview: ProvReportPreviewRef, model: ProvModelId): void {
        appendReportAct(doc, analysisId, actor, model, "inflexa:PreviewReport", preview.threadId, {
            "inflexa:pagePath": preview.pagePath,
            "inflexa:documentHash": preview.documentHash,
        });
    }

    /** Append the records of a recorded version: the act, the version entity, and its specialization of the report. */
    function appendReportVersionRecorded(doc: ProvDocument, analysisId: string, actor: ProvActor, version: ProvReportVersionRef, model: ProvModelId): void {
        const action = appendReportAct(doc, analysisId, actor, model, "inflexa:RecordReportVersion", version.threadId, {
            "inflexa:versionId": version.versionId,
            "inflexa:replaced": version.replaced,
        });
        const versionQn = reportVersionQName(version.versionId);
        // tsprov gives `specializationOf` no identifier, and the generation edge lands on a fresh
        // action id, thus `unified()` cannot collapse a second copy of either. The first-declaration
        // guard is the dedup. Read the record count BEFORE the declaration below.
        const firstDeclaration = doc.getRecord(versionQn).length === 0;
        doc.entity(versionQn, {
            "prov:type": "inflexa:ReportVersion",
            "inflexa:versionId": version.versionId,
            "inflexa:threadId": version.threadId,
        });
        if (!firstDeclaration) return;
        doc.wasGeneratedBy(versionQn, action.actionQn, action.time);
        doc.wasAttributedTo(versionQn, action.agentQn);
        // A version IS the report, fixed at one point in time, which is PROV's own reading of
        // `specializationOf`. `wasAttributedTo` cannot say it, because attribution takes an AGENT
        // and the report is an entity. `hadMember` would say the version is one PART of the report,
        // which is false.
        doc.specializationOf(versionQn, reportQName(version.threadId));
    }

    return {
        analysisQName,
        inputQName,
        runQName,
        stepQName,
        fileQName,
        commandQName,
        modelAgentQName,
        freshDocument,
        loadDocument,
        appendLifecycleAction,
        appendCreation,
        appendInputAdded,
        appendInputRemoved,
        appendRunStarted,
        appendRunCompleted,
        appendStepCompleted,
        appendCommandExecuted,
        appendFileWritten,
        appendInputUsed,
        appendSessionCreated,
        appendReportBlockAdded,
        appendReportBlockChanged,
        appendReportBlockRemoved,
        appendReportBlockMoved,
        appendReportTitleSet,
        appendReportDerivationRun,
        appendReportPreviewed,
        appendReportVersionRecorded,
    };
}
