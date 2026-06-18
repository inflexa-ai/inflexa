import { ok, err, type Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import type { AnchorMarker } from "../../types/anchor.ts";
import type { IdOrName } from "../../lib/types.ts";
import type { DbError } from "../../db/errors.ts";
import { findProjectByRef } from "../../db/primary_query.ts";
import { findMarkerUpwards } from "../anchor/marker.ts";
import { classifyMarkerSighting, resolveAnchor } from "../anchor/anchor.ts";
import { findAnalysis, listAnalysesForAnchorAt, listRecentAnalyses } from "./analysis.ts";

/** What bare `inf` resolves to, by the spec's precedence. Pure data — the picker/prompts/printing live in the CLI/TUI layer. */
export type ResolvedContext =
    | { kind: "analysis"; analysis: Analysis; anchorPath: string } // a single clear target
    | { kind: "anchor"; anchorPath: string; analyses: Analysis[] } // a folder with 0+ analyses → pick/new
    | { kind: "pick"; analyses: Analysis[] } // ambiguous → interactive picker
    | { kind: "copy"; cwd: string; marker: AnchorMarker } // folder is a copy → command prompts re-mint vs fork
    | { kind: "empty"; cwd: string }; // nothing here → offer to start one

/** Flags that override cwd-based resolution; each is an id-or-name reference. */
export type ContextFlags = { analysis?: IdOrName; project?: IdOrName };

/**
 * Decide what bare `inf` operates on, by the spec's precedence. Pure data — the picker,
 * prompts, and "loud context" printing live in the CLI/TUI layer.
 */
export function resolveContext(cwd: string, flags: ContextFlags): Result<ResolvedContext, DbError> {
    // 1. Explicit flags win outright.
    if (flags.analysis) {
        return findAnalysis(flags.analysis).andThen((analysis): Result<ResolvedContext, DbError> => {
            // Unmatched flag: surface recent analyses so the command can report the mismatch.
            if (!analysis) return listRecentAnalyses().map((analyses) => ({ kind: "pick", analyses }));
            return resolveAnchor(analysis.anchorId).map(({ anchor, path }) => ({
                kind: "analysis",
                analysis,
                anchorPath: path ?? anchor.cachedPath,
            }));
        });
    }
    if (flags.project) {
        return findProjectByRef(flags.project).andThen((project): Result<ResolvedContext, DbError> => {
            if (!project) return ok({ kind: "pick", analyses: [] }); // unknown project → empty picker
            return listRecentAnalyses({ projectId: project.id }).map((analyses) => ({ kind: "pick", analyses }));
        });
    }

    // 2. The folder (or an ancestor) is an anchor.
    let found: ReturnType<typeof findMarkerUpwards>;
    try {
        found = findMarkerUpwards(cwd);
    } catch (cause) {
        return err({ type: "query_failed", op: "resolveContext:marker", cause });
    }
    if (!found) return ok({ kind: "empty", cwd }); // 3. Nothing here.

    const marker = found.marker;
    return classifyMarkerSighting(found.dir, marker).andThen((sighting): Result<ResolvedContext, DbError> => {
        // Copy guard: never auto-resolve a copied folder — let the command prompt.
        if (sighting === "copy") return ok({ kind: "copy", cwd, marker });
        return resolveAnchor(marker.anchorId).andThen(({ anchor, path }) => {
            const anchorPath = path ?? anchor.cachedPath;
            return listAnalysesForAnchorAt(cwd).map((analyses): ResolvedContext => {
                const [only] = analyses;
                if (analyses.length === 1 && only) return { kind: "analysis", analysis: only, anchorPath };
                return { kind: "anchor", anchorPath, analyses };
            });
        });
    });
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** One-line, human-readable summary printed before any action (the spec's loud context). */
export function describeContext(ctx: ResolvedContext): string {
    switch (ctx.kind) {
        case "analysis":
            return `context: analysis "${ctx.analysis.name}" — ${ctx.anchorPath}`;
        case "anchor":
            return `context: anchor ${ctx.anchorPath} (${plural(ctx.analyses.length, "analysis", "analyses")})`;
        case "pick":
            return `context: pick (${plural(ctx.analyses.length, "candidate", "candidates")})`;
        case "copy":
            return `context: copied folder ${ctx.cwd} — re-mint or fork before use`;
        case "empty":
            return `context: empty — ${ctx.cwd} (no analysis here; start one?)`;
    }
}
