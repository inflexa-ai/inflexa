import { homedir } from "node:os";
import { join } from "node:path";

const dataVar = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
const configVar = process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME";
const logLevelVar = "INFLEXA_LOG_LEVEL";
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
 * CLIProxyAPI listens on this fixed port inside the container we manage
 * (src/modules/proxy/setup.ts publishes it) and the chat backend connects to it.
 * We own the container, so the endpoint is intentionally NOT user-overridable — it is
 * not read from process.env. If we ever let users choose the port, derive the
 * URLs from it right here.
 */
const cliproxyPort = 8317;

export const env = Object.freeze({
    dbPath: join(dataDir(), "inflexa", "agent.db"),
    logDir: join(dataDir(), "inflexa", "logs"),
    /**
     * Fallback output root, used only when an analysis's anchor folder is not writable
     * (a read-only mount, a directory owned by another user). The default lives beside
     * the data at `<anchor>/.inflexa/analyses/<slug>/`; this guarantees every analysis always
     * has somewhere to write. See src/modules/analysis/output.ts.
     */
    outputFallbackDir: join(dataDir(), "inflexa", "analyses"),
    /**
     * Advisory per-analysis instance locks: `<dataDir>/inflexa/locks/<analysisId>.lock`. One inflexa
     * process may have an analysis open at a time; the lock files coordinate that across instances.
     * See src/modules/analysis/lock.ts.
     */
    locksDir: join(dataDir(), "inflexa", "locks"),
    /**
     * CLIProxyAPI runs in a container (Docker or Podman, see
     * src/modules/proxy/setup.ts). The config and the provider-credential dir are
     * state we own, so they live under our data dir and are bind-mounted into the
     * container.
     */
    cliproxyConfigPath: join(dataDir(), "inflexa", "cliproxy", "config.yaml"),
    cliproxyAuthDir: join(dataDir(), "inflexa", "cliproxy", "auth"),
    configPath: join(configDir(), "inflexa", "config.json"),
    authPath: join(configDir(), "inflexa", "auth.json"),
    provKeyPath: join(configDir(), "inflexa", "prov_key.json"),
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
// Deferred so the spawnSync only runs when the value is first read (provenance actor, --version),
// not on every CLI startup. In release builds --define inlines process.env.INFLEXA_GIT_COMMIT as a
// string literal, so the fallback is dead code. The fallback is dev-only: resolve from git. If
// neither source produces a commit, the binary was not built correctly — crash rather than silently
// stamping provenance with garbage.
let _gitCommit: string | undefined;
function resolveGitCommit(): string {
    if (process.env.INFLEXA_GIT_COMMIT) return process.env.INFLEXA_GIT_COMMIT;
    if (process.env.NODE_ENV === "production")
        throw new Error("INFLEXA_GIT_COMMIT is not set on production environment. This means the binary was not built correctly.");

    // Dev-only path: resolve from the working tree's HEAD.
    return Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
}

export const bakedEnv = Object.freeze({
    auth0Domain: process.env.INFLEXA_AUTH0_DOMAIN,
    auth0ClientId: process.env.INFLEXA_AUTH0_CLIENT_ID,
    auth0Audience: process.env.INFLEXA_AUTH0_AUDIENCE,
    get gitCommit(): string {
        if (_gitCommit === undefined) _gitCommit = resolveGitCommit();
        return _gitCommit;
    },
});

export type EnvDocEntry = { kind: "path"; label: string; description: string; baseVar: string } | { kind: "var"; name: string; description: string };

/** Rendered into the Paths/Environment sections of --help (src/cli/index.ts). */
export const envDoc: Readonly<Record<Exclude<keyof typeof env, "cliproxyPort" | "cliproxyBaseUrl" | "cliproxyApiUrl">, EnvDocEntry>> = Object.freeze({
    dbPath: { kind: "path", label: "database", description: "saved sessions (SQLite)", baseVar: dataVar },
    logDir: { kind: "path", label: "logs", description: "log files, rotated daily, 7-day retention", baseVar: dataVar },
    outputFallbackDir: { kind: "path", label: "outputs", description: "analysis outputs when the anchor folder isn't writable", baseVar: dataVar },
    locksDir: { kind: "path", label: "locks", description: "advisory per-analysis instance locks", baseVar: dataVar },
    cliproxyConfigPath: { kind: "path", label: "proxy config", description: "CLIProxyAPI config, mounted into the proxy container", baseVar: dataVar },
    cliproxyAuthDir: { kind: "path", label: "proxy auth", description: "CLIProxyAPI provider credentials, created by `inflexa setup`", baseVar: dataVar },
    configPath: { kind: "path", label: "config", description: "settings (telemetry consent)", baseVar: configVar },
    authPath: { kind: "path", label: "auth", description: "Auth0 session tokens, created by `inflexa auth login`", baseVar: configVar },
    provKeyPath: { kind: "path", label: "provenance key", description: "Ed25519 keypair for signing provenance chain hashes", baseVar: configVar },
    logLevel: { kind: "var", name: logLevelVar, description: "log verbosity: trace|debug|info|warn|error|fatal (default: info)" },
    otelEndpoint: { kind: "var", name: otelEndpointVar, description: "OTLP endpoint for log export; requires telemetry enabled via `inflexa config`" },
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
 * `INFLEXA_INSTALL_DIR` overrides it (e.g. `/usr/local/bin` with sudo, or a Homebrew prefix).
 */
export function installDir(): string {
    const override = process.env.INFLEXA_INSTALL_DIR;
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

/**
 * Terminal-environment detection for the clipboard writer (src/lib/clipboard.ts), homed here because
 * env.ts is the single sanctioned `process.env` reader. These are NOT inflexa configuration — they are
 * terminal-multiplexer / display-server facts (the same category as `process.stdout.isTTY`), so they
 * live OUTSIDE the `env`/`envDoc` config object and never appear in `--help`. All three vars are set
 * at process startup and stable for its lifetime, so reading them once at module load is correct.
 */
export const terminalEnv = Object.freeze({
    /** tmux or GNU screen is wrapping us — OSC 52 clipboard writes need DCS passthrough to escape it. */
    multiplexed: Boolean(process.env.TMUX || process.env.STY),
    /** Running under Wayland — the clipboard tool is `wl-copy` rather than X11's `xclip`. */
    wayland: Boolean(process.env.WAYLAND_DISPLAY),
});
