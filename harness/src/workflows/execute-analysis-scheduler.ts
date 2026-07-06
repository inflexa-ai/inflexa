/**
 * Dependency-gated scheduler for `executeAnalysis`.
 *
 * Three pure functions over a plan DAG, unit-testable in isolation:
 *
 *  - `validatePlanDag` — cycle + missing-dependency detection, typed errors.
 *  - `scheduleReady`   — given the completed set, return every step whose
 *                        dependencies are now satisfied and that has not
 *                        already been started.
 *  - `computeTopologicalLevels` — UI-only depth per step (level 0 = no deps,
 *                                 level N = max(level(deps)) + 1). Persisted
 *                                 on `cortex_step_executions.wave` and emitted
 *                                 on `data-dag-state`; does NOT gate execution.
 *
 * The parent workflow drives the scheduler — it owns the in-flight handle
 * map and reacts to child completions / failures. Keeping the scheduler
 * pure means parent recovery replays the same dispatch sequence given the
 * same persisted child outcomes.
 */

import type { MachineBudget, ResourceSpec } from "../config/resource-limits.js";

/**
 * The minimum shape the scheduler needs from a plan step. Larger workflow-state
 * schemas are a superset of this, keeping the scheduler decoupled.
 */
export interface PlanStep {
    readonly id: string;
    readonly depends_on: readonly string[];
}

/** Budget-admission inputs — the snapshotted machine budget from the workflow
 *  input plus each step's plan-declared resources. */
export interface BudgetAdmission {
    readonly budget: MachineBudget;
    readonly resourcesByStepId: Readonly<Record<string, ResourceSpec>>;
}

/** Partition of the dependency-satisfied steps under budget admission. */
export interface ScheduledSteps {
    /** Steps to start now — they fit the remaining budget capacity. */
    readonly admit: readonly string[];
    /** Dependency-satisfied steps held until in-flight steps free capacity. */
    readonly heldForCapacity: readonly string[];
    /** Steps whose declared resources exceed the budget outright — they could
     *  never be admitted even against an empty budget. */
    readonly neverFits: readonly string[];
}

// ── Errors ───────────────────────────────────────────────────────────

/** Thrown when the plan DAG contains a dependency cycle. */
export class CycleError extends Error {
    constructor(readonly involvedSteps: readonly string[]) {
        super(`dependency cycle detected involving steps: ${involvedSteps.join(", ")}`);
        this.name = "CycleError";
    }
}

/** Thrown when a step references a `depends_on` id that does not exist. */
export class MissingDependencyError extends Error {
    constructor(
        readonly stepId: string,
        readonly missingDependency: string,
    ) {
        super(`step "${stepId}" depends on "${missingDependency}" which is not in the plan`);
        this.name = "MissingDependencyError";
    }
}

/** Thrown when two steps share the same `id`. */
export class DuplicateStepIdError extends Error {
    constructor(readonly stepId: string) {
        super(`plan contains duplicate step id "${stepId}"`);
        this.name = "DuplicateStepIdError";
    }
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Validate a plan DAG. Throws on duplicate ids, missing dependencies, or
 * cycles. Returns the validated step map for convenient downstream use.
 */
export function validatePlanDag<S extends PlanStep>(steps: readonly S[]): Map<string, S> {
    const stepById = new Map<string, S>();
    for (const step of steps) {
        if (stepById.has(step.id)) {
            throw new DuplicateStepIdError(step.id);
        }
        stepById.set(step.id, step);
    }

    for (const step of steps) {
        for (const dep of step.depends_on) {
            if (!stepById.has(dep)) {
                throw new MissingDependencyError(step.id, dep);
            }
        }
    }

    detectCycle(steps);
    return stepById;
}

/**
 * Iterative DFS cycle detection — Kahn-style would also work, but DFS lets
 * us surface the participating step ids directly when a cycle is found.
 */
function detectCycle<S extends PlanStep>(steps: readonly S[]): void {
    const VISITING = 1;
    const DONE = 2;
    const state = new Map<string, number>();
    const stepById = new Map(steps.map((s) => [s.id, s] as const));

    for (const start of steps) {
        if (state.get(start.id) === DONE) continue;
        // Iterative DFS — preserves the in-progress chain so we can report it.
        const stack: Array<{ id: string; iter: Iterator<string> }> = [{ id: start.id, iter: stepById.get(start.id)!.depends_on[Symbol.iterator]() }];
        state.set(start.id, VISITING);

        while (stack.length > 0) {
            const frame = stack[stack.length - 1]!;
            const next = frame.iter.next();
            if (next.done) {
                state.set(frame.id, DONE);
                stack.pop();
                continue;
            }
            const childId = next.value;
            const childState = state.get(childId);
            if (childState === VISITING) {
                const cycle = stack.map((f) => f.id);
                cycle.push(childId);
                throw new CycleError(cycle);
            }
            if (childState === DONE) continue;
            state.set(childId, VISITING);
            stack.push({
                id: childId,
                iter: stepById.get(childId)!.depends_on[Symbol.iterator](),
            });
        }
    }
}

// ── Scheduling ───────────────────────────────────────────────────────

/**
 * Return every step that is now eligible to start: all of its `depends_on`
 * are in `completedSet`, and the step itself is not yet in `startedSet`.
 *
 * Pure function — the parent workflow recomputes this after every child
 * completion (or on parent recovery) and dispatches each returned id via
 * `DBOS.startWorkflow`. Order in the returned array follows the plan's
 * declared order for deterministic dispatch.
 *
 * With `admission`, the dependency-satisfied steps are additionally gated on
 * the machine budget and partitioned instead of returned flat: a step is
 * admitted only while the declared resources of the in-flight steps
 * (`startedSet`) plus every step admitted earlier in the round leave room for
 * it. Admission is greedy in plan order with skip-over — a candidate that does
 * not fit never blocks a later, smaller one. Determinism holds because every
 * input derives from the workflow input and checkpointed completion state.
 */
export function scheduleReady<S extends PlanStep>(steps: readonly S[], completedSet: ReadonlySet<string>, startedSet?: ReadonlySet<string>): string[];
export function scheduleReady<S extends PlanStep>(
    steps: readonly S[],
    completedSet: ReadonlySet<string>,
    startedSet: ReadonlySet<string>,
    admission: BudgetAdmission,
): ScheduledSteps;
export function scheduleReady<S extends PlanStep>(
    steps: readonly S[],
    completedSet: ReadonlySet<string>,
    startedSet: ReadonlySet<string> = new Set(),
    admission?: BudgetAdmission,
): string[] | ScheduledSteps {
    const ready: string[] = [];
    for (const step of steps) {
        if (startedSet.has(step.id) || completedSet.has(step.id)) continue;
        if (step.depends_on.every((d) => completedSet.has(d))) {
            ready.push(step.id);
        }
    }
    if (!admission) return ready;

    const { budget, resourcesByStepId } = admission;
    // A step with no declared resources weighs nothing — it is never throttled,
    // matching the unbudgeted legacy behavior for that step.
    const weightOf = (id: string): { cpu: number; memoryGb: number } => resourcesByStepId[id] ?? { cpu: 0, memoryGb: 0 };

    let usedCpu = 0;
    let usedMemoryGb = 0;
    for (const id of startedSet) {
        const w = weightOf(id);
        usedCpu += w.cpu;
        usedMemoryGb += w.memoryGb;
    }

    const admit: string[] = [];
    const heldForCapacity: string[] = [];
    const neverFits: string[] = [];
    for (const id of ready) {
        const w = weightOf(id);
        if (w.cpu > budget.cpu || w.memoryGb > budget.memoryGb) {
            neverFits.push(id);
        } else if (usedCpu + w.cpu <= budget.cpu && usedMemoryGb + w.memoryGb <= budget.memoryGb) {
            admit.push(id);
            usedCpu += w.cpu;
            usedMemoryGb += w.memoryGb;
        } else {
            heldForCapacity.push(id);
        }
    }
    return { admit, heldForCapacity, neverFits };
}

// ── Topological levels (UI layout) ───────────────────────────────────

/**
 * Compute a depth per step. A step with no dependencies is level 0; a step
 * with deps is `max(level(dep)) + 1`. Used by the UI for column layout in
 * the DAG view and persisted as `cortex_step_executions.wave` for legacy
 * compatibility — it does NOT gate execution.
 *
 * Pre-condition: `validatePlanDag` has been called (no cycles, no missing
 * deps). Behaviour is undefined on an invalid DAG.
 */
export function computeTopologicalLevels<S extends PlanStep>(steps: readonly S[]): Map<string, number> {
    const stepById = new Map(steps.map((s) => [s.id, s] as const));
    const levels = new Map<string, number>();

    function levelOf(id: string): number {
        const cached = levels.get(id);
        if (cached !== undefined) return cached;
        const step = stepById.get(id);
        if (step === undefined) {
            throw new MissingDependencyError("(internal)", id);
        }
        let level = 0;
        for (const dep of step.depends_on) {
            level = Math.max(level, levelOf(dep) + 1);
        }
        levels.set(id, level);
        return level;
    }

    for (const step of steps) {
        levelOf(step.id);
    }
    return levels;
}
