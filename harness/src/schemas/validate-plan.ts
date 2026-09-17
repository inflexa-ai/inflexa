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
import { resolvePackage, type PackageResolution, type PackageSources } from "../sandbox/image-packages.js";
import { formatQuery, identityKey, parseQuery, type PackageQuery, type ParseQueryError } from "../sandbox/package-identity.js";
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
     * The plan-generation path passes this; `execute_analysis` plan mode deliberately does
     * not, so stored plans that predate the policy keep running (the
     * sandbox-creation clamp remains their backstop).
     */
    readonly perStepCeiling?: ResourceLimits;
    /**
     * The pool that the link pass reads, and the base sets of the image. When
     * present, each package entry that parses resolves with `resolvePackage`,
     * and a both-track name, a name that neither source holds, or a wrong pin
     * of a base package is an error — the planner corrects it in its loop, and
     * it does not meet the refusal at the launch. The planner passes the
     * sources of its census. `execute_analysis` plan mode passes none, because
     * its link pass resolves the stored plan itself.
     */
    readonly packages?: PackageSources;
}

/**
 * One issue for one package entry that does not parse. Each message names the
 * step and the entry, because a planner corrects the entry it wrote.
 *
 * The wording carries the reason of each refusal. A location publishes an
 * installer detail as an interface. An unknown `<word>:` prefix rides into the
 * pool as part of the name. A specifier that is not `==` turns a range such as
 * `numpy>=1.26` into a package name, and the pool then refuses a package that
 * it holds.
 */
function describeParseError(stepId: string, entry: string, error: ParseQueryError): string {
    switch (error.type) {
        case "empty":
            return `Step "${stepId}" names an empty package entry — name each package as a requirement (a bare name, or name==version)`;
        case "location":
            return (
                `Step "${stepId}" names a package location "${entry}" — name each package as a requirement ` +
                `(a bare name, or name==version), never a path, a URL, or a store directory`
            );
        case "unknown_prefix":
            return (
                `Step "${stepId}" names the ecosystem of "${entry}" with a prefix the link pass cannot read — ` +
                `the permitted prefixes are "python:" and "r:", and a bare name searches both tracks`
            );
        case "unsupported_specifier":
            return (
                `Step "${stepId}" pins "${entry}" with a specifier the link pass cannot honor — ` + `use a bare name, or name==version with one exact version`
            );
    }
}

/**
 * The issue for one parsed entry that does not resolve to one identity, or
 * `null` for an entry that resolves. The words are the words of the link pass
 * of the embedder, thus the planner reads at the submit what the launch would
 * say.
 *
 * A pin of a pool package takes no part: the census holds the newest pin of
 * each package only, thus the link pass stays the reader of that version. A
 * pin of an image package compares, because the image holds one version.
 */
function describeResolution(stepId: string, entry: string, query: PackageQuery, resolution: PackageResolution): string | null {
    switch (resolution.kind) {
        case "pool":
        case "image":
            return null;
        case "image_version":
            return (
                `Step "${stepId}" names "${entry}", but the image holds ${identityKey(resolution.identity)} at version ${resolution.held} only — ` +
                `write the name with no version, or pin ==${resolution.held}`
            );
        case "ambiguous":
            return (
                `Step "${stepId}" names "${entry}", which the Python track and the R track both hold — ` +
                `ask again for \`${formatQuery({ spelling: query.spelling, track: "python" })}\` ` +
                `or \`${formatQuery({ spelling: query.spelling, track: "r" })}\``
            );
        case "unknown":
            return resolution.suggestion === undefined
                ? `Step "${stepId}" names "${entry}", which the pool does not hold — name the package as the census shows it, or leave it out`
                : `Step "${stepId}" names "${entry}", which the pool does not hold — the pool holds "${resolution.suggestion.name}" ` +
                      `(${identityKey(resolution.suggestion)}) — an R package name is case-sensitive, thus the two spellings are two names`;
    }
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

    // 6. Each package entry is a query of the one grammar. The validation IS
    //    the parse, thus no second reader of the grammar can disagree with the
    //    link pass. An absent array passes, because stored plans from before
    //    the field carry none. With the package sources, the query then
    //    resolves by the rule that the link pass runs.
    const sources = options?.packages;
    for (const step of plan.steps) {
        for (const entry of step.packages ?? []) {
            const parsed = parseQuery(entry);
            if (parsed.isErr()) {
                errors.push(describeParseError(step.id, entry, parsed.error));
                continue;
            }
            if (!sources) continue;
            const issue = describeResolution(step.id, entry, parsed.value, resolvePackage(parsed.value, sources));
            if (issue !== null) errors.push(issue);
        }
    }

    // 7. Step-id path safety. The id becomes the `runs/{runId}/{stepId}` directory
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
