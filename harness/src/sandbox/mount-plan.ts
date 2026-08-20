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
 * A caller can declare its own `writableTail` in place of the step tail — a
 * workspace-relative path that becomes the one read-write mount, with no step
 * subdirectories under it. The session derivation declares one; the run path
 * declares none and keeps the step tail. Thus a sandbox writes into the step
 * directory or into the one declared tail, and nowhere else.
 *
 * The precedence is a refusal, not an order: `readOnly` and `writableTail` state
 * opposite things about the same mount, thus a coordinate set that carries both
 * throws here — the same as a crafted id. No caller can hold both and get a
 * silently chosen winner.
 *
 * Container paths are a function of `resourceId` alone — they never carry the
 * host location of the tree. Where that tree physically lives is the embedder's
 * (`resolveWorkspaceRoot`); the two are reconciled per backend: Docker binds the
 * resolved root directly, K8s addresses it as a `subPath` into the session PVC
 * (see {@link buildSessionSubPaths}).
 */

import { assertSafeId, assertSafeTail } from "../workspace/paths.js";
import type { ToolchainSource } from "./types.js";

export const STEP_SUBDIRS = ["output", "scripts", "figures", "logs", "notebooks"] as const;

/**
 * Container mountpoints of the two read-only stores. Exported because they are
 * also the discovery tools' default read root: a host whose own process sees a
 * store the way the sandbox does configures nothing further.
 */
export const LIBS_CONTAINER_PATH = "/mnt/libs";
export const REFS_CONTAINER_PATH = "/mnt/refs";

/** Container path of the per-analysis read-write cache, when a farm resolution carries a cache location. */
export const FARM_CACHE_CONTAINER_PATH = "/mnt/libs/cache";

/**
 * Container path of the mounted farm, keyed on the declared toolchain. With
 * `"image"` the farm mounts at `/mnt/libs/farm`. With `"store"` (or absent)
 * it stays `/mnt/libs/current`, because the baked resolvers of the old
 * images name that path.
 */
export function farmContainerPath(toolchainSource: ToolchainSource | undefined): string {
    return toolchainSource === "image" ? `${LIBS_CONTAINER_PATH}/farm` : `${LIBS_CONTAINER_PATH}/current`;
}

export interface MountPlanCoords {
    analysisId: string;
    runId: string;
    stepId: string;
    /**
     * Enforced read-only: emit no read-write step mount. The container sees only
     * the read-only analysis tree (plus container-local `/tmp`). Used by the
     * a generic read-only agent that must not mutate analysis files.
     */
    readOnly?: boolean;
    /**
     * The declared write tail: a workspace-relative path that takes the place of the
     * step tail as the one read-write mount, with no step subdirectories under it.
     * Each segment passes the safe-id discipline of the step builder. Absent keeps
     * the step tail, thus the run path is unchanged. A tail beside `readOnly` is a
     * contradiction, and the builders refuse it.
     */
    writableTail?: string;
}

export interface MountPlanStores {
    /** Lib store is mounted at `/mnt/libs`, with the farm nested inside it, and its env is emitted. */
    libs: boolean;
    /** Ref store is mounted at `/mnt/refs`. */
    refs: boolean;
    /**
     * The declared toolchain owner. Keys the farm container path and the
     * resolver env. Absent means `"store"`: the legacy environment,
     * byte-identical to the one before the field existed.
     */
    toolchainSource?: ToolchainSource;
    /** The farm resolution carries a cache location, mounted read-write at `/mnt/libs/cache`. */
    cache?: boolean;
}

export interface MountPlan {
    /** Flat read-only mount of the whole analysis tree. */
    readonlyTreePath: string;
    /**
     * Nested read-write mount, also the WorkingDir: the step's artifact directory,
     * or the declared write tail in its place. Undefined for a read-only sandbox —
     * no writable mount exists; the WorkingDir falls back to the read-only tree
     * root.
     */
    writableStepPath?: string;
    /** Container WorkingDir: the writable mount, or the RO tree root in
     *  read-only mode. */
    workingDir: string;
    /** Container path of the lib store, present only when `libs`. */
    libsPath?: string;
    /** Container path of the farm of the analysis, present only when `libs`. Keyed on the toolchain source. */
    farmPath?: string;
    /** Container path of the read-write cache, present only when `libs` and `cache`. */
    cachePath?: string;
    /** Container path of the ref store, present only when `refs`. */
    refsPath?: string;
    /** Pre-created subdirectories under the writable mount. Empty when read-only
     *  (nothing to pre-create) and when a declared tail replaces the step tail. */
    stepSubdirs: readonly string[];
    /** Env merged into the sandbox container: provenance + lib-store vars. */
    env: Record<string, string>;
}

/** K8s `subPath` strings into the session PVC. No leading or trailing slash. */
export interface SessionSubPaths {
    /** Read-only mount of the whole analysis tree. */
    readonly ro: string;
    /** Read-write mount of the step's artifact dir, or of the declared tail; absent when read-only. */
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

/** The one writable mount of a sandbox: its workspace-relative tail, and what the host pre-makes under it. */
export interface SandboxWriteTail {
    /** The tail beneath the workspace root, in both container and PVC-relative space. */
    readonly tail: string;
    /** The subdirectories the host pre-creates under the tail. A declared tail is one directory, thus none. */
    readonly subdirs: readonly string[];
}

/**
 * The write tail of a sandbox, or `undefined` when the sandbox holds no write mount.
 *
 * The one owner of the rule, read by the container path, the PVC subPath, and the
 * host-side preparation alike. Thus the directory the harness makes and the
 * directory the sandbox mounts are provably the same one.
 *
 * `readOnly` beside a declared tail states two opposite things about one mount, thus
 * it throws rather than picking a winner.
 */
export function sandboxWriteTail(coords: MountPlanCoords): SandboxWriteTail | undefined {
    // The two ids reach the sandbox name, the ownership labels, and the registry row on every path, not the
    // step tail alone. Thus they take their validation before any branch, and a crafted id is refused even
    // where no step directory is built.
    assertSafeId(coords.runId, "runId");
    assertSafeId(coords.stepId, "stepId");
    if (coords.writableTail === undefined) {
        return coords.readOnly ? undefined : { tail: stepTail(coords.runId, coords.stepId), subdirs: STEP_SUBDIRS };
    }
    if (coords.readOnly) {
        throw new Error(`sandbox mount: a read-only sandbox cannot declare a write tail (got ${coords.writableTail})`);
    }
    // The segments come back validated, thus the join below re-splits nothing.
    return { tail: assertSafeTail(coords.writableTail).join("/"), subdirs: [] };
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
    const write = sandboxWriteTail(coords);
    return {
        ro: workspaceSubPath,
        ...(write === undefined ? {} : { rw: `${workspaceSubPath}/${write.tail}` }),
    };
}

/**
 * Lib-store package-discovery env, keyed on the declared toolchain.
 * PYTHONPATH is intentionally omitted — system Python resolves via a `.pth`
 * file in the lib store.
 *
 * With `"store"` (or absent) the env is byte-identical to the legacy one:
 * the conda `bin` under `/mnt/libs/current`, thus an old embedder keeps its
 * exact environment. With `"image"` the image owns the toolchain: `PATH`
 * holds `/opt/conda/bin` before the farm `python/bin` at the end, thus a
 * farm script never shadows an image tool. The cache env points into the
 * read-write cache mount only when it is present — the entrypoint fallback
 * covers the caches otherwise.
 */
function libStoreEnv(toolchainSource: ToolchainSource | undefined, cache: boolean): Record<string, string> {
    if (toolchainSource !== "image") {
        return {
            R_LIBS_SITE: "/mnt/libs/current/r/github:/mnt/libs/current/r/bioconductor:/mnt/libs/current/r/cran",
            NODE_PATH: "/mnt/libs/current/node/node_modules",
            PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/mnt/libs/current/conda/bin",
        };
    }
    const farm = farmContainerPath(toolchainSource);
    return {
        R_LIBS_SITE: `${farm}/r/github:${farm}/r/bioconductor:${farm}/r/cran`,
        NODE_PATH: "/opt/node/node_modules",
        PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/conda/bin:${farm}/python/bin`,
        ...(cache
            ? {
                  NUMBA_CACHE_DIR: `${FARM_CACHE_CONTAINER_PATH}/numba-cache`,
                  MPLCONFIGDIR: `${FARM_CACHE_CONTAINER_PATH}/matplotlib_config`,
              }
            : {}),
    };
}

export function buildMountPlan(coords: MountPlanCoords, stores: MountPlanStores): MountPlan {
    const { analysisId } = coords;
    // `analysisId` becomes the RO mount point `/{analysisId}` even in read-only
    // mode (where `stepTail` — which validates runId/stepId — is not reached).
    assertSafeId(analysisId, "analysisId");
    const readonlyTreePath = `/${analysisId}`;
    const write = sandboxWriteTail(coords);
    const writableStepPath = write === undefined ? undefined : `${readonlyTreePath}/${write.tail}`;
    const cache = stores.libs && stores.cache === true;

    return {
        readonlyTreePath,
        writableStepPath,
        workingDir: writableStepPath ?? readonlyTreePath,
        libsPath: stores.libs ? LIBS_CONTAINER_PATH : undefined,
        farmPath: stores.libs ? farmContainerPath(stores.toolchainSource) : undefined,
        cachePath: cache ? FARM_CACHE_CONTAINER_PATH : undefined,
        refsPath: stores.refs ? REFS_CONTAINER_PATH : undefined,
        stepSubdirs: write?.subdirs ?? [],
        env: {
            PROVENANCE_WATCH_DIRS: readonlyTreePath,
            ...(stores.libs ? libStoreEnv(stores.toolchainSource, cache) : {}),
        },
    };
}
