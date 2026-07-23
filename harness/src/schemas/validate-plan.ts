/**
 * Plan validation — pure structural checks on an AnalysisPlan.
 *
 * Depends only on the plan schema types, the topological sorter, and the
 * agent id list. No framework dependencies. The `generatePlan` tool imports
 * this directly.
 *
 * Checks:
 * 1. Topological sort succeeds (no cycles, no missing deps)
 * 2. Output prefix uniqueness
 * 3. All agent assignments exist in the agent catalog
 * 4. All steps have resources defined
 */

import { KNOWN_AGENT_IDS } from "../agents/sandbox-catalog.js";
import type { ResourceLimits } from "../config/resource-limits.js";
import { CycleError, DependencyError, topoSortIntoWaves } from "../execution/topo-sort.js";
import { isSafeId, STEP_SUBDIRS, SYNTHESIS_STEP_ID } from "../workspace/paths.js";
import type { AnalysisPlan } from "./workflow-state.js";

const KNOWN_AGENTS: ReadonlySet<string> = new Set(KNOWN_AGENT_IDS);

/**
 * Reserved step-id names. A step id equal to an artifact subdirectory name
 * would make its directory (`runs/{runId}/{stepId}`) collide with the
 * subdirectory convention agents expect inside a step, and
 * {@link SYNTHESIS_STEP_ID} is the run-phase ledger row `executeAnalysis`
 * writes for run-level synthesis — a plan step with that id would collide with
 * the row's `(run_id, step_id)` primary key (see the harness-workspace-tools spec).
 */
const RESERVED_STEP_IDS: ReadonlySet<string> = new Set([...STEP_SUBDIRS, SYNTHESIS_STEP_ID]);

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

export interface ValidatePlanOptions {
    /**
     * Host per-step resource ceilings. When present, a step whose declared
     * `resources` exceed them is an error — the planner gets actionable
     * feedback at plan time instead of a silent clamp at sandbox creation.
     * The plan-generation path passes this; `execute_plan` deliberately does
     * not, so stored plans that predate the policy keep running (the
     * sandbox-creation clamp remains their backstop).
     */
    readonly perStepCeiling?: ResourceLimits;
}

/** Derive a filesystem-safe output prefix from a step ID. */
export function deriveOutputPrefix(stepId: string): string {
    return stepId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * Validate an analysis plan for structural correctness.
 *
 * Returns `valid: true` if the plan passes all checks, or `valid: false`
 * with a list of human-readable error strings.
 */
export function validatePlan(plan: AnalysisPlan, options?: ValidatePlanOptions): ValidationResult {
    const errors: string[] = [];

    if (plan.steps.length === 0) {
        return { valid: true, errors: [] };
    }

    // 1. Topological sort — catches cycles and missing dependencies
    try {
        topoSortIntoWaves(plan.steps);
    } catch (err) {
        if (err instanceof CycleError) {
            errors.push(`Dependency cycle detected involving steps: ${err.involvedSteps.join(", ")}`);
        } else if (err instanceof DependencyError) {
            errors.push(`Step "${err.stepId}" depends on "${err.missingDependency}" which does not exist in the plan`);
        } else {
            errors.push(`Topological sort failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // 2. Output prefix uniqueness
    const seen = new Map<string, string[]>();
    for (const step of plan.steps) {
        const prefix = deriveOutputPrefix(step.id);
        const ids = seen.get(prefix);
        if (ids) {
            ids.push(step.id);
        } else {
            seen.set(prefix, [step.id]);
        }
    }

    const duplicates = [...seen.entries()].filter(([, ids]) => ids.length > 1);
    for (const [prefix, ids] of duplicates) {
        errors.push(`Duplicate output prefix "${prefix}" used by steps: ${ids.join(", ")}`);
    }

    // 3. Agent assignment validation
    for (const step of plan.steps) {
        if (!step.agent) {
            errors.push(`Step "${step.id}" has no agent assigned — every step must specify an agent`);
        } else if (!KNOWN_AGENTS.has(step.agent)) {
            errors.push(`Step "${step.id}" assigns unknown agent "${step.agent}" — not found in agent catalog`);
        }
    }

    // 4. Resources validation
    const ceiling = options?.perStepCeiling;
    for (const step of plan.steps) {
        if (!step.resources) {
            errors.push(`Step "${step.id}" has no resources defined — cpu and memoryGb are required`);
            continue;
        }
        if (!ceiling) continue;
        if (step.resources.cpu > ceiling.maxCpu) {
            errors.push(
                `Step "${step.id}" requests cpu: ${step.resources.cpu} but this host allows at most ` +
                    `${ceiling.maxCpu} per step — reduce cpu or restructure the step`,
            );
        }
        if (step.resources.memoryGb > ceiling.maxMemoryGb) {
            errors.push(
                `Step "${step.id}" requests memoryGb: ${step.resources.memoryGb} but this host allows at most ` +
                    `${ceiling.maxMemoryGb} per step — reduce memoryGb or restructure the step`,
            );
        }
    }

    // 5. Reserved step-id names (collide with artifact subdirectories or the
    //    run-phase synthesis ledger row)
    for (const step of plan.steps) {
        if (RESERVED_STEP_IDS.has(step.id.toLowerCase())) {
            errors.push(
                `Step "${step.id}" uses a reserved name — step ids must not be one of: ` +
                    `${[...RESERVED_STEP_IDS].join(", ")} (the artifact subdirectory names collide with the ` +
                    `step-directory convention; "${SYNTHESIS_STEP_ID}" is the run-level synthesis phase)`,
            );
        }
    }

    // 6. Step-id path safety. The id becomes the `runs/{runId}/{stepId}` directory
    //    segment and a `/{analysisId}/…` container mount path; an unsafe segment
    //    (a slash, or `.`/`..`) could traverse or widen the mount. The sandbox
    //    mount boundary also rejects these (assertSafeId), but catching it here
    //    turns it into an actionable, retryable planner error instead of a
    //    durably-failed step at sandbox creation.
    for (const step of plan.steps) {
        if (!isSafeId(step.id)) {
            errors.push(
                `Step "${step.id}" has an unsafe id — step ids may contain only letters, digits, '.', '_', '-' ` +
                    `and cannot be '.' or '..' (the id becomes a workspace directory and container mount segment)`,
            );
        }
    }

    return { valid: errors.length === 0, errors };
}
