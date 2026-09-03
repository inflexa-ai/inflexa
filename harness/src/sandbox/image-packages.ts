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
 */
export const ImagePackagesSchema = z
    .object({
        schema: z.literal(1),
        image: ImageIdentitySchema,
        runtimes: ImageRuntimesSchema,
        system_tools: z.array(ImageSystemToolSchema),
        node: z.array(ImageNodePackageSchema),
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
