import { homedir } from "node:os";
import { join } from "node:path";

/**
 * True when this process is a `bun test` run whose sandbox preload never executed — the one condition
 * under which importing this module is a data-loss hazard rather than ordinary configuration.
 *
 * Split out from the import-time guard below purely so the truth table is unit-testable: the guard
 * reads `process.env` during module evaluation, so within a test process it has already run (or not)
 * and cannot be re-driven.
 */
export function isUnsandboxedTestRun(nodeEnv: string | undefined, sandboxMarker: string | undefined): boolean {
    return nodeEnv === "test" && !sandboxMarker;
}

// A `bun test` process that reaches this module without the sandbox marker resolves every `env.*` path
// against the developer's REAL ~/.local/share/inflexa and ~/.config/inflexa. Two live incidents began
// exactly there (agent.db, config.json and the models dir deleted). Bun resolves `bunfig.toml` from the
// cwd and never walks up, so `cli/bunfig.toml`'s `[test].preload` — the thing that redirects XDG_* and
// stamps INFLEXA_TEST_SANDBOX — silently does not apply to a run started anywhere but `cli/`. The repo
// root refuses its own case (root bunfig's preload); this refuses every other, including a nested cwd.
//
// Deny the PATHS, not each destructive call: a test cannot reach a `rmSync` with a real path in hand if
// the path never resolved. `assertTestSandbox` remains the per-site check for the narrower case of a test
// that unsets the marker after this module is already imported.
//
// Inert outside a test run. A built binary has NODE_ENV --defined to its build channel
// ("production" | "development", scripts/build.ts), so the comparison folds to a compile-time false and
// the branch is eliminated. `bun run dev` leaves NODE_ENV unset. `runCli` forwards the parent's whole
// environment, marker included, so its subprocess passes.
//
// `throw` at import rather than a Result: module evaluation has no error channel to return one on, and
// aborting the process loudly IS the correct outcome — same class as `assertTestSandbox`, a test-harness
// boundary whose failure must stop the suite rather than be swallowed by a careless caller.
// The ONE sanctioned NODE_ENV read. The rule that bans it is right — NODE_ENV is not our product-mode
// axis, INFLEXA_BUILD_CHANNEL is — and this is not a product gate: it asks "is this a `bun test`
// process?", which the channel cannot answer (a source run and a test run both leave it unset) and only
// NODE_ENV can. The dot access is load-bearing for exactly the reason the rule cites: scripts/build.ts
// --defines NODE_ENV from the channel, so a shipped binary folds this to `"production" === "test"` and
// eliminates the branch entirely.
// eslint-disable-next-line no-restricted-syntax -- see above
if (isUnsandboxedTestRun(process.env.NODE_ENV, process.env.INFLEXA_TEST_SANDBOX)) {
    throw new Error(
        "refusing to resolve inflexa paths: test sandbox not active — NODE_ENV=test but INFLEXA_TEST_SANDBOX is unset, so env.* would point at your real data. Run `bun test` from cli/ so bunfig's preload redirects XDG_* and stamps the marker.",
    );
}

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
 * (src/modules/infra/setup.ts publishes it) and the chat backend connects to it.
 * We own the container, so the endpoint is intentionally NOT user-overridable — it is
 * not read from process.env. If we ever let users choose the port, derive the
 * URLs from it right here.
 */
const cliproxyPort = 8317;

/**
 * Default host-published port for the inflexa-postgres container. Off the standard
 * 5432 (clashes with a user's system PG) and 5433 (claimed by the harness testcontainer).
 * Rhymes with the proxy's owned port 8317. User-overridable via config.json.
 */
const postgresPort = 8432;

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
// Deferred so the spawnSync only runs when the value is first read (provenance actor, --version), not
// on every CLI startup. INFLEXA_GIT_COMMIT is NOT in the bakedEnv block below — its requirement is
// channel-conditional, and that block's scanner would demand it of every build — so scripts/build.ts
// emits its --define explicitly, gated on a production channel. In a production binary that --define
// makes the first read a string literal and the rest of this function unreachable.
let _gitCommit: string | undefined;
function resolveGitCommit(): string {
    if (process.env.INFLEXA_GIT_COMMIT) return process.env.INFLEXA_GIT_COMMIT;
    // Reaching here in a production build means the artifact bypassed scripts/build.ts (a hand-rolled
    // `bun build`, a patched script). Its own gate already refuses that combination, so this is a
    // backstop, not the enforcement point — but the failure it guards against is silently stamping
    // provenance with a commit resolved from whatever tree the USER happens to be standing in, so it
    // must still crash rather than shell out. Keyed on the baked channel, NOT NODE_ENV: the same
    // --define makes this literal "production" === "production" in a shipped binary, whereas NODE_ENV
    // would be an unguarded runtime read.
    if (process.env.INFLEXA_BUILD_CHANNEL === "production")
        throw new Error("INFLEXA_GIT_COMMIT is not set in a production build. This means the binary was not built correctly.");

    // Dev-only path: resolve from the working tree's HEAD.
    const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
    if (!sha) throw new Error("Could not resolve git HEAD — are you running outside a git checkout?");
    return sha;
}

export const bakedEnv = Object.freeze({
    auth0Domain: process.env.INFLEXA_AUTH0_DOMAIN,
    auth0ClientId: process.env.INFLEXA_AUTH0_CLIENT_ID,
    auth0Audience: process.env.INFLEXA_AUTH0_AUDIENCE,
    // Build channel — `production` | `development` — baked at build time so a shipped binary's
    // identity is fixed at compile and cannot be swayed by the user's runtime environment. The literal
    // `process.env.INFLEXA_BUILD_CHANNEL` dot access is load-bearing: scripts/build.ts scans this block
    // for exactly that pattern to learn which vars to --define, and its missing-var guard rejects an
    // empty/unset value — so a build MUST declare the channel. `bun run dev` leaves it unset (→ undefined
    // → development). This is the ONE signal both `env.isDevelopment` (via isDevelopmentBuild) and
    // `devCommandsEnabled` derive from. We deliberately do NOT read NODE_ENV here: it is the ecosystem's
    // signal for how BUNDLED DEPENDENCIES compile, a separate axis. scripts/build.ts --defines NODE_ENV
    // from this same channel value, so the two are coupled at the single build authority and cannot drift
    // (a `production` binary with a `development` NODE_ENV would ship prod-gated code atop dev-mode deps).
    buildChannel: process.env.INFLEXA_BUILD_CHANNEL,
    get gitCommit(): string {
        if (_gitCommit === undefined) _gitCommit = resolveGitCommit();
        return _gitCommit;
    },
});

/**
 * The pure decision behind `env.isDevelopment`, split out so its truth table is unit-testable: `env`
 * freezes its `bakedEnv.buildChannel` read at import, so the flag's own input cannot be varied within
 * a test process. A build is development unless the `production` channel was baked in — the source-run
 * default (unset channel) is development. Deliberately does NOT honor the `INFLEXA_DEV=1` escape hatch
 * that {@link devCommandsActive} adds: that re-enables dev *commands* on a shipped binary for support,
 * but must not also repoint container names / harness skills+templates dirs at the dev repo checkout.
 */
export function isDevelopmentBuild(channel: string | undefined): boolean {
    return channel !== "production";
}

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
     * Advisory instance locks: `<dataDir>/inflexa/locks/<key>.lock`, keyed by an analysis id (one
     * inflexa process may have an analysis open at a time) or a fixed sentinel for the embedded harness
     * runtime (one DBOS engine per machine). The lock files coordinate that across instances.
     * See src/lib/lock.ts.
     */
    locksDir: join(dataDir(), "inflexa", "locks"),
    /**
     * Harness session trees: `<sessionsDir>/<analysisId>/…` holds an analysis's staged
     * inputs (`data/inputs/…`) and its sandbox run outputs (`runs/<runId>/<stepId>/…`).
     * Deliberately ONE global base rather than per-analysis (e.g. under the analysis's
     * output dir): the embedded harness closes over a single `sessionsBasePath` when its
     * workflows are registered, once per process, so the base cannot vary by analysis.
     * See openspec/changes/embed-harness-runtime (design decision D2).
     */
    sessionsDir: join(dataDir(), "inflexa", "sessions"),
    /**
     * Local embedding model storage: `<dataDir>/inflexa/models/`. The GGUF for
     * `bge-small-en-v1.5` (q8_0, 384-dim) is downloaded here on `inflexa setup --embeddings`
     * opt-in. See src/modules/embedding/setup.ts.
     */
    modelDir: join(dataDir(), "inflexa", "models"),
    /** The local embedding GGUF path — `<modelDir>/bge-small-en-v1.5-q8_0.gguf`. */
    embeddingModelPath: join(dataDir(), "inflexa", "models", "bge-small-en-v1.5-q8_0.gguf"),
    /**
     * CLIProxyAPI runs in a container (Docker or Podman, see
     * src/modules/infra/setup.ts). The config and the provider-credential dir are
     * state we own, so they live under our data dir and are bind-mounted into the
     * container.
     */
    cliproxyConfigPath: join(dataDir(), "inflexa", "cliproxy", "config.yaml"),
    cliproxyAuthDir: join(dataDir(), "inflexa", "cliproxy", "auth"),
    /**
     * Postgres data directory — bind-mounted into the inflexa-postgres container at
     * `/var/lib/postgresql` (the PG 18+ parent mount) so DB state persists across CLI restarts. See
     * src/modules/infra/postgres.ts.
     */
    postgresDataDir: join(dataDir(), "inflexa", "postgres"),
    /**
     * Docker Compose file — generated by `inflexa setup` to orchestrate both the
     * proxy and Postgres containers on a shared network. Regenerated on every setup
     * run; the launch-time gate generates it if missing.
     */
    composeFilePath: join(dataDir(), "inflexa", "docker-compose.yml"),
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
    postgresPort,
    /**
     * True unless this is a production build — derived from the baked {@link bakedEnv.buildChannel}
     * (via {@link isDevelopmentBuild}), never from NODE_ENV. A production binary bakes
     * `INFLEXA_BUILD_CHANNEL=production`, guaranteed by scripts/build.ts's missing-var guard, so
     * `isDevelopment` is a compile-time-fixed `false`; `bun run dev` leaves the channel unset, so it is
     * `true`. Governs dev-only runtime layout: the compose container/network prefix
     * (src/modules/infra/compose.ts) and the harness skills/templates dirs (src/modules/harness/config.ts).
     * Reading NODE_ENV directly would be the wrong signal — its Bun.build value is set by --define from
     * this same channel, but as the deps' compile-mode axis it is intentionally not a source of truth here.
     */
    isDevelopment: isDevelopmentBuild(bakedEnv.buildChannel),
});

/**
 * True when the dev/E2E command surface (`chat`, `profile`, `run`) should be registered.
 * A production build bakes `INFLEXA_BUILD_CHANNEL=production` and gets a product-only surface; any
 * other channel — notably the unset development default of `bun run dev` — enables them. `INFLEXA_DEV=1`
 * is a deliberate runtime escape hatch: it is intentionally NOT in `bakedEnv`, so it is never
 * --define-inlined and stays a live `process.env` read even inside a compiled production binary,
 * letting support re-enable the dev commands on a shipped build without a rebuild. See the
 * dev-commands spec.
 */
export function devCommandsEnabled(): boolean {
    return devCommandsActive(bakedEnv.buildChannel, process.env.INFLEXA_DEV);
}

/**
 * The pure decision behind {@link devCommandsEnabled}, split out only so its truth table is unit
 * testable: `env`/`bakedEnv` freeze their `process.env` reads at import, so the accessor's own
 * inputs cannot be varied within a test process. It is {@link isDevelopmentBuild} (the same
 * baked-channel axis `env.isDevelopment` uses) widened by the `INFLEXA_DEV=1` runtime escape hatch.
 */
export function devCommandsActive(channel: string | undefined, devOverride: string | undefined): boolean {
    return isDevelopmentBuild(channel) || devOverride === "1";
}

export type EnvDocEntry = { kind: "path"; label: string; description: string; baseVar: string } | { kind: "var"; name: string; description: string };

/** Rendered into the Paths/Environment sections of --help (src/cli/index.ts). */
export const envDoc: Readonly<
    Record<Exclude<keyof typeof env, "cliproxyPort" | "cliproxyBaseUrl" | "cliproxyApiUrl" | "postgresPort" | "isDevelopment">, EnvDocEntry>
> = Object.freeze({
    dbPath: { kind: "path", label: "database", description: "saved sessions (SQLite)", baseVar: dataVar },
    logDir: { kind: "path", label: "logs", description: "log files, rotated daily, 7-day retention", baseVar: dataVar },
    outputFallbackDir: { kind: "path", label: "outputs", description: "analysis outputs when the anchor folder isn't writable", baseVar: dataVar },
    locksDir: { kind: "path", label: "locks", description: "advisory per-analysis instance locks", baseVar: dataVar },
    sessionsDir: { kind: "path", label: "sessions", description: "harness session trees: staged inputs and sandbox run outputs", baseVar: dataVar },
    modelDir: { kind: "path", label: "models", description: "local embedding GGUF models, downloaded by `inflexa setup --embeddings`", baseVar: dataVar },
    embeddingModelPath: {
        kind: "path",
        label: "embedding model",
        description: "the bge-small-en-v1.5 GGUF used by the local embedding provider",
        baseVar: dataVar,
    },
    cliproxyConfigPath: { kind: "path", label: "proxy config", description: "CLIProxyAPI config, mounted into the proxy container", baseVar: dataVar },
    cliproxyAuthDir: { kind: "path", label: "proxy auth", description: "CLIProxyAPI provider credentials, created by `inflexa setup`", baseVar: dataVar },
    postgresDataDir: {
        kind: "path",
        label: "postgres data",
        description: "Postgres data dir, bind-mounted into the inflexa-postgres container",
        baseVar: dataVar,
    },
    composeFilePath: {
        kind: "path",
        label: "compose file",
        description: "Docker Compose file orchestrating the proxy and Postgres containers",
        baseVar: dataVar,
    },
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
