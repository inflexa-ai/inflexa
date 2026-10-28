/**
 * The workspace mutate seam — `{ writeFile }` confined to one agent's writable
 * working directory. The write-side counterpart to `WorkspaceFilesystem`
 * (see the harness-workspace-tools spec).
 *
 * The seam owns the whole gauntlet that `write_file` and `edit_file` share —
 * resolve + confine to the working directory, the symlink-hardened landing,
 * the host `fs` write, and the provenance record — so the confinement
 * invariant is concentrated in one place instead of being a per-tool
 * convention.
 *
 * The write and its provenance record are two calls. `writeFile` lands the
 * bytes and gives back the record of the write; the tool carries the record as
 * its call record, and its fold hands it to `recordWrite`. The loop caches the
 * tool call as one step, thus a replay never lands the bytes again, and the
 * fold still records the write into fresh process state.
 *
 * Two realizations serve the two agent contexts. `createWorkspaceMutator`
 * closes over fixed per-step coordinates and records into the step-scoped
 * lineage collector (the sandbox agents). `createSessionWorkspaceMutator`
 * resolves its coordinates per call from the session's analysis scope — the
 * write prefix is the analysis root — and emits a `write-file` session event
 * through the provenance seam (the conversation agent, which runs under no
 * run and no step).
 *
 * The landing is hardened beyond the lexical resolver: missing parent
 * directories are created only inside the write prefix, the deepest existing
 * ancestor is realpath-checked against the realpath'd prefix (a symlinked
 * ancestor cannot re-aim the write), and a symlinked final component is
 * refused, never followed.
 *
 * The landing is atomic: the bytes go to a temporary file in the target's
 * directory, and a rename puts that file over the target. A reader of the
 * target sees the old file or the new file whole, never a part of one, and a
 * process that dies mid-write leaves the target as it was.
 */

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from "node:path";

import type { AgentSession } from "../../auth/types.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { tryFs, tryFsWrite } from "../../lib/fs-result.js";
import type { Logger } from "../../lib/logger.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { ProvenanceCollector } from "../../provenance/collector.js";
import { bindSessionEmit, type ProvenanceSeam, type SessionProvenanceEvent } from "../../provenance/seam.js";
import { resolveForWrite, type ResolveWorkspaceRoot } from "../../workspace/paths.js";

/** Outcome of a confined write. Expected outcomes are data variants — never throws on them. */
export type WriteFileResult =
    | { readonly status: "ok"; readonly path: string; readonly bytesWritten: number }
    | { readonly status: "out_of_scope"; readonly path: string }
    | { readonly status: "out_of_prefix"; readonly path: string }
    | { readonly status: "symlink_denied"; readonly path: string };

/**
 * What one landed write leaves for provenance: the hash and the size of the
 * exact bytes on disk, computed at the landing. Plain JSON, because the step
 * cache of the tool call holds it.
 */
export type WriteRecord = {
    readonly analysisId: string;
    /** The thread of a session write; absent under a run. */
    threadId?: string;
    /** Analysis-root-relative, forward-slashed. */
    readonly path: string;
    readonly hash: string;
    readonly size: number;
    readonly toolName: MutateToolName;
    readonly invocationId: string;
};

/** A write that lands: the result, and the record of the write for `recordWrite`. */
export type LandedWrite = { readonly status: "ok"; readonly path: string; readonly bytesWritten: number; readonly record: WriteRecord };

/** `writeFile` gives back the result, and on success the record of the write for `recordWrite`. */
export type WriteOutcome = LandedWrite | Exclude<WriteFileResult, { status: "ok" }>;

/**
 * Agent-visible name of the tool driving a confined write. Rides the write args
 * so a successful write is attributed to the invoking tool in provenance
 * (`inflexa:tool` in the signed document) — the seam records the write without
 * inspecting its caller.
 */
export const MUTATE_TOOL_NAMES = ["write_file", "edit_file", "knowledge_template", "execute_command"] as const;

export type MutateToolName = (typeof MUTATE_TOOL_NAMES)[number];

export type WorkspaceMutatorDeps = {
    /** Absolute host root of this analysis's workspace tree — used by the resolver. */
    readonly workspaceRoot: string;
    readonly analysisId: string;
    /** Absolute host working directory: relative paths resolve here AND writes are confined here. */
    readonly workingDir: string;
    /**
     * Step-scoped lineage collector. On a successful confined write the seam
     * records a file-tool provenance record here — hash and size computed
     * in-process from the exact bytes written. Omit to skip recording; the
     * write itself proceeds unchanged.
     */
    readonly lineageCollector?: ProvenanceCollector;
};

export type WorkspaceMutator = {
    /**
     * Resolve `path` against the working directory (relative) or analysis root
     * (absolute `/{analysisId}/...`), confine the result to the working
     * directory, and land `content` on the host filesystem. `toolName` names
     * the invoking tool so a successful write is attributed to it in
     * provenance. `invocationId` is the tool call's loop id — pass the tool
     * context's `invocationId`: it rides the provenance record so the write's
     * call activity gets a deterministic identity. `session` is the calling
     * agent's session — pass the tool context's `session`: the step-scoped
     * realization ignores it, the session-scoped one resolves its coordinates
     * and its provenance attribution from it.
     *
     * Records nothing: a successful write gives back its record for `recordWrite`.
     *
     * `beforeLand` runs when the new bytes wait in the temporary file and the
     * target is still unchanged. It gets the outcome that the write gives back.
     * A rejection lands nothing, and the write rejects with it.
     */
    writeFile(args: {
        readonly path: string;
        readonly content: string;
        readonly toolName: MutateToolName;
        readonly invocationId: string;
        readonly session: AgentSession;
        readonly beforeLand?: (write: LandedWrite) => Promise<void>;
    }): Promise<WriteOutcome>;
    /**
     * Record one landed write in provenance. A tool calls it from its call-record
     * fold, thus the record reaches process-local state on each replay too.
     */
    recordWrite(record: WriteRecord): void;
};

/** Outcome of the hardened landing — the disk-touching half of a confined write. */
type LandingStatus = "ok" | "out_of_prefix" | "symlink_denied";

/**
 * Land `bytes` at `absolute`, hardened against a symlink re-aiming the write.
 * `absolute` is already lexically confined under `prefix` by the resolver;
 * this function guards the physical path:
 *
 *   1. Realpath the prefix (created if absent — it is workflow-owned
 *      infrastructure, not agent input).
 *   2. Realpath the deepest existing ancestor of the target and refuse when it
 *      lands outside the realpath'd prefix — a symlinked ancestor inside the
 *      prefix cannot point the write elsewhere. A dangling-symlink ancestor
 *      has no landing at all and is refused too.
 *   3. Create the missing parents under that canonical ancestor, then realpath
 *      the created directory and refuse when it lands outside the prefix — a
 *      symlink raced into a missing segment between the ancestor check and the
 *      recursive mkdir would re-aim the tail of the path.
 *   4. Refuse a symlinked final component (lstat), then stage the bytes in a
 *      temporary file beside it and rename that file over it. The rename
 *      replaces a symlink raced in after the check, and never follows it.
 *
 * Refusals are data; a genuine I/O failure throws (the loop's dispatch catch
 * maps it to an error tool result). A throw removes the temporary file.
 */
async function landBytes(
    prefix: string,
    absolute: string,
    bytes: Buffer,
    stagingKey: string,
    beforeRename: (() => Promise<void>) | undefined,
): Promise<LandingStatus> {
    unwrapOrThrow(await tryFsWrite("mutator.mkdirPrefix", () => mkdir(prefix, { recursive: true }), { path: prefix }));
    const realPrefix = unwrapOrThrow(await tryFs("mutator.realpathPrefix", () => realpath(prefix), { path: prefix }));

    // Deepest existing ancestor of the target. The walk stops at the prefix,
    // which exists — the resolver already confined the lexical path under it.
    let deepest = dirname(absolute);
    while (deepest !== prefix) {
        const stat = unwrapOrThrow(await tryFs<Stats | null>("mutator.lstatAncestor", () => lstat(deepest), { path: deepest, onAbsent: () => null }));
        if (stat !== null) break;
        deepest = dirname(deepest);
    }

    const realDeepest = unwrapOrThrow(await tryFs<string | null>("mutator.realpathAncestor", () => realpath(deepest), { path: deepest, onAbsent: () => null }));
    if (realDeepest === null) return "symlink_denied";
    if (realDeepest !== realPrefix && !realDeepest.startsWith(realPrefix + sep)) return "out_of_prefix";

    const targetDir = joinPath(realDeepest, relativePath(deepest, dirname(absolute)));
    let landingDir = realDeepest;
    if (targetDir !== realDeepest) {
        unwrapOrThrow(await tryFsWrite("mutator.mkdirParents", () => mkdir(targetDir, { recursive: true }), { path: targetDir }));
        // Recursive mkdir follows a symlink that already occupies a segment, so
        // a symlink raced into a missing segment after the ancestor check would
        // re-aim the tail. The canonical path of the created directory exposes
        // it; a directory that vanished before the check is hostile too. The
        // staging below uses the canonical path, so the write never traverses
        // the raced segment again.
        const realTarget = unwrapOrThrow(
            await tryFs<string | null>("mutator.realpathTarget", () => realpath(targetDir), { path: targetDir, onAbsent: () => null }),
        );
        if (realTarget === null) return "symlink_denied";
        if (realTarget !== realPrefix && !realTarget.startsWith(realPrefix + sep)) return "out_of_prefix";
        landingDir = realTarget;
    }

    const finalPath = joinPath(landingDir, basename(absolute));
    const finalStat = unwrapOrThrow(await tryFs<Stats | null>("mutator.lstatFinal", () => lstat(finalPath), { path: finalPath, onAbsent: () => null }));
    if (finalStat !== null && finalStat.isSymbolicLink()) return "symlink_denied";

    const stagingPath = joinPath(landingDir, stagingNameFor(stagingKey, finalPath));
    let landed = false;
    try {
        await stageBytes(stagingPath, bytes, finalStat?.isFile() === true ? finalStat.mode : undefined);
        if (beforeRename !== undefined) await beforeRename();
        unwrapOrThrow(await tryFsWrite("mutator.rename", () => rename(stagingPath, finalPath), { path: finalPath }));
        landed = true;
    } finally {
        if (!landed) await tryFsWrite("mutator.removeStaging", () => unlink(stagingPath), { path: stagingPath }).unwrapOr(undefined);
    }
    return "ok";
}

/**
 * The name of the temporary file of one write. A rerun of the same call writes
 * the same name, thus it replaces a file that a dead process left behind.
 */
function stagingNameFor(stagingKey: string, finalPath: string): string {
    return `.${createHash("sha256").update(`${stagingKey}\0${finalPath}`).digest("hex").slice(0, 32)}.tmp`;
}

/**
 * Write `bytes` to the temporary file. The file takes the permission bits of
 * the file that it replaces, thus an edit keeps, for example, the execute bit
 * of a script.
 */
async function stageBytes(stagingPath: string, bytes: Buffer, replacedMode: number | undefined): Promise<void> {
    // `O_NOFOLLOW` refuses a symlink planted at the staging name (`ELOOP`).
    const handle = unwrapOrThrow(
        await tryFsWrite("mutator.openStaging", () => open(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW), {
            path: stagingPath,
        }),
    );
    try {
        unwrapOrThrow(await tryFsWrite("mutator.writeBytes", () => handle.writeFile(bytes), { path: stagingPath }));
        if (replacedMode !== undefined) {
            unwrapOrThrow(await tryFsWrite("mutator.chmodStaging", () => handle.chmod(replacedMode & 0o7777), { path: stagingPath }));
        }
    } finally {
        unwrapOrThrow(await tryFsWrite("mutator.close", () => handle.close(), { path: stagingPath }));
    }
}

/** One landed confined write: the paths in both frames, and the exact bytes on disk. */
export type ConfinedWriteOk = {
    readonly status: "ok";
    /** Analysis-root-relative, forward-slashed — the provenance-facing form. */
    readonly relative: string;
    /** The `/{analysisId}/…` frame-independent form — the agent-facing result path. */
    readonly agentPath: string;
    readonly bytes: Buffer;
};

/**
 * The shared write gauntlet both realizations run: resolve + confine
 * (`resolveForWrite`), then the hardened landing. A refusal comes back as data;
 * an ok carries what the caller's provenance record needs — the
 * analysis-relative path and the exact bytes that landed. `beforeLand` gets
 * the same ok while the bytes wait in the temporary file.
 */
export async function confinedWrite(args: {
    readonly workspaceRoot: string;
    readonly analysisId: string;
    readonly workingDir: string;
    readonly path: string;
    readonly content: string;
    readonly invocationId: string;
    readonly beforeLand: ((staged: ConfinedWriteOk) => Promise<void>) | undefined;
}): Promise<{ readonly status: Exclude<LandingStatus, "ok"> | "out_of_scope" } | ConfinedWriteOk> {
    const scoped = resolveForWrite({
        workspaceRoot: args.workspaceRoot,
        analysisId: args.analysisId,
        workingDir: args.workingDir,
        path: args.path,
    });
    if (scoped.kind === "out_of_scope") return { status: "out_of_scope" };
    if (scoped.kind === "out_of_prefix") return { status: "out_of_prefix" };

    // Analysis-root-relative, forward-slashed: the agent-facing result
    // path prepends the `/{analysisId}` frame; a provenance record uses
    // the bare tail (the collector normalizes it step-relative itself).
    const relative = scoped.relative.split("\\").join("/");
    const agentPath = `/${args.analysisId}/${relative}`;
    const bytes = Buffer.from(args.content, "utf8");
    const prefix = resolvePath(args.workingDir);

    const confined: ConfinedWriteOk = { status: "ok", relative, agentPath, bytes };
    const { beforeLand } = args;
    const landed = await landBytes(prefix, scoped.absolute, bytes, args.invocationId, beforeLand === undefined ? undefined : () => beforeLand(confined));
    if (landed !== "ok") return { status: landed };
    return confined;
}

export function createWorkspaceMutator(deps: WorkspaceMutatorDeps): WorkspaceMutator {
    return {
        async writeFile({ path, content, toolName, invocationId, beforeLand }) {
            const landedWrite = (landed: ConfinedWriteOk): LandedWrite => {
                // `invocationId` is replay-stable: the model turn that minted the tool
                // call is a durably cached step, so a re-execution replays the same id.
                // That is what lets the bridge key a DETERMINISTIC call-activity
                // identifier on it — a wall-clock stamp here would be re-minted per
                // replay and must never reach an identifier or a formal PROV position.
                const record: WriteRecord = {
                    analysisId: deps.analysisId,
                    path: landed.relative,
                    hash: computeSha256(landed.bytes),
                    size: landed.bytes.length,
                    toolName,
                    invocationId,
                };
                return { status: "ok", path: landed.agentPath, bytesWritten: landed.bytes.length, record };
            };
            const landed = await confinedWrite({
                workspaceRoot: deps.workspaceRoot,
                analysisId: deps.analysisId,
                workingDir: deps.workingDir,
                path,
                content,
                invocationId,
                beforeLand: beforeLand === undefined ? undefined : (staged) => beforeLand(landedWrite(staged)),
            });
            if (landed.status !== "ok") return { status: landed.status, path };
            return landedWrite(landed);
        },
        recordWrite(record) {
            deps.lineageCollector?.recordFileToolWrite({
                path: record.path,
                hash: record.hash,
                size: record.size,
                toolName: record.toolName,
                invocationId: record.invocationId,
            });
        },
    };
}

/** Construction deps of the session-scoped realization — see {@link createSessionWorkspaceMutator}. */
export type SessionWorkspaceMutatorDeps = {
    /** Workspace-root resolution seam — the write coordinates resolve per call from the session's analysis scope. */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /**
     * The provenance seam. On a successful confined write the seam's session
     * emit receives one `write-file` event — hash and size computed in-process
     * from the exact bytes written, attributed to the session's analysis and
     * thread. An unbound session emit records nothing; the write itself
     * proceeds unchanged.
     */
    readonly provenance?: ProvenanceSeam;
    readonly logger?: Logger;
};

/**
 * The session-scoped `WorkspaceMutator` realization — the conversation agent's
 * write path. Where `createWorkspaceMutator` closes over fixed per-step
 * coordinates, this one serves every analysis from one construction: each call
 * resolves the workspace root from the session's analysis scope, and the write
 * prefix IS that root — the agent modifies its own analysis tree freely, while
 * `..` traversal, a foreign analysis, and the symlink escapes stay refused by
 * the same gauntlet.
 *
 * A write here runs under no run and no step, so its provenance is a session
 * observation, not a collector record: each successful write emits one
 * `write-file` session event (see `provenance/seam.ts`).
 */
export function createSessionWorkspaceMutator(deps: SessionWorkspaceMutatorDeps): WorkspaceMutator {
    const logger = (deps.logger ?? createNoopLogger()).named("workspace-mutator");
    const observe = bindSessionEmit(deps.provenance, logger);
    return {
        async writeFile({ path, content, toolName, invocationId, session, beforeLand }) {
            const scope = session.scope;
            const landedWrite = (landed: ConfinedWriteOk): LandedWrite => {
                const record: WriteRecord = {
                    analysisId: scope.analysisId,
                    path: landed.relative,
                    hash: computeSha256(landed.bytes),
                    size: landed.bytes.length,
                    toolName,
                    invocationId,
                };
                if (scope.threadId !== undefined) record.threadId = scope.threadId;
                return { status: "ok", path: landed.agentPath, bytesWritten: landed.bytes.length, record };
            };

            // Rejects on an unknown analysis — the loop's dispatch catch maps
            // it to an error tool result, like any unexpected host failure.
            const workspaceRoot = await deps.resolveWorkspaceRoot(scope.analysisId);
            const landed = await confinedWrite({
                workspaceRoot,
                analysisId: scope.analysisId,
                workingDir: workspaceRoot,
                path,
                content,
                invocationId,
                beforeLand: beforeLand === undefined ? undefined : (staged) => beforeLand(landedWrite(staged)),
            });
            if (landed.status !== "ok") return { status: landed.status, path };
            return landedWrite(landed);
        },
        recordWrite(record) {
            const event: Extract<SessionProvenanceEvent, { type: "write-file" }> = {
                type: "write-file",
                analysisId: record.analysisId,
                path: record.path,
                hash: record.hash,
                size: record.size,
                tool: record.toolName,
                invocationId: record.invocationId,
            };
            if (record.threadId !== undefined) event.threadId = record.threadId;
            observe(event);
        },
    };
}
