import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Result } from "neverthrow";

import { env } from "./env.ts";

export interface Config {
    telemetry: boolean;
}

export type ConfigError = { type: "config_write_failed"; cause: unknown };

export function readConfig(): Config {
    try {
        const parsed: unknown = JSON.parse(readFileSync(env.configPath, "utf8"));
        if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)["telemetry"] === "boolean") {
            return { telemetry: (parsed as { telemetry: boolean }).telemetry };
        }
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
