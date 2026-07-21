/**
 * Backend-agnostic mount model — the single source of truth for the
 * container-side paths, writable step subdirectories, and lib-store env
 * that both the Docker and K8s clients translate into their own mount
 * mechanism (`HostConfig.Binds` vs `volumes`/`volumeMounts`).
 *
 * The storage contract (CLAUDE.md "Storage Layout"): a flat read-only
 * mount of the analysis tree at `/{resourceId}`, a nested read-write
 * mount at `/{resourceId}/runs/{runId}/{stepId}` for the step's
 * artifacts, lib store read-only at `/mnt/libs`, ref store read-only at
 * `/mnt/refs`.
 *
 * Container paths are a function of `resourceId` alone — they never carry the
 * host location of the tree. Where that tree physically lives is the embedder's
 * (`resolveWorkspaceRoot`); the two are reconciled per backend: Docker binds the
 * resolved root directly, K8s addresses it as a `subPath` into the session PVC
 * (see {@link buildSessionSubPaths}).
 */

import { assertSafeId } from "../workspace/paths.js";

export const STEP_SUBDIRS = ["output", "scripts", "figures", "logs", "notebooks"] as const;

const LIBS_CONTAINER_PATH = "/mnt/libs";
const REFS_CONTAINER_PATH = "/mnt/refs";

export interface MountPlanCoords {
    analysisId: string;
    runId: string;
    stepId: string;
    /**
     * Enforced read-only: emit no read-write step mount. The container sees only
     * the read-only analysis tree (plus container-local `/tmp`). Used by the
     * ephemeral executor, whose prompt promises it physically cannot write files.
     */
    readOnly?: boolean;
}

export interface MountPlanStores {
    /** Lib store is mounted at `/mnt/libs` and its env is emitted. */
    libs: boolean;
    /** Ref store is mounted at `/mnt/refs`. */
    refs: boolean;
}

export interface MountPlan {
    /** Flat read-only mount of the whole analysis tree. */
    readonlyTreePath: string;
    /**
     * Nested read-write mount for this step's artifacts, also the WorkingDir.
     * Undefined for a read-only sandbox — no writable mount exists; the
     * WorkingDir falls back to the read-only tree root.
     */
    writableStepPath?: string;
    /** Container WorkingDir: the writable step path, or the RO tree root in
     *  read-only mode. */
    workingDir: string;
    /** Container path of the lib store, present only when `libs`. */
    libsPath?: string;
    /** Container path of the ref store, present only when `refs`. */
    refsPath?: string;
    /** Pre-created subdirectories under the writable step path. Empty when
     *  read-only (nothing to pre-create). */
    stepSubdirs: readonly string[];
    /** Env merged into the sandbox container: provenance + lib-store vars. */
    env: Record<string, string>;
}

/** K8s `subPath` strings into the session PVC. No leading or trailing slash. */
export interface SessionSubPaths {
    /** Read-only mount of the whole analysis tree. */
    readonly ro: string;
    /** Read-write mount of the step's artifact dir; absent when read-only. */
    readonly rw?: string;
}

/**
 * The step tail beneath an analysis's workspace root, in both container and
 * PVC-relative space. The harness owns this layout (workspace-layout spec).
 */
function stepTail(runId: string, stepId: string): string {
    // The single builder feeding both the container RW path (`buildMountPlan`)
    // and the K8s RW subPath (`buildSessionSubPaths`); validate here so a crafted
    // `stepId` cannot inject a `..`/`/` into either.
    assertSafeId(runId, "runId");
    assertSafeId(stepId, "stepId");
    return `runs/${runId}/${stepId}`;
}

/**
 * K8s `subPath`s for the session-PVC mounts.
 *
 * `workspaceSubPath` is the analysis's workspace root expressed relative to the PVC root —
 * i.e. `relative(pvcRoot, resolveWorkspaceRoot(analysisId))`. Deriving the subPaths from the
 * same resolver that `precreateStepTree` mkdirs under is what makes the directory the harness
 * creates and the directory the pod mounts provably the same one. Hardcoding `{analysisId}`
 * here instead would silently mount elsewhere for any embedder whose roots are not laid out
 * as `{pvcRoot}/{analysisId}` — a coupling nothing in the type system would catch.
 */
export function buildSessionSubPaths(coords: MountPlanCoords, workspaceSubPath: string): SessionSubPaths {
    if (workspaceSubPath.length === 0 || workspaceSubPath.startsWith("/") || workspaceSubPath.split("/").includes("..")) {
        throw new Error(
            `buildSessionSubPaths: workspaceSubPath must be a non-empty PVC-root-relative path without '..' (got ${JSON.stringify(workspaceSubPath)})`,
        );
    }
    return {
        ro: workspaceSubPath,
        rw: coords.readOnly ? undefined : `${workspaceSubPath}/${stepTail(coords.runId, coords.stepId)}`,
    };
}

/**
 * Lib-store package-discovery env. PYTHONPATH is intentionally omitted —
 * system Python resolves via a `.pth` file in the lib store.
 */
function libStoreEnv(): Record<string, string> {
    return {
        R_LIBS_SITE: "/mnt/libs/current/r/github:/mnt/libs/current/r/bioconductor:/mnt/libs/current/r/cran",
        NODE_PATH: "/mnt/libs/current/node/node_modules",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/mnt/libs/current/conda/bin",
    };
}

/**
 * The container directories the sandbox's inotify watcher observes: the step's
 * own run tree, and nothing else.
 *
 * The criterion is what this exec *mutates*, not what it may read. inotify
 * reports creations, deletions, and moves — never reads — and the only tree
 * this container can write is the one mounted read-write beneath it. `data/` is
 * staged before the run and frozen for its duration, and a step observed
 * `completed` writes no more; neither can raise an event the watcher collects,
 * so a watch on either is a watch that structurally cannot fire while spending
 * the walk's budget. Excluding them also removes the walk's only unbounded
 * terms: `data/` and a sibling's outputs are shaped by the dataset, not by
 * anything the harness bounds, and the walk is a startup cost paid before the
 * child process spawns.
 *
 * Narrowing costs no lineage edge, because reads never came from inotify. A
 * read this command performs — of `data/`, of a sibling, of a prior run — is
 * intercepted by the in-container hooks, whose prefix filter
 * (`PROVENANCE_DATA_PREFIXES`) is the whole mount root and is configured
 * independently below. Being unwatched is not being inadmissible: whether such
 * a read may assert lineage is classification's decision, not capture scope's.
 *
 * A read-only sandbox has no read-write step mount and therefore writes
 * nowhere, so it watches nothing at all.
 */
function ownRunTreeWatchDirs(writableStepPath: string | undefined): string[] {
    return writableStepPath ? [writableStepPath] : [];
}

export function buildMountPlan(coords: MountPlanCoords, stores: MountPlanStores): MountPlan {
    const { analysisId, runId, stepId, readOnly } = coords;
    // `analysisId` becomes the RO mount point `/{analysisId}` even in read-only
    // mode (where `stepTail` — which validates runId/stepId — is not reached).
    assertSafeId(analysisId, "analysisId");
    const readonlyTreePath = `/${analysisId}`;
    const writableStepPath = readOnly ? undefined : `${readonlyTreePath}/${stepTail(runId, stepId)}`;

    return {
        readonlyTreePath,
        writableStepPath,
        workingDir: writableStepPath ?? readonlyTreePath,
        libsPath: stores.libs ? LIBS_CONTAINER_PATH : undefined,
        refsPath: stores.refs ? REFS_CONTAINER_PATH : undefined,
        stepSubdirs: readOnly ? [] : STEP_SUBDIRS,
        env: {
            PROVENANCE_WATCH_DIRS: ownRunTreeWatchDirs(writableStepPath).join(","),
            // The in-container hooks (Python audit hook, R hooks, LD_PRELOAD
            // interposer) intercept only their own process's opens, so they
            // cannot observe another container's writes and need no narrowing.
            // Keeping their filter at the mount root is what leaves a command's
            // own cross-step or prior-run read capturable where inotify does not
            // watch — classification, not capture scope, decides whether such a
            // read may assert lineage.
            PROVENANCE_DATA_PREFIXES: readonlyTreePath,
            ...(stores.libs ? libStoreEnv() : {}),
        },
    };
}
