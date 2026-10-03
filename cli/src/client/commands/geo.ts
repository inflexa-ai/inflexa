import { fail } from "../../lib/cli.ts";
import { describeClientError } from "../api.ts";
import { resolveAnalysisContext } from "../analyses.ts";
import type { ContextFlags } from "./analyses.ts";

/**
 * The folder that `inflexa geo download` downloads into — the analysis's home folder, not its workspace. The
 * local server resolves it (`POST /api/v1/analyses/resolve`); the download itself runs in this process.
 *
 * Resolution needs an analysis only to reach that folder, so both a resolved analysis and a bare
 * anchor answer the question and neither branch reads the analysis itself. Mirrors how profile/run
 * resolve their target, minus the single-analysis requirement they need and this does not: several
 * analyses in one folder still share the one folder to download into.
 */
export async function resolveGeoDownloadFolder(flags: ContextFlags): Promise<string> {
    const ctx = (await resolveAnalysisContext({ cwd: process.cwd(), ref: flags.analysis, project: flags.project })).match(
        (c) => c,
        (e) => fail(`Could not resolve the folder to download into: ${describeClientError(e)}`),
    );
    switch (ctx.kind) {
        case "analysis":
        case "anchor":
            return ctx.anchorPath;
        case "pick": {
            // Reachable only through an unmatched `--analysis`: `resolveContext` answers with `pick` for a
            // ref that matched nothing or for a `--project`, and this command declares no `--project`. So
            // the ambiguity half of `pick` — "several analyses could match, name one" — cannot arise here,
            // and a message offering `--analysis` to a user who just passed it would be the unhelpful half.
            const known = ctx.analyses.length === 0 ? "" : `\nKnown analyses:\n${ctx.analyses.map((a) => `  - ${a.id}  ${a.name}`).join("\n")}`;
            return fail(`No analysis matches "${flags.analysis}".${known}`);
        }
        case "copy":
            return fail("This folder looks copied — run `inflexa repair` or `inflexa relocate` before downloading into it.");
        case "empty":
            return fail("No analysis here — run `inflexa new` to create one, or pass --analysis <id|name>.");
    }
}
