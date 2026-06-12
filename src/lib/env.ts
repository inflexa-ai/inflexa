import { homedir } from "node:os";
import { join } from "node:path";

function dataDir(): string {
    if (process.platform === "win32") {
        return process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    }
    return process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
}

function configDir(): string {
    if (process.platform === "win32") {
        return process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
    }
    return process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
}

export const env = Object.freeze({
    dbPath: join(dataDir(), "inf", "agent.db"),
    logDir: join(dataDir(), "inf", "logs"),
    configPath: join(configDir(), "inf", "config.json"),
    logLevel: process.env["INF_LOG_LEVEL"],
    otelEndpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
});
