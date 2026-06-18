import { findAnalysis } from "./analysis.ts";
import { ensureOutputDir } from "./output.ts";
import { dieOn, fail } from "../../lib/cli.ts";
import type { IdOrName } from "../../lib/types.ts";

// Platform opener: derived from the running OS (not config), so it stays out of env.ts.
function openerArgv(dir: string): string[] {
    switch (process.platform) {
        case "darwin":
            return ["open", dir];
        case "win32":
            return ["cmd", "/c", "start", "", dir];
        default:
            return ["xdg-open", dir];
    }
}

/** `inf open <id|name>` — open an analysis's output directory in the OS file browser. */
export function runOpen(idOrName: IdOrName): void {
    const analysis = findAnalysis(idOrName).match((a) => a, dieOn("Failed to resolve analysis"));
    if (!analysis) fail(`No analysis found matching "${idOrName}".`);

    // ensure (not just resolve) — the directory must exist to be opened.
    const dir = ensureOutputDir(analysis).match((d) => d, dieOn("Failed to prepare output directory"));
    console.log(dir);
    Bun.spawn(openerArgv(dir), { stdout: "inherit", stderr: "inherit" });
}
