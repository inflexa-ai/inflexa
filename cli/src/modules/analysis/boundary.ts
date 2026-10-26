import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { errnoCode, type FsError } from "../../lib/fs.ts";
import { canonicalPathAsync } from "../../lib/paths.ts";
import { ensureOutputDir, readableWorkspaceRootForAnalysisId, type WorkspaceError } from "./output.ts";
import { resolveInputPath } from "./input.ts";

/** The structural read/write roots for an analysis's agent. */
export type Roots = {
    /** Exactly one: the resolved workspace root. */
    writable: string[];
    /** Declared inputs (resolved absolute) + the workspace root. */
    readable: string[];
};

/**
 * The structural write boundary: the agent's only writable root is the analysis workspace —
 * the same tree that holds staged inputs, run artifacts, and provenance exports; readable
 * roots are the declared inputs plus that workspace. There is no per-input access mode —
 * user data outside the workspace is read-only by construction. An unresolvable or
 * non-writable workspace is an error (there is no substitute writable root).
 */
export function computeRoots(analysis: Analysis): ResultAsync<Roots, WorkspaceError> {
    return ensureOutputDir(analysis).andThen((outDir) =>
        listAnalysisInputs(analysis.id).asyncAndThen((inputs) =>
            new ResultAsync(resolveEach(inputs)).map((resolved): Roots => {
                // Drop inputs whose anchor can't be resolved (null) — they aren't readable until
                // relocated; the CLI surfaces unresolved inputs, this library doesn't print.
                const readableInputs = resolved.filter((p): p is string => p !== null).map((p) => resolve(p));
                const out = resolve(outDir);
                return {
                    writable: [out],
                    readable: [...new Set([...readableInputs, out])],
                };
            }),
        ),
    );
}

/** Resolve each input one at a time, and stop at the first failure: each anchored input can run a bounded search of its own. */
async function resolveEach(inputs: readonly AnalysisInput[]): Promise<Result<(string | null)[], DbError>> {
    const out: (string | null)[] = [];
    for (const input of inputs) {
        const resolved = await resolveInputPath(input);
        if (resolved.isErr()) return err(resolved.error);
        out.push(resolved.value);
    }
    return ok(out);
}

// Boundary-safe containment: a path is inside a root when it equals the root or sits under it
// with a separator boundary, so `/a/bc` is not considered inside `/a/b`.
function contains(root: string, target: string): boolean {
    const r = resolve(root);
    const t = resolve(target);
    if (t === r) return true;
    return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Deny-first. Pure (no filesystem) so they work for write targets that don't exist yet and
 * stay cheap on the agent's hot path. This is an advisory application-layer contract, NOT OS
 * sandboxing — a determined model can still route around it.
 */
export function canWrite(roots: Roots, absPath: string): boolean {
    return roots.writable.some((root) => contains(root, absPath));
}

export function canRead(roots: Roots, absPath: string): boolean {
    return roots.readable.some((root) => contains(root, absPath));
}

/** A root of a read, in the two forms that the real-path test needs. */
export type ReadRoot = {
    /** The root as the lookup gave it. The text test of an absent path runs against this form. */
    text: string;
    /** The root with each symbolic link resolved. The real path of a target is inside this form. */
    canonical: string;
};

/**
 * The verdict of {@link classifyRealPath}. `absent` also tells if the path is inside a root as text, which means
 * with each `.` and `..` resolved and no symbolic link resolved.
 */
export type RealPathVerdict = { type: "in"; realPath: string } | { type: "outside" } | { type: "absent"; insideAsText: boolean };

/** The `realpath` codes that mean the path leads to nothing: it is absent, a part of it is not a folder, or the links loop. */
const ABSENT_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/** The roots of a read, or `"unlimited"` for a read that no root limits. An empty list means that no root admits a path. */
export type ReadRoots = readonly ReadRoot[] | "unlimited";

/**
 * The real-path test of a read: one `realpath` of `absPath` off the event loop, then the boundary-safe `contains`
 * against the canonical form of each root. A real path equal to a root is inside it, thus an input that is one
 * file passes. Each `realpath` failure that is not in {@link ABSENT_CODES} is the error, with its cause.
 * Unlike `computeRoots`, it is not lexical: a symbolic link that leaves the roots is `outside`.
 *
 * With `"unlimited"`, no root limits the read: an existing path is `in` with its real path wherever it leads, and an
 * absent path is `absent` and inside as text. An empty list is different: it admits no path.
 */
export function classifyRealPath(roots: ReadRoots, absPath: string): ResultAsync<RealPathVerdict, FsError> {
    // With no root, each path is outside, and an absent path is outside as text: the answer needs no disk.
    if (roots !== "unlimited" && roots.length === 0) return okAsync({ type: "outside" });
    const inRoots = (root: (r: ReadRoot) => string, path: string): boolean => roots === "unlimited" || roots.some((r) => contains(root(r), path));
    return ResultAsync.fromPromise(realpath(absPath), (cause): FsError => ({ type: "io_failed", op: "classifyRealPath", cause }))
        .map((real): RealPathVerdict => (inRoots((r) => r.canonical, real) ? { type: "in", realPath: real } : { type: "outside" }))
        .orElse((e): ResultAsync<RealPathVerdict, FsError> => {
            if (!ABSENT_CODES.has(errnoCode(e.cause) ?? "")) return errAsync(e);
            return okAsync({ type: "absent", insideAsText: inRoots((r) => r.text, absPath) });
        });
}

/**
 * The root of a read of the workspace of an analysis: its workspace root. It makes no folder, records no
 * sighting, and does not require a writable folder. The error is a `workspace_unavailable` with its message, or a
 * `DbError`.
 */
export function workspaceReadRoot(analysisId: string): ResultAsync<ReadRoot, WorkspaceError> {
    return readableWorkspaceRootForAnalysisId(analysisId).andThen((text) =>
        ResultAsync.fromSafePromise(canonicalPathAsync(text)).map((canonical): ReadRoot => ({ text, canonical })),
    );
}
