/**
 * Resource limits — ported from orchestrator/src/config/resource-limits.ts.
 *
 * Validates sandbox resource requests against cluster maximums.
 * Used by K8sSandbox.
 */

import { z } from "zod";

// ── Schemas ─────────────────────────────────────────────────────────

export const GpuSpecSchema = z.object({
    count: z.number().int().positive(),
});

export const ResourceSpecSchema = z.object({
    cpu: z.number().positive(),
    memoryGb: z.number().positive(),
    gpu: GpuSpecSchema.optional(),
});

export const ResourceLimitsSchema = z.object({
    maxCpu: z.number().positive(),
    maxMemoryGb: z.number().positive(),
    maxGpuCount: z.number().int().nonnegative(),
});

export const MachineBudgetSchema = z.object({
    cpu: z.number().positive(),
    memoryGb: z.number().positive(),
});

export const ResourcePolicySchema = z.object({
    perStep: ResourceLimitsSchema,
    budget: MachineBudgetSchema,
    ephemeral: ResourceSpecSchema.optional(),
});

export type GpuSpec = z.infer<typeof GpuSpecSchema>;
export type ResourceSpec = z.infer<typeof ResourceSpecSchema>;
export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;
export type MachineBudget = z.infer<typeof MachineBudgetSchema>;
export type ResourcePolicy = z.infer<typeof ResourcePolicySchema>;

/** Default LLM-turn budget for a sandbox agent step. Covers simple,
 *  standard, and complex analyses — extra headroom on simple steps is
 *  cheaper than truncating complex ones. */
export const DEFAULT_SANDBOX_MAX_STEPS = 75;

// ── Error ───────────────────────────────────────────────────────────

export class ResourceLimitsConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ResourceLimitsConfigError";
    }
}

// ── Parsing ─────────────────────────────────────────────────────────

function parsePositiveNumber(name: string, value: string | undefined): number {
    if (!value) {
        throw new ResourceLimitsConfigError(`${name} environment variable is required`);
    }
    const num = Number(value);
    if (isNaN(num) || num <= 0) {
        throw new ResourceLimitsConfigError(`${name} must be a positive number, got: ${value}`);
    }
    return num;
}

function parseNonNegativeInt(name: string, value: string | undefined): number {
    if (!value) {
        throw new ResourceLimitsConfigError(`${name} environment variable is required`);
    }
    const num = Number(value);
    if (isNaN(num) || num < 0) {
        throw new ResourceLimitsConfigError(`${name} must be a non-negative number, got: ${value}`);
    }
    if (!Number.isInteger(num)) {
        throw new ResourceLimitsConfigError(`${name} must be an integer, got: ${value}`);
    }
    return num;
}

/**
 * Load resource limits from environment variables.
 *
 * Required: SANDBOX_MAX_CPU, SANDBOX_MAX_MEMORY_GB, SANDBOX_MAX_GPU_COUNT
 * @throws ResourceLimitsConfigError if configuration is invalid
 */
export function loadResourceLimits(): ResourceLimits {
    const maxCpu = parsePositiveNumber("SANDBOX_MAX_CPU", process.env.SANDBOX_MAX_CPU);
    const maxMemoryGb = parsePositiveNumber("SANDBOX_MAX_MEMORY_GB", process.env.SANDBOX_MAX_MEMORY_GB);
    const maxGpuCount = parseNonNegativeInt("SANDBOX_MAX_GPU_COUNT", process.env.SANDBOX_MAX_GPU_COUNT);

    const limits: ResourceLimits = { maxCpu, maxMemoryGb, maxGpuCount };

    const result = ResourceLimitsSchema.safeParse(limits);
    if (!result.success) {
        throw new ResourceLimitsConfigError(`Invalid resource limits configuration: ${result.error.message}`);
    }

    return result.data;
}

/**
 * Validate an embedder-supplied resource policy.
 *
 * Invariant: a maximum-size step must be admissible against an empty budget,
 * so the per-step ceilings may not exceed the machine budget.
 * @throws ResourceLimitsConfigError if the policy is invalid
 */
export function parseResourcePolicy(input: unknown): ResourcePolicy {
    const result = ResourcePolicySchema.safeParse(input);
    if (!result.success) {
        throw new ResourceLimitsConfigError(`Invalid resource policy: ${result.error.message}`);
    }
    const policy = result.data;
    if (policy.perStep.maxCpu > policy.budget.cpu) {
        throw new ResourceLimitsConfigError(
            `perStep.maxCpu (${policy.perStep.maxCpu}) exceeds budget.cpu (${policy.budget.cpu}) — a maximum-size step could never be scheduled`,
        );
    }
    if (policy.perStep.maxMemoryGb > policy.budget.memoryGb) {
        throw new ResourceLimitsConfigError(
            `perStep.maxMemoryGb (${policy.perStep.maxMemoryGb}) exceeds budget.memoryGb (${policy.budget.memoryGb}) — a maximum-size step could never be scheduled`,
        );
    }
    return policy;
}

/**
 * Clamp a resource request to cluster limits (cap, don't throw).
 * Returns a new spec with values capped to the configured maximums.
 */
export function clampResources(spec: ResourceSpec, limits: ResourceLimits): ResourceSpec {
    return {
        cpu: Math.min(spec.cpu, limits.maxCpu),
        memoryGb: Math.min(spec.memoryGb, limits.maxMemoryGb),
        ...(spec.gpu && {
            gpu: { count: Math.min(spec.gpu.count, limits.maxGpuCount) },
        }),
    };
}
