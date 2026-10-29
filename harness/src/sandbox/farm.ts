/**
 * Farm-source resolution and the `inflexa.lock` farm contract.
 *
 * A farm carries exactly one metadata file, `inflexa.lock`, beside its link
 * trees and its caches (the lib-store spec). The mount gate and the package
 * inventory read this one file — `packages.txt`, `meta.json`, and
 * `lock.json` are not part of the farm contract.
 *
 * The resolution and the gate refuse differently, on purpose:
 * - A resolver refusal (`unavailable`, or a throw) is a `farm_unavailable`
 *   `SandboxError` — the call refuses and no container is made.
 * - A lock-gate failure degrades — the backend drops both store mounts,
 *   logs a warning, and still makes the container. Under a config that
 *   declares `packageStore: "required"`, the same failure refuses with
 *   `farm_unusable`, and no container is made.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { safeParseJsonAs } from "../lib/parse-json.js";
import type { SandboxError } from "./sandbox-error.js";
import type { FarmLocation, FarmSource } from "./types.js";

/** The one metadata file of a farm. */
export const FARM_LOCK_FILE = "inflexa.lock";

/** One linked distribution. `requested` obeys the PEP 376 meaning: true for a direct ask, false for a transitive dependency. */
export const FarmLockPackageSchema = z.looseObject({
    name: z.string(),
    version: z.string(),
    /** The link subtree of the package (for example `python`, `cran`, `bioconductor`). */
    track: z.string(),
    store_dir: z.string(),
    /** The full sha256 of the sorted store tree. */
    hash: z.string(),
    requested: z.boolean(),
    /**
     * The provenance of a source-built distribution, read from its build record
     * at composition time. An index entry carries none, because the pinned index
     * is its provenance. Additive, thus the lock schema number stays 1.
     */
    source: z
        .union([z.looseObject({ url: z.string(), commit: z.string(), pin: z.string() }), z.looseObject({ treeHash: z.string(), pin: z.string() })])
        .optional(),
});

/**
 * Whatever `JSON.parse` yields: a JSON value, plus Infinity — an over-large
 * literal such as `1e999` reads as Infinity, which `z.json()` refuses.
 * `JSON.parse` output never holds `undefined`, so the check is exact for that feed.
 */
const ParsedJsonValue = z.custom<unknown>((value) => value !== undefined);

/**
 * `inflexa.lock` at schema version 1. Additive fields pass through — a
 * breaking change to the shape must move the schema number instead.
 */
export const FarmLockSchema = z.looseObject({
    schema: z.literal(1),
    arch: z.enum(["amd64", "arm64"]),
    packages: z.array(FarmLockPackageSchema),
    /** Per-language provenance. Each language object owns its own fields. */
    languages: z.looseObject({
        python: z.looseObject({ version: z.string(), index: z.string() }).optional(),
        r: z
            .looseObject({
                version: z.string(),
                bioc_releases: z.array(z.string()),
                /** The embedded pak lock of the build, verbatim. */
                pak_lock: ParsedJsonValue.optional(),
            })
            .optional(),
    }),
    /** The warm replay record. Present in the catalog farm only. */
    warm: z
        .record(
            z.string(),
            z.looseObject({
                script_sha256: z.string(),
                cache_entries: z.array(z.string()),
            }),
        )
        .optional(),
    /** The top-level entries that the link merge kept-first or skipped. */
    merge_conflicts: z
        .array(
            z.looseObject({
                entry: z.string(),
                action: z.enum(["kept-first", "skipped"]),
            }),
        )
        .optional(),
});
export type FarmLock = z.infer<typeof FarmLockSchema>;

export type FarmLockError =
    | { readonly type: "lock_unreadable"; readonly lockPath: string; readonly cause: unknown }
    | { readonly type: "lock_invalid"; readonly lockPath: string; readonly cause: unknown };

/**
 * Read and validate the `inflexa.lock` of a farm directory. The mount gate
 * accepts a farm only when this returns ok — a farm whose lock is absent,
 * unparseable, or at an unknown schema version is not usable.
 */
export function readFarmLock(farmPath: string): Result<FarmLock, FarmLockError> {
    return readFarmLockFile(join(farmPath, FARM_LOCK_FILE));
}

/** Read and validate one `inflexa.lock` by its file path. The package inventory reads through this too. */
export function readFarmLockFile(lockPath: string): Result<FarmLock, FarmLockError> {
    let raw: string;
    try {
        raw = readFileSync(lockPath, "utf8");
    } catch (cause) {
        return err({ type: "lock_unreadable", lockPath, cause });
    }
    let lock;
    try {
        lock = safeParseJsonAs(raw, FarmLockSchema);
    } catch (cause) {
        return err({ type: "lock_invalid", lockPath, cause });
    }
    if (!lock.success) {
        return err({ type: "lock_invalid", lockPath, cause: lock.error });
    }
    return ok(lock.data);
}

/**
 * Resolve the farm source of one analysis. Runs before any container work.
 * `fixed` answers at once. `per-analysis` calls the resolver of the
 * embedder — an `unavailable` result and a throw both refuse the call with
 * `farm_unavailable`, and the reason of the embedder rides in the error.
 */
export async function resolveFarmSource(source: FarmSource, analysisId: string, op: string): Promise<Result<FarmLocation, SandboxError>> {
    if (source.kind === "fixed") return ok(source.location);
    try {
        const resolution = await source.resolve(analysisId);
        if (resolution.kind === "unavailable") {
            return err({ type: "farm_unavailable", op, analysisId, reason: resolution.reason });
        }
        return ok(resolution.location);
    } catch (cause) {
        return err({ type: "farm_unavailable", op, analysisId, reason: "the farm resolver threw", cause });
    }
}
