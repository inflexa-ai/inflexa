/**
 * Canonical workspace path resolver — shared between the read surface and
 * the sandbox-gated mutate surface.
 *
 * One module that maps agent-supplied paths to physical session-tree
 * locations under the frame-aware path model (see the harness-workspace-tools spec):
 *
 *   - A **relative** path resolves against the caller's `workingDir` (the
 *     agent's writable working directory; the analysis root when omitted, as
 *     for the conversation agent). Frame-local.
 *   - An **absolute `/{analysisId}/...`** path resolves against the analysis
 *     root regardless of `workingDir`. Frame-independent — the canonical
 *     interchange form for paths crossing an agent or frame boundary.
 *
 * Both surfaces share this resolver, so a file a step writes is read back at
 * the identical path — agreement is structural, not re-implemented per tool.
 * `resolveForWrite` adds confinement: a resolved path outside `workingDir`
 * comes back `out_of_prefix` (the read surface skips that — it roams the tree
 * read-only).
 */

import { relative as relativePath, resolve as resolvePath, sep } from "node:path";

import { previewResourceId } from "@inflexa-ai/harness/contracts/content-url.js";

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
 * that escapes `${sessionsBasePath}/${analysisId}/` (`..` traversal, absolute
 * paths outside the tree, `/{otherAnalysisId}/...`).
 */
export function resolveWorkspacePath(args: {
    readonly sessionsBasePath: string;
    readonly analysisId: string;
    readonly path: string;
    /** Absolute host base that relative paths resolve against. Defaults to the analysis root. */
    readonly workingDir?: string;
}): ResolvedPath {
    const { sessionsBasePath, analysisId, path } = args;

    if (path.length === 0 || path.includes("\0")) return { kind: "out_of_scope" };

    const analysisRoot = resolvePath(sessionsBasePath, analysisId);

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
    readonly sessionsBasePath: string;
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
 * from the session base + analysis/run/step coordinates the workflow owns.
 */
export function stepWritePrefix(args: {
    readonly sessionsBasePath: string;
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
}): string {
    return resolvePath(args.sessionsBasePath, args.analysisId, "runs", args.runId, args.stepId);
}

/**
 * Map a host-side absolute path within the session tree to its in-sandbox
 * absolute path. Each analysis is bind-mounted at `/{analysisId}`, so the
 * session-base-relative tail is identical on both sides — only the root
 * differs. Single source of truth for the `execute_command` / `write_file`
 * cwd and the `{{WORKING_DIR}}` prompt substitution (see the harness-workspace-tools spec).
 */
export function toSandboxPath(sessionsBasePath: string, hostAbsPath: string): string {
    return "/" + relativePath(sessionsBasePath, hostAbsPath).split(sep).join("/");
}

/**
 * Versioned preview directory — consistent path at every layer (URL, PVC, S3).
 * Uses `previewResourceId` from `@inflexa-ai/harness/contracts` so the formula
 * lives in exactly one TypeScript file. Drift against the Go mirror
 * is caught by the shared test vector in react-client.
 */
export function previewVersionDir(resourceId: string, previewId: string, version: number): string {
    return `${previewResourceId(resourceId, previewId)}/v${version}`;
}

/** Preview root for a specific preview (all versions). */
export function previewDir(resourceId: string, previewId: string): string {
    return previewResourceId(resourceId, previewId);
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

function assertSafeId(value: string, label: string): void {
    if (!SAFE_ID.test(value)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
}

/** Input data directory (immutable). */
export function analysisDataDir(resourceId: string): string {
    assertSafeId(resourceId, "resourceId");
    return `${resourceId}/data`;
}

/** Root directory for a specific workflow run. */
export function runDir(resourceId: string, runId: string): string {
    assertSafeId(resourceId, "resourceId");
    assertSafeId(runId, "runId");
    return `${resourceId}/runs/${runId}`;
}

/** Step directory within a run. */
export function runStepDir(resourceId: string, runId: string, stepId: string): string {
    assertSafeId(resourceId, "resourceId");
    assertSafeId(runId, "runId");
    assertSafeId(stepId, "stepId");
    return `${resourceId}/runs/${runId}/${stepId}`;
}

/** Step subdirectory for a specific artifact type. */
export type StepSubdirType = "scripts" | "output" | "figures" | "logs" | "notebooks";

export function stepSubdir(stepBase: string, type: StepSubdirType): string {
    return `${stepBase}/${type}`;
}

/** Report output directory. */
export function reportDir(resourceId: string, reportId: string): string {
    assertSafeId(resourceId, "resourceId");
    assertSafeId(reportId, "reportId");
    return `${resourceId}/reports/${reportId}`;
}

/** All previews for an analysis (authorization boundary). */
export function previewsForAnalysis(resourceId: string): string {
    assertSafeId(resourceId, "resourceId");
    return `previews/${resourceId}`;
}

/** All standard subdirectory types for a step. */
export const STEP_SUBDIRS: readonly StepSubdirType[] = ["scripts", "output", "figures", "logs", "notebooks"] as const;

/** Get all subdirectory paths for a step. */
export function allStepSubdirs(stepBase: string): string[] {
    return STEP_SUBDIRS.map((type) => stepSubdir(stepBase, type));
}
