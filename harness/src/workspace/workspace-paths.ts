/**
 * Workspace paths — single source of truth for all agent-visible paths.
 *
 * Composes mount points (buildMountPaths()) with step subdirectory types
 * (STEP_SUBDIRS) into the full paths that agents use in workspace tools.
 *
 * Import from here — not from mount-strategy or paths directly — when
 * you need paths that agents will see.
 */

import { buildMountPaths } from "./mount-strategy.js";
import { STEP_SUBDIRS, type StepSubdirType } from "./paths.js";

export { buildMountPaths };
export { STEP_SUBDIRS, type StepSubdirType };

/**
 * Build artifact subdirectory paths for a step using canonical mount paths.
 * Agents see these paths in workspace tools and prompts.
 */
export function buildArtifactDirs(resourceId: string, runId: string, stepId: string) {
    const mp = buildMountPaths(resourceId, runId, stepId);
    return {
        OUTPUT: `${mp.ARTIFACTS}/output`,
        SCRIPTS: `${mp.ARTIFACTS}/scripts`,
        FIGURES: `${mp.ARTIFACTS}/figures`,
        LOGS: `${mp.ARTIFACTS}/logs`,
        NOTEBOOKS: `${mp.ARTIFACTS}/notebooks`,
    } as const;
}

/** Resolved sessions base path. */
export function sessionsBasePath(sessionsBasePath: string): string {
    return sessionsBasePath;
}
