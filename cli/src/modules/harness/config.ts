import { join } from "node:path";
import { z } from "zod";
import type { ResourceLimits } from "@inflexa-ai/harness";
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
    embedding: z
        .object({
            baseURL: z.string(),
            token: z.string(),
            model: z.string().optional(),
        })
        .optional(),
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
        })
        .optional(),
    adminPort: z.number().int().positive().optional(),
    skillsDir: z.string().optional(),
});

/** Fully-resolved embedding endpoint — the profile's vector indexing cannot run without one. */
export type HarnessEmbeddingConfig = {
    readonly baseURL: string;
    readonly token: string;
    readonly model: string;
};

/**
 * The `harness` config key resolved to concrete values. `null` fields are the
 * two genuine launch prerequisites the cli cannot default: the embedding
 * endpoint — its own baseURL + API key, deliberately a SEPARATE path from the
 * chat proxy, which fronts OAuth chat providers and serves no embeddings
 * route — and, outside a dev checkout, the skills tree. The pre-flight turns
 * each `null` into an actionable error, and a configured embedding endpoint
 * is additionally probed at boot (config presence can't prove reachability,
 * and embeddings fail late in the profile workflow).
 */
export type ResolvedHarnessConfig = {
    /** Chat model id; `null` means resolve the default from the proxy's `/models` at boot. */
    readonly model: string | null;
    readonly embedding: HarnessEmbeddingConfig | null;
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

/**
 * Matches the harness's own embedding default (`providers/embedding.ts`) so an
 * endpoint configured without a model gets the model that endpoint most likely
 * serves under the OpenAI-compatible contract.
 */
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/** Locally-built image tag (`docker build` per images/sandbox-base/README.md). */
const DEFAULT_SANDBOX_IMAGE = "sandbox-base:latest";

/**
 * Conservative dev-machine ceilings; every sandbox request is clamped to these
 * by the harness. Config-overridable for bigger workstations.
 */
const DEFAULT_RESOURCE_LIMITS: ResourceLimits = { maxCpu: 4, maxMemoryGb: 8, maxGpuCount: 0 };

/**
 * In the port family of the owned services (proxy 8317, postgres 8432) rather
 * than DBOS's usual 3001, which collides with common dev servers.
 */
const DEFAULT_ADMIN_PORT = 8433;

/** All-defaults resolved config, used when the `harness` key is absent or when it failed validation. */
function defaultsWith(cfg: z.infer<typeof harnessConfigSchema> | undefined, configError?: { issues: string }): ResolvedHarnessConfig {
    return {
        model: cfg?.model ?? null,
        embedding: cfg?.embedding
            ? {
                  baseURL: cfg.embedding.baseURL,
                  token: cfg.embedding.token,
                  model: cfg.embedding.model ?? DEFAULT_EMBEDDING_MODEL,
              }
            : null,
        bioKeys: {
            drugbank: cfg?.bioKeys?.drugbank ?? "",
            disgenet: cfg?.bioKeys?.disgenet ?? "",
            epaCcte: cfg?.bioKeys?.epaCcte ?? "",
            ncbi: cfg?.bioKeys?.ncbi,
            github: cfg?.bioKeys?.github,
        },
        sandboxImage: cfg?.sandboxImage ?? DEFAULT_SANDBOX_IMAGE,
        resourceLimits: {
            maxCpu: cfg?.resourceLimits?.maxCpu ?? DEFAULT_RESOURCE_LIMITS.maxCpu,
            maxMemoryGb: cfg?.resourceLimits?.maxMemoryGb ?? DEFAULT_RESOURCE_LIMITS.maxMemoryGb,
            maxGpuCount: cfg?.resourceLimits?.maxGpuCount ?? DEFAULT_RESOURCE_LIMITS.maxGpuCount,
        },
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
