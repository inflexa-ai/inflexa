import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { MachineBudget, ResourceLimits, ResourcePolicy } from "@inflexa-ai/harness";
import { readConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { ARCHES, DOCKER_PLATFORM, type Arch } from "../libs/arch.ts";

/**
 * Shape of the `harness` config key. Lives here (not in lib/config.ts) so the harness feature owns
 * its own config contract, and — crucially — so validation is NOT swallowed by a block-level
 * `.catch`: lib/config.ts passes the raw value through as `unknown` and this resolver validates it,
 * turning a single bad field into a precise error instead of silently discarding the whole block.
 */
const harnessConfigSchema = z.object({
    model: z.string().optional(),
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
            budget: z
                .object({
                    cpu: z.number().positive().optional(),
                    memoryGb: z.number().positive().optional(),
                })
                .optional(),
            ephemeral: z
                .object({
                    cpu: z.number().positive(),
                    memoryGb: z.number().positive(),
                })
                .optional(),
        })
        .optional(),
    adminPort: z.number().int().positive().optional(),
    skillsDir: z.string().optional(),
});

/**
 * The `harness` config key resolved to concrete values. The embedder is NOT
 * configured here: it comes from the top-level `embedding` config key, resolved
 * by `modules/embedding/resolve.ts` at boot. The one genuine launch prerequisite
 * this config cannot default is the skills tree (outside a dev checkout); the
 * pre-flight turns its `null` into an actionable error.
 */
export type ResolvedHarnessConfig = {
    /** Chat model id; `null` means resolve the default from the proxy's `/models` at boot. */
    readonly model: string | null;
    /** Absent keys pass as empty strings — the affected tools surface auth errors per-call. */
    readonly bioKeys: {
        readonly drugbank: string;
        readonly disgenet: string;
        readonly epaCcte: string;
        readonly ncbi?: string;
        readonly github?: string;
    };
    readonly sandboxImage: string;
    /**
     * The harness's `ResourcePolicy`, resolved from `harness.resourceLimits`:
     * the per-step ceilings plus the machine budget and optional ephemeral
     * sandbox size. What the fields mean and how they are enforced is the
     * harness's contract — this module only resolves the values it supplies
     * (see `resolvePolicy` for the derivation and its defaults).
     */
    readonly resourcePolicy: ResourcePolicy;
    /** DBOS admin port. */
    readonly adminPort: number;
    readonly skillsDir: string | null;
    /**
     * Host dir to bind-mount read-only at `/mnt/libs`, or `null` when no store is
     * provisioned. Set to the store root ONLY when its `current` symlink exists:
     * Docker auto-creates a missing bind source as a root-owned empty dir, which
     * would silently mount an empty store, so the mount is coupled to the store's
     * actual presence (`inflexa libs pull` creates `current` → the harness starts
     * mounting it). See modules/libs/ and the design's "coupling guard".
     */
    readonly libStorePath: string | null;
    /**
     * Docker `--platform` value forcing sandbox containers onto the SAME
     * architecture as the mounted store (the active store's `meta.json` arch —
     * native binaries under `/mnt/libs` must never run in a mismatched-arch
     * container). `null` when no store is mounted or its arch is unknown: the
     * sandbox then runs at Docker's default platform.
     */
    readonly sandboxPlatform: string | null;
    /**
     * Set when the `harness` config key was present but failed validation (e.g. a field of the wrong
     * type). Carries the offending field paths so boot can report the real problem instead of a
     * misleading downstream error. The other fields are defaults here and must not be relied on.
     */
    readonly configError?: { issues: string };
};

/**
 * Dev-checkout skills tree: the shared repo-root `skills/` directory
 * (cli/src/modules/harness → four levels up). Meaningless inside a compiled
 * binary — `import.meta.dir` is a bundled virtual path there — which is why
 * non-dev runs require the config key instead.
 */
const devSkillsDir = join(import.meta.dir, "../../../../skills");

/** Locally-built image tag (`docker build` per images/sandbox-base/README.md). */
const DEFAULT_SANDBOX_IMAGE = "sandbox-base:latest";

/** Detected host capacity: logical cores and total memory in whole GB. */
export function detectedMachine(): MachineBudget {
    return {
        cpu: Math.max(1, availableParallelism()),
        memoryGb: Math.max(1, Math.floor(totalmem() / 1024 ** 3)),
    };
}

/**
 * Resolve the resource policy the CLI supplies to the harness. The machine
 * budget — the total share of this host analyses may use — is the value the
 * user owns (`inflexa setup` asks for exactly this); unset, it defaults to
 * half the detected machine, leaving the rest for the user's editor, browser,
 * and the harness itself. The per-step ceilings are derived, not asked: a
 * single step may take the whole allowance (the harness serializes heavy
 * steps against the budget), so they default to the budget itself, with the
 * explicit `maxCpu`/`maxMemoryGb` keys kept as expert overrides. An explicit
 * ceiling above the budget raises the budget to it — the harness rejects a
 * policy whose maximum-size step could never be scheduled, and a user who
 * configured `maxMemoryGb: 16` on a small machine meant to allow such steps
 * to run (one at a time).
 */
function resolvePolicy(cfg: z.infer<typeof harnessConfigSchema> | undefined): ResourcePolicy {
    const machine = detectedMachine();
    const limits = cfg?.resourceLimits;
    const configured = {
        cpu: limits?.budget?.cpu ?? Math.max(1, Math.floor(machine.cpu / 2)),
        memoryGb: limits?.budget?.memoryGb ?? Math.max(1, Math.floor(machine.memoryGb / 2)),
    };
    const perStep: ResourceLimits = {
        maxCpu: limits?.maxCpu ?? configured.cpu,
        maxMemoryGb: limits?.maxMemoryGb ?? configured.memoryGb,
        maxGpuCount: limits?.maxGpuCount ?? 0,
    };
    return {
        perStep,
        budget: {
            cpu: Math.max(configured.cpu, perStep.maxCpu),
            memoryGb: Math.max(configured.memoryGb, perStep.maxMemoryGb),
        },
        ...(limits?.ephemeral && { ephemeral: limits.ephemeral }),
    };
}

/**
 * In the port family of the owned services (proxy 8317, postgres 8432) rather
 * than DBOS's usual 3001, which collides with common dev servers.
 */
const DEFAULT_ADMIN_PORT = 8433;

/** All-defaults resolved config, used when the `harness` key is absent or when it failed validation. */
function defaultsWith(cfg: z.infer<typeof harnessConfigSchema> | undefined, configError?: { issues: string }): ResolvedHarnessConfig {
    const resourcePolicy = resolvePolicy(cfg);
    return {
        model: cfg?.model ?? null,
        bioKeys: {
            drugbank: cfg?.bioKeys?.drugbank ?? "",
            disgenet: cfg?.bioKeys?.disgenet ?? "",
            epaCcte: cfg?.bioKeys?.epaCcte ?? "",
            ncbi: cfg?.bioKeys?.ncbi,
            github: cfg?.bioKeys?.github,
        },
        sandboxImage: cfg?.sandboxImage ?? DEFAULT_SANDBOX_IMAGE,
        resourcePolicy,
        adminPort: cfg?.adminPort ?? DEFAULT_ADMIN_PORT,
        skillsDir: cfg?.skillsDir ?? (env.isDev ? devSkillsDir : null),
        ...resolveLibStore(),
        configError,
    };
}

/**
 * The coupling guard: return the store root to mount ONLY when its `current`
 * pointer exists, else `null` (no mount) — plus the Docker platform to force,
 * read from the active version's `meta.json`. Reads the top-level `libStorePath`
 * config override (not a `harness.*` field), defaulting to `env.libStorePath`.
 */
function resolveLibStore(): { libStorePath: string | null; sandboxPlatform: string | null } {
    const root = readConfig().libStorePath ?? env.libStorePath;
    const libStorePath = libStoreMount(root);
    return { libStorePath, sandboxPlatform: libStorePath === null ? null : libStorePlatform(root) };
}

/**
 * The Docker `--platform` value matching the active store's arch, or `null`
 * when the active version's `meta.json` is missing/corrupt or names an unknown
 * arch (a foreign/local build — no platform is forced). Exported for tests.
 */
export function libStorePlatform(root: string): string | null {
    try {
        const version = basename(readlinkSync(join(root, "current")));
        const raw: unknown = JSON.parse(readFileSync(join(root, version, "meta.json"), "utf8")); // on-disk JSON, arch checked below
        if (typeof raw !== "object" || raw === null) return null;
        const arch = (raw as Record<string, unknown>).arch;
        if (typeof arch !== "string" || !(ARCHES as readonly string[]).includes(arch)) return null;
        return DOCKER_PLATFORM[arch as Arch];
    } catch {
        return null;
    }
}

/**
 * Pure coupling-guard predicate: the store root iff `current` is a live store
 * pointer, else `null`. Kept separate (and exported) from {@link resolveLibStoreMount}
 * so the invariant — no live `current`, no mount — is unit-testable against a temp dir.
 *
 * This mirrors `readActive` (modules/libs/store.ts) rather than a bare `existsSync`:
 * `existsSync` FOLLOWS the link, so a `current` that is a real directory (a
 * symlink-dereferencing restore) or a symlink whose target escapes the root would
 * pass the guard while `readActive` reports "no store" — the sandbox would then
 * advertise `/mnt/libs` it does not actually have. The predicate therefore requires
 * `current` to be a symlink whose target resolves, within the root, to an existing
 * version directory (`basename` strips any path components, so an out-of-root target
 * can never name a dir under the root).
 */
export function libStoreMount(root: string): string | null {
    const current = join(root, "current");
    let isSymlink: boolean;
    try {
        isSymlink = lstatSync(current).isSymbolicLink();
    } catch {
        return null; // no `current` entry at all
    }
    if (!isSymlink) return null; // a real dir/file (deref restore) is not a provisioned store
    let target: string;
    try {
        target = readlinkSync(current);
    } catch {
        return null;
    }
    const version = basename(target);
    if (version === "" || version === "." || version === "..") return null; // degenerate pointer → no store
    return existsSync(join(root, version)) ? root : null; // dangling → no store
}

/**
 * Resolve the `harness` config key, filling every defaultable field per-field. The raw value comes
 * through lib/config.ts as `unknown` and is validated here: an absent key resolves to all-defaults,
 * while a present-but-invalid key resolves to all-defaults carrying a `configError` that names the
 * offending fields, so boot reports the real problem instead of a misleading "embedding not
 * configured" error.
 */
export function resolveHarnessConfig(): ResolvedHarnessConfig {
    const raw = readConfig().harness;
    if (raw === undefined) return defaultsWith(undefined);
    const parsed = harnessConfigSchema.safeParse(raw);
    if (parsed.success) return defaultsWith(parsed.data);
    const issues = parsed.error.issues.map((i) => `harness.${i.path.join(".")}: ${i.message}`).join("; ");
    return defaultsWith(undefined, { issues });
}
