import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ok, type Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { env } from "../../lib/env.ts";
import { isDirWritable } from "../anchor/marker.ts";
import { resolveAnchor } from "../anchor/anchor.ts";

/**
 * Decide an analysis's output dir (does not create it). Three cases, in order:
 * 1. explicit override / prior fallback already recorded on the analysis;
 * 2. anchor resolves and is writable → beside the data under `.inf/`;
 * 3. fallback to managed storage so every analysis always has somewhere to write.
 */
export function resolveOutputDir(analysis: Analysis): Result<string, DbError> {
    if (analysis.outputDirectory !== null) return ok(analysis.outputDirectory);

    return resolveAnchor(analysis.anchorId).map(({ path }) => {
        if (path !== null && isDirWritable(path)) {
            return join(path, ".inf", "analyses", analysis.slug);
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
