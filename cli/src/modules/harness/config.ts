import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { MachineBudget, ResourceLimits, ResourcePolicy } from "@inflexa-ai/harness";
import { readConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";

/**
 * Shape of the `harness` config key. Lives here (not in lib/config.ts) so the harness feature owns
 * its own config contract, and — crucially — so validation is NOT swallowed by a block-level
 * `.catch`: lib/config.ts passes the raw value through as `unknown` and this resolver validates it,
 * turning a single bad field into a precise error instead of silently discarding the whole block.
 */
const harnessConfigSchema = z.object({
    model: z.string().optional(),
    bioKeys: z
        .object({
            drugbank: z.string().optional(),
            disgenet: z.string().optional(),
            epaCcte: z.string().optional(),
            ncbi: z.string().optional(),
            github: z.string().optional(),
        })
        .optional(),
    sandboxImage: z.string().optional(),
    resourceLimits: z
        .object({
            maxCpu: z.number().positive().optional(),
            maxMemoryGb: z.number().positive().optional(),
            maxGpuCount: z.number().int().nonnegative().optional(),
            budget: z
                .object({
                    cpu: z.number().positive().optional(),
                    memoryGb: z.number().positive().optional(),
                })
                .optional(),
            ephemeral: z
                .object({
                    cpu: z.number().positive(),
                    memoryGb: z.number().positive(),
                })
                .optional(),
        })
        .optional(),
    adminPort: z.number().int().positive().optional(),
    skillsDir: z.string().optional(),
});

/**
 * The `harness` config key resolved to concrete values. The embedder is NOT
 * configured here: it comes from the top-level `embedding` config key, resolved
 * by `modules/embedding/resolve.ts` at boot. The one genuine launch prerequisite
 * this config cannot default is the skills tree (outside a dev checkout); the
 * pre-flight turns its `null` into an actionable error.
 */
export type ResolvedHarnessConfig = {
    /** Chat model id; `null` means resolve the default from the proxy's `/models` at boot. */
    readonly model: string | null;
    /** Absent keys pass as empty strings — the affected tools surface auth errors per-call. */
    readonly bioKeys: {
        readonly drugbank: string;
        readonly disgenet: string;
        readonly epaCcte: string;
        readonly ncbi?: string;
        readonly github?: string;
    };
    readonly sandboxImage: string;
    readonly resourceLimits: ResourceLimits;
    /**
     * The harness's `ResourcePolicy`, resolved from `harness.resourceLimits`:
     * the per-step ceilings (`resourceLimits`, unchanged) plus the machine
     * budget and optional ephemeral sandbox size. What the fields mean and how
     * they are enforced is the harness's contract — this module only resolves
     * the values it supplies: an unset budget defaults to half the detected
     * host, raised to the per-step ceilings so the resolved policy always
     * satisfies the harness's load-time invariants.
     */
    readonly resourcePolicy: ResourcePolicy;
    /** DBOS admin port. */
    readonly adminPort: number;
    readonly skillsDir: string | null;
    /**
     * Set when the `harness` config key was present but failed validation (e.g. a field of the wrong
     * type). Carries the offending field paths so boot can report the real problem instead of a
     * misleading downstream error. The other fields are defaults here and must not be relied on.
     */
    readonly configError?: { issues: string };
};

/**
 * Dev-checkout skills tree: the shared repo-root `skills/` directory
 * (cli/src/modules/harness → four levels up). Meaningless inside a compiled
 * binary — `import.meta.dir` is a bundled virtual path there — which is why
 * non-dev runs require the config key instead.
 */
const devSkillsDir = join(import.meta.dir, "../../../../skills");

/** Locally-built image tag (`docker build` per images/sandbox-base/README.md). */
const DEFAULT_SANDBOX_IMAGE = "sandbox-base:latest";

/**
 * Conservative dev-machine ceilings; every sandbox request is clamped to these
 * by the harness. Config-overridable for bigger workstations.
 */
const DEFAULT_RESOURCE_LIMITS: ResourceLimits = { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 };

/**
 * Default machine budget: half the host's cores and memory — enough to run real
 * analyses while leaving the other half for the user's editor, browser, and the
 * harness itself. Exported so `inflexa setup` can show the same suggestion it
 * would otherwise silently apply.
 */
export function detectedMachineBudget(): MachineBudget {
    return {
        cpu: Math.max(1, Math.floor(availableParallelism() / 2)),
        memoryGb: Math.max(1, Math.floor(totalmem() / 1024 ** 3 / 2)),
    };
}

/**
 * Assemble the policy from the resolved per-step ceilings and the (possibly
 * partial) configured budget. The budget is raised to the per-step ceilings when
 * it lands below them — the harness rejects a policy whose maximum-size step
 * could never be scheduled, and a user who explicitly configured `maxMemoryGb:
 * 16` on a small machine meant to allow such steps to run (one at a time).
 */
function resolvePolicy(perStep: ResourceLimits, cfg: z.infer<typeof harnessConfigSchema> | undefined): ResourcePolicy {
    const detected = detectedMachineBudget();
    const budget = {
        cpu: Math.max(cfg?.resourceLimits?.budget?.cpu ?? detected.cpu, perStep.maxCpu),
        memoryGb: Math.max(cfg?.resourceLimits?.budget?.memoryGb ?? detected.memoryGb, perStep.maxMemoryGb),
    };
    return {
        perStep,
        budget,
        ...(cfg?.resourceLimits?.ephemeral && { ephemeral: cfg.resourceLimits.ephemeral }),
    };
}

/**
 * In the port family of the owned services (proxy 8317, postgres 8432) rather
 * than DBOS's usual 3001, which collides with common dev servers.
 */
const DEFAULT_ADMIN_PORT = 8433;

/** All-defaults resolved config, used when the `harness` key is absent or when it failed validation. */
function defaultsWith(cfg: z.infer<typeof harnessConfigSchema> | undefined, configError?: { issues: string }): ResolvedHarnessConfig {
    const resourceLimits: ResourceLimits = {
        maxCpu: cfg?.resourceLimits?.maxCpu ?? DEFAULT_RESOURCE_LIMITS.maxCpu,
        maxMemoryGb: cfg?.resourceLimits?.maxMemoryGb ?? DEFAULT_RESOURCE_LIMITS.maxMemoryGb,
        maxGpuCount: cfg?.resourceLimits?.maxGpuCount ?? DEFAULT_RESOURCE_LIMITS.maxGpuCount,
    };
    return {
        model: cfg?.model ?? null,
        bioKeys: {
            drugbank: cfg?.bioKeys?.drugbank ?? "",
            disgenet: cfg?.bioKeys?.disgenet ?? "",
            epaCcte: cfg?.bioKeys?.epaCcte ?? "",
            ncbi: cfg?.bioKeys?.ncbi,
            github: cfg?.bioKeys?.github,
        },
        sandboxImage: cfg?.sandboxImage ?? DEFAULT_SANDBOX_IMAGE,
        resourceLimits,
        resourcePolicy: resolvePolicy(resourceLimits, cfg),
        adminPort: cfg?.adminPort ?? DEFAULT_ADMIN_PORT,
        skillsDir: cfg?.skillsDir ?? (env.isDev ? devSkillsDir : null),
        configError,
    };
}

/**
 * Resolve the `harness` config key, filling every defaultable field per-field. The raw value comes
 * through lib/config.ts as `unknown` and is validated here: an absent key resolves to all-defaults,
 * while a present-but-invalid key resolves to all-defaults carrying a `configError` that names the
 * offending fields, so boot reports the real problem instead of a misleading "embedding not
 * configured" error.
 */
export function resolveHarnessConfig(): ResolvedHarnessConfig {
    const raw = readConfig().harness;
    if (raw === undefined) return defaultsWith(undefined);
    const parsed = harnessConfigSchema.safeParse(raw);
    if (parsed.success) return defaultsWith(parsed.data);
    const issues = parsed.error.issues.map((i) => `harness.${i.path.join(".")}: ${i.message}`).join("; ");
    return defaultsWith(undefined, { issues });
}
