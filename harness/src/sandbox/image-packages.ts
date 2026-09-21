/**
 * `image-packages.json` — the self-description of the sandbox image.
 *
 * The image bakes two package tracks that the content-addressed store cannot
 * hold: the conda tools at `/opt/conda` and the Node packages at `/opt/node`.
 * The image writes one record of them at `/opt/inflexa/image-packages.json`,
 * and the catalog build copies that record verbatim into the root of the
 * package store it packed beside it. Thus every reader of a store learns the
 * image inventory from the store alone — with no container engine, no
 * registry client, and no path outside the store.
 *
 * The record is JSON with a `schema` number, the same convention as
 * {@link FarmLockSchema}: an additive field passes through untouched, and a
 * breaking change to the shape moves the number instead. A structured record
 * is what lets a row carry its version, and what lets a later change compare
 * the recorded image against the configured one.
 *
 * This schema is the ONE definition of the shape. The image writes the bytes
 * and the harness validates them, thus a producer that drifts is refused here
 * rather than half-read downstream.
 */

import { readFileSync } from "node:fs";

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import {
    joinPoolIndexes,
    poolIndexOver,
    pythonIdentity,
    resolveQuery,
    rIdentity,
    type PackageIdentity,
    type PackageQuery,
    type PoolIndex,
    type Track,
} from "./package-identity.js";

/**
 * The file name of the record, at the root of the package store. Exported,
 * as `FARM_LOCK_FILE` is, thus an embedder that joins the path onto its own
 * store root never spells the name by hand.
 */
export const IMAGE_PACKAGES_FILE = "image-packages.json";

/** The image the record describes. The pair of tags shares one version string. */
export const ImageIdentitySchema = z
    .object({
        repository: z.string(),
        version: z.string(),
        arch: z.enum(["amd64", "arm64"]),
    })
    .passthrough();

/** The interpreter versions of the image, so a reader can compare them against the lock. */
export const ImageRuntimesSchema = z
    .object({
        python: z.string(),
        r: z.string(),
        node: z.string(),
    })
    .passthrough();

/**
 * One conda tool of the image. `executable` carries the binary name when it
 * differs from the package name (the manifest `binaries:` map holds those
 * exceptions), because an agent invokes the binary and not the package.
 */
export const ImageSystemToolSchema = z
    .object({
        name: z.string(),
        version: z.string(),
        executable: z.string().optional(),
    })
    .passthrough();

/** One Node package of the image. */
export const ImageNodePackageSchema = z
    .object({
        name: z.string(),
        version: z.string(),
    })
    .passthrough();

/**
 * `image-packages.json` at schema version 1. The keys `system_tools` and
 * `node` are the keys of the image manifest, thus one name means one track
 * across the build and the reader.
 *
 * `r_base` and `python_stdlib` name the base sets of the two runtimes: the R
 * packages at the priority `base`, and the Python standard-library modules.
 * The image holds them and the store does not. Both fields are optional,
 * because a record from before them is still a valid record at schema 1.
 */
export const ImagePackagesSchema = z
    .object({
        schema: z.literal(1),
        image: ImageIdentitySchema,
        runtimes: ImageRuntimesSchema,
        system_tools: z.array(ImageSystemToolSchema),
        node: z.array(ImageNodePackageSchema),
        r_base: z.array(z.string()).optional(),
        python_stdlib: z.array(z.string()).optional(),
    })
    .passthrough();
export type ImagePackages = z.infer<typeof ImagePackagesSchema>;

export type ImagePackagesError =
    | { readonly type: "record_unreadable"; readonly recordPath: string; readonly cause: unknown }
    | { readonly type: "record_invalid"; readonly recordPath: string; readonly cause: unknown };

/**
 * Read and validate one `image-packages.json` by its file path. The read is
 * synchronous, the same as {@link readFarmLockFile}, because the caller reads
 * the record on each call and a store download can land while the process
 * runs. Both errors are normal states of a host that reads a store from
 * before this record existed.
 */
export function readImagePackagesFile(recordPath: string): Result<ImagePackages, ImagePackagesError> {
    let raw: string;
    try {
        raw = readFileSync(recordPath, "utf8");
    } catch (cause) {
        return err({ type: "record_unreadable", recordPath, cause });
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        return err({ type: "record_invalid", recordPath, cause });
    }
    const record = ImagePackagesSchema.safeParse(parsed);
    if (!record.success) {
        return err({ type: "record_invalid", recordPath, cause: record.error });
    }
    return ok(record.data);
}

/**
 * The base sets of the image: an index of the base R packages and the Python
 * standard-library modules, and the runtime version of each track. The image
 * holds one version of a base package, which is the version of its runtime.
 */
export type ImageBase = {
    readonly index: PoolIndex;
    readonly runtimes: Readonly<Record<Track, string>>;
};

/**
 * The image base of a store that carries no record. Its index holds nothing,
 * thus {@link resolvePackage} never answers from it, and it never reads the
 * two runtime versions.
 */
export const EMPTY_IMAGE_BASE: ImageBase = { index: poolIndexOver([]), runtimes: { python: "", r: "" } };

/**
 * The image base of one record: the R identity of each `r_base` name, the
 * Python identity of each `python_stdlib` name, and the runtime versions. A
 * record with neither field gives an index that holds nothing.
 */
export function imageBaseOf(record: ImagePackages): ImageBase {
    return {
        index: poolIndexOver([...(record.r_base ?? []).map((name) => rIdentity(name)), ...(record.python_stdlib ?? []).map((name) => pythonIdentity(name))]),
        runtimes: { python: record.runtimes.python, r: record.runtimes.r },
    };
}

/** The two sources that a package entry resolves against: the pool of the store, and the base sets of the image. */
export type PackageSources = {
    readonly pool: PoolIndex;
    readonly image: ImageBase;
};

/**
 * What one query resolves to over the two sources.
 *
 * - `pool` — the pool holds the identity.
 * - `image` — only the image holds the identity, at the runtime `version`.
 * - `image_version` — only the image holds the identity, and the query pins a
 *   version that is not `held`, the runtime version.
 * - `ambiguous` and `unknown` — the answers of the ladder over the two sources.
 */
export type PackageResolution =
    | { readonly kind: "pool"; readonly identity: PackageIdentity }
    | { readonly kind: "image"; readonly identity: PackageIdentity; readonly version: string }
    | { readonly kind: "image_version"; readonly identity: PackageIdentity; readonly held: string }
    | { readonly kind: "ambiguous"; readonly python: PackageIdentity; readonly r: PackageIdentity }
    | { readonly kind: "unknown"; readonly suggestion?: PackageIdentity };

/**
 * Resolve one query over the pool first, and over the pool and the image second.
 *
 * The pool ranks above the image. A spelling that the pool resolves keeps that
 * answer, thus an image name of the other track cannot make it ambiguous: the
 * R package `optparse` stays `r:optparse`, although Python lists `optparse`
 * in its standard library. Only a query that the pool alone does not resolve
 * reads the image.
 *
 * The plan validation and the link pass of an embedder both call this
 * function, thus the two readers give one answer for each entry.
 *
 * The pool reads no version, because the census holds the newest pin only and
 * the link pass picks the version. The image holds one version of each base
 * package, thus a pin of an image package compares here.
 *
 * @param query The query of one entry.
 * @param sources The pool and the image base.
 */
export function resolvePackage(query: PackageQuery, sources: PackageSources): PackageResolution {
    const fromPool = resolveQuery(query, sources.pool);
    if (fromPool.kind === "resolved") return { kind: "pool", identity: fromPool.identity };

    const joined = resolveQuery(query, joinPoolIndexes(sources.pool, sources.image.index));
    switch (joined.kind) {
        case "resolved": {
            // The pool alone did not resolve the query, and the joined index
            // adds only identities of the image. Thus a resolved identity here
            // is an identity that only the image holds.
            const held = sources.image.runtimes[joined.identity.track];
            return query.version !== undefined && query.version !== held
                ? { kind: "image_version", identity: joined.identity, held }
                : { kind: "image", identity: joined.identity, version: held };
        }
        case "ambiguous":
            return { kind: "ambiguous", python: joined.python, r: joined.r };
        case "unknown":
            return joined.suggestion === undefined ? { kind: "unknown" } : { kind: "unknown", suggestion: joined.suggestion };
    }
}
