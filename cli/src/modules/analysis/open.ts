import { ok, type Result } from "neverthrow";
import { findAnalysis } from "./analysis.ts";
import { ensureOutputDir, locateExistingOutputDir } from "./output.ts";
import { openExternal } from "../../lib/open_external.ts";
import { dieOn, fail } from "../../lib/cli.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { IdOrName } from "../../lib/types.ts";
import type { WorkspaceError } from "./output.ts";

/**
 * Open an analysis's workspace root in the OS file browser; returns the opened path. The revealed
 * directory is the analysis's single tree — staged inputs (`data/`), run artifacts (`runs/`),
 * reports, and provenance exports. Library-pure (no stdout, no process exit) so both the
 * `inflexa open` CLI adapter and the in-app command palette can call it.
 *
 * An already-materialized tree is revealed as-is — a home folder that later went read-only must
 * not block opening results the user already produced. Only when nothing exists yet do we
 * materialize it, which needs a writable folder and surfaces the actionable non-writable error.
 */
export function openOutputDir(analysis: Analysis): Result<string, WorkspaceError> {
    return locateExistingOutputDir(analysis)
        .andThen((existing): Result<string, WorkspaceError> => (existing !== null ? ok(existing) : ensureOutputDir(analysis)))
        .map((dir) => {
            // Fire-and-forget reveal: a missing opener (ENOENT) is not worth crashing for — the caller
            // still gets the resolved dir to print, and under WSL this routes through wslview/explorer.exe.
            openExternal(dir).match(
                () => {},
                () => {},
            );
            return dir;
        });
}

/** `inflexa open <id|name>` — open an analysis's workspace in the OS file browser. */
export function runOpen(idOrName: IdOrName): void {
    const analysis = findAnalysis(idOrName).match((a) => a, dieOn("Failed to resolve analysis"));
    if (!analysis) fail(`No analysis found matching "${idOrName}".`);

    const dir = openOutputDir(analysis).match(
        (d) => d,
        (e) => (e.type === "workspace_unavailable" ? fail(e.message) : fail(`Failed to prepare the analysis workspace (${e.type})`, e.cause)),
    );
    console.log(dir);
}
