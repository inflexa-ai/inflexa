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

    // TODO(slop): This is not ok, we first unlink the analysis from it's current project, and then re-link it?
    // But if we fail to find the project, that analysis will now be orphaned.
    if (!projectRef) {
        updateAnalysisProject(analysis.id, null).match(
            () => console.log(`Cleared the project of "${label}".`),
            (error) => fail(`Failed to clear project: ${error.type}`, error.cause),
        );
        return;
    }

    const project = findProjectByRef(projectRef).match((p) => p, dieOn("Failed to resolve project"));
    if (!project) fail(`No project found matching "${projectRef}".`);
    updateAnalysisProject(analysis.id, project.id).match(
        () => console.log(`Set the project of "${label}" to "${project.name}".`),
        (error) => fail(`Failed to set project: ${error.type}`, error.cause),
    );
}
