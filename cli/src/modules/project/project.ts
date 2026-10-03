import { findProjectByRef } from "../../db/primary_query.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Project } from "../../types/project.ts";

/**
 * Resolve an analysis's linked project. A pure read — writes no anchor marker, so it is safe in
 * passive flows (the no-litter rule). `null` when the analysis has no project or the lookup fails.
 */
export function projectForAnalysis(analysis: Analysis | null): Project | null {
    if (!analysis?.projectId) return null;
    return findProjectByRef(analysis.projectId).match(
        (p) => p,
        () => null,
    );
}
