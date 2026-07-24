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

// DATA-LOSS GUARD. A `bun test` process that reaches this module without the sandbox marker resolves
// every `env.*` path against the developer's REAL ~/.local/share/inflexa and ~/.config/inflexa — two
// live incidents began exactly there (full story: src/test_support/sandbox.ts). Bun reads bunfig from
// the cwd only, so `cli/bunfig.toml`'s preload (which redirects XDG_* and stamps INFLEXA_TEST_SANDBOX)
// covers only runs started in `cli/`; the root bunfig refuses the root run; this refuses every other
// cwd. Deny the PATHS, not each destructive call: a test cannot reach a `rmSync` with a real path in
// hand if the path never resolved. `assertTestSandbox` remains the per-site check for the one case
// this cannot see — a test that unsets the marker after this module is already imported.
//
// Inert outside `bun test`: a built binary has NODE_ENV --defined to its channel (scripts/build.ts),
// folding the comparison to a compile-time false; `bun run dev` leaves NODE_ENV unset; `runCli`
// forwards the parent's whole environment, marker included, so its subprocess passes.
//
// `throw`, not Result: module evaluation has no error channel, and a test-harness boundary's failure
// must stop the suite loudly. This is also the ONE sanctioned NODE_ENV read: it asks "is this a
// `bun test` process?", which only NODE_ENV can answer (the build channel is unset in both a source
// run and a test run) — and the literal dot access is what lets the build's --define eliminate the
// branch in a shipped binary.
// eslint-disable-next-line no-restricted-syntax -- the one sanctioned NODE_ENV read; see above
if (isUnsandboxedTestRun(process.env.NODE_ENV, process.env.INFLEXA_TEST_SANDBOX)) {
    throw new Error(
        "refusing to resolve inflexa paths: test sandbox not active — NODE_ENV=test but INFLEXA_TEST_SANDBOX is unset, so env.* would point at your real data. Run `bun test` from cli/ so bunfig's preload redirects XDG_* and stamps the marker.",
    );
}

const dataVar = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
const configVar = process.platform === "win32" ? "APPDATA" : "XDG_CONFIG_HOME";
const logLevelVar = "INFLEXA_LOG_LEVEL";
const otelEndpointVar = "OTEL_EXPORTER_OTLP_ENDPOINT";
const modelApiKeyVar = "INFLEXA_MODEL_API_KEY";
// The ecosystem-conventional provider variables a `direct` connection can read/adopt. The API-key vars
// are the provider-derived FALLBACK for the direct-mode secret (after INFLEXA_MODEL_API_KEY); the
// *_BASE_URL vars are read ONLY for one-time setup detection (never a runtime endpoint binding). Homed
// here because env.ts is the sole `process.env` reader — see resolveModelApiKey / detectProviderEnv.
const anthropicApiKeyVar = "ANTHROPIC_API_KEY";
const openaiApiKeyVar = "OPENAI_API_KEY";
const anthropicBaseUrlVar = "ANTHROPIC_BASE_URL";
const openaiBaseUrlVar = "OPENAI_BASE_URL";
// The Anthropic-wire BEARER token variable. A short-lived first-party token (WIF / gateway / enterprise
// credential) rather than a static `x-api-key`; consumed as a `direct`-mode credential source via a
// configured `{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }` auth block, and detected by
// setup. Read here (the sole `process.env` reader) — see {@link anthropicAuthTokenSet}.
const anthropicAuthTokenVar = "ANTHROPIC_AUTH_TOKEN";

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

/**
 * The host ports the stack binds and the four host-side mount/compose paths it binds — split into pure
 * helpers so the whole stack identity derives from ONE channel signal ({@link isDevelopmentBuild} over the
 * baked build channel, never NODE_ENV), the same signal `compose.ts` names its containers/networks from.
 * Two of the three ports are published by the containers (proxy, Postgres); the third — the DBOS `admin`
 * port — is bound by the harness runtime's in-process admin HTTP server (modules/harness/runtime.ts), not a
 * container, yet lives in this same table because this helper is the SINGLE place a channel's owned
 * host-port allocation is decided, so cross-channel collision avoidance is provable in one spot. Exported
 * (rather than folded into `env`) because the frozen `env` reads the channel once at import and cannot be
 * re-driven inside a test process — the file's established testability pattern (see {@link isDevelopmentBuild}).
 *
 * WHY the entire stack — not just container names — must fork by channel: on a dual-build machine (every
 * developer runs `bun run dev` beside an installed binary) the two stacks share exactly these resources,
 * and each shared one is a collision:
 *   - a HOST PORT bind — the loser's container sits dead in `Created` while the winner holds the port;
 *   - the COMPOSE FILE — every entry point regenerates it from the running channel's config, so one build
 *     silently rewrites the file the other executes (cross-regeneration);
 *   - the POSTGRES DATA DIR — one shared PGDATA means two engines racing the same on-disk cluster;
 *   - and most dangerously the CLIProxyAPI CREDENTIAL DIR — two independently-refreshing proxies pointed
 *     at ONE rotating OAuth refresh-token credential corrupt it: each rotation invalidates the other's
 *     copy, tripping provider reuse-detection and killing the grant (the forced-relogin symptom the
 *     launch gate was built to remove). Dev therefore signs in once into its OWN credential dir and never
 *     reads or writes the production one.
 *
 * Production values are byte-identical to their historical form, so an installed binary is untouched; dev
 * gets fixed sibling ports (proxy 8318, postgres 8434, admin 8435) and sibling paths (`cliproxy-dev/`,
 * `postgres-dev/`, `docker-compose.dev.yml`). Dev Postgres deliberately avoids 8433 — the PRODUCTION DBOS
 * admin server binds it, so a dev Postgres there would EADDRINUSE the first harness boot on a dual-build
 * machine — plus 5432 (system PG) and 5433 (the harness testcontainer). Run together, the full bound-port
 * set is six distinct listeners: prod {8317, 8432, 8433} ∪ dev {8318, 8434, 8435}.
 */
export type StackPorts = {
    /** Host port the CLIProxyAPI container publishes (also the URL the chat backend connects to). */
    readonly cliproxy: number;
    /** Default host port the Postgres container publishes — the channel-aware default for `postgres.port`. */
    readonly postgres: number;
    /**
     * Default host port the harness's DBOS admin HTTP server binds — modules/harness/runtime.ts hands it to
     * `DBOS.setConfig({ adminPort })` before `DBOS.launch()`, which opens a live host listener there. It is
     * the channel-aware default for `harness.adminPort`; a config.json override still wins. It lives in this
     * table beside the two container ports — even though the runtime, not a container, binds it — because
     * this helper is the single place a channel's owned host-port allocation is decided, so a dev and an
     * installed prod runtime are provably never contending for a bind.
     */
    readonly admin: number;
};

/** Channel-aware host ports for the stack — dev siblings (8318/8434/8435) off the production trio (8317/8432/8433). See {@link StackPorts}. */
export function stackPorts(channel: string | undefined): StackPorts {
    return isDevelopmentBuild(channel) ? { cliproxy: 8318, postgres: 8434, admin: 8435 } : { cliproxy: 8317, postgres: 8432, admin: 8433 };
}

/**
 * The Postgres host ports RESERVED as channel defaults — production 8432 and dev 8434, the two values
 * {@link stackPorts} hands out. NEITHER may ever live in `config.json` as an explicit choice: the file is
 * shared by both build channels, so pinning either channel's sibling default there overrides the OTHER
 * channel's default and re-creates the very stack collision the channel-aware defaults remove — and a pin
 * cannot be healed from the channel whose default it does not equal (that channel reads it back as a real
 * choice). So a port equal to a reserved value is treated as "no choice" on BOTH sides of the boundary:
 * `explicitPostgresFields` (setup.ts) never persists it, and `resolvePostgresConfig` (config.ts) never
 * honors it — falling back to THIS channel's sibling default, which self-heals a pin an older build froze,
 * on the first resolve, from either channel. Any OTHER value is a genuine user choice that deliberately
 * applies to both channels per the per-field override contract.
 */
export const reservedPostgresPorts: readonly number[] = [stackPorts("production").postgres, stackPorts("development").postgres];

/** True when `port` is one of the {@link reservedPostgresPorts} channel defaults — never persisted or honored as an explicit choice. */
export function isReservedPostgresPort(port: number): boolean {
    return reservedPostgresPorts.includes(port);
}

/** The four host-side stack paths that must not be shared across build channels. See {@link stackPaths}. */
export type StackPaths = {
    /** CLIProxyAPI config file, bind-mounted into the proxy container. */
    readonly cliproxyConfigPath: string;
    /** CLIProxyAPI provider-credential dir, bind-mounted into the proxy container. */
    readonly cliproxyAuthDir: string;
    /** Postgres data dir, bind-mounted into the Postgres container. */
    readonly postgresDataDir: string;
    /** Generated Docker Compose file orchestrating the stack. */
    readonly composeFilePath: string;
};

/**
 * Channel-aware stack paths under `<dataDirBase>/inflexa/…`. Dev derives sibling names so a dev stack
 * never shares a mount source or compose file with an installed production stack (see {@link StackPorts}
 * for the collision surface). Production names are byte-identical to their pre-change form.
 */
export function stackPaths(dataDirBase: string, channel: string | undefined): StackPaths {
    const dev = isDevelopmentBuild(channel);
    const proxyDir = dev ? "cliproxy-dev" : "cliproxy";
    const postgresDir = dev ? "postgres-dev" : "postgres";
    const composeFile = dev ? "docker-compose.dev.yml" : "docker-compose.yml";
    return {
        cliproxyConfigPath: join(dataDirBase, "inflexa", proxyDir, "config.yaml"),
        cliproxyAuthDir: join(dataDirBase, "inflexa", proxyDir, "auth"),
        postgresDataDir: join(dataDirBase, "inflexa", postgresDir),
        composeFilePath: join(dataDirBase, "inflexa", composeFile),
    };
}

// The stack's ports and paths, each derived ONCE from the baked channel for the frozen env below.
const stack = stackPorts(bakedEnv.buildChannel);
const stackDirs = stackPaths(dataDir(), bakedEnv.buildChannel);

export const env = Object.freeze({
    dbPath: join(dataDir(), "inflexa", "agent.db"),
    logDir: join(dataDir(), "inflexa", "logs"),
    /**
     * Public reference-data store. Deliberate setup/download actions create this path; passive
     * runtime composition only checks whether it exists before offering it to the harness.
     */
    refsDir: join(dataDir(), "inflexa", "refs"),
    /**
     * Cached sandbox-image package inventories, one directory per image ID. NOT a library
     * store: the packages themselves are baked into the image and never staged here — this
     * holds only the `packages.txt` extracted from the image's inventory label, so the
     * harness can read on the host what otherwise exists only inside the container.
     */
    libsDir: join(dataDir(), "inflexa", "libs"),
    /**
     * Materialized skills/templates content: `<dataDir>/inflexa/content/<contentHash>/{skills,templates}`.
     * A peer of `refsDir`/`modelDir` — a runtime asset tree, not config — but sourced from the binary's
     * OWN embedded archive rather than a network download (see modules/harness/content.ts). The
     * `<contentHash>` segment (see {@link env.contentHash}) makes a new binary version extract a fresh
     * tree on first run, so updates ride the install. Only ever written/read in a release build; a dev
     * run points skills/templates at the repo checkout and never touches this path.
     */
    contentDir: join(dataDir(), "inflexa", "content"),
    /**
     * Advisory instance locks: `<dataDir>/inflexa/locks/<key>.lock`, keyed by an analysis id (one
     * inflexa process may have an analysis open at a time) or a fixed sentinel for the embedded harness
     * runtime (one DBOS engine per machine). The lock files coordinate that across instances.
     * See src/lib/lock.ts.
     */
    locksDir: join(dataDir(), "inflexa", "locks"),
    /**
     * Local embedding model storage: `<dataDir>/inflexa/models/`. The GGUF for
     * `bge-small-en-v1.5` (q8_0, 384-dim) is downloaded here on `inflexa setup --embeddings`
     * opt-in. See src/modules/embedding/setup.ts.
     */
    modelDir: join(dataDir(), "inflexa", "models"),
    /** The local embedding GGUF path — `<modelDir>/bge-small-en-v1.5-q8_0.gguf`. */
    embeddingModelPath: join(dataDir(), "inflexa", "models", "bge-small-en-v1.5-q8_0.gguf"),
    /**
     * Local embedding sidecar runtime: `<dataDir>/inflexa/llama-server/`. The pinned `llama.cpp`
     * release (the `llama-server` binary + its shared libraries) is materialized into a tag-named
     * subdirectory here on `inflexa setup --embeddings local` opt-in — extracted from a build-time
     * embedded asset in the compiled binary, downloaded from source. See
     * src/modules/embedding/llama_runtime.ts.
     */
    llamaServerDir: join(dataDir(), "inflexa", "llama-server"),
    /**
     * CLIProxyAPI runs in a container (Docker or Podman, see
     * src/modules/infra/setup.ts). The config and the provider-credential dir are
     * state we own, so they live under our data dir and are bind-mounted into the
     * container.
     */
    cliproxyConfigPath: stackDirs.cliproxyConfigPath,
    cliproxyAuthDir: stackDirs.cliproxyAuthDir,
    /**
     * Postgres data directory — bind-mounted into the inflexa-postgres container at
     * `/var/lib/postgresql` (the PG 18+ parent mount) so DB state persists across CLI restarts. See
     * src/modules/infra/postgres.ts.
     */
    postgresDataDir: stackDirs.postgresDataDir,
    /**
     * Docker Compose file — generated by `inflexa setup` to orchestrate both the
     * proxy and Postgres containers on a shared network. Regenerated on every setup
     * run; the launch-time gate generates it if missing.
     */
    composeFilePath: stackDirs.composeFilePath,
    configPath: join(configDir(), "inflexa", "config.json"),
    authPath: join(configDir(), "inflexa", "auth.json"),
    provKeyPath: join(configDir(), "inflexa", "prov_key.json"),
    logLevel: process.env[logLevelVar],
    otelEndpoint: process.env[otelEndpointVar],
    /**
     * CLIProxyAPI networking — channel-aware ports from {@link stackPorts}, deliberately excluded from
     * envDoc/--help (see the Exclude on envDoc below). We own the container, so the endpoint is NOT
     * user-overridable; the URLs interpolate the derived port so a channel switch moves all three together.
     */
    cliproxyPort: stack.cliproxy,
    cliproxyBaseUrl: `http://localhost:${stack.cliproxy}`, // human-facing, no /v1
    cliproxyApiUrl: `http://localhost:${stack.cliproxy}/v1`, // chat backend endpoint
    postgresPort: stack.postgres,
    /**
     * Default host port the harness runtime's DBOS admin HTTP server binds — the channel-aware default for
     * `harness.adminPort` (modules/harness/config.ts). Excluded from envDoc/--help below like the other
     * derived ports: we own the bind and a config.json override supersedes it, so it is not a user-facing
     * env path. See {@link stackPorts} for the port-family and cross-channel collision-avoidance rationale.
     */
    adminPort: stack.admin,
    /**
     * The build-baked identity of the embedded skills/templates archive — a short hash over the
     * archived file set (see scripts/build.ts), naming the {@link env.contentDir} subdirectory the
     * release binary extracts into. `--define`d at build time exactly like `INFLEXA_GIT_COMMIT` (an
     * EXPLICIT define, deliberately NOT in the {@link bakedEnv} scanner block — that block's missing-var
     * guard applies to every channel and would reject a development build, which legitimately has no
     * archive). Hence `string | undefined`: a `bun run dev` process has no baked value, and the dev
     * skills/templates resolution never reads this.
     */
    contentHash: process.env.INFLEXA_CONTENT_HASH,
    /**
     * True unless the `production` channel was baked in — {@link isDevelopmentBuild} over
     * {@link bakedEnv.buildChannel}, never NODE_ENV (the buildChannel note above owns the
     * one-axis rationale). Governs dev-only runtime layout: the compose container/network prefix
     * (src/modules/infra/compose.ts) and the harness skills/templates dirs (src/modules/harness/config.ts).
     */
    isDevelopment: isDevelopmentBuild(bakedEnv.buildChannel),
});

/**
 * The provider-conventional API-key variable NAME for `provider` — `ANTHROPIC_API_KEY` for `anthropic`,
 * `OPENAI_API_KEY` for every other provider. The name only, never the value: used to name the tried
 * fallback in the boot key-missing error and setup's guidance, so those messages stay honest without a
 * second `process.env` reader. See {@link resolveModelApiKey} for the resolution that consumes it.
 */
export function providerApiKeyVar(provider: string): string {
    return provider === "anthropic" ? anthropicApiKeyVar : openaiApiKeyVar;
}

/**
 * Resolve the `direct`-connection chat API key from the environment ONLY (env.ts is the sole `process.env`
 * reader), parameterized by the connection's `provider`. Precedence: `INFLEXA_MODEL_API_KEY` (the explicit
 * override), then the provider-conventional variable ({@link providerApiKeyVar}) so a machine already
 * provisioned for Claude Code / the SDKs works unchanged. Read at call time (not frozen at import) so it
 * reflects the live environment. The resolved value is NEVER written to config, telemetry, logs, or
 * provenance — it READS an existing secret, never copies it. Ignored in `cliproxy` mode (its own client key).
 *
 * This is the DEFAULT credential path; a configured `auth` block instead supplies a refreshing source that
 * supersedes it (including the `ANTHROPIC_AUTH_TOKEN` bearer case — see lib/credential.ts). Bedrock/Vertex
 * stay out of scope (no direct-mode HTTP `/v1` signer).
 */
export function resolveModelApiKey(provider: string): string | undefined {
    return process.env[modelApiKeyVar] ?? process.env[providerApiKeyVar(provider)];
}

/**
 * True when {@link anthropicAuthTokenVar} (`ANTHROPIC_AUTH_TOKEN`) is set — the env signal of a bearer-token
 * Anthropic setup. Read here because env.ts is the sole `process.env` reader; setup consumes it (never the
 * value) to OFFER the `{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }` credential source.
 */
export function anthropicAuthTokenSet(): boolean {
    return Boolean(process.env[anthropicAuthTokenVar]);
}

/**
 * Read a single environment variable for the credential source's `env` kind (lib/credential.ts) — the sole
 * sanctioned `process.env` read behind it. A live read (not frozen at import) so a re-exported token is
 * picked up and a 401 can re-read it; an empty value counts as unset.
 */
export function readEnvCredentialVar(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
}

/**
 * The presence + endpoint facts of the conventional provider environment, for `inflexa setup`'s
 * one-time direct-path adoption (see modules/infra/setup.ts). Deliberately reports only WHETHER each API
 * key is set — never its value — because setup copies only the non-secret `{ provider, baseURL, protocol }`
 * into config; the key stays an environment read via {@link resolveModelApiKey}. The `*_BASE_URL` values
 * are the RAW convention (asymmetric: `ANTHROPIC_BASE_URL` is a bare root, `OPENAI_BASE_URL` is usually
 * already `/v1`-terminated); setup normalizes them before offering the pre-fill.
 */
export type ProviderEnvSnapshot = {
    /** `ANTHROPIC_API_KEY` is set (value withheld — setup never copies the key). */
    readonly anthropicApiKeySet: boolean;
    /** `ANTHROPIC_BASE_URL` if set — a BARE root by convention (the Anthropic SDK appends `/v1/…`). */
    readonly anthropicBaseURL: string | undefined;
    /** `OPENAI_API_KEY` is set. */
    readonly openaiApiKeySet: boolean;
    /** `OPENAI_BASE_URL` if set — usually already `/v1`-terminated. */
    readonly openaiBaseURL: string | undefined;
};

/**
 * Snapshot the conventional provider environment for setup's direct-path detection. The SOLE reader of
 * the ecosystem `*_BASE_URL` variables — a one-time setup read, never a runtime endpoint binding (boot
 * resolves the endpoint from config only). Read at call time so `inflexa setup` sees the live shell.
 */
export function detectProviderEnv(): ProviderEnvSnapshot {
    return {
        anthropicApiKeySet: Boolean(process.env[anthropicApiKeyVar]),
        anthropicBaseURL: process.env[anthropicBaseUrlVar] || undefined,
        openaiApiKeySet: Boolean(process.env[openaiApiKeyVar]),
        openaiBaseURL: process.env[openaiBaseUrlVar] || undefined,
    };
}

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
    Record<
        Exclude<keyof typeof env, "cliproxyPort" | "cliproxyBaseUrl" | "cliproxyApiUrl" | "postgresPort" | "adminPort" | "isDevelopment" | "contentHash">,
        EnvDocEntry
    >
> = Object.freeze({
    dbPath: { kind: "path", label: "database", description: "saved sessions (SQLite)", baseVar: dataVar },
    logDir: { kind: "path", label: "logs", description: "log files, rotated daily, 7-day retention", baseVar: dataVar },
    refsDir: {
        kind: "path",
        label: "references",
        description: "reference data mounted read-only in sandboxes at /mnt/refs",
        baseVar: dataVar,
    },
    libsDir: {
        kind: "path",
        label: "package inventories",
        description: "per-image package lists extracted from the sandbox image's inventory label",
        baseVar: dataVar,
    },
    contentDir: {
        kind: "path",
        label: "content",
        description: "skills/templates extracted from the binary on first run, keyed by content hash",
        baseVar: dataVar,
    },
    locksDir: { kind: "path", label: "locks", description: "advisory per-analysis instance locks", baseVar: dataVar },
    modelDir: { kind: "path", label: "models", description: "local embedding GGUF models, downloaded by `inflexa setup --embeddings`", baseVar: dataVar },
    embeddingModelPath: {
        kind: "path",
        label: "embedding model",
        description: "the bge-small-en-v1.5 GGUF used by the local embedding provider",
        baseVar: dataVar,
    },
    llamaServerDir: {
        kind: "path",
        label: "llama runtime",
        description: "pinned llama-server runtime for local embeddings, materialized by `inflexa setup --embeddings local`",
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

/**
 * `--help` documentation for the direct-connection secret channel — vars that are NOT backed by an `env`
 * field because they are resolved on demand by {@link resolveModelApiKey} (parameterized by provider),
 * not eagerly read into the frozen `env`. Kept separate from {@link envDoc} precisely because that record
 * is key-locked to `env`'s fields: surfacing these as `env` fields would widen the secret's surface for
 * no gain. Rendered alongside `envDoc`'s var rows by src/cli/index.ts.
 *
 * `ANTHROPIC_AUTH_TOKEN` is consumed not as a bare env fallback here but via a configured `direct`-mode
 * `auth` block (`{ kind: "env", var: "ANTHROPIC_AUTH_TOKEN", scheme: "bearer" }` — see lib/credential.ts);
 * setup offers it when detected. Bedrock/Vertex remain out of scope (no direct-mode HTTP signer).
 */
export const modelConnectionEnvDoc: readonly { readonly name: string; readonly description: string }[] = Object.freeze([
    {
        name: modelApiKeyVar,
        description:
            'API key for a direct model connection (config `models.connection.mode: "direct"`) — the explicit override, tried first; unused with the default managed proxy',
    },
    {
        name: `${anthropicApiKeyVar} / ${openaiApiKeyVar}`,
        description:
            "provider-conventional fallback for the direct-connection key when INFLEXA_MODEL_API_KEY is unset (ANTHROPIC_API_KEY for provider anthropic, OPENAI_API_KEY otherwise); read from the environment only, never persisted",
    },
]);

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
