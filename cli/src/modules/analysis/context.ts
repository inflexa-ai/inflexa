import { ok, err, type Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import type { AnchorMarker } from "../../types/anchor.ts";
import type { IdOrName } from "../../lib/types.ts";
import type { DbError } from "../../db/errors.ts";
import { dieOn, fail } from "../../lib/cli.ts";
import { findProjectByRef } from "../../db/primary_query.ts";
import { findMarkerUpwards } from "../anchor/marker.ts";
import { classifyMarkerSighting, resolveAnchor, resolvedPathOrCached } from "../anchor/anchor.ts";
import { findAnalysis, listAnalysesForAnchorAt, listRecentAnalyses } from "./analysis.ts";

/** What bare `inflexa` resolves to, by the spec's precedence. Pure data — the picker/prompts/printing live in the CLI/TUI layer. */
export type ResolvedContext =
    | { kind: "analysis"; analysis: Analysis; anchorPath: string } // a single clear target
    | { kind: "anchor"; anchorPath: string; analyses: Analysis[] } // a folder with 0+ analyses → pick/new
    | { kind: "pick"; analyses: Analysis[] } // ambiguous → interactive picker
    | { kind: "copy"; cwd: string; marker: AnchorMarker } // folder is a copy → command prompts re-mint vs fork
    | { kind: "empty"; cwd: string }; // nothing here → offer to start one

/** Flags that override cwd-based resolution; each is an id-or-name reference. */
export type ContextFlags = { analysis?: IdOrName; project?: IdOrName };

/**
 * Decide what bare `inflexa` operates on, by the spec's precedence. Pure data — the picker,
 * prompts, and "loud context" printing live in the CLI/TUI layer.
 */
export function resolveContext(cwd: string, flags: ContextFlags): Result<ResolvedContext, DbError> {
    // 1. Explicit flags win outright.
    if (flags.analysis) {
        return findAnalysis(flags.analysis).andThen((analysis): Result<ResolvedContext, DbError> => {
            // Unmatched flag: surface recent analyses so the command can report the mismatch.
            if (!analysis) return listRecentAnalyses().map((analyses) => ({ kind: "pick", analyses }));
            // The analysis's anchor row may be gone (user edited the DB) — fall back to cwd for display
            // rather than failing; the analysis is still openable.
            return resolveAnchor(analysis.anchorId).map((resolved) => ({
                kind: "analysis",
                analysis,
                anchorPath: resolvedPathOrCached(resolved) ?? cwd,
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
    const markerResult = findMarkerUpwards(cwd);
    if (markerResult.isErr()) return err({ type: "query_failed", op: "resolveContext:marker", cause: markerResult.error });
    const found = markerResult.value;
    if (!found) return ok({ kind: "empty", cwd }); // 3. Nothing here.

    const marker = found.marker;
    return classifyMarkerSighting(found.dir, marker).andThen((sighting): Result<ResolvedContext, DbError> => {
        // Copy guard: never auto-resolve a copied folder — let the command prompt.
        if (sighting === "copy") return ok({ kind: "copy", cwd, marker });
        // A marker on disk whose anchor row the DB no longer has (e.g. the user deleted the DB) is a
        // routine desync, not an error: fall back to the marker's own directory for the anchor path and
        // carry on — listAnalysesForAnchorAt returns nothing, so this resolves to an empty anchor the
        // user can start an analysis in (which re-establishes the row from the marker).
        return resolveAnchor(marker.anchorId).andThen((resolved) => {
            const anchorPath = resolvedPathOrCached(resolved) ?? found.dir;
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

/**
 * Resolve the single analysis a deliberate command operates on, or die with a way
 * forward. Shared by the harness commands (`profile`/`run`/`chat`) and `inputs
 * add`/`remove`/`ls`: an explicit `--analysis` flag or an anchor holding exactly one
 * analysis resolves directly; multiple/ambiguous/empty each fail with the fix. Lives
 * here (not in a command module) so every analysis-scoped command reduces context the
 * same way — `emptyHint` is the only per-command difference (its "how to start" line).
 */
export function resolveSingleAnalysis(flags: ContextFlags, emptyHint: string): Analysis {
    const ctx = resolveContext(process.cwd(), flags).match((c) => c, dieOn("Failed to resolve context"));
    const listCandidates = (analyses: Analysis[]): string => analyses.map((a) => `  - ${a.id}  ${a.name}`).join("\n");
    switch (ctx.kind) {
        case "analysis":
            return ctx.analysis;
        case "anchor": {
            const [only, ...rest] = ctx.analyses;
            if (only && rest.length === 0) return only;
            if (!only) fail("No analyses on this anchor yet. Run `inflexa new` to create one first.");
            fail(`Multiple analyses here — pick one with --analysis <id|name>:\n${listCandidates(ctx.analyses)}`);
            break;
        }
        case "pick":
            fail(`Ambiguous context — pick one with --analysis <id|name>:\n${listCandidates(ctx.analyses)}`);
            break;
        case "empty":
            fail(emptyHint);
            break;
        case "copy":
            fail("This folder is a copied anchor — run `inflexa repair` or `inflexa relocate` first.");
            break;
        default: {
            const exhaustive: never = ctx;
            throw new Error(`unhandled context kind: ${JSON.stringify(exhaustive)}`);
        }
    }
}
