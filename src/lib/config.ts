import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Result } from "neverthrow";
import { z } from "zod";

import { env } from "./env.ts";

const configSchema = z.object({
    telemetry: z.boolean(),
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
    return { telemetry: false };
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
