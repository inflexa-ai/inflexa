import { join } from "node:path";
import type { ResourceLimits } from "@inflexa-ai/harness";
import { readConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";

/** Fully-resolved embedding endpoint — the profile's vector indexing cannot run without one. */
export type HarnessEmbeddingConfig = {
    readonly baseURL: string;
    readonly token: string;
    readonly model: string;
};

/**
 * The `harness` config key resolved to concrete values. `null` fields are the
 * two genuine launch prerequisites the cli cannot default: the embedding
 * endpoint (the local proxy serves none — S1 in the embed-harness-runtime
 * design) and, outside a dev checkout, the skills tree. The pre-flight in the
 * launch command turns each `null` into an actionable error.
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

/** Resolve the `harness` config key, filling every defaultable field per-field. */
export function resolveHarnessConfig(): ResolvedHarnessConfig {
    const cfg = readConfig().harness;
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
    };
}
