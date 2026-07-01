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
    /** K8s `subPath` for the read-only tree mount (no leading slash). */
    sessionSubPathRO: string;
    /** K8s `subPath` for the read-write step mount; undefined when read-only. */
    sessionSubPathRW?: string;
    /** Env merged into the sandbox container: provenance + lib-store vars. */
    env: Record<string, string>;
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
    const sessionSubPathRW = `${analysisId}/runs/${runId}/${stepId}`;
    const writableStepPath = readOnly ? undefined : `/${sessionSubPathRW}`;

    return {
        readonlyTreePath,
        writableStepPath,
        workingDir: writableStepPath ?? readonlyTreePath,
        libsPath: stores.libs ? LIBS_CONTAINER_PATH : undefined,
        refsPath: stores.refs ? REFS_CONTAINER_PATH : undefined,
        stepSubdirs: readOnly ? [] : STEP_SUBDIRS,
        sessionSubPathRO: analysisId,
        sessionSubPathRW: readOnly ? undefined : sessionSubPathRW,
        env: {
            PROVENANCE_WATCH_DIRS: readonlyTreePath,
            ...(stores.libs ? libStoreEnv() : {}),
        },
    };
}
