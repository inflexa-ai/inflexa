/**
 * Canonical workspace path resolver — shared between the read surface and
 * the sandbox-gated mutate surface.
 *
 * One module that maps agent-supplied paths to physical workspace-tree
 * locations under the frame-aware path model (see the harness-workspace-tools spec):
 *
 *   - A **relative** path resolves against the caller's `workingDir` (the
 *     agent's writable working directory; the analysis root when omitted, as
 *     for the conversation agent). Frame-local.
 *   - An **absolute `/{analysisId}/...`** path resolves against the analysis
 *     root regardless of `workingDir`. Frame-independent — the canonical
 *     interchange form for paths crossing an agent or frame boundary.
 *
 * The analysis root itself comes from the embedder through the
 * {@link ResolveWorkspaceRoot} seam — the harness owns the layout *inside*
 * the root, the embedder owns *where* the root lives. Host paths carry no
 * `{resourceId}` segment (the resolved root already identifies the resource);
 * the `/{resourceId}/…` form survives only as the container-side view, which
 * bind mounts keep independent of the host location.
 *
 * Both surfaces share this resolver, so a file a step writes is read back at
 * the identical path — agreement is structural, not re-implemented per tool.
 * `resolveForWrite` adds confinement: a resolved path outside `workingDir`
 * comes back `out_of_prefix` (the read surface skips that — it roams the tree
 * read-only).
 */

import { relative as relativePath, resolve as resolvePath, sep } from "node:path";

/**
 * The workspace-root resolution seam (see the workspace-root-resolution spec).
 *
 * Maps a resource id to the absolute host directory of that resource's
 * workspace tree. Supplied by the embedder at the composition root and closed
 * over once at workflow registration — the *function* is fixed per process,
 * its *result* varies per resource, which is what makes per-resource roots
 * compatible with DBOS's register-once model.
 *
 * Realization contract:
 *   - **Injective** — two live resources never resolve to the same root; the
 *     harness treats the root as exclusively owned and does not verify this.
 *   - **Durable-state-backed** — resolve from host state that survives the
 *     process (a DB row, a config map), never process memory, so a recovered
 *     workflow on a fresh process resolves correctly.
 *   - **Stable while the resource has an active run** — derived paths are
 *     recorded in durable step outputs; preventing mid-run moves is the
 *     embedder's job.
 *   - **Throws on unknown resources** — inside DBOS bodies the failure must
 *     cross the step boundary as a throw so the step is durably recorded as
 *     failed (see `lib/result.ts` house rules).
 */
export type ResolveWorkspaceRoot = (resourceId: string) => string;

/** Result of resolving a workspace path against the canonical layout. */
export type ResolvedPath = { readonly kind: "ok"; readonly absolute: string; readonly relative: string } | { readonly kind: "out_of_scope" };

/**
 * Result of resolving a path for a *write*: scope resolution plus confinement
 * to the caller's `workingDir`. `out_of_prefix` (in-tree but outside the
 * working directory) is distinct from `out_of_scope` (escaped the analysis
 * tree) so the model can correct toward its working directory rather than
 * guessing why the write failed. Both are data variants — never throws.
 */
export type WriteResolvedPath =
    { readonly kind: "ok"; readonly absolute: string; readonly relative: string } | { readonly kind: "out_of_scope" } | { readonly kind: "out_of_prefix" };

/**
 * Resolve an agent-supplied path against the analysis tree under the
 * frame-aware model.
 *
 *   - **Relative** (no leading slash) → resolved against `workingDir`
 *     (defaults to the analysis root). E.g. with `workingDir` =
 *     `…/runs/{runId}/{stepId}`, `"output/x.csv"` → that step's output dir.
 *   - **Absolute `/{analysisId}/...`** → resolved against the analysis root,
 *     ignoring `workingDir`. Frame-independent.
 *
 * The returned `relative` is always **analysis-root-relative** (used to build
 * the in-sandbox `/{analysisId}/…` path). Returns `out_of_scope` for any input
 * that escapes the resolved workspace root (`..` traversal, absolute host
 * paths outside the tree, `/{otherAnalysisId}/...`).
 */
export function resolveWorkspacePath(args: {
    /** Absolute host root of the analysis's workspace tree (from the embedder's resolver). */
    readonly workspaceRoot: string;
    readonly analysisId: string;
    readonly path: string;
    /** Absolute host base that relative paths resolve against. Defaults to the analysis root. */
    readonly workingDir?: string;
}): ResolvedPath {
    const { workspaceRoot, analysisId, path } = args;

    if (path.length === 0 || path.includes("\0")) return { kind: "out_of_scope" };

    const analysisRoot = resolvePath(workspaceRoot);

    let absolute: string;
    if (path.startsWith("/")) {
        const stripped = stripAnalysisRoot(path, analysisId);
        if (stripped === null) return { kind: "out_of_scope" };
        absolute = resolvePath(analysisRoot, stripped);
    } else {
        const base = args.workingDir ?? analysisRoot;
        absolute = resolvePath(base, path);
    }

    if (absolute !== analysisRoot && !absolute.startsWith(analysisRoot + sep)) {
        return { kind: "out_of_scope" };
    }

    const relative = absolute === analysisRoot ? "" : absolute.slice(analysisRoot.length + 1);
    return { kind: "ok", absolute, relative };
}

/**
 * Resolve a path for a write: same frame-aware resolution as
 * `resolveWorkspacePath` (relative → `workingDir`, absolute → analysis root),
 * then confine the result to `workingDir`. A `..` escape from the tree is
 * `out_of_scope`; an in-tree path outside the working directory is
 * `out_of_prefix`. A path equal to `workingDir` itself is in-prefix.
 *
 * `workingDir` is the absolute host path of the agent's writable working
 * directory (for a plannable step, `stepWritePrefix(...)`).
 */
export function resolveForWrite(args: {
    /** Absolute host root of the analysis's workspace tree (from the embedder's resolver). */
    readonly workspaceRoot: string;
    readonly analysisId: string;
    readonly path: string;
    readonly workingDir: string;
}): WriteResolvedPath {
    const resolved = resolveWorkspacePath(args);
    if (resolved.kind === "out_of_scope") return { kind: "out_of_scope" };

    const prefix = resolvePath(args.workingDir);
    if (resolved.absolute !== prefix && !resolved.absolute.startsWith(prefix + sep)) {
        return { kind: "out_of_prefix" };
    }
    return { kind: "ok", absolute: resolved.absolute, relative: resolved.relative };
}

/**
 * Derive the canonical writable-prefix absolute path for a sandbox step.
 * Single source of truth — the agent does NOT supply this; it is computed
 * from the workspace root + run/step coordinates the workflow owns.
 */
export function stepWritePrefix(args: { readonly workspaceRoot: string; readonly runId: string; readonly stepId: string }): string {
    // `stepId` originates in an LLM-authored plan; validate before it becomes a
    // host directory path (this prefix is the mkdir target and the docker bind
    // source) so a crafted `..`/`/` segment cannot widen or escape the mount.
    assertSafeId(args.runId, "runId");
    assertSafeId(args.stepId, "stepId");
    return resolvePath(args.workspaceRoot, "runs", args.runId, args.stepId);
}

/**
 * Map a host-side absolute path within an analysis's workspace tree to its
 * in-sandbox absolute path. The tree is bind-mounted at `/{resourceId}`, so
 * the sandbox path is the resource id plus the root-relative tail — the host
 * location of the root never leaks into the container. Single source of truth
 * for the `execute_command` / `write_file` cwd and for the working directory
 * a step briefing names (see the harness-workspace-tools spec).
 */
export function toSandboxPath(workspaceRoot: string, resourceId: string, hostAbsPath: string): string {
    const tail = relativePath(workspaceRoot, hostAbsPath).split(sep).join("/");
    // A `..`-leading tail means `hostAbsPath` is not under `workspaceRoot`; every
    // current caller passes an in-tree path (a step write prefix), so this is a
    // guard against a future miswire producing `/{resourceId}/../…`, not a
    // reachable case today.
    if (tail === ".." || tail.startsWith("../")) {
        throw new Error(`toSandboxPath: host path escapes the workspace root: ${hostAbsPath}`);
    }
    return tail === "" ? `/${resourceId}` : `/${resourceId}/${tail}`;
}

/**
 * Parent of every preview, workspace-root-relative. Callers that enumerate
 * previews join this; callers that address one join {@link previewDir}. Both
 * spell the segment through this constant so the tree has one owner.
 */
export const PREVIEWS_ROOT = "previews";

/**
 * Versioned preview directory, workspace-root-relative. Previews live inside
 * the analysis tree (`previews/{previewId}/v{N}`); the content-token `res`
 * claim keeps the separate `previews/{analysisId}/{previewId}` formula in
 * `contracts/content-url.ts` — that is URL space, not a filesystem sub-path,
 * and hosts that serve previews map one onto the other themselves.
 */
export function previewVersionDir(previewId: string, version: number): string {
    return `${previewDir(previewId)}/v${version}`;
}

/** Preview root for a specific preview (all versions), workspace-root-relative. */
export function previewDir(previewId: string): string {
    assertSafeId(previewId, "previewId");
    return `${PREVIEWS_ROOT}/${previewId}`;
}

/**
 * Find the highest version number from a list of version directory names.
 * Expects names like "v1", "v2", etc. Returns 0 if no versions found.
 */
export function latestPreviewVersion(dirNames: string[]): number {
    let max = 0;
    for (const name of dirNames) {
        const match = name.match(/^v(\d+)$/);
        if (match) {
            const n = parseInt(match[1], 10);
            if (n > max) max = n;
        }
    }
    return max;
}

/**
 * For an analysis-rooted input (`/{analysisId}/...`), strip the leading
 * `/{analysisId}/` segment so it can be resolved relative to the analysis
 * root. Returns `null` if the first segment does not match `analysisId` —
 * paths under a different analysis or system paths like `/etc/passwd` are
 * rejected here.
 */
function stripAnalysisRoot(path: string, analysisId: string): string | null {
    const withoutLead = path.slice(1);
    const slashIdx = withoutLead.indexOf("/");
    const firstSegment = slashIdx === -1 ? withoutLead : withoutLead.slice(0, slashIdx);
    if (firstSegment !== analysisId) return null;
    return slashIdx === -1 ? "" : withoutLead.slice(slashIdx + 1);
}

const SAFE_ID = /^[\w.-]+$/;

/**
 * True when `value` is a safe single path segment: the `SAFE_ID` charset (word
 * chars, `.`, `-` — no slash, NUL, or shell-hostile char) AND not a pure-dot
 * segment (`.`/`..`), which the charset otherwise admits and which `resolve`/`join`
 * would treat as the current/parent directory and use to climb the tree. The one
 * definition of "safe id", shared by the throwing {@link assertSafeId} at path
 * builders and the plan validator (`validate-plan.ts`), so a stepId is judged the
 * same at plan time and at mount time.
 */
export function isSafeId(value: string): boolean {
    return SAFE_ID.test(value) && value !== "." && value !== "..";
}

/**
 * Throwing form of {@link isSafeId} for the mount/host-path builders. Ids are
 * harness-minted UUIDs on every trusted path, but `stepId` reaches these builders
 * straight from an LLM-authored plan, so this is the boundary that keeps a crafted
 * id from re-rooting a mount or a host write. Exported so the mount-plan builders
 * (the container-path source of truth) validate the same way.
 */
export function assertSafeId(value: string, label: string): void {
    if (!isSafeId(value)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
}

/** Root directory for a specific workflow run, workspace-root-relative. */
export function runDir(runId: string): string {
    assertSafeId(runId, "runId");
    return `runs/${runId}`;
}

/** Step directory within a run, workspace-root-relative. */
export function runStepDir(runId: string, stepId: string): string {
    assertSafeId(runId, "runId");
    assertSafeId(stepId, "stepId");
    return `runs/${runId}/${stepId}`;
}

/** Step subdirectory for a specific artifact type. */
export type StepSubdirType = "scripts" | "output" | "figures" | "logs" | "notebooks";

export function stepSubdir(stepBase: string, type: StepSubdirType): string {
    return `${stepBase}/${type}`;
}

/** Report output directory, workspace-root-relative. */
export function reportDir(reportId: string): string {
    assertSafeId(reportId, "reportId");
    return `reports/${reportId}`;
}

/** All standard subdirectory types for a step. */
export const STEP_SUBDIRS: readonly StepSubdirType[] = ["scripts", "output", "figures", "logs", "notebooks"] as const;

/**
 * Reserved id of the run-phase synthesis row in `cortex_step_executions` — the
 * ledger row `executeAnalysis` writes for run-level synthesis so progress
 * readers see the phase. Reserved here beside {@link STEP_SUBDIRS} because the
 * reservation is a layout fact as much as a ledger one: a plan step with this
 * id would collide with the row's primary key AND put its step directory
 * `runs/{runId}/synthesis/` beside the run-level `runs/{runId}/synthesis.json`.
 * Plan validation rejects it (see validate-plan).
 */
export const SYNTHESIS_STEP_ID = "synthesis";

/** Get all subdirectory paths for a step. */
export function allStepSubdirs(stepBase: string): string[] {
    return STEP_SUBDIRS.map((type) => stepSubdir(stepBase, type));
}
