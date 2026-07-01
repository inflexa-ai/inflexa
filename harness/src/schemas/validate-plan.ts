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
import { CycleError, DependencyError, topoSortIntoWaves } from "../execution/topo-sort.js";
import { STEP_SUBDIRS } from "../workspace/paths.js";
import type { AnalysisPlan } from "./workflow-state.js";

const KNOWN_AGENTS: ReadonlySet<string> = new Set(KNOWN_AGENT_IDS);

/**
 * Reserved step-id names. A step id equal to an artifact subdirectory name
 * would make its directory (`runs/{runId}/{stepId}`) collide with the
 * subdirectory convention agents expect inside a step (see the harness-workspace-tools spec).
 */
const RESERVED_STEP_IDS: ReadonlySet<string> = new Set(STEP_SUBDIRS);

export interface ValidationResult {
    valid: boolean;
    errors: string[];
}

/** Derive a filesystem-safe output prefix from a step ID. */
export function deriveOutputPrefix(stepId: string): string {
    return stepId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Validate an analysis plan for structural correctness.
 *
 * Returns `valid: true` if the plan passes all checks, or `valid: false`
 * with a list of human-readable error strings.
 */
export function validatePlan(plan: AnalysisPlan): ValidationResult {
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
    for (const step of plan.steps) {
        if (!step.resources) {
            errors.push(`Step "${step.id}" has no resources defined — cpu and memoryGb are required`);
        }
    }

    // 5. Reserved step-id names (collide with artifact subdirectories)
    for (const step of plan.steps) {
        if (RESERVED_STEP_IDS.has(step.id.toLowerCase())) {
            errors.push(
                `Step "${step.id}" uses a reserved name — step ids must not be one of: ` +
                    `${STEP_SUBDIRS.join(", ")} (they collide with the artifact subdirectory convention)`,
            );
        }
    }

    return { valid: errors.length === 0, errors };
}
