/**
 * Mount strategy — single source of truth for workspace/pod mount paths.
 *
 * Single-mount model: one workspace mount covers the full analysis tree.
 * Write protection is enforced via K8s RO volumeMount (execute_command) and
 * by the harness write guard at the workspace-filesystem layer. Pod mounts
 * are nested (K8s handles this fine — most-specific path wins).
 */

import { runStepDir } from "./paths.js";
import { join } from "node:path";

// ── Mount Path Builders ──────────────────────────────────────────────────

/**
 * Canonical paths for a step.
 *
 * ANALYSIS is the single workspace mount (covers the full analysis tree).
 * ARTIFACTS is a subpath within that mount (the step's writable area, used as CWD).
 */
export function buildMountPaths(resourceId: string, runId: string, stepId: string) {
    return {
        /** Full analysis tree — single workspace mount. */
        ANALYSIS: `/${resourceId}`,
        /** Step's writable area — subpath within ANALYSIS, used as CWD. */
        ARTIFACTS: `/${runStepDir(resourceId, runId, stepId)}`,
    } as const;
}

// ── Types ───────────────────────────────────────────────────────────────

export interface PodMount {
    mountPath: string;
    subPath: string;
    readOnly: boolean;
}

export interface DockerMount {
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
}

// ── Pod mounts ──────────────────────────────────────────────────────────

/**
 * Build pod volumeMount specs — nested: full analysis (RO) + step area (RW).
 * K8s handles nested mounts — the most-specific path wins.
 */
export function buildPodMounts(opts: { resourceId: string; runId: string; stepId: string }): PodMount[] {
    const mp = buildMountPaths(opts.resourceId, opts.runId, opts.stepId);
    return [
        {
            mountPath: mp.ANALYSIS,
            subPath: opts.resourceId,
            readOnly: true,
        },
        {
            mountPath: mp.ARTIFACTS,
            subPath: runStepDir(opts.resourceId, opts.runId, opts.stepId),
            readOnly: false,
        },
    ];
}

// ── Docker bind mounts ─────────────────────────────────────────────────

/**
 * Build Docker bind mount specs — same nesting logic as buildPodMounts,
 * but with host paths derived from sessionPath.
 * Docker handles nested mounts — the most-specific path wins.
 */
export function buildDockerMounts(opts: { resourceId: string; runId: string; stepId: string; sessionPath: string }): DockerMount[] {
    const mp = buildMountPaths(opts.resourceId, opts.runId, opts.stepId);
    const stepRelPath = runStepDir(opts.resourceId, opts.runId, opts.stepId);
    return [
        {
            hostPath: join(opts.sessionPath, opts.resourceId),
            containerPath: mp.ANALYSIS,
            readOnly: true,
        },
        {
            hostPath: join(opts.sessionPath, stepRelPath),
            containerPath: mp.ARTIFACTS,
            readOnly: false,
        },
    ];
}
