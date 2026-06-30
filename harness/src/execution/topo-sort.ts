/**
 * Topological sort of a plan DAG into execution waves.
 *
 * Uses Kahn's algorithm to group steps into waves where steps within
 * a wave have no inter-dependencies and can run in parallel.
 */

import type { AnalysisStep } from "../schemas/workflow-state.js";

/** A wave is a group of steps with no inter-dependencies that can run in parallel. */
export type ExecutionWave = AnalysisStep[];

// ── Errors ─────────────────────────────────────────────────────────

/** Thrown when the plan DAG contains a dependency cycle. */
export class CycleError extends Error {
    readonly involvedSteps: string[];

    constructor(involvedSteps: string[]) {
        super(`Dependency cycle detected involving steps: ${involvedSteps.join(", ")}`);
        this.name = "CycleError";
        this.involvedSteps = involvedSteps;
    }
}

/** Thrown when a step references a dependency that does not exist in the plan. */
export class DependencyError extends Error {
    readonly stepId: string;
    readonly missingDependency: string;

    constructor(stepId: string, missingDependency: string) {
        super(`Step "${stepId}" depends on "${missingDependency}" which does not exist in the plan`);
        this.name = "DependencyError";
        this.stepId = stepId;
        this.missingDependency = missingDependency;
    }
}

// ── Core ───────────────────────────────────────────────────────────

/**
 * Convert a flat array of analysis steps into ordered execution waves.
 *
 * Steps within a wave share no inter-dependencies and can run concurrently.
 * Wave ordering guarantees that all dependencies of wave N are satisfied
 * by waves 0..N-1.
 *
 * @param steps - Flat array of analysis steps with `id` and `depends_on`
 * @returns Ordered array of waves (each wave is an array of steps)
 * @throws {DependencyError} If a step references a non-existent dependency
 * @throws {CycleError} If the dependency graph contains a cycle
 */
export function topoSortIntoWaves(steps: AnalysisStep[]): ExecutionWave[] {
    if (steps.length === 0) return [];

    // Build lookup and validate dependencies exist
    const stepById = new Map<string, AnalysisStep>();
    for (const step of steps) {
        stepById.set(step.id, step);
    }

    for (const step of steps) {
        for (const dep of step.depends_on) {
            if (!stepById.has(dep)) {
                throw new DependencyError(step.id, dep);
            }
        }
    }

    // Kahn's algorithm: compute in-degree for each step (only counting
    // edges within this step set)
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const step of steps) {
        inDegree.set(step.id, 0);
        dependents.set(step.id, []);
    }

    for (const step of steps) {
        for (const dep of step.depends_on) {
            inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
            dependents.get(dep)!.push(step.id);
        }
    }

    // Process wave by wave: each wave consists of all nodes with in-degree 0
    const waves: ExecutionWave[] = [];
    let remaining = steps.length;

    // Seed the first frontier with all zero-indegree nodes
    let frontier = steps.filter((s) => inDegree.get(s.id) === 0).map((s) => s.id);

    while (frontier.length > 0) {
        // Current frontier forms a wave
        const wave: ExecutionWave = frontier.map((id) => stepById.get(id)!);
        waves.push(wave);
        remaining -= frontier.length;

        // Compute next frontier
        const nextFrontier: string[] = [];
        for (const id of frontier) {
            for (const dep of dependents.get(id)!) {
                const newDeg = (inDegree.get(dep) ?? 1) - 1;
                inDegree.set(dep, newDeg);
                if (newDeg === 0) {
                    nextFrontier.push(dep);
                }
            }
        }

        frontier = nextFrontier;
    }

    // If nodes remain, the graph has a cycle
    if (remaining > 0) {
        const cycleSteps = steps.filter((s) => (inDegree.get(s.id) ?? 0) > 0).map((s) => s.id);
        throw new CycleError(cycleSteps);
    }

    return waves;
}
