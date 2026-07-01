import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Result } from "neverthrow";
import { z } from "zod";

import { DEFAULT_THEME_ID, themeIds } from "./design_system.ts";
import { runtimeIds, runtimes, type ContainerRuntime } from "./container.ts";
import { env } from "./env.ts";

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
