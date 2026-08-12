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
import type { FarmSource, ResolveAnalysisFarm } from "./types.js";

export const STEP_SUBDIRS = ["output", "scripts", "figures", "logs", "notebooks"] as const;

const LIBS_CONTAINER_PATH = "/mnt/libs";
/**
 * Container path of the farm of the analysis. It nests inside the store mount.
 * The image bakes this path into `R_LIBS_SITE` and into the Python `.pth`, and
 * the warm caches key on it. Thus it is a constant of the container contract: a
 * per-analysis farm arrives as a mount at this path, never at a path of its own.
 */
const FARM_CONTAINER_PATH = `${LIBS_CONTAINER_PATH}/current`;
const REFS_CONTAINER_PATH = "/mnt/refs";

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
    /**
     * Container path of the farm of the analysis, nested inside the lib store.
     * Present only when `libs`. A backend mounts the farm here when its farm
     * provider names one.
     */
    farmPath?: string;
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
 *
 * `PATH` and `NODE_PATH` name a path in the runtime image, never a path under
 * `/mnt/libs`. The store carries packages only; the image owns the conda track at
 * `/opt/conda` and the Node track at `/opt/node`. A store mounts read-only over
 * `/mnt/libs`, so a store-relative `PATH` here would remove the command-line tools
 * of the image from every sandbox that has a store.
 */
function libStoreEnv(): Record<string, string> {
    return {
        R_LIBS_SITE: `${FARM_CONTAINER_PATH}/r/github:${FARM_CONTAINER_PATH}/r/bioconductor:${FARM_CONTAINER_PATH}/r/cran`,
        NODE_PATH: "/opt/node/node_modules",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/conda/bin",
    };
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
        farmPath: stores.libs ? FARM_CONTAINER_PATH : undefined,
        refsPath: stores.refs ? REFS_CONTAINER_PATH : undefined,
        stepSubdirs: readOnly ? [] : STEP_SUBDIRS,
        env: {
            PROVENANCE_WATCH_DIRS: readonlyTreePath,
            ...(stores.libs ? libStoreEnv() : {}),
        },
    };
}

/**
 * The provider that a farm source names, or `undefined` when the store root is
 * itself the farm.
 *
 * The three kinds of {@link FarmSource} collapse to one question for a backend:
 * is there a farm to mount inside the store mount, and where. `store-root` gives
 * no provider, thus the backend makes one mount and the nested mount never
 * appears. The other two give a provider, and the backend treats them alike.
 *
 * `fixed` becomes a provider that ignores its analysis id. That keeps ONE code
 * path in each backend, thus a managed deployment that serves one farm and a CLI
 * that composes one for each analysis exercise the same mount code.
 */
export function farmProviderOf(source: FarmSource | undefined): ResolveAnalysisFarm | undefined {
    if (source === undefined) return undefined;
    switch (source.kind) {
        case "store-root":
            return undefined;
        case "fixed":
            return () => ({ kind: "farm", location: source.location });
        case "per-analysis":
            return source.resolve;
        default: {
            // The union is closed, thus the compiler proves that this is unreachable.
            const unreachable: never = source;
            throw new Error(`unhandled farm source: ${JSON.stringify(unreachable)}`);
        }
    }
}
