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
    // The embedded harness runtime (data-profile runs). Optional — per-field defaults
    // resolve in modules/harness/config.ts, mirroring the postgres key's pattern.
    // `embedding` has no defaults: the local proxy serves no embeddings endpoint
    // (Anthropic auth), so a user-supplied OpenAI-compatible endpoint is a launch
    // prerequisite. The catch salvages a corrupt `harness` value to all-defaults.
    harness: z
        .object({
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
        })
        .catch({})
        .optional(),
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
    return { telemetry: false, theme: DEFAULT_THEME_ID, runtime: "docker", leaderTimeout: 2000 };
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
