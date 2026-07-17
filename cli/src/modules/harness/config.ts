import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { MachineBudget, ResourceLimits, ResourcePolicy } from "@inflexa-ai/harness";
import { type Result } from "neverthrow";
import { modelsConfigSchema, readConfig, writeConfig, type ConfigError, type ModelAuthConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { DEFAULT_SANDBOX_IMAGE } from "../libs/images.ts";

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
    templatesDir: z.string().optional(),
});

/**
 * The `harness` config key resolved to concrete values. The embedder is NOT
 * configured here: it comes from the top-level `embedding` config key, resolved
 * by `modules/embedding/resolve.ts` at boot. The two genuine launch prerequisites
 * this config cannot default are the skills and templates trees (outside a dev
 * checkout); the pre-flight turns either `null` into an actionable error.
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
    /**
     * The harness's `ResourcePolicy`, resolved from `harness.resourceLimits`:
     * the per-step ceilings plus the machine budget and optional ephemeral
     * sandbox size. What the fields mean and how they are enforced is the
     * harness's contract — this module only resolves the values it supplies
     * (see `resolvePolicy` for the derivation and its defaults).
     */
    readonly resourcePolicy: ResourcePolicy;
    /** DBOS admin port. */
    readonly adminPort: number;
    readonly skillsDir: string | null;
    /** Root templates tree for in-process report rendering; `null` outside a dev checkout without the config key. */
    readonly templatesDir: string | null;
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
 * Dev-checkout templates tree: the shared repo-root `templates/` directory
 * (cli/src/modules/harness → four levels up). Meaningless inside a compiled
 * binary — `import.meta.dir` is a bundled virtual path there — which is why
 * non-dev runs require the config key instead.
 */
const devTemplatesDir = join(import.meta.dir, "../../../../templates");

/**
 * Release-build default for `skillsDir`/`templatesDir`: the hash-keyed directory the binary extracts its
 * embedded content into (`modules/harness/content.ts` materializes it before the runtime's pre-flight
 * gate). Pure path computation — no IO here. `env.contentHash` is baked into every release binary (so
 * when `env.isDevelopment` is false it is present); the `null` fallback is a defensive backstop for a
 * misbuild that omitted it, which `ensureBundledContent` catches first and reports as `no_content_hash`.
 * A `null` here degrades to the existing `skills_dir_missing`/`templates_dir_missing` gate rather than a
 * malformed `<contentDir>/undefined/...` path.
 */
function releaseContentDir(sub: "skills" | "templates"): string | null {
    return env.contentHash ? join(env.contentDir, env.contentHash, sub) : null;
}

/** Detected host capacity: logical cores and total memory in whole GB. */
export function detectedMachine(): MachineBudget {
    return {
        cpu: Math.max(1, availableParallelism()),
        memoryGb: Math.max(1, Math.floor(totalmem() / 1024 ** 3)),
    };
}

/**
 * Resolve the resource policy the CLI supplies to the harness. The machine
 * budget — the total share of this host analyses may use — is the value the
 * user owns (`inflexa setup` asks for exactly this); unset, it defaults to
 * half the detected machine, leaving the rest for the user's editor, browser,
 * and the harness itself. The per-step ceilings are derived, not asked: a
 * single step may take the whole allowance (the harness serializes heavy
 * steps against the budget), so they default to the budget itself, with the
 * explicit `maxCpu`/`maxMemoryGb` keys kept as expert overrides. An explicit
 * ceiling above the budget raises the budget to it — the harness rejects a
 * policy whose maximum-size step could never be scheduled, and a user who
 * configured `maxMemoryGb: 16` on a small machine meant to allow such steps
 * to run (one at a time).
 */
function resolvePolicy(cfg: z.infer<typeof harnessConfigSchema> | undefined): ResourcePolicy {
    const machine = detectedMachine();
    const limits = cfg?.resourceLimits;
    const configured = {
        cpu: limits?.budget?.cpu ?? Math.max(1, Math.floor(machine.cpu / 2)),
        memoryGb: limits?.budget?.memoryGb ?? Math.max(1, Math.floor(machine.memoryGb / 2)),
    };
    const perStep: ResourceLimits = {
        maxCpu: limits?.maxCpu ?? configured.cpu,
        maxMemoryGb: limits?.maxMemoryGb ?? configured.memoryGb,
        maxGpuCount: limits?.maxGpuCount ?? 0,
    };
    return {
        perStep,
        budget: {
            cpu: Math.max(configured.cpu, perStep.maxCpu),
            memoryGb: Math.max(configured.memoryGb, perStep.maxMemoryGb),
        },
        ...(limits?.ephemeral && { ephemeral: limits.ephemeral }),
    };
}

/**
 * In the port family of the owned services (proxy 8317, postgres 8432) rather
 * than DBOS's usual 3001, which collides with common dev servers.
 */
const DEFAULT_ADMIN_PORT = 8433;

/** All-defaults resolved config, used when the `harness` key is absent or when it failed validation. */
function defaultsWith(cfg: z.infer<typeof harnessConfigSchema> | undefined, configError?: { issues: string }): ResolvedHarnessConfig {
    const resourcePolicy = resolvePolicy(cfg);
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
        resourcePolicy,
        adminPort: cfg?.adminPort ?? DEFAULT_ADMIN_PORT,
        skillsDir: cfg?.skillsDir ?? (env.isDevelopment ? devSkillsDir : releaseContentDir("skills")),
        templatesDir: cfg?.templatesDir ?? (env.isDevelopment ? devTemplatesDir : releaseContentDir("templates")),
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

/** The harness provider kinds a direct endpoint can speak — the two the harness's AI SDK path covers. */
export type ModelWireProtocol = "anthropic" | "openai-compatible";

/**
 * The two user-facing model agents: `conversation` (the chat agent and its
 * sub-agents) and `sandbox` (the catalog step agents, data profiling, and the ephemeral runner).
 * Internal agents — run synthesis, post-step metadata/summary, target assessment — follow `sandbox`.
 * Derived from the `models.agents` schema keys so the domain type can never drift from the config
 * surface it names.
 */
export type AgentName = keyof NonNullable<z.infer<typeof modelsConfigSchema>["agents"]>;

/**
 * The closed agent set as a runtime list — the source boot iterates for its per-agent resolution. The
 * `satisfies` guard rejects any element that is not a {@link AgentName}, keeping the list honest.
 */
export const AGENT_NAMES = ["conversation", "sandbox"] as const satisfies readonly AgentName[];

/**
 * Per-agent model-id overrides from `models.agents`, each optional. An absent agent falls through the
 * resolution order (`models.agents.<agent>` → `harness.model` → connection default) at boot; this
 * shape carries only what config stated, not the resolved id.
 */
export type AgentModelOverrides = { readonly [Agent in AgentName]?: string };

/**
 * Persist one agent's model id to `models.agents.<agent>` in config.json (the pick
 * is durable the instant it is made, independent of when the live runtime applies it). Spread-preserving
 * like `writeDirectConnection` — every other config key, the `models.connection` block, and the OTHER
 * agent's override are kept; only this agent's entry is rewritten. Returns the write Result so the caller
 * (the palette picker) surfaces a failure and does NOT then apply a runtime change config disagrees with.
 */
export function writeAgentModel(agent: AgentName, model: string): Result<void, ConfigError> {
    const config = readConfig();
    // `config.models` is `unknown` in lib/config.ts (validated downstream by resolveModelConnection), so
    // spread both it and its nested `agents` as plain records to preserve the sibling keys this write does
    // not manage (the connection, and the other agent).
    const models = (config.models ?? {}) as Record<string, unknown>;
    const agents = { ...(models.agents as Record<string, unknown> | undefined), [agent]: model };
    return writeConfig({ ...config, models: { ...models, agents } });
}

/**
 * The model connection resolved to the concrete facts boot consumes. A discriminated union over
 * `mode`: `cliproxy` targets the owned proxy (boot supplies `env.cliproxyApiUrl` + the minted proxy
 * client key), `direct` carries the user's endpoint and wire protocol (secret via
 * `INFLEXA_MODEL_API_KEY`). `provider` is the CONFIGURED vendor slug in both modes — the fact
 * provenance records, never derived from a model id. `agents` carries the per-agent model overrides
 * from `models.agents` verbatim (one shared connection; only the models differ per agent); the RESOLVED per-agent
 * model is computed at boot, where the connection default is knowable. `configError` is set when the
 * `models` block was present but failed validation: boot reports it and falls back to this default
 * connection, exactly as {@link ResolvedHarnessConfig.configError} does for the `harness` block.
 */
export type ResolvedModelConnection =
    | { readonly mode: "cliproxy"; readonly provider: string; readonly agents: AgentModelOverrides; readonly configError?: { issues: string } }
    | {
          readonly mode: "direct";
          readonly provider: string;
          /** The configured endpoint (required in direct mode). */
          readonly baseURL: string;
          readonly protocol: ModelWireProtocol;
          /**
           * An optional refreshing credential source (`models.connection.auth`) — a named env var or a
           * token-minting command — that supersedes the env-key resolution. Carries only the non-secret
           * name/command/scheme; the token is resolved lazily at the wire, never at boot.
           */
          readonly auth?: ModelAuthConfig;
          readonly agents: AgentModelOverrides;
          readonly configError?: { issues: string };
      };

/**
 * The shared connection's identity — the two facts the TUI surfaces beside the per-agent models:
 * the configured provider slug and the mode. A projection of
 * {@link ResolvedModelConnection} carrying ONLY what the status surface renders (never the baseURL,
 * secret, or agent overrides). Boot-resolved and immutable for the runtime's life — a live agent-model
 * swap never changes the connection (it is shared across agents), so it is seeded once.
 */
export type ModelConnectionIdentity = {
    /** The configured vendor slug (`anthropic`, `openai`, …) — the attested fact, never derived from a model id. */
    readonly provider: string;
    /** Which backend the connection targets: the owned local proxy (`cliproxy`), or a user-supplied endpoint (`direct`). */
    readonly mode: ResolvedModelConnection["mode"];
};

/**
 * The zero-config connection: cliproxy mode, provider `anthropic`, no agent overrides — the default an
 * install without a `models` block boots on, so it chats and records provenance with both agents
 * resolving to the one auto-resolved model.
 */
const DEFAULT_MODEL_CONNECTION: ResolvedModelConnection = { mode: "cliproxy", provider: "anthropic", agents: {} };

/**
 * Resolve the `models.connection` block the boot builds the chat provider from. The raw value comes
 * through lib/config.ts as `unknown` and is validated here (same pattern as {@link resolveHarnessConfig}):
 * an absent block — or a present block with no `connection` — resolves to {@link DEFAULT_MODEL_CONNECTION};
 * a present-but-invalid block resolves to that default carrying a `configError` naming the offending
 * fields, so boot reports the real problem instead of a misleading downstream error. The protocol for a
 * direct endpoint is implied from the provider when unset: `anthropic` ⇒ the Anthropic wire kind,
 * every other provider ⇒ OpenAI-compatible; an explicit `protocol` overrides (e.g. an Anthropic-fronting
 * gateway that speaks OpenAI-compatible). cliproxy has no protocol choice — the proxy always exposes the
 * Anthropic Messages route the chat path targets. The `models.agents` overrides ride through verbatim on
 * every non-error branch — including an `agents`-only block (no `connection`), which resolves to the
 * default connection carrying its agent overrides — so boot can resolve each agent's model. A
 * malformed block drops the overrides with the rest of it (they cannot be trusted past a parse failure).
 */
export function resolveModelConnection(): ResolvedModelConnection {
    const raw = readConfig().models;
    if (raw === undefined) return DEFAULT_MODEL_CONNECTION;
    const parsed = modelsConfigSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `models.${i.path.join(".")}: ${i.message}`).join("; ");
        return { ...DEFAULT_MODEL_CONNECTION, configError: { issues } };
    }
    const agents: AgentModelOverrides = parsed.data.agents ?? {};
    const connection = parsed.data.connection;
    if (connection === undefined) return { ...DEFAULT_MODEL_CONNECTION, agents };
    if (connection.mode === "cliproxy") {
        return { mode: "cliproxy", provider: connection.provider ?? "anthropic", agents };
    }
    const protocol: ModelWireProtocol = connection.protocol ?? (connection.provider === "anthropic" ? "anthropic" : "openai-compatible");
    // Carry the optional token-free `auth` source verbatim (present only on a well-formed direct block).
    return {
        mode: "direct",
        provider: connection.provider,
        baseURL: connection.baseURL,
        protocol,
        agents,
        ...(connection.auth !== undefined && { auth: connection.auth }),
    };
}
