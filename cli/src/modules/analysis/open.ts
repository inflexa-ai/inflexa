import { ok, err, type Result } from "neverthrow";
import { findAnalysis } from "./analysis.ts";
import { ensureOutputDir } from "./output.ts";
import { dieOn, fail } from "../../lib/cli.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { IdOrName } from "../../lib/types.ts";
import type { WorkspaceError } from "./output.ts";

/**
 * The OS-specific argv that opens `dir` in the file browser. `platform` defaults to the running OS
 * (the opener is derived from the OS, not config, so it stays out of env.ts); it is a parameter only
 * so tests can exercise each branch without mutating the global `process.platform`.
 */
export function openerArgv(dir: string, platform: NodeJS.Platform = process.platform): string[] {
    switch (platform) {
        case "darwin":
            return ["open", dir];
        case "win32":
            return ["cmd", "/c", "start", "", dir];
        default:
            return ["xdg-open", dir];
    }
}

/**
 * Spawn the OS opener for `dir`, Result-wrapped: `Bun.spawn` throws synchronously when the
 * opener binary is missing (ENOENT — e.g. a headless Linux box without xdg-open), and callers
 * inside key handlers must surface that as a notice, never a crash.
 */
export function openInFileBrowser(dir: string): Result<void, Error> {
    try {
        Bun.spawn(openerArgv(dir), { stdout: "ignore", stderr: "ignore" });
        return ok(undefined);
    } catch (cause) {
        return err(cause instanceof Error ? cause : new Error(String(cause)));
    }
}

/**
 * Ensure an analysis's workspace root exists and open it in the OS file browser; returns the
 * opened path. The revealed directory is the analysis's single tree — staged inputs (`data/`),
 * run artifacts (`runs/`), reports, and provenance exports. Library-pure (no stdout, no process
 * exit) so both the `inflexa open` CLI adapter and the in-app command palette can call it.
 */
export function openOutputDir(analysis: Analysis): Result<string, WorkspaceError> {
    // ensure (not just resolve) — the directory must exist to be opened.
    return ensureOutputDir(analysis).map((dir) => {
        try {
            Bun.spawn(openerArgv(dir), { stdout: "inherit", stderr: "inherit" });
        } catch {
            // Fire-and-forget: a missing opener (ENOENT) is not worth crashing for.
        }
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
