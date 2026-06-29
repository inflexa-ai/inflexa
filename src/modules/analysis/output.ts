import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ok, type Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { env } from "../../lib/env.ts";
import { isDirWritable } from "../anchor/marker.ts";
import { resolveAnchor } from "../anchor/anchor.ts";

/**
 * An analysis's default output sub-path under its anchor: `.inflexa/analyses/<slug>`. The single
 * source of this layout — shared by {@link resolveOutputDir} and provenance source-analysis
 * detection (which matches a stored input ref against it without resolving the anchor).
 */
export function defaultOutputSubdir(slug: string): string {
    return join(".inflexa", "analyses", slug);
}

/**
 * Decide an analysis's output dir (does not create it). Three cases, in order:
 * 1. explicit override / prior fallback already recorded on the analysis;
 * 2. anchor resolves and is writable → beside the data under `.inflexa/`;
 * 3. fallback to managed storage so every analysis always has somewhere to write.
 */
export function resolveOutputDir(analysis: Analysis): Result<string, DbError> {
    if (analysis.outputDirectory !== null) return ok(analysis.outputDirectory);

    // A missing/unlocatable anchor (null resolved, or null path) falls through to managed storage —
    // the same path as a non-writable anchor folder, so outputs always have somewhere to go.
    return resolveAnchor(analysis.anchorId).map((resolved) => {
        const path = resolved?.path ?? null;
        if (path !== null && isDirWritable(path)) {
            return join(path, defaultOutputSubdir(analysis.slug));
        }
        return join(env.outputFallbackDir, analysis.slug);
    });
}

/**
 * `resolveOutputDir` + `mkdir -p` (idempotent). The output dir is the only writable target
 * (the write boundary); nothing here touches source data.
 */
export function ensureOutputDir(analysis: Analysis): Result<string, DbError> {
    return resolveOutputDir(analysis).map((dir) => {
        mkdirSync(dir, { recursive: true });
        return dir;
    });
}
