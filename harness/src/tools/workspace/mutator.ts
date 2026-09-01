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
 * The landing is hardened beyond the lexical resolver: missing parent
 * directories are created only inside the write prefix, the deepest existing
 * ancestor is realpath-checked against the realpath'd prefix (a symlinked
 * ancestor cannot re-aim the write), and the final open uses `O_NOFOLLOW`
 * (a symlinked final component is refused, never followed).
 */

import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from "node:path";

import { computeSha256 } from "../../lib/fs-helpers.js";
import { tryFs, tryFsWrite } from "../../lib/fs-result.js";
import { unwrapOrThrow } from "../../lib/result.js";
import type { RunStep } from "../../loop/types.js";
import type { ProvenanceCollector } from "../../provenance/collector.js";
import { resolveForWrite } from "../../workspace/paths.js";

/** Outcome of a confined write. Expected outcomes are data variants — never throws on them. */
export type WriteFileResult =
    | { readonly status: "ok"; readonly path: string; readonly bytesWritten: number }
    | { readonly status: "out_of_scope"; readonly path: string }
    | { readonly status: "out_of_prefix"; readonly path: string }
    | { readonly status: "symlink_denied"; readonly path: string };

/**
 * Agent-visible name of the tool driving a confined write. Rides the write args
 * so a successful write is attributed to the invoking tool in provenance
 * (`inflexa:tool` in the signed document) — the seam records the write without
 * inspecting its caller.
 */
export type MutateToolName = "write_file" | "edit_file";

export interface WorkspaceMutatorDeps {
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
}

export interface WorkspaceMutator {
    /**
     * Resolve `path` against the working directory (relative) or analysis root
     * (absolute `/{analysisId}/...`), confine the result to the working
     * directory, and land `content` on the host filesystem. `toolName` names
     * the invoking tool so a successful write is attributed to it in
     * provenance. `runStep` wraps the disk mutation in a replay-cached step —
     * pass the tool context's `runStep`.
     */
    writeFile(args: {
        readonly path: string;
        readonly content: string;
        readonly toolName: MutateToolName;
        readonly runStep: RunStep;
    }): Promise<WriteFileResult>;
}

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
 *   3. Create the missing parents under that canonical ancestor only — a
 *      component that does not exist cannot be a symlink.
 *   4. Refuse a symlinked final component (lstat), then open with
 *      `O_NOFOLLOW` so a symlink raced in after the check still cannot be
 *      followed.
 *
 * Refusals are data; a genuine I/O failure throws (the loop's dispatch catch
 * maps it to an error tool result).
 */
async function landBytes(prefix: string, absolute: string, bytes: Buffer): Promise<LandingStatus> {
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
    if (targetDir !== realDeepest) {
        unwrapOrThrow(await tryFsWrite("mutator.mkdirParents", () => mkdir(targetDir, { recursive: true }), { path: targetDir }));
    }

    const finalPath = joinPath(targetDir, basename(absolute));
    const finalStat = unwrapOrThrow(await tryFs<Stats | null>("mutator.lstatFinal", () => lstat(finalPath), { path: finalPath, onAbsent: () => null }));
    if (finalStat !== null && finalStat.isSymbolicLink()) return "symlink_denied";

    // `O_NOFOLLOW` backstops the lstat refusal: a symlink raced in between the
    // two calls fails the open (`ELOOP`) instead of being followed.
    const handle = unwrapOrThrow(
        await tryFsWrite("mutator.open", () => open(finalPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW), {
            path: finalPath,
        }),
    );
    try {
        unwrapOrThrow(await tryFsWrite("mutator.writeBytes", () => handle.writeFile(bytes), { path: finalPath }));
    } finally {
        unwrapOrThrow(await tryFsWrite("mutator.close", () => handle.close(), { path: finalPath }));
    }
    return "ok";
}

export function createWorkspaceMutator(deps: WorkspaceMutatorDeps): WorkspaceMutator {
    return {
        async writeFile({ path, content, toolName, runStep }) {
            const scoped = resolveForWrite({
                workspaceRoot: deps.workspaceRoot,
                analysisId: deps.analysisId,
                workingDir: deps.workingDir,
                path,
            });
            if (scoped.kind === "out_of_scope") return { status: "out_of_scope", path };
            if (scoped.kind === "out_of_prefix") return { status: "out_of_prefix", path };

            // Analysis-root-relative, forward-slashed: the agent-facing result
            // path prepends the `/{analysisId}` frame; the provenance record uses
            // the bare tail (the collector normalizes it step-relative itself).
            const relative = scoped.relative.split("\\").join("/");
            const agentPath = `/${deps.analysisId}/${relative}`;
            const contentBytes = Buffer.from(content, "utf8");
            const prefix = resolvePath(deps.workingDir);

            // The loop dispatches a workflow-mode tool body unwrapped (see
            // `dispatchTools` in loop/run-agent.ts), so a DBOS replay re-runs
            // this body. The step wrapper caches the landing: a replay returns
            // the recorded outcome instead of touching the disk again.
            const landed = await runStep("write", () => landBytes(prefix, scoped.absolute, contentBytes));
            if (landed !== "ok") return { status: landed, path };

            // Attest the write in-process from the exact bytes just written — the
            // seam owns write provenance the same way it owns confinement. The
            // record lands outside the write step on purpose: the collector is
            // process-local state, so a recovered replay must re-record into the
            // fresh collector even while the cached step skips the disk write.
            //
            // `timestamp` is a write-time wall clock — normally a replay hazard in
            // provenance, but safe here because the record contributes only producer
            // IDENTITY downstream: the bridge drops it (the cli's file-tool ref has no
            // timestamp field) and the signed `inflexa:FileToolWrite` activity carries
            // just the tool name, so a re-execution's fresh stamp changes nothing in
            // the attested graph. Do NOT start forwarding it into an identifier or a
            // formal PROV position without making it replay-stable first.
            if (deps.lineageCollector) {
                deps.lineageCollector.recordFileToolWrite({
                    path: relative,
                    hash: computeSha256(contentBytes),
                    size: contentBytes.length,
                    toolName,
                    timestamp: new Date().toISOString(),
                });
            }

            return { status: "ok", path: agentPath, bytesWritten: contentBytes.length };
        },
    };
}
