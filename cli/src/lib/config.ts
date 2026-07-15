import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Result, ok, err } from "neverthrow";
import { z } from "zod";

import { DEFAULT_THEME_ID, themeIds } from "./design_system.ts";
import { ContainerRuntimeError, ensureReady, firstReadyRuntime, runtimeIds, runtimes, type ContainerRuntime } from "./container.ts";
import { env } from "./env.ts";
import { DEFAULT_DATABASE, DEFAULT_PASSWORD, DEFAULT_PORT, DEFAULT_USER, type PostgresConnection } from "../modules/infra/postgres_types.ts";

const configSchema = z.object({
    telemetry: z.boolean(),
    theme: z.enum(themeIds).catch(DEFAULT_THEME_ID).default(DEFAULT_THEME_ID),
    // Absent = never chosen: the first command that needs containers detects a
    // ready runtime (docker first) and pins it here (see ensureRuntime). A corrupt
    // value is treated as unset — re-detected at next need — rather than silently
    // coerced to docker, which would look like an explicit choice.
    runtime: z.enum(runtimeIds).optional().catch(undefined),
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
    // The model connection block — the user-owned chat backend (see {@link modelsConfigSchema}).
    // Declared `unknown` and validated downstream by `resolveModelConnection` (modules/harness/config.ts)
    // for the SAME reasons the `harness` key is: a strict inline schema would fail the WHOLE config
    // parse on one bad field (dropping telemetry/theme with it), while a block-level `.catch` would
    // SILENTLY discard a malformed block instead of reporting it. Deferring to the resolver names the
    // exact offending field, keeps siblings intact, and fails closed to the cliproxy/anthropic default.
    // The key MUST be declared (zod strips unrecognized keys), else `readConfig().models` is always
    // undefined. Unlike `harness` (whose schema can't live here — lib/ must not import a module), the
    // model connection is a cli-owned config concept, so its schema lives here beside this declaration.
    models: z.unknown().optional(),
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

/**
 * The `models.connection` union — the user-owned chat backend, mirroring the `embedding` block's
 * mode discrimination. `cliproxy` is the managed local proxy (today's default); `direct` is any
 * user-supplied Anthropic or OpenAI-compatible endpoint. `provider` is the vendor slug (an OPEN
 * vocabulary, e.g. `anthropic`/`openai`/`google`) — a configured FACT in both modes, never derived
 * from a model id. `protocol` selects the harness wire kind for direct endpoints; when absent it is
 * implied from the provider (see `resolveModelConnection`). Validated by `resolveModelConnection`
 * (modules/harness/config.ts), not inline, so a malformed block reports a precise error and fails
 * closed without dropping its config siblings.
 */
export const modelConnectionSchema = z.discriminatedUnion("mode", [
    z.object({
        mode: z.literal("cliproxy"),
        provider: z.string().optional(),
    }),
    z.object({
        mode: z.literal("direct"),
        provider: z.string(),
        baseURL: z.string(),
        protocol: z.enum(["anthropic", "openai-compatible"]).optional(),
    }),
]);

/**
 * The top-level `models` block. `connection` selects the ONE shared chat backend; `agents` maps each
 * user-facing agent — `conversation` (the chat agent + its sub-agents) and `sandbox` (the step agents,
 * data profiling, the ephemeral runner) — to an optional model id served by that connection.
 * `connection` is a nested field (rather than a flat `modelConnection`
 * key) precisely so `agents` can live beside it. Both are optional: an `agents`-only block still
 * resolves to the default connection, and an absent `agents` map means both agents resolve to the
 * single configured model — today's behavior verbatim. Per-agent model RESOLUTION
 * (`models.agents.<agent>` → `harness.model` → connection default) lives in `resolveModelConnection`
 * + boot, not in the schema.
 */
export const modelsConfigSchema = z.object({
    connection: modelConnectionSchema.optional(),
    agents: z.object({ conversation: z.string().optional(), sandbox: z.string().optional() }).optional(),
});

export type ConfigError = { type: "config_write_failed"; cause: unknown };

export function readConfig(): Config {
    try {
        const parsed: unknown = JSON.parse(readFileSync(env.configPath, "utf8")); // unknown: on-disk contents, validated by the schema below
        const result = configSchema.safeParse(parsed);
        if (result.success) return result.data;
    } catch {
        // Missing or unreadable config fails closed: consent not granted.
    }
    return { telemetry: false, theme: DEFAULT_THEME_ID, leaderTimeout: 2000, embedding: { mode: "off" } };
}

/**
 * Resolve the configured container runtime to its descriptor, or `null` when the
 * user has never chosen one (commands that need a runtime go through
 * {@link ensureRuntime}, which detects and pins one). Lives here (not in
 * lib/container.ts) so the descriptor registry stays config-free and importable
 * by this module's zod enum without an import cycle.
 */
export function selectedRuntime(): ContainerRuntime | null {
    const id = readConfig().runtime;
    return id === undefined ? null : runtimes[id];
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
 * Peek the on-disk config for a `runtime` string that schema validation discarded.
 * `runtime: z.enum(...).catch(undefined)` silently drops an unrecognized persisted
 * value so corrupt config never blocks startup — but that hides a typo'd selection.
 * Returns the raw string ONLY when the persisted value is a string the enum rejected
 * (the exact case the pin notice must name); a valid id, a non-string, an absent key,
 * or an unreadable/unparseable file all yield `null` — there is nothing to name.
 *
 * Deliberately re-reads the file rather than threading the discarded value through
 * {@link readConfig}: this peek runs only in {@link ensureRuntime}'s pin path, so
 * passive config reads never pay for the extra parse.
 */
function discardedRuntimeValue(): string | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(env.configPath, "utf8")); // unknown: on-disk contents, shape-narrowed below
        if (typeof parsed !== "object" || parsed === null) return null;
        // Sound: the typeof-object/null guard above narrowed `parsed` to a non-null object, so property access on a Record view is safe.
        const raw = (parsed as Record<string, unknown>).runtime;
        // Only a STRING the enum rejected is a discarded selection worth naming: a
        // valid id was never discarded, and a non-string was never a selection.
        if (typeof raw !== "string") return null;
        // Widen the readonly id tuple to readonly string[] only so `.includes` accepts an arbitrary string — no runtime effect.
        return (runtimeIds as readonly string[]).includes(raw) ? null : raw;
    } catch {
        // Unreadable / unparseable raw config: no value to name, stay silent.
        return null;
    }
}

/**
 * The runtime gate for every command that needs containers: resolve the runtime
 * AND verify it is usable, in one step.
 *
 * - An explicit selection is a hard gate: it is probed alone and never silently
 *   switched — only `inflexa setup` (a deliberate re-provisioning act) may move
 *   away from a dead selection.
 * - No selection: probe the supported runtimes in registry order and PIN the
 *   first ready one to config, telling the user. Pinning (rather than floating
 *   per-invocation) makes the choice sticky exactly when the first runtime-bound
 *   state gets created — if Docker reappeared later, a floating resolution would
 *   abandon a Podman-provisioned stack and re-provision a colliding one under
 *   Docker. A failed pin write aborts for the same reason: downstream steps
 *   re-read config, so an unpersisted detection would split one run across two
 *   runtimes.
 *
 * Read-only diagnostics that must not write config (e.g. `sandbox status`)
 * compose {@link selectedRuntime} + `firstReadyRuntime` themselves instead.
 *
 * `probe` is injectable for tests only — the real check spawns runtime binaries.
 */
export async function ensureRuntime(
    probe: (rt: ContainerRuntime) => Promise<Result<void, ContainerRuntimeError>> = ensureReady,
): Promise<Result<ContainerRuntime, ContainerRuntimeError>> {
    const selected = selectedRuntime();
    if (selected) {
        // Hard gate: an explicit selection is probed alone and never switched. Only
        // `inflexa setup` may move off a dead selection, so the failure names it —
        // appended HERE and not in `container.ts`'s hint (shared by setup's own
        // fallback, which must not tell you to run setup) nor in setup itself.
        return (await probe(selected))
            .map(() => selected)
            .mapErr((e) => new ContainerRuntimeError(`${e.message}\n  To switch container runtimes, run \`inflexa setup\`.`));
    }

    const detected = await firstReadyRuntime(
        runtimeIds.map((id) => runtimes[id]),
        probe,
    );
    if (detected.isErr()) return detected;
    const rt = detected.value;

    // Capture any discarded selection BEFORE the write rewrites the file with a valid
    // id — afterward the raw peek would find nothing to name.
    const discarded = discardedRuntimeValue();

    const write = writeConfig({ ...readConfig(), runtime: rt.id });
    if (write.isErr()) {
        return err(
            new ContainerRuntimeError(
                `Detected ${rt.label}, but saving it as the container runtime failed.\n  Check that ${env.configPath} is writable and re-run.`,
            ),
        );
    }
    // Every caller reaches this gate before taking the terminal (the TUI launch
    // path runs it pre-render), so a plain line is safe — and the user must hear
    // that a durable choice was just made on their behalf. When validation discarded
    // a typo'd `runtime` value, name it so the pin does not masquerade as a fresh
    // choice (the discarded selection would otherwise vanish silently).
    console.log(
        discarded !== null
            ? `  Ignoring unrecognized runtime "${discarded}" in config.json — using ${rt.label} and saving it as the container runtime.`
            : `  No container runtime selected — using ${rt.label} and saving it as the container runtime.`,
    );
    return ok(rt);
}

/**
 * Read the chat-backend connection MODE from config — the minimal fact the infra layer needs to shape
 * the compose file (proxy service present in `cliproxy`, dropped in `direct`). Lives here, beside the
 * `models` schema this file owns, rather than pulling the full harness resolver
 * (`resolveModelConnection`, modules/harness/config.ts) into infra's compose-lifecycle callers: the
 * compose file cares about the mode alone, not the provider/protocol/secret the harness boot resolves.
 * Mode selection mirrors `resolveModelConnection` exactly: an absent block, an invalid block, or a
 * connection-less block all resolve to the `cliproxy` default; only a well-formed `direct` connection
 * yields `"direct"`.
 */
export function resolveConnectionMode(): "cliproxy" | "direct" {
    const raw = readConfig().models;
    if (raw === undefined) return "cliproxy";
    const parsed = modelsConfigSchema.safeParse(raw);
    if (!parsed.success) return "cliproxy";
    return parsed.data.connection?.mode ?? "cliproxy";
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
