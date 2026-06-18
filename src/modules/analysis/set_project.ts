import { findAnalysis } from "./analysis.ts";
import { findProjectByRef } from "../../db/primary_query.ts";
import { updateAnalysisProject } from "../../db/primary_mutation.ts";
import { dieOn, fail } from "../../lib/cli.ts";
import type { IdOrName } from "../../lib/types.ts";

/**
 * `inf analysis set-project <analysis> [project]` — attach/move/clear an analysis's grouping.
 * A missing `projectRef` clears it.
 */
export function runSetProject(analysisRef: IdOrName, projectRef: IdOrName | null): void {
    const analysis = findAnalysis(analysisRef).match((a) => a, dieOn("Failed to resolve analysis"));
    if (!analysis) fail(`No analysis found matching "${analysisRef}".`);
    const label = analysis.name;

    // Resolve the target project BEFORE touching the analysis's link, so a failed lookup
    // exits (via fail()) without ever clearing project_id — the analysis is never left
    // orphaned on the way to a project that turns out not to exist. A null projectRef is
    // the explicit "clear" request.
    const project = projectRef ? findProjectByRef(projectRef).match((p) => p, dieOn("Failed to resolve project")) : null;
    if (projectRef && !project) fail(`No project found matching "${projectRef}".`);

    // One atomic write: set to the resolved project, or clear when none was given.
    updateAnalysisProject(analysis.id, project?.id ?? null).match(
        () => console.log(project ? `Set the project of "${label}" to "${project.name}".` : `Cleared the project of "${label}".`),
        (error) => fail(`Failed to ${project ? "set" : "clear"} project: ${error.type}`, error.cause),
    );
}
