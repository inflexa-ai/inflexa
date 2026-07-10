import { resolve, sep } from "node:path";
import { Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { ensureOutputDir, type WorkspaceError } from "./output.ts";
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
export function computeRoots(analysis: Analysis): Result<Roots, WorkspaceError> {
    return ensureOutputDir(analysis).andThen((outDir) =>
        listAnalysisInputs(analysis.id).andThen((inputs) =>
            Result.combine(inputs.map((i) => resolveInputPath(i))).map((resolved): Roots => {
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
