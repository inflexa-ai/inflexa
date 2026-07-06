import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Result } from "neverthrow";
import { z } from "zod";

import { DEFAULT_THEME_ID, themeIds } from "./design_system.ts";
import { runtimeIds, runtimes, type ContainerRuntime } from "./container.ts";
import { env } from "./env.ts";
import { DEFAULT_DATABASE, DEFAULT_PASSWORD, DEFAULT_PORT, DEFAULT_USER, type PostgresConnection } from "../modules/infra/postgres_types.ts";

const configSchema = z.object({
    telemetry: z.boolean(),
    theme: z.enum(themeIds).catch(DEFAULT_THEME_ID).default(DEFAULT_THEME_ID),
    runtime: z.enum(runtimeIds).catch("docker").default("docker"),
    // Optional keybinding overrides: command id (e.g. "app.command-palette") → key string
    // (e.g. "ctrl+p"). Resolved over defaults by the TUI keymap engine; unknown ids and
    // unparseable values are ignored, so a stray entry never breaks config load.
    keybinds: z.record(z.string(), z.string()).optional(),
    // How long (ms) a half-typed leader sequence stays pending before it is abandoned.
    leaderTimeout: z.number().int().positive().catch(2000).default(2000),
    // Postgres substrate for the embedded harness. Optional — every field falls back
    // per-field to the defaults in modules/infra/postgres_types.ts. Always provisions a local
    // container alongside the proxy (no external mode). The catch salvages a corrupt
    // `postgres` value to safe defaults; no `.default()` at this level — when the key is
    // absent entirely, readConfig yields postgres: undefined and resolvePostgresConfig
    // fills in the per-field defaults.
    postgres: z
        .object({
            host: z.string().optional(),
            port: z.number().int().positive().optional(),
            database: z.string().optional(),
            user: z.string().optional(),
            password: z.string().optional(),
        })
        .catch({})
        .optional(),
    // The embedded harness runtime's settings (data-profile runs). Declared as opaque `unknown` and
    // validated downstream in modules/harness/config.ts (`resolveHarnessConfig`), NOT shaped inline:
    //
    //   - There is no harness-package schema to import. The `harness.*` shape (model/bioKeys/
    //     sandboxImage/adminPort/skillsDir) is THIS cli's user-facing config contract — the knobs the
    //     cli chooses to expose and map onto the harness's runtime deps — not something the harness
    //     package defines. `@inflexa-ai/harness` exports only `ResourceLimitsSchema`, for one sub-field.
    //   - The schema lives in the harness feature slice (modules/harness/config.ts), which owns this
    //     contract. lib/ (infra) must never import a module (see CLAUDE.md dependency rules), so this
    //     file cannot reference that schema — the value crosses the boundary opaque.
    //   - Inline validation here can't satisfy all three needs at once: a strict `z.object({...})` fails
    //     the WHOLE config parse on one bad harness field, dropping siblings (telemetry/theme/postgres)
    //     with it; a block-level `.catch({})` instead SILENTLY discards the harness key, surfacing e.g.
    //     a mistyped `adminPort` as a misleading "embedding not configured". Deferring validation to the
    //     owner reports the exact offending field AND leaves siblings intact.
    //
    // `unknown` (never `any`) forces the owner to parse before use; and the key MUST be declared, because
    // zod strips unrecognized keys — without this line `readConfig().harness` would always be undefined.
    harness: z.unknown().optional(),
    // Embedding backend selection — the ONE config surface for embeddings; the harness
    // runtime consumes it through `resolveEmbedder` (modules/embedding/resolve.ts).
    // `off` until the user runs `inflexa setup --embeddings`. `modelPath` is set when
    // `mode === "local"` (path to the GGUF). `api-key` mode connects DIRECTLY to an
    // OpenAI-compatible endpoint (never through the chat proxy, which serves no
    // embeddings route): `apiKey` is required; `baseURL`/`model`/`dimensions` default
    // to api.openai.com + text-embedding-3-small + 1536. `dimensions` must match what
    // `model` emits — it sizes each per-analysis vector index.
    embedding: z
        .object({
            mode: z.enum(["local", "api-key", "off"]).catch("off").default("off"),
            modelPath: z.string().optional(),
            apiKey: z.string().optional(),
            baseURL: z.string().optional(),
            model: z.string().optional(),
            dimensions: z.number().int().positive().optional(),
        })
        .catch({ mode: "off" })
        .default({ mode: "off" }),
});
export type Config = z.infer<typeof configSchema>;

export type ConfigError = { type: "config_write_failed"; cause: unknown };

export function readConfig(): Config {
    try {
        const parsed: unknown = JSON.parse(readFileSync(env.configPath, "utf8")); // unknown: on-disk contents, validated by the schema below
        const result = configSchema.safeParse(parsed);
        if (result.success) return result.data;
    } catch {
        // Missing or unreadable config fails closed: consent not granted.
    }
    return { telemetry: false, theme: DEFAULT_THEME_ID, runtime: "docker", leaderTimeout: 2000, embedding: { mode: "off" } };
}

/**
 * Resolve the configured container runtime to its descriptor. Lives here (not in
 * lib/container.ts) so the descriptor registry stays config-free and importable
 * by this module's zod enum without an import cycle.
 */
export function activeRuntime(): ContainerRuntime {
    return runtimes[readConfig().runtime];
}

export function writeConfig(config: Config): Result<void, ConfigError> {
    return Result.fromThrowable(
        () => {
            mkdirSync(dirname(env.configPath), { recursive: true });
            writeFileSync(env.configPath, JSON.stringify(config, null, 4) + "\n");
        },
        (cause): ConfigError => ({ type: "config_write_failed", cause }),
    )();
}

/**
 * Resolve the postgres config from {@link readConfig}, filling every unset field
 * per-field with the defaults from modules/infra/postgres_types.ts. The result is a
 * fully-populated {@link PostgresConnection} — no `undefined` fields — the
 * harness-wiring change will hand to `createPool` as a `PoolConfig`. Missing or
 * corrupt config yields all-defaults (mode docker, image pgvector/pgvector:pg18,
 * db/user/password inflexa, port 8432), so a fresh install never blocks boot.
 */
export function resolvePostgresConfig(): PostgresConnection {
    const pg = readConfig().postgres;
    return {
        host: pg?.host ?? "localhost",
        port: pg?.port ?? DEFAULT_PORT,
        database: pg?.database ?? DEFAULT_DATABASE,
        user: pg?.user ?? DEFAULT_USER,
        password: pg?.password ?? DEFAULT_PASSWORD,
    };
}
