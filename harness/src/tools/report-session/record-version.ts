/**
 * The record tool of a report session.
 *
 * The tool records one version of the report. A version that the gate did not accept must never stand, thus
 * the tool runs the whole gate first, and only a pass reaches the store. The gate and the look rule run on
 * every record, the first and each later one alike.
 *
 * The gate has three parts, in order of cost. The finish gates the schema, the unique ids, and the
 * structural tier, and a gap list returns as data. The look-before-record rule then compares the seen hash
 * against the hash of the current draft, on the state that the load already read. A never-seen page and a
 * stale look each refuse with a distinct reason, and the rule reads no model judgment. The full validation
 * resolves every reference through the injected resolver, matches each chart encoding, and matches each
 * assert. A failure names the block that holds the failed part, thus the agent repairs one block and not the
 * report at large.
 *
 * The look runs before the validation on purpose. The validation builds the resolver and its prepare pass
 * can start a container, thus the cheap look guards the expensive pass. A never-seen or stale draft refuses
 * before the resolver constructs.
 *
 * On a pass the store records the document that the gate validated, the pinned snapshot, and the anchor from
 * the thread row. A record on a thread that holds a version replaces that version whole, under the same
 * version id. Thus the loop is unbounded: the agent amends, looks again, and records again, and the stored
 * version equals the page that the last look accepted. A refused record leaves the stored version as it was.
 * The outcome of a pass carries the version id, and it names a replacement.
 *
 * The prune runs after the version lands. It removes the output file of each derivation that the recorded
 * document does not reference, under the `derived/` directory of the session alone. The records stay
 * append-only, because the bytes are reproducible from the script and the sources. A failed removal logs and
 * changes no outcome.
 */

import { ok, type Result } from "neverthrow";
import { rm } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { z } from "zod";

import type { AuthContext } from "../../auth/types.js";
import type { ReportDocument } from "../../contracts/report-blocks.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { describeDbError } from "../../lib/db-result.js";
import { describeFsError, tryFsWrite } from "../../lib/fs-result.js";
import type { Logger } from "../../lib/logger.js";
import type { ThreadStore } from "../../memory/thread-store.js";
import { referencedPaths, walkBlocks } from "../../report-model/block-walk.js";
import { finishDraft, type FinishGap, type SessionDerivation } from "../../report-model/draft-finish.js";
import { computeDraftHash } from "../../report-model/draft-hash.js";
import type { ReferenceResolver } from "../../report-model/reference-resolver.js";
import { validateReport, type ResolutionFailure, type SchemaIssue } from "../../report-model/validate.js";
import type { RecordVersionError, ReportVersionStore } from "../../state/report-versions.js";
import { reportSessionDerivedDir, resolveWorkspacePath, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway, type SessionRefusal } from "../report-authoring/authoring-tools.js";
import { bindSessionEmit, type ProvenanceSeam } from "../../provenance/seam.js";

/** The empty input. The tool records the current draft of the thread, thus it needs no field. */
const recordVersionInput = z.object({});

export type RecordVersionInput = z.infer<typeof recordVersionInput>;

/**
 * The typed outcome of the record tool. Each arm is ok-channel data, thus the tool never throws for a
 * degraded condition.
 *
 * `gaps` names each completeness gap of the draft. `never-seen` means that no eyes ran on the current draft.
 * `stale-look` means that the eyes ran, and the agent then changed the draft. `root-unresolvable` means that
 * the resolver construction cannot resolve the workspace root. `invalid` names each gate failure, and a
 * resolution failure carries the block that holds it. `recorded` carries the version id, and `replaced` is
 * true when the record wrote over the earlier version of the thread.
 */
export type RecordVersionResult =
    | { outcome: "refused"; refusal: SessionRefusal }
    | { outcome: "gaps"; gaps: FinishGap[] }
    | { outcome: "never-seen" }
    | { outcome: "stale-look" }
    | { outcome: "resolver-unavailable" }
    | { outcome: "root-unresolvable"; detail: string }
    | { outcome: "invalid"; schemaIssues?: SchemaIssue[]; duplicateIds?: string[]; resolutionFailures?: ResolutionFailure[] }
    | { outcome: "record-failed"; detail: string }
    | { outcome: "recorded"; versionId: string; replaced: boolean };

/**
 * The construction deps of the record tool.
 *
 * `store` is the version store. `threads` reads the anchor of the report thread, thus the
 * version carries the parent conversation and the transcript position. `makeResolver` is optional, because a
 * resolver realization can be absent, and the gate needs one. It binds one analysis, thus the tool makes the
 * resolver over the scope of the call.
 *
 * `resolveWorkspaceRoot` maps the analysis of the call onto its workspace root. The prune reaches the
 * derived directory of the session under that root, thus the seam is mandatory: a composition that bound
 * none would record a version and leave every unused derivation on disk.
 */
export interface RecordVersionToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly store: ReportVersionStore;
    readonly threads: Pick<ThreadStore, "getThread">;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly makeResolver?: (scope: { analysisId: string; auth: AuthContext }) => ReferenceResolver;
    /** The provenance seam; an unbound session emit emits nothing and the record runs the same. */
    readonly provenance?: ProvenanceSeam;
    readonly logger?: Logger;
}

/** A short account of a record refusal, for the detail of a transient failure. */
function describeRecordFailure(error: RecordVersionError): string {
    switch (error.type) {
        case "malformed_document":
            return "the gate accepted a document that the store read as malformed";
        case "malformed_snapshot":
            return "the pinned snapshot is malformed";
        case "parent_analysis_mismatch":
            return "the parent version belongs to a different analysis";
        default:
            return describeDbError(error);
    }
}

/**
 * Remove the output file of each derivation that the recorded document does not reference.
 *
 * The unused set is a set difference: a derivation is used when a binding of the recorded document names its
 * output path. The document is the one that the gate validated, thus the prune reads what the version holds
 * and never the draft.
 *
 * The prune reaches the `derived/` directory of the session alone. A record whose path resolves outside that
 * directory is skipped, because this tool never removes a file that it does not own. A stale record from an
 * earlier layout and a crafted path both land in that arm.
 *
 * The version already stands at this point. Thus each failure costs the cleanup alone: an unresolvable root,
 * a path that escapes, and a failed removal each log and change no outcome. The records stay, and the bytes
 * are reproducible from the script and the sources. The scope of the prune resolves inside the same guard as
 * the root, because both builders throw and a throw here would read as a failure of a call that succeeded.
 */
async function pruneUnusedDerivations(args: {
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly analysisId: string;
    readonly threadId: string;
    readonly document: ReportDocument;
    readonly derivations: readonly SessionDerivation[];
    readonly logger: Logger;
}): Promise<void> {
    if (args.derivations.length === 0) {
        return;
    }
    const named = referencedPaths(walkBlocks(args.document.sections).references);
    const unused = args.derivations.filter((record) => !named.has(record.outputPath));
    if (unused.length === 0) {
        return;
    }

    let root: string;
    let derivedDir: string;
    try {
        root = args.resolveWorkspaceRoot(args.analysisId);
        derivedDir = resolvePath(root, reportSessionDerivedDir(args.threadId));
    } catch (cause) {
        args.logger.warn("the unused derivations did not prune", {
            threadId: args.threadId,
            analysisId: args.analysisId,
            ...args.logger.errorFields(cause),
        });
        return;
    }

    for (const record of unused) {
        const resolved = resolveWorkspacePath({ workspaceRoot: root, analysisId: args.analysisId, path: record.outputPath });
        if (resolved.kind !== "ok" || !resolved.absolute.startsWith(derivedDir + sep)) {
            args.logger.warn("an unused derivation sits outside the derived directory of the session", {
                threadId: args.threadId,
                analysisId: args.analysisId,
                path: record.outputPath,
            });
            continue;
        }
        // An absent file is the normal condition of a prune that ran before, thus `force` treats it as done.
        const removed = await tryFsWrite("record.rm", () => rm(resolved.absolute, { force: true }), { path: resolved.absolute });
        if (removed.isErr()) {
            args.logger.warn("an unused derivation did not go", { path: resolved.absolute, detail: describeFsError(removed.error) });
        }
    }
}

/**
 * Make the record tool over the session-state gateway, the version store, the thread store, and the
 * resolver.
 *
 * The tool reads the thread id from the scope of the call, and it loads the state through the gateway. Thus
 * one factory serves every thread. The tool holds no per-session value.
 */
export function createRecordVersionTool(deps: RecordVersionToolDeps): Tool<RecordVersionInput, RecordVersionResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("record-report-version");
    const observe = bindSessionEmit(deps.provenance, logger);

    return defineTool({
        id: "record_report_version",
        description:
            "Record the current draft as one report version. The tool runs the whole gate first: it finishes the draft, " +
            "resolves each reference, matches each chart encoding, and matches each assert. An incomplete draft gives back the gap list, " +
            "and a failed reference gives back the block that broke. The tool records a version only after the eyes look at the current page. " +
            "A thread holds one version, thus a later record replaces it whole. Amend the draft, look at the page again, and record again. " +
            "After the version lands, the tool removes the file of each derived table that no block of the recorded report binds.",
        inputSchema: recordVersionInput,
        executionMode: "inline",
        describeCall: "none",
        // The version id is the one durable product of the first record, thus the created arm names it. A
        // later record writes over that same id, thus the line names the update and never reads as a
        // refusal. Each other arm is a gate that refused, and the kind of the arm is what a watcher reads.
        describeResult: (_input, result): string => {
            if (result.outcome !== "recorded") return result.outcome;
            return result.replaced ? "version updated" : `version ${result.versionId}`;
        },
        execute: async (_input, ctx): Promise<Result<RecordVersionResult, ToolError>> => {
            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) {
                return ok({ outcome: "refused", refusal: opened.error });
            }
            const { threadId, analysisId, state, seenDocumentHash, derivations } = opened.value;
            const { document: draft, snapshot } = state;

            const finished = finishDraft(draft, snapshot, derivations);
            if (!finished.valid) {
                return ok({ outcome: "gaps", gaps: finished.gaps });
            }

            // The look-before-record rule runs before the resolver and the validation, on the state that the
            // load already read. The preview stamps the rendered hash, and the eyes copy it onto the seen
            // hash. A never-seen page carries no seen hash. A stale look carries the hash of an earlier draft,
            // thus a mismatch against the current draft refuses. Each refusal skips the expensive validation.
            const currentHash = computeDraftHash(draft);
            if (seenDocumentHash === null) {
                return ok({ outcome: "never-seen" });
            }
            if (seenDocumentHash !== currentHash) {
                return ok({ outcome: "stale-look" });
            }

            if (deps.makeResolver === undefined) {
                return ok({ outcome: "resolver-unavailable" });
            }
            // The resolver construction resolves the workspace root inside, and that seam throws on an
            // unresolvable root. The guard turns the throw into a typed outcome that names the fault, thus a
            // control-flow exception propagates and the unresolvable root does not.
            let resolver: ReferenceResolver;
            try {
                resolver = deps.makeResolver({ analysisId, auth: ctx.session.auth });
            } catch (cause) {
                logger.warn("the workspace root did not resolve", { threadId, analysisId, ...logger.errorFields(cause) });
                return ok({ outcome: "root-unresolvable", detail: "the workspace root did not resolve" });
            }

            const validation = await validateReport(finished.document, snapshot, resolver);
            if (!validation.valid) {
                return ok({
                    outcome: "invalid",
                    ...(validation.schemaIssues ? { schemaIssues: validation.schemaIssues } : {}),
                    ...(validation.duplicateIds ? { duplicateIds: validation.duplicateIds } : {}),
                    ...(validation.resolutionFailures ? { resolutionFailures: validation.resolutionFailures } : {}),
                });
            }

            const thread = await deps.threads.getThread(threadId);
            if (thread.isErr()) {
                logger.warn("the thread row read failed", { threadId, analysisId, ...logger.errorFields(thread.error.cause) });
                return ok({ outcome: "record-failed", detail: describeDbError(thread.error) });
            }
            if (thread.value === null) {
                logger.warn("the report thread row is absent at record", { threadId, analysisId });
                return ok({ outcome: "record-failed", detail: "the report thread row is absent" });
            }

            const recorded = await deps.store.record({
                document: finished.document,
                snapshot,
                analysisId,
                threadId,
                parentThreadId: thread.value.parentThreadId,
                parentSeq: thread.value.parentSeq,
            });
            if (recorded.isOk()) {
                // The version stands from here, thus the event states a version that a reader can open.
                observe({ type: "record-version", analysisId, threadId, versionId: recorded.value.versionId, replaced: recorded.value.outcome === "replaced" });
                // The prune reclaims the bytes of each derivation that the recorded document ignores, and it
                // decides nothing about the outcome. It runs on each record, thus an output that an amend
                // unbound goes at the next record.
                await pruneUnusedDerivations({
                    resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
                    analysisId,
                    threadId,
                    document: finished.document,
                    derivations,
                    logger,
                });
            }
            return recorded.match(
                (ref): Result<RecordVersionResult, ToolError> => ok({ outcome: "recorded", versionId: ref.versionId, replaced: ref.outcome === "replaced" }),
                (error): Result<RecordVersionResult, ToolError> => {
                    logger.warn("the version did not record", { threadId, analysisId, reason: error.type });
                    return ok({ outcome: "record-failed", detail: describeRecordFailure(error) });
                },
            );
        },
    });
}
