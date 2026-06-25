import { listRecentAnalyses } from "./analysis.ts";
import { findProjectByRef, getAnchor } from "../../db/primary_query.ts";
import { dieOn, fail } from "../../lib/cli.ts";

/** `inflexa ls [--project <p>]` — list recent analyses, each with its home folder. */
export function runLs(opts: { project?: string }): void {
    let projectId: string | undefined;
    if (opts.project) {
        const project = findProjectByRef(opts.project).match((p) => p, dieOn("Failed to resolve project"));
        if (!project) fail(`No project found matching "${opts.project}".`);
        projectId = project.id;
    }

    listRecentAnalyses({ projectId }).match((analyses) => {
        if (analyses.length === 0) {
            console.log("No analyses found.");
            return;
        }
        console.log(`\n  Analyses (${analyses.length}):\n`);
        for (const a of analyses) {
            const date = new Date(a.createdAt).toLocaleString();
            // Read-only display: use the cached path directly (no reconciliation side effects).
            const anchorPath = getAnchor(a.anchorId).match(
                (anchor) => anchor?.cachedPath ?? "?",
                () => "?",
            );
            console.log(`  ${a.id}  ${a.name}  ${anchorPath}  (${date})`);
        }
        console.log();
    }, dieOn("Failed to list analyses"));
}
