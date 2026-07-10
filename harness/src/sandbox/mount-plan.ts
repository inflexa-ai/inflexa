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

export function buildMountPlan(coords: MountPlanCoords, stores: MountPlanStores): MountPlan {
    const { analysisId, runId, stepId, readOnly } = coords;
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
            PROVENANCE_WATCH_DIRS: readonlyTreePath,
            ...(stores.libs ? libStoreEnv() : {}),
        },
    };
}
