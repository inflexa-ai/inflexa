import { homedir } from "node:os";
import { join } from "node:path";

const dataVar = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
const configVar = process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME";
const logLevelVar = "INF_LOG_LEVEL";
const otelEndpointVar = "OTEL_EXPORTER_OTLP_ENDPOINT";

function dataDir(): string {
    const base = process.env[dataVar];
    if (base) return base;
    return process.platform === "win32" ? join(homedir(), "AppData", "Local") : join(homedir(), ".local", "share");
}

function configDir(): string {
    const base = process.env[configVar];
    if (base) return base;
    return process.platform === "win32" ? join(homedir(), "AppData", "Roaming") : join(homedir(), ".config");
}

/**
 * CLIProxyAPI listens on this fixed port inside the Docker container we manage
 * (src/cli/setup.ts publishes it) and the chat backend connects to it. We own
 * the container, so the endpoint is intentionally NOT user-overridable — it is
 * not read from process.env. If we ever let users choose the port, derive the
 * URLs from it right here.
 */
const cliproxyPort = 8317;

export const env = Object.freeze({
    dbPath: join(dataDir(), "inf", "agent.db"),
    logDir: join(dataDir(), "inf", "logs"),
    /**
     * Fallback output root, used only when an analysis's anchor folder is not writable
     * (a read-only mount, a directory owned by another user). The default lives beside
     * the data at `<anchor>/.inf/analyses/<slug>/`; this guarantees every analysis always
     * has somewhere to write. See src/modules/analysis/output.ts.
     */
    outputFallbackDir: join(dataDir(), "inf", "analyses"),
    /**
     * CLIProxyAPI runs in Docker (see src/cli/setup.ts). The config and the
     * provider-credential dir are state we own, so they live under our data dir
     * and are bind-mounted into the container.
     */
    cliproxyConfigPath: join(dataDir(), "inf", "cliproxy", "config.yaml"),
    cliproxyAuthDir: join(dataDir(), "inf", "cliproxy", "auth"),
    configPath: join(configDir(), "inf", "config.json"),
    authPath: join(configDir(), "inf", "auth.json"),
    logLevel: process.env[logLevelVar],
    otelEndpoint: process.env[otelEndpointVar],
    /**
     * CLIProxyAPI networking — internal constants, deliberately excluded from
     * envDoc/--help (see the Exclude on envDoc below).
     */
    cliproxyPort,
    cliproxyBaseUrl: `http://localhost:${cliproxyPort}`, // human-facing, no /v1
    cliproxyApiUrl: `http://localhost:${cliproxyPort}/v1`, // chat backend endpoint
});

/**
 * Internal configuration baked into release binaries: `bun run build` inlines
 * each value via --define, so the compiled executable never consults the
 * runtime environment for them — end users cannot override them, and they are
 * deliberately absent from envDoc/--help. Dev runs (`bun run dev`) fall back
 * to runtime env/.env through these same expressions. The literal dot access
 * is load-bearing: the bundler only inlines static `process.env.X` member
 * expressions, never dynamic `process.env[name]` reads. To bake a new value,
 * just add its dot access here — scripts/build.ts derives the baked-var list
 * from this block, so there is nothing else to keep in sync.
 */
export const bakedEnv = Object.freeze({
    auth0Domain: process.env.INF_AUTH0_DOMAIN,
    auth0ClientId: process.env.INF_AUTH0_CLIENT_ID,
    auth0Audience: process.env.INF_AUTH0_AUDIENCE,
});

export type EnvDocEntry = { kind: "path"; label: string; description: string; baseVar: string } | { kind: "var"; name: string; description: string };

/** Rendered into the Paths/Environment sections of --help (src/cli/index.ts). */
export const envDoc: Readonly<Record<Exclude<keyof typeof env, "cliproxyPort" | "cliproxyBaseUrl" | "cliproxyApiUrl">, EnvDocEntry>> = Object.freeze({
    dbPath: { kind: "path", label: "database", description: "saved sessions (SQLite)", baseVar: dataVar },
    logDir: { kind: "path", label: "logs", description: "log files, rotated daily, 7-day retention", baseVar: dataVar },
    outputFallbackDir: { kind: "path", label: "outputs", description: "analysis outputs when the anchor folder isn't writable", baseVar: dataVar },
    cliproxyConfigPath: { kind: "path", label: "proxy config", description: "CLIProxyAPI config, mounted into the proxy container", baseVar: dataVar },
    cliproxyAuthDir: { kind: "path", label: "proxy auth", description: "CLIProxyAPI provider credentials, created by `inf setup`", baseVar: dataVar },
    configPath: { kind: "path", label: "config", description: "settings (telemetry consent)", baseVar: configVar },
    authPath: { kind: "path", label: "auth", description: "Auth0 session tokens, created by `inf auth login`", baseVar: configVar },
    logLevel: { kind: "var", name: logLevelVar, description: "log verbosity: trace|debug|info|warn|error|fatal (default: info)" },
    otelEndpoint: { kind: "var", name: otelEndpointVar, description: "OTLP endpoint for log export; requires telemetry enabled via `inf config`" },
});

// Dev-tooling paths for `bun run dev:install` (scripts/dev_install.ts): where the `inflexa`
// executable is placed on PATH, and where `wipe`'s `repo` target removes it. Homed here so the
// OS path logic lives beside the app's other path derivations, but deliberately OUT of
// `env`/`envDoc` — the compiled binary's users never install it, so it is not a runtime path.

/**
 * The directory `dev:install` puts `inflexa` in, defaulting to a no-sudo, user-writable dir:
 * - macOS/Linux: `~/.local/bin` — the XDG/freedesktop convention for user executables. We avoid
 *   `/usr/local/bin` because it is root-owned on Apple Silicon (Homebrew moved to `/opt/homebrew`),
 *   so a plain install there fails with EACCES.
 * - Windows: `%LOCALAPPDATA%\Microsoft\WindowsApps` — user-writable and on PATH by default.
 *
 * `INF_INSTALL_DIR` overrides it (e.g. `/usr/local/bin` with sudo, or a Homebrew prefix).
 */
export function installDir(): string {
    const override = process.env.INF_INSTALL_DIR;
    if (override) return override;
    if (process.platform === "win32") {
        const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
        return join(localAppData, "Microsoft", "WindowsApps");
    }
    return join(homedir(), ".local", "bin");
}

/** Absolute path of the dev-installed `inflexa` executable (`.exe` on Windows). See {@link installDir}. */
export function installedBinPath(): string {
    return join(installDir(), process.platform === "win32" ? "inflexa.exe" : "inflexa");
}
