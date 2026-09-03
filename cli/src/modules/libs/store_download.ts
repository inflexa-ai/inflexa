/**
 * The GHCR pull of the content-addressed package store, plus its receipt-backed staging.
 *
 * The store publishes to GHCR as an OCI artifact, one for each architecture (the publisher is
 * `.github/workflows/package-store-build.yml`). This module brings that artifact onto the user
 * machine without a container engine: an anonymous token GET, a manifest GET, then one digest-pinned
 * blob GET for each layer, all over https. Each blob rides `downloadToFile` (the bearer token in its
 * injectable `fetch` seam), and the returned sha256 must equal the descriptor digest or the layer is
 * refused.
 *
 * The layers are zstd-compressed tars: one for each track plus one base layer with the catalog farm
 * and the dependency graph. Extraction of every layer into one staged root reassembles the
 * `/mnt/libs` tree exactly, with the symlinks kept verbatim. The activation obeys the receipt
 * pattern of the reference store (`modules/refs/store.ts`): stage, rename, then write the receipt
 * last. Thus a crash before the receipt reads back as incomplete, and the next run repairs it.
 *
 * The catalog farm arrives as a TEMPLATE and never as an active environment. No pointer selects a
 * farm at the store level, because each sandbox mounts the farm of its own analysis. The catalog
 * holds the prepared caches of the store, and a new analysis farm seeds its own cache from them.
 *
 * The activation MERGES the staged tree into the store root, and it removes nothing. The root is
 * shared with `inflexa store add`, which acquires into the same `store/` pool, and with the
 * composition, which writes an analysis farm beside the published one ({@link mergeStagedRoot}).
 *
 * The transfer runs as the detached `catalog` transfer child (`modules/libs/transfers.ts`): this
 * module holds the catalog MECHANICS and the child body, and the shared lifecycle — the row, the
 * lock, the liveness — is the transfers module's. The receipt on disk stays the truth of what the
 * store holds, and the row is only the truth of what the child does.
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";

import { recordTransferProgress, recordTransferResolve, settleTransfer, startTransferRun } from "../../db/primary_mutation.ts";
import {
    createLivenessWatch,
    downloadToFile,
    LIVENESS_WINDOW_MS,
    type DownloadError,
    type DownloadProgress,
    type DownloadRetry,
    type FetchLike,
    type LivenessWatch,
} from "../../lib/download.ts";
import { sha256File } from "../../lib/hash.ts";
import { acquireInstanceLock, releaseInstanceLock, PACKAGE_STORE_METADATA_LOCK_KEY } from "../../lib/lock.ts";
import type { TransferPhase } from "../../types/store.ts";
/**
 * The image inventory record of the catalog, at the store root. The catalog build writes it beside the
 * graph, and the harness inventory tool reads it from the mounted store root. It rides the update rule
 * of the graph, because it names the image that the resolved set was proven inside: the graph, the
 * catalog farm, and this record describe ONE build, thus they move together.
 */
import { IMAGE_PACKAGES_FILE } from "@inflexa-ai/harness";

import { CATALOG_FARM, ensureStoreMountpoints } from "./composition.ts";
import { readTransferReport, spawnDetachedSelf, stopTransferChild, transferLockKey, type TransferReport } from "./transfers.ts";

/** The registry host the store publishes to. */
const STORE_REGISTRY = "ghcr.io";

/**
 * The store repository below the registry. The publisher writes
 * `ghcr.io/<owner>/package-store` (`.github/workflows/package-store-build.yml`). The owner is the
 * inflexa-ai org, the same namespace the sandbox images publish under (`modules/libs/images.ts`).
 */
const STORE_REPOSITORY = "inflexa-ai/package-store";

/** The media type of a per-track layer, from the publisher. */
const TRACK_MEDIA_TYPE = "application/vnd.inflexa.package-store.track.v1.tar+zstd";

/** The media type of the base layer that carries the catalog farm and the graph, from the publisher. */
const BASE_MEDIA_TYPE = "application/vnd.inflexa.package-store.base.v1.tar+zstd";

/** The manifest media types the pull accepts; the arch tag resolves to an image manifest, never an index. */
const MANIFEST_ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json";

/** The receipt schema version. A different value on disk reads as an invalid receipt, thus as incomplete. */
const RECEIPT_VERSION = 1;

/** The installer-owned metadata directory below the store root. Its dot name keeps it out of the store content. */
const METADATA_DIR = ".inflexa-download";

/**
 * The dependency graph of the catalog, at the store root. The name is part of the store contract,
 * because the composition reads the closure of a farm from it (`images/sandbox-provisioner/emit_deps.py`).
 */
const STORE_GRAPH = "deps.json";

/** How long the merge waits for the store-level metadata mutex before it reports a conflict. */
const METADATA_MUTEX_WAIT_MS = 30_000;

/** How often the merge tests whether the metadata mutex freed. */
const METADATA_MUTEX_POLL_MS = 100;

/**
 * The default retry schedule for a blob GET. GHCR names no contractual rate limit, so a shed or a
 * transient upstream status takes another attempt with exponential backoff. Only the request is
 * retried, never a body that already began arriving — the {@link downloadToFile} contract.
 */
const DEFAULT_BLOB_RETRY: DownloadRetry = {
    attempts: 4,
    baseMs: 500,
    shouldRetry: (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504,
};

/** A published store architecture, as the publisher tags it (`latest-<arch>`). */
export type StoreArch = "amd64" | "arm64";

/** One layer descriptor from the manifest: the media type, the content digest, and the compressed size. */
export type StoreLayer = {
    readonly mediaType: string;
    readonly digest: string;
    readonly size: number;
};

/** The receipt the store download writes last, pinning the manifest it activated. */
export type StoreReceipt = {
    /** Schema version; a mismatch reads as invalid. */
    readonly version: number;
    /** The manifest digest, pinned at resolve time so a moved tag cannot mix two versions. */
    readonly manifestDigest: string;
    /** The tag the pull resolved (`latest-<arch>`). */
    readonly reference: string;
    /** The architecture the store serves. */
    readonly arch: StoreArch;
    /** Activation timestamp (ISO 8601). */
    readonly activatedAt: string;
    /** The layers the manifest declared, recorded for a later completeness check. */
    readonly layers: readonly StoreLayer[];
};

/**
 * The cheap local state of the store content, read without the network.
 *
 * `local` is a store the user built with `inflexa store add`: it holds real content and it carries
 * no receipt, because no download made it. It is never `missing`, and a download over it is a merge.
 */
export type StoreContentState = "missing" | "local" | "incomplete" | "installed" | "invalid_receipt";

/** Why a store download could not complete. Each variant names one stage. */
export type StoreDownloadError =
    | { readonly type: "unsupported_arch"; readonly arch: string; readonly message: string }
    | { readonly type: "token_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "manifest_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "digest_mismatch"; readonly message: string; readonly expected: string; readonly actual: string }
    | { readonly type: "download_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "extract_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "io_failed"; readonly message: string; readonly cause?: unknown };

/** What one activation merge did to the store root, so the caller can report the outcome of the merge. */
export type StoreMergeReport = {
    /** The `store/` directory names the download moved in. A name that was already there is not here. */
    readonly storeDirsAdded: readonly string[];
    /** The farm names the download moved in. */
    readonly farmsAdded: readonly string[];
    /** The farm names the download left alone, because the store root already holds a farm of each name. */
    readonly farmsKept: readonly string[];
    /** The farm names the update swapped whole — the catalog farm on `--update`, and nothing else. */
    readonly farmsReplaced: readonly string[];
};

/**
 * What a download attempt produced. `up_to_date` means the receipt already pins the resolved
 * manifest. `update_available` reports a moved tag WITHOUT applying it, so the caller can ask before
 * it downloads. `downloaded` is a completed, activated store, with the report of what the merge into
 * the store root changed.
 */
export type StoreDownloadOutcome =
    | { readonly type: "up_to_date"; readonly manifestDigest: string }
    | { readonly type: "update_available"; readonly installedDigest: string; readonly latestDigest: string }
    | { readonly type: "downloaded"; readonly manifestDigest: string; readonly bytes: number; readonly merge: StoreMergeReport };

/**
 * A fire-and-forget progress notification for one store download. A layer event carries its digest,
 * because more than one layer transfers in sequence and an unattributed byte count would be ambiguous.
 *
 * `manifest_resolved` carries the two totals. The manifest declares the size of every layer before
 * the first byte arrives, thus an observer that records them records exact figures and never an
 * estimate.
 *
 * `unpack_bytes` counts the bytes that come OUT of the decompressor of a layer, and it is the only
 * sign of life the staging gives. An observer must not add it to the transferred total: those bytes
 * arrived already, and the last `layer_completed` counted them.
 */
export type StoreDownloadProgress =
    | { readonly type: "resolving" }
    | { readonly type: "manifest_resolved"; readonly manifestDigest: string; readonly totalBytes: number; readonly totalLayers: number }
    | { readonly type: "layer_started"; readonly digest: string; readonly declaredBytes?: number }
    | { readonly type: "layer_bytes"; readonly digest: string; readonly bytes: number }
    | { readonly type: "layer_completed"; readonly digest: string; readonly bytes: number }
    | { readonly type: "staging" }
    | { readonly type: "unpack_bytes"; readonly digest: string; readonly bytes: number };

/** The seams the CLI composition edge supplies. Production passes only `storeRoot`; a test injects the rest. */
export type StoreDownloadDeps = {
    /** The CLI-owned store root (`env.packageStoreDir`), supplied by the caller; this module never re-derives it. */
    readonly storeRoot: string;
    /** The architecture to pull; defaults to the host architecture. */
    readonly arch?: StoreArch;
    /** Fetch implementation; defaults to the runtime fetch. */
    readonly fetch?: FetchLike;
    /** Clock used in the receipt. */
    readonly now?: () => Date;
    /** Stable attempt id used for staging. */
    readonly attemptId?: () => string;
    /** Progress observer for a live transfer; absent means the download reports nothing. */
    readonly onProgress?: (event: StoreDownloadProgress) => void;
    /** Retry schedule for a blob GET; defaults to {@link DEFAULT_BLOB_RETRY}. */
    readonly retry?: DownloadRetry;
    /**
     * Download even when a receipt already pins a different manifest. The update consent sets this
     * after the user says yes; without it, a moved tag reports `update_available` and downloads
     * nothing.
     */
    readonly force?: boolean;
    /**
     * The silence that ends the decompress of a layer, in milliseconds; omitted means
     * {@link LIVENESS_WINDOW_MS}. A test passes a small value, and production passes none.
     */
    readonly unpackWindowMs?: number;
    /**
     * The wall bound of one `tar` run, in milliseconds; omitted means the bound that
     * {@link tarBoundMs} computes from the size of the tar. A test pins it, thus no test waits for
     * the production floor.
     */
    readonly tarBoundMs?: number;
};

/** Resolve the host architecture to the publisher's arch label, or refuse an architecture with no store. */
export function resolveStoreArch(arch: string): Result<StoreArch, StoreDownloadError> {
    switch (arch) {
        case "x64":
            return ok("amd64");
        case "arm64":
            return ok("arm64");
        default:
            return err({ type: "unsupported_arch", arch, message: `No published package store for the ${arch} architecture.` });
    }
}

/** The installer-owned paths below one store root. */
export type StoreDownloadPaths = {
    /** The dot name of the metadata directory, so activation never moves it out of the staged tree. */
    readonly metadataName: string;
    /** The metadata directory itself. */
    readonly metadata: string;
    /** Per-attempt staging root. */
    readonly staging: string;
    /** Digest-keyed blob cache, reused by a repaired run and dropped after a durable receipt. */
    readonly blobs: string;
    /** The active receipt. */
    readonly receipt: string;
};

/** Resolve all installer-owned paths without creating anything. */
export function storeDownloadPaths(storeRoot: string): StoreDownloadPaths {
    const metadata = join(storeRoot, METADATA_DIR);
    return {
        metadataName: METADATA_DIR,
        metadata,
        staging: join(metadata, "staging"),
        blobs: join(metadata, "blobs"),
        receipt: join(metadata, "receipt.json"),
    };
}

/** Deliver a progress event, swallowing observer throws — progress is decoration and must never abort a live transfer. */
function reportProgress(onProgress: ((event: StoreDownloadProgress) => void) | undefined, event: StoreDownloadProgress): void {
    if (onProgress === undefined) return;
    try {
        onProgress(event);
    } catch {
        // A progress readout is decoration over a transfer that is otherwise succeeding.
    }
}

/** Translate a single-file download event into a layer-attributed store event. */
function forwardLayerProgress(onProgress: ((event: StoreDownloadProgress) => void) | undefined, digest: string, event: DownloadProgress): void {
    switch (event.type) {
        case "started":
            reportProgress(onProgress, { type: "layer_started", digest, ...(event.declaredBytes === undefined ? {} : { declaredBytes: event.declaredBytes }) });
            return;
        case "bytes":
            reportProgress(onProgress, { type: "layer_bytes", digest, bytes: event.bytes });
            return;
        case "completed":
            reportProgress(onProgress, { type: "layer_completed", digest, bytes: event.bytes });
            return;
    }
}

function isMissing(cause: unknown): boolean {
    return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function errorText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

/**
 * A local write fault stays an io fault, because its remedy is the user's disk. Every wire fault —
 * an unreachable host, a bad status, a redirect downgraded off https — is one thing to the caller:
 * the layer did not arrive.
 */
function mapDownloadError(error: DownloadError): StoreDownloadError {
    return error.type === "io_failed"
        ? { type: "io_failed", message: error.message, cause: error.cause }
        : { type: "download_failed", message: error.message, ...("cause" in error ? { cause: error.cause } : {}) };
}

/** The digest is the content id; a colon is not a portable path segment, so it becomes the file stem. */
function blobFileName(digest: string): string {
    return `${digest.replace(":", "-")}.tar.zst`;
}

/** GET an anonymous pull token for the store repository. */
async function fetchAnonymousToken(doFetch: FetchLike): Promise<Result<string, StoreDownloadError>> {
    const url = `https://${STORE_REGISTRY}/token?service=${STORE_REGISTRY}&scope=repository:${STORE_REPOSITORY}:pull`;
    let response: Response;
    try {
        response = await doFetch(url, {});
    } catch (cause) {
        return err({ type: "token_failed", message: `Could not reach the ${STORE_REGISTRY} token endpoint.`, cause });
    }
    if (!response.ok) {
        return err({ type: "token_failed", message: `The ${STORE_REGISTRY} token request failed: HTTP ${response.status} ${response.statusText}.` });
    }
    let body: unknown;
    try {
        body = await response.json();
    } catch (cause) {
        return err({ type: "token_failed", message: `The ${STORE_REGISTRY} token response was not valid JSON.`, cause });
    }
    // GHCR answers with `{ token }` for an anonymous pull; some registries name it `access_token`.
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const token = typeof record.token === "string" ? record.token : typeof record.access_token === "string" ? record.access_token : undefined;
    if (token === undefined || token === "") return err({ type: "token_failed", message: `The ${STORE_REGISTRY} token response carried no token.` });
    return ok(token);
}

/** The manifest resolved to its pinned digest and its layer descriptors. */
type ResolvedStoreManifest = {
    readonly manifestDigest: string;
    readonly layers: readonly StoreLayer[];
};

/** Read the layer descriptors from a parsed manifest, refusing any unexpected shape or media type. */
function readManifestLayers(manifest: unknown): Result<readonly StoreLayer[], StoreDownloadError> {
    if (typeof manifest !== "object" || manifest === null) return err({ type: "manifest_failed", message: "The manifest was not an object." });
    const layersRaw = (manifest as Record<string, unknown>).layers;
    if (!Array.isArray(layersRaw) || layersRaw.length === 0) return err({ type: "manifest_failed", message: "The manifest declared no layers." });
    const layers: StoreLayer[] = [];
    for (const entry of layersRaw) {
        if (typeof entry !== "object" || entry === null) return err({ type: "manifest_failed", message: "A manifest layer was not an object." });
        const layer = entry as Record<string, unknown>;
        if (typeof layer.mediaType !== "string" || typeof layer.digest !== "string" || typeof layer.size !== "number") {
            return err({ type: "manifest_failed", message: "A manifest layer lacked a media type, a digest, or a size." });
        }
        if (layer.mediaType !== TRACK_MEDIA_TYPE && layer.mediaType !== BASE_MEDIA_TYPE) {
            return err({ type: "manifest_failed", message: `A manifest layer carried an unexpected media type: ${layer.mediaType}.` });
        }
        layers.push({ mediaType: layer.mediaType, digest: layer.digest, size: layer.size });
    }
    return ok(layers);
}

/** GET the manifest for a reference and pin its digest from the raw bytes. */
async function resolveManifest(doFetch: FetchLike, reference: string, token: string): Promise<Result<ResolvedStoreManifest, StoreDownloadError>> {
    const url = `https://${STORE_REGISTRY}/v2/${STORE_REPOSITORY}/manifests/${reference}`;
    let response: Response;
    try {
        response = await doFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT } });
    } catch (cause) {
        return err({ type: "manifest_failed", message: `Could not reach ${url}.`, cause });
    }
    if (!response.ok) {
        return err({ type: "manifest_failed", message: `The manifest request for ${reference} failed: HTTP ${response.status} ${response.statusText}.` });
    }
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
        return err({ type: "manifest_failed", message: `Could not read the manifest body for ${reference}.`, cause });
    }
    // The digest comes from the raw bytes, not from a header: it is the value the receipt pins, so a
    // later run compares against exactly what was served rather than a value the registry can restate.
    const manifestDigest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch (cause) {
        return err({ type: "manifest_failed", message: `The manifest for ${reference} was not valid JSON.`, cause });
    }
    const layers = readManifestLayers(parsed);
    if (layers.isErr()) return err(layers.error);
    return ok({ manifestDigest, layers: layers.value });
}

/**
 * Fetch one layer blob into the digest-keyed cache and verify it against its descriptor.
 *
 * The transfer is {@link downloadToFile}: the bearer token rides its injectable `fetch` seam, and
 * GHCR answers a blob GET with an https redirect to a GitHub CDN host, which the utility's
 * `insecure_redirect` check accepts. The utility hashes the bytes and the caller owns the
 * verification, so a blob whose sha256 differs from the descriptor is discarded and refused. A
 * verified cache hit skips the network, so a repaired run does not fetch bytes that it holds.
 */
async function downloadLayerBlob(
    doFetch: FetchLike,
    token: string,
    layer: StoreLayer,
    dest: string,
    retry: DownloadRetry,
    onProgress: ((event: StoreDownloadProgress) => void) | undefined,
): Promise<Result<number, StoreDownloadError>> {
    if (existsSync(dest)) {
        const cached = await sha256File(dest);
        if (cached.isOk() && `sha256:${cached.value}` === layer.digest) {
            // A cache hit still reports its two edges. An observer that sums the completed layers would
            // otherwise stop short of the declared total by exactly the layers a repaired run reused, and
            // its meter would stall below full over a transfer that is in fact complete.
            const bytes = (await stat(dest)).size;
            reportProgress(onProgress, { type: "layer_started", digest: layer.digest, declaredBytes: layer.size });
            reportProgress(onProgress, { type: "layer_completed", digest: layer.digest, bytes });
            return ok(bytes);
        }
    }
    const authed: FetchLike = (input, init) => {
        // downloadToFile sends no headers of its own; the bearer rides here, on the initial request.
        // `fetch` strips Authorization on a cross-origin redirect, which is correct — the CDN URL is
        // pre-signed.
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return doFetch(input, { ...init, headers });
    };
    const url = `https://${STORE_REGISTRY}/v2/${STORE_REPOSITORY}/blobs/${layer.digest}`;
    const downloaded = await downloadToFile(url, dest, {
        fetch: authed,
        retry,
        onProgress: (event) => forwardLayerProgress(onProgress, layer.digest, event),
    });
    if (downloaded.isErr()) return err(mapDownloadError(downloaded.error));
    const actual = `sha256:${downloaded.value.sha256}`;
    if (actual !== layer.digest) {
        // The bytes do not match the descriptor. Discard the layer so corrupt content never reaches the store.
        await rm(dest, { force: true }).catch(() => undefined);
        return err({
            type: "digest_mismatch",
            message: `A store layer hashed to ${actual}, not its descriptor digest ${layer.digest}.`,
            expected: layer.digest,
            actual,
        });
    }
    return ok(downloaded.value.bytes);
}

/**
 * The `tar` diagnostics that report a damaged, a truncated, or a resynchronized archive.
 *
 * `tar` answered exit 0 over an archive that it also called `Damaged tar archive`, and it printed
 * `Retrying...` more than a thousand times over that same run. Thus the exit code alone is not a
 * verdict, and a run that prints one of these words extracted less than the archive holds. Each
 * marker is compared in lower case, because the two `tar` implementations differ in their capitals.
 */
const TAR_DAMAGE_MARKERS = ["damaged", "truncated", "unexpected eof", "retrying", "skipping to next header"] as const;

/** How many `lstat` calls {@link verifyStagedLayer} keeps in flight. A window of 64 reads 78,000 members in about 90 ms, against about 900 ms one at a time. */
const COMPLETENESS_WINDOW = 64;

/** How many absent members a completeness failure names. The count carries the scale, thus a few examples are enough to act on. */
const MISSING_EXAMPLE_LIMIT = 3;

/**
 * The floor of the wall bound of one `tar` run.
 *
 * A small layer answers to the floor alone: five minutes is far past the time any archive of that
 * size wants, thus a run that passes it is stopped and not slow.
 */
const TAR_BOUND_FLOOR_MS = 300_000;

/**
 * The rate that scales the wall bound above the floor: 1024 bytes for each millisecond, which is
 * 1 MiB for each second.
 *
 * The rate is deliberately generous. A disk that writes a store layer at less than 1 MiB per second
 * is already a machine in trouble, thus the bound never cuts an extraction that works.
 */
const TAR_BOUND_BYTES_PER_MS = 1024;

/**
 * The wall bound of one `tar` run over a tar of `tarBytes`.
 *
 * `tar` reports no byte figure of its own, thus liveness cannot bound it and only the clock can. The
 * bound scales with the archive, because a flat value is either too tight for a 4 GiB layer or too
 * loose for a small one.
 */
function tarBoundMs(tarBytes: number): number {
    return Math.max(TAR_BOUND_FLOOR_MS, Math.ceil(tarBytes / TAR_BOUND_BYTES_PER_MS));
}

/** Render a millisecond bound as whole seconds, for a message a user reads. */
function describeSeconds(ms: number): string {
    return `${Math.round(ms / 1000)}s`;
}

/** What one layer unpack needs beyond its two paths: the identity of the layer, and the bounds it runs under. */
type LayerUnpack = {
    /** The descriptor digest. Each failure names it, because the layers unpack in sequence and the row carries one message. */
    readonly digest: string;
    /** The silence that ends the decompress, in milliseconds. */
    readonly windowMs: number;
    /** The wall bound of one `tar` run, or `undefined` when the bound comes from the size of the tar. */
    readonly tarBoundMs?: number;
};

/** How one decompress ended. `stalled` is the watch, and it is the answer that a pending pipeline cannot give. */
type DecompressOutcome = { readonly type: "done" } | { readonly type: "failed"; readonly cause: unknown } | { readonly type: "stalled" };

/**
 * The failure of one layer unpack, as the row states it.
 *
 * Each message names the digest and the word `unpacking`. The phase word is what tells a reader that
 * the bytes arrived and that the fault came after them, which is the one thing a byte meter at full
 * cannot say.
 */
function unpackFailure(digest: string, detail: string): StoreDownloadError {
    return { type: "extract_failed", message: `The unpacking of the store layer ${digest} ${detail}.` };
}

/** What one `tar` run produced. Both streams are read every time, because a warning is the only signal of a damaged archive. */
type TarRun = {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    /** True when the wall bound stopped the child. The exit code then reports the signal, not the archive. */
    readonly boundFired: boolean;
};

/**
 * Run `tar` under a wall bound, and collect its exit code and both of its streams.
 *
 * The two reads and the exit wait run together. A sequential read would let the other pipe fill and
 * stop the child, and a member list of a large layer is many megabytes.
 *
 * The bound sends SIGKILL and not SIGTERM, because the fault it answers is a child that makes no
 * progress at all, and such a child can also miss a signal that it must handle itself.
 *
 * `keepAlive` ticks while the child runs. `tar` reports no byte figure, thus the tick is the one
 * signal that keeps the row age honest over a run that the bound permits to hold for minutes.
 */
async function runTar(args: readonly string[], boundMs: number, keepAlive?: () => void): Promise<TarRun> {
    const proc = Bun.spawn(["tar", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let boundFired = false;
    const bound = setTimeout(() => {
        boundFired = true;
        proc.kill("SIGKILL");
    }, boundMs);
    const pulse = keepAlive === undefined ? undefined : setInterval(keepAlive, PROGRESS_WRITE_INTERVAL_MS);
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { code, stdout, stderr, boundFired };
    } finally {
        clearTimeout(bound);
        if (pulse !== undefined) clearInterval(pulse);
    }
}

/** The first damage diagnostic in a `tar` stderr text, or `undefined` when the text holds none. */
function tarDamage(stderr: string): string | undefined {
    return stderr
        .split("\n")
        .find((line) => {
            const lower = line.toLowerCase();
            return TAR_DAMAGE_MARKERS.some((marker) => lower.includes(marker));
        })
        ?.trim();
}

/**
 * Confirm that a staged tree carries every member of the archive that filled it.
 *
 * WHAT THIS PROVES. The blob hashed to its descriptor digest before the extraction, and the
 * decompression of a zstd frame is total, thus the inflated tar is byte-for-byte what the publisher
 * made. The archive is therefore the one authority on what the layer holds, and it states its own
 * member list. This check reads that list and confirms that each name is an entry on disk. As a
 * result, a `tar` that stopped part-way is refused, which is the exact fault this module carried.
 *
 * WHAT THIS DOES NOT PROVE. It reads the presence of an entry, never its bytes: a member whose body
 * landed short still counts as present. It does not read the mode, the owner, or the timestamp. It
 * does not resolve a symlink, because a farm link bakes an absolute `/mnt/libs/...` target that
 * dangles on the host by design. It says nothing about the store as a whole, because a layer
 * descriptor carries a size and a digest and no entry count, thus no count is invented from outside
 * the archive.
 *
 * The one known limit is a member name that carries a newline. `tar -t` writes one name for each
 * line, thus such a name reads as two absent names. The publisher feeds `tar` a newline-delimited
 * member list, so such a name cannot reach a layer in the first place.
 *
 * Exported so a test proves the guarantee directly against a tree that the test made partial. This
 * check is the only thing between a partial extraction and a receipt that calls it installed.
 *
 * The member list runs under the same wall bound as the extraction, because it is the same program
 * over the same archive. `digest` names the layer in a failure, because the caller unpacks the
 * layers in sequence and the row carries one message only.
 */
export async function verifyStagedLayer(
    tarPath: string,
    stageRoot: string,
    digest: string,
    boundMs: number,
    keepAlive?: () => void,
): Promise<Result<number, StoreDownloadError>> {
    const listed = await runTar(["-tf", tarPath], boundMs, keepAlive);
    if (listed.boundFired) return err(unpackFailure(digest, `passed its \`tar\` bound of ${describeSeconds(boundMs)} at the member list`));
    const listDamage = tarDamage(listed.stderr);
    if (listed.code !== 0 || listDamage !== undefined) {
        const detail = listDamage ?? listed.stderr.trim();
        return err({
            type: "extract_failed",
            message: `Could not list a store layer to verify it (tar exit ${listed.code})${detail === "" ? "" : `: ${detail}`}.`,
        });
    }
    const members = listed.stdout.split("\n").filter((line) => line !== "");
    if (members.length === 0) return err({ type: "extract_failed", message: "A store layer declared no members, thus the extraction cannot be verified." });

    let missing = 0;
    const examples: string[] = [];
    for (let start = 0; start < members.length; start += COMPLETENESS_WINDOW) {
        await Promise.all(
            members.slice(start, start + COMPLETENESS_WINDOW).map(async (member) => {
                if (await entryExists(join(stageRoot, member))) return;
                missing += 1;
                if (examples.length < MISSING_EXAMPLE_LIMIT) examples.push(member);
            }),
        );
    }
    if (missing > 0) {
        return err({
            type: "extract_failed",
            message: `A store layer extracted only part of its content: ${missing} of ${members.length} members are absent, for example ${examples.join(", ")}. Run \`inflexa store download\` again.`,
        });
    }
    return ok(members.length);
}

/**
 * Extract one layer into the staged root.
 *
 * THE ROUTE, AND THE REASON. The layer is a zstd-compressed tar. The runtime decompressor writes the
 * inflated tar to a temporary file, then `tar -xf` reads that file. The operating system moves every
 * byte, and no stream crosses the JS bridge. That bridge is exactly what failed before: a
 * `Readable.toWeb` pump into the stdin of `tar` broke with `EINVAL` on `send` part-way through a
 * 1.33 GB layer, and it left 142 of 451 store directories on disk under an exit code of 0.
 *
 * THE REJECTED ALTERNATIVE. A shell pipeline, `zstd -d -c <blob> | tar -x`, moves the same bytes
 * through the operating system. It is refused because `zstd` is not a system program. macOS ships
 * `tar` at `/usr/bin/tar` and ships no `zstd`, thus the pipeline adds a dependency that a user
 * machine does not carry. `tar --zstd` is refused for the same reason: the system libarchive links
 * zlib, liblzma, and bz2lib, and it falls back to the same absent `zstd` program. A pipeline also
 * hides the exit code of its left side behind `PIPESTATUS`, which is one more thing to get right for
 * no gain.
 *
 * THE ACCEPTED COST. The temporary file is the whole inflated layer: about 4.3 GB for the python
 * layer, written in about 7 seconds. It is removed as soon as `tar` has read it, thus the peak cost
 * is one layer and never the whole store.
 *
 * THE VERDICT. The exit code is not trusted on its own, and the stderr text is read on every run —
 * refer to {@link TAR_DAMAGE_MARKERS}. A clean run then goes to {@link verifyStagedLayer}, thus a
 * partial extraction returns an error and never an ok.
 *
 * THE BOUNDS. The decompress runs under a liveness watch on the bytes that leave the decompressor,
 * and each `tar` run under a wall bound ({@link tarBoundMs}). Neither is decoration: a Bun 1.3.10
 * fault lost the completion of this very pipeline, and the child then slept as a live transfer for
 * an hour and held the sandbox gate with it.
 */
async function extractLayer(
    blobPath: string,
    stageRoot: string,
    layer: LayerUnpack,
    onProgress: ((event: StoreDownloadProgress) => void) | undefined,
): Promise<Result<void, StoreDownloadError>> {
    // The temporary tar sits beside its blob, thus it lands on the filesystem of the store root rather
    // than on a small system temp volume. The uuid keeps two attempts over one blob apart.
    const tarPath = `${blobPath}.${randomUUIDv7()}.tar`;
    const watch = createLivenessWatch(layer.windowMs);
    try {
        const flowed = await decompressLayer(blobPath, tarPath, layer, watch, onProgress);
        if (flowed.isErr()) return err(flowed.error);
        const boundMs = layer.tarBoundMs ?? tarBoundMs((await stat(tarPath)).size);
        // A zero-byte tick: the handler of the row ignores the count, and only `updated_at` moves.
        const keepAlive = (): void => reportProgress(onProgress, { type: "unpack_bytes", digest: layer.digest, bytes: 0 });
        const extracted = await runTar(["-x", "-f", tarPath, "-C", stageRoot], boundMs, keepAlive);
        if (extracted.boundFired) return err(unpackFailure(layer.digest, `passed its \`tar\` bound of ${describeSeconds(boundMs)}`));
        const damage = tarDamage(extracted.stderr);
        if (extracted.code !== 0 || damage !== undefined) {
            const detail = damage ?? extracted.stderr.trim();
            return err({
                type: "extract_failed",
                message: `Extracting a store layer failed (tar exit ${extracted.code})${detail === "" ? "" : `: ${detail}`}.`,
            });
        }
        return (await verifyStagedLayer(tarPath, stageRoot, layer.digest, boundMs, keepAlive)).map(() => undefined);
    } catch (cause) {
        return err({ type: "extract_failed", message: `Extracting a store layer failed: ${errorText(cause)}.`, cause });
    } finally {
        watch.close();
        await rm(tarPath, { force: true }).catch(() => undefined);
    }
}

/**
 * Inflate one blob into `tarPath` under the liveness watch of its layer.
 *
 * The counter sits between the decompressor and the file write, because that is the one place where
 * the bytes prove that the decompress still works. The read of the blob proves nothing: a file that
 * the operating system serves reads fast whatever the decompressor does with it.
 *
 * THE RACE, AND THE REASON. The watch aborts the pipeline, and the pipeline is ALSO raced against
 * the abort itself. An abort alone is not enough: a `pipeline` whose source waits on a read that
 * never answers keeps its promise pending long after the abort, and the fault this bound answers is
 * precisely a completion that never arrives. The race gives the layer an end in either case. The
 * abandoned pipeline holds no lock and writes only the temporary tar, which the caller removes.
 */
async function decompressLayer(
    blobPath: string,
    tarPath: string,
    layer: LayerUnpack,
    watch: LivenessWatch,
    onProgress: ((event: StoreDownloadProgress) => void) | undefined,
): Promise<Result<void, StoreDownloadError>> {
    // A pass-through Transform rather than a `data` listener: `pipeline` owns the flow, thus a
    // listener would compete with it for the mode of the stream.
    const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            watch.alive();
            reportProgress(onProgress, { type: "unpack_bytes", digest: layer.digest, bytes: chunk.length });
            callback(null, chunk);
        },
    });
    // `pipeline` propagates a decompressor fault and a write fault, thus a truncated zstd frame or
    // a disk that ran out fails here and never reaches `tar` as a short archive.
    const source = createReadStream(blobPath);
    const sink = createWriteStream(tarPath);
    const flow = pipeline(source, createZstdDecompress(), counter, sink, { signal: watch.signal }).then(
        (): DecompressOutcome => ({ type: "done" }),
        (cause: unknown): DecompressOutcome => ({ type: "failed", cause }),
    );
    const stall = new Promise<DecompressOutcome>((resolve) => {
        watch.signal.addEventListener("abort", () => resolve({ type: "stalled" }), { once: true });
    });
    const outcome = await Promise.race([flow, stall]);
    if (outcome.type === "stalled" || watch.expired()) {
        // The abandoned pipeline cannot be trusted with its own teardown: the fault this watch answers
        // is a runtime that lost the completion, and the same machinery closes the file handles. The
        // two ends hold the only descriptors, thus this drop releases them whatever the pipeline does.
        source.destroy();
        sink.destroy();
        return err(unpackFailure(layer.digest, `moved no bytes for ${describeSeconds(layer.windowMs)}`));
    }
    if (outcome.type === "failed") {
        return err({ type: "extract_failed", message: `Could not decompress a store layer: ${errorText(outcome.cause)}.`, cause: outcome.cause });
    }
    return ok(undefined);
}

/** Report whether a path is there. `lstat` reads the entry itself, so a dangling symlink counts as present. */
async function entryExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Merge the children of one staged directory into its counterpart under the store root.
 *
 * A name that both sides hold stays as it is. Under `store/` a skip costs nothing and it is always
 * correct, because the store is content-addressed and write-once: the directory name carries the
 * hash of the content, so the same name is the same bytes. Under `farms/` the skip is the whole
 * point. A farm belongs to an analysis of the user, and this merge adds and never removes.
 */
async function mergeChildren(stagedDir: string, targetDir: string): Promise<{ readonly added: readonly string[]; readonly kept: readonly string[] }> {
    const added: string[] = [];
    const kept: string[] = [];
    await mkdir(targetDir, { recursive: true });
    for (const child of await readdir(stagedDir)) {
        const to = join(targetDir, child);
        if (await entryExists(to)) {
            kept.push(child);
            continue;
        }
        await rename(join(stagedDir, child), to);
        added.push(child);
    }
    return { added, kept };
}

/**
 * Merge the staged farms into `farms/`, with the one publisher-owned exception.
 *
 * A farm of an analysis merges add-only, exactly as {@link mergeChildren} does: it belongs to the
 * user, and the download never replaces it. The catalog farm belongs to the publisher, and on an
 * update it must travel WITH the graph. Its closure names store directories of one resolved set, so
 * a kept catalog farm beside a new graph fails `graph.nodes.has` on every farm-less compose, and
 * {@link readTemplate} then serves the subtrees of the old catalog.
 */
async function mergeFarms(
    stagedDir: string,
    targetDir: string,
    replaceCatalog: boolean,
): Promise<{ readonly added: readonly string[]; readonly kept: readonly string[]; readonly replaced: readonly string[] }> {
    const added: string[] = [];
    const kept: string[] = [];
    const replaced: string[] = [];
    await mkdir(targetDir, { recursive: true });
    for (const child of await readdir(stagedDir)) {
        const to = join(targetDir, child);
        if (await entryExists(to)) {
            if (child === CATALOG_FARM && replaceCatalog) {
                // A crash between the removal and the rename leaves no catalog farm, and the
                // receipt is then unwritten — the next run merges again and lands it whole.
                await rm(to, { recursive: true, force: true });
                await rename(join(stagedDir, child), to);
                replaced.push(child);
                continue;
            }
            kept.push(child);
            continue;
        }
        await rename(join(stagedDir, child), to);
        added.push(child);
    }
    return { added, kept, replaced };
}

/**
 * Take the store-level metadata mutex, run `fn`, and release it.
 *
 * Two writers touch the dependency graph at the store root: a download with `--update` replaces it,
 * and a flight commit appends to it. The mutex is what keeps the two apart. The wait is bounded,
 * because a flight commit is short, and a mutex that never freed means a holder that is stuck rather
 * than a holder that is busy.
 *
 * The lock is re-entrant for one pid, thus it separates PROCESSES and not two overlapping calls
 * inside one process. That is the whole surface it needs: the downloader runs detached, and a flight
 * runs in the process of the user.
 */
export async function withStoreMetadataMutex<T, E>(onTimeout: (holderPid: number) => E, fn: () => Promise<Result<T, E>>): Promise<Result<T, E>> {
    for (let waited = 0; ; waited += METADATA_MUTEX_POLL_MS) {
        const lock = acquireInstanceLock(PACKAGE_STORE_METADATA_LOCK_KEY);
        if (lock.acquired) {
            try {
                return await fn();
            } finally {
                releaseInstanceLock(PACKAGE_STORE_METADATA_LOCK_KEY);
            }
        }
        if (waited >= METADATA_MUTEX_WAIT_MS) {
            return err(onTimeout(lock.holderPid));
        }
        await Promise.sleep(METADATA_MUTEX_POLL_MS);
    }
}

/** The timeout error of a merge that could not take the metadata mutex. */
function metadataMutexTimeout(holderPid: number): StoreDownloadError {
    return {
        type: "io_failed",
        message: `Another \`inflexa\` process (pid ${holderPid}) holds the package-store metadata lock. Wait for it to finish, then run \`inflexa store download\` again.`,
    };
}

/**
 * Merge one replaceable record of the catalog into the store root, under the metadata mutex.
 *
 * {@link STORE_GRAPH} and {@link IMAGE_PACKAGES_FILE} both ride this rule. On a plain download the
 * record moves in only when the root carries none, exactly as any other top-level entry does. On
 * `--update` the record of the NEW catalog replaces the record of the old one: the two describe
 * different builds, and a kept record would state what the new catalog never resolved.
 *
 * The mutex is here for the graph, whose second writer is the flight commit. The image record has one
 * writer only, and it takes the same lock anyway: an uncontended acquire costs nothing, and one rule
 * in one place is worth more than a second, narrower path.
 */
async function mergeReplaceableRecord(name: string, staged: string, target: string, replace: boolean): Promise<Result<void, StoreDownloadError>> {
    return withStoreMetadataMutex(metadataMutexTimeout, async () => {
        try {
            if (await entryExists(target)) {
                if (!replace) return ok(undefined);
                await rm(target, { force: true });
            }
            await rename(staged, target);
            return ok(undefined);
        } catch (cause) {
            return err({ type: "io_failed", message: `Could not merge ${name} into ${target}.`, cause });
        }
    });
}

/**
 * Merge each staged top-level entry into the store root, and remove nothing.
 *
 * The whole `/mnt/libs` tree lives directly at the store root, and the root is shared. `inflexa
 * store add` acquires into the same `store/` pool, and the composition writes an analysis farm
 * beside the published one. A replacement would destroy that work, so the download moves in only
 * what the root does not have. `store/` and `farms/` merge one level deeper, because both owners
 * write into them. Three records ride the update rule instead: `deps.json` and `image-packages.json`
 * ({@link mergeReplaceableRecord}), and the catalog farm ({@link mergeFarms}), because the graph, the
 * template, and the image record describe one build and must move together. Any other top-level entry
 * moves in only when it is absent.
 *
 * The merge keeps the crash safety of the receipt pattern. Each move is a `rename` inside one
 * filesystem, thus a child is complete or absent and never half-written. A crash part-way leaves the
 * receipt unwritten, so the store reads back as incomplete and the next run merges again — where
 * each child that already landed is simply skipped.
 */
async function mergeStagedRoot(
    stageRoot: string,
    storeRoot: string,
    metadataName: string,
    replacePublisherRecords: boolean,
): Promise<Result<StoreMergeReport, StoreDownloadError>> {
    let entries: readonly string[];
    try {
        entries = (await readdir(stageRoot)).filter((name) => name !== metadataName);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not read the staged store at ${stageRoot}.`, cause });
    }
    const ordered = [...entries].sort((a, b) => a.localeCompare(b));
    const storeDirsAdded: string[] = [];
    const farmsAdded: string[] = [];
    const farmsKept: string[] = [];
    const farmsReplaced: string[] = [];
    try {
        for (const name of ordered) {
            const to = join(storeRoot, name);
            if (name === "store") {
                storeDirsAdded.push(...(await mergeChildren(join(stageRoot, name), to)).added);
                continue;
            }
            if (name === "farms") {
                const merged = await mergeFarms(join(stageRoot, name), to, replacePublisherRecords);
                farmsAdded.push(...merged.added);
                farmsKept.push(...merged.kept);
                farmsReplaced.push(...merged.replaced);
                continue;
            }
            if (name === STORE_GRAPH || name === IMAGE_PACKAGES_FILE) {
                const merged = await mergeReplaceableRecord(name, join(stageRoot, name), to, replacePublisherRecords);
                if (merged.isErr()) return err(merged.error);
                continue;
            }
            if (await entryExists(to)) continue;
            await rename(join(stageRoot, name), to);
        }
        return ok({ storeDirsAdded, farmsAdded, farmsKept, farmsReplaced });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not merge the staged store into ${storeRoot}.`, cause });
    }
}

/**
 * Extract every layer into a fresh staging root, then merge it into the store root.
 *
 * `onProgress` carries the byte counter of each unpack out to the caller, thus the observer that
 * writes the row learns that the child still works. The download events reach the same observer, so
 * one channel states the whole life of the transfer.
 */
async function stageAndMerge(
    storeRoot: string,
    paths: StoreDownloadPaths,
    layers: readonly StoreLayer[],
    attemptId: string,
    replacePublisherRecords: boolean,
    bounds: { readonly windowMs: number; readonly tarBoundMs?: number },
    onProgress: ((event: StoreDownloadProgress) => void) | undefined,
): Promise<Result<StoreMergeReport, StoreDownloadError>> {
    const attemptRoot = join(paths.staging, attemptId);
    try {
        await rm(attemptRoot, { recursive: true, force: true });
        await mkdir(attemptRoot, { recursive: true });
        for (const layer of layers) {
            const unpack: LayerUnpack = { digest: layer.digest, ...bounds };
            const extracted = await extractLayer(join(paths.blobs, blobFileName(layer.digest)), attemptRoot, unpack, onProgress);
            if (extracted.isErr()) return err(extracted.error);
        }
        return await mergeStagedRoot(attemptRoot, storeRoot, paths.metadataName, replacePublisherRecords);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not stage the package store under ${storeRoot}.`, cause });
    } finally {
        // The merge renames the staged entries out, leaving the attempt dir behind; every attempt gets a
        // fresh id, so without this they accumulate. A skipped child stays here, and this drops it.
        await rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Validate a parsed receipt, returning `undefined` for any shape the reader cannot trust. */
function parseStoreReceipt(raw: unknown): StoreReceipt | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    if (record.version !== RECEIPT_VERSION) return undefined;
    if (typeof record.manifestDigest !== "string" || typeof record.reference !== "string") return undefined;
    if (record.arch !== "amd64" && record.arch !== "arm64") return undefined;
    if (typeof record.activatedAt !== "string") return undefined;
    if (!Array.isArray(record.layers)) return undefined;
    const layers: StoreLayer[] = [];
    for (const entry of record.layers) {
        if (typeof entry !== "object" || entry === null) return undefined;
        const layer = entry as Record<string, unknown>;
        if (typeof layer.mediaType !== "string" || typeof layer.digest !== "string" || typeof layer.size !== "number") return undefined;
        layers.push({ mediaType: layer.mediaType, digest: layer.digest, size: layer.size });
    }
    return {
        version: RECEIPT_VERSION,
        manifestDigest: record.manifestDigest,
        reference: record.reference,
        arch: record.arch,
        activatedAt: record.activatedAt,
        layers,
    };
}

/** Read the active receipt. `exists` without a `receipt` marks a present-but-invalid file. */
async function readStoreReceipt(receiptPath: string): Promise<{ readonly exists: boolean; readonly receipt?: StoreReceipt }> {
    let info;
    try {
        info = await lstat(receiptPath);
    } catch (cause) {
        return isMissing(cause) ? { exists: false } : { exists: true };
    }
    // A symlink or a non-file where the receipt belongs is a tampered or damaged store, treated as invalid.
    if (info.isSymbolicLink() || !info.isFile()) return { exists: true };
    try {
        const raw: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
        return { exists: true, receipt: parseStoreReceipt(raw) };
    } catch {
        return { exists: true };
    }
}

/** Write the receipt through a temp file and an atomic rename, so a reader never sees a half-written receipt. */
async function writeStoreReceipt(receiptPath: string, receipt: StoreReceipt): Promise<Result<void, StoreDownloadError>> {
    const temp = `${receiptPath}.${randomUUIDv7()}.tmp`;
    try {
        await mkdir(dirname(receiptPath), { recursive: true });
        await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
        await rename(temp, receiptPath);
        return ok(undefined);
    } catch (cause) {
        await rm(temp, { force: true }).catch(() => undefined);
        return err({ type: "io_failed", message: `Could not write the package-store receipt ${receiptPath}.`, cause });
    }
}

/**
 * The cheap local state of the store content, read without the network.
 *
 * The receipt is written last, so its presence attests the content landed. But the content is a
 * directory on the user machine and can be removed, so a store whose pool or whose farms are gone
 * degrades to incomplete rather than to a false `installed`. Those two ARE the store: the pool holds
 * every distribution, and the catalog farm under `farms/` is the template of the extensions.
 *
 * With no receipt there are three states, and only content separates them. A staging directory is
 * the fingerprint of a download that started, thus the store is an interrupted one that the next run
 * repairs. Without that fingerprint, content in the root is the store the user built with `inflexa
 * store add`, which is a complete store of its own and never a missing one. An empty root is the
 * genuine first run. The staging check comes first, because a crash part-way through a merge leaves
 * both marks and a repair is what that store wants.
 */
export async function inspectStoreContent(storeRoot: string): Promise<StoreContentState> {
    if (!existsSync(storeRoot)) return "missing";
    const paths = storeDownloadPaths(storeRoot);
    const receiptRead = await readStoreReceipt(paths.receipt);
    if (receiptRead.exists && receiptRead.receipt === undefined) return "invalid_receipt";
    const pool = existsSync(join(storeRoot, "store"));
    const farms = existsSync(join(storeRoot, "farms"));
    if (receiptRead.receipt !== undefined) return pool && farms ? "installed" : "incomplete";
    if (existsSync(paths.staging)) return "incomplete";
    return pool || farms ? "local" : "missing";
}

/** Prepare the store root and the installer-owned directories the download writes into. */
async function prepareDownloadDirs(storeRoot: string, paths: StoreDownloadPaths): Promise<Result<void, StoreDownloadError>> {
    try {
        await mkdir(storeRoot, { recursive: true });
        await mkdir(paths.blobs, { recursive: true });
        await mkdir(paths.staging, { recursive: true });
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not prepare the package store at ${storeRoot}.`, cause });
    }
}

/**
 * Pull the store from GHCR and activate it under `deps.storeRoot`.
 *
 * The tag resolves to a manifest digest one time at the start, then every fetch uses digests only,
 * so a moved `latest` cannot mix two versions in one store. When a receipt already pins the resolved
 * manifest, the pull is a no-op (`up_to_date`); when it pins a different one, the pull reports
 * `update_available` and downloads nothing, unless `deps.force` says the user agreed to the update.
 * Otherwise it downloads and verifies each layer, stages, merges into the store root, and writes the
 * receipt last. The merge keeps every locally acquired package and every farm — refer to
 * {@link mergeStagedRoot}.
 */
export async function downloadPackageStore(deps: StoreDownloadDeps): Promise<Result<StoreDownloadOutcome, StoreDownloadError>> {
    const archResult = deps.arch !== undefined ? ok<StoreArch, StoreDownloadError>(deps.arch) : resolveStoreArch(process.arch);
    if (archResult.isErr()) return err(archResult.error);
    const arch = archResult.value;
    const doFetch = deps.fetch ?? fetch;
    const reference = `latest-${arch}`;

    reportProgress(deps.onProgress, { type: "resolving" });
    const token = await fetchAnonymousToken(doFetch);
    if (token.isErr()) return err(token.error);
    const manifest = await resolveManifest(doFetch, reference, token.value);
    if (manifest.isErr()) return err(manifest.error);
    // Reported before the receipt comparison below, so a resolve that transfers nothing still tells
    // the caller which manifest the registry serves now. That digest is what an installed receipt is
    // compared against, thus it is how a reader with no network learns that an update is available.
    reportProgress(deps.onProgress, {
        type: "manifest_resolved",
        manifestDigest: manifest.value.manifestDigest,
        totalBytes: manifest.value.layers.reduce((sum, layer) => sum + layer.size, 0),
        totalLayers: manifest.value.layers.length,
    });

    const paths = storeDownloadPaths(deps.storeRoot);
    const receiptRead = await readStoreReceipt(paths.receipt);
    const installed = receiptRead.receipt;
    if (installed !== undefined && deps.force !== true) {
        // An installed root gets its mountpoint entries on each run that keeps it, current or behind:
        // a root that a download landed before the entries existed has no other writer, and the
        // mkdir is idempotent.
        ensureStoreMountpoints(deps.storeRoot);
        if (installed.manifestDigest === manifest.value.manifestDigest) {
            return ok({ type: "up_to_date", manifestDigest: installed.manifestDigest });
        }
        // A moved `latest` is never applied silently: report it, and the caller asks before it downloads.
        return ok({ type: "update_available", installedDigest: installed.manifestDigest, latestDigest: manifest.value.manifestDigest });
    }

    const prepared = await prepareDownloadDirs(deps.storeRoot, paths);
    if (prepared.isErr()) return err(prepared.error);

    const retry = deps.retry ?? DEFAULT_BLOB_RETRY;
    let bytes = 0;
    for (const layer of manifest.value.layers) {
        const dest = join(paths.blobs, blobFileName(layer.digest));
        const layerResult = await downloadLayerBlob(doFetch, token.value, layer, dest, retry, deps.onProgress);
        if (layerResult.isErr()) return err(layerResult.error);
        bytes += layerResult.value;
    }

    reportProgress(deps.onProgress, { type: "staging" });
    const attemptId = deps.attemptId?.() ?? randomUUIDv7();
    const bounds = {
        windowMs: deps.unpackWindowMs ?? LIVENESS_WINDOW_MS,
        ...(deps.tarBoundMs === undefined ? {} : { tarBoundMs: deps.tarBoundMs }),
    };
    // `force` IS the `--update` consent, thus it is also the consent that replaces the dependency
    // graph: the new catalog resolved a different set, and the two graphs must not merge.
    const staged = await stageAndMerge(deps.storeRoot, paths, manifest.value.layers, attemptId, deps.force === true, bounds, deps.onProgress);
    if (staged.isErr()) return err(staged.error);

    // Before the receipt, thus a root that reads back as installed holds the entries that a runc
    // engine needs for the nested farm and cache binds. The artifact packs none of them.
    ensureStoreMountpoints(deps.storeRoot);

    const receipt: StoreReceipt = {
        version: RECEIPT_VERSION,
        manifestDigest: manifest.value.manifestDigest,
        reference,
        arch,
        activatedAt: (deps.now?.() ?? new Date()).toISOString(),
        layers: manifest.value.layers,
    };
    const written = await writeStoreReceipt(paths.receipt, receipt);
    if (written.isErr()) return err(written.error);

    // The blobs are consumed once staged, and the receipt is now durable, so dropping them frees a
    // second copy of the whole store. Nothing resumes from them after this point.
    await rm(paths.blobs, { recursive: true, force: true }).catch(() => undefined);
    return ok({ type: "downloaded", manifestDigest: manifest.value.manifestDigest, bytes, merge: staged.value });
}

// --- the detached catalog transfer child ---------------------------------------

/**
 * The manifest digest the receipt pins, or `null` when the store carries no valid receipt.
 *
 * This is the installed half of the update comparison. The other half is the digest the last resolve
 * recorded on the row. When the two differ, an update is available — and that is the only way a
 * reader with no network learns it.
 */
export async function installedCatalogManifest(storeRoot: string): Promise<string | null> {
    const read = await readStoreReceipt(storeDownloadPaths(storeRoot).receipt);
    return read.receipt?.manifestDigest ?? null;
}

/** What a catalog start attempt did. Only `started` puts a child on the machine. */
export type CatalogTransferStart =
    | { readonly type: "started"; readonly pid: number }
    | { readonly type: "already_running"; readonly report: TransferReport }
    | { readonly type: "up_to_date"; readonly manifestDigest: string }
    | { readonly type: "update_available"; readonly installedDigest: string; readonly latestDigest: string };

/**
 * The hidden flag that tells the re-invoked `inflexa store download` to move the bytes itself rather
 * than start a third process. The registry (`src/cli/index.ts`) declares the same spelling as a
 * hidden option, because a command registry that imported this module would give up its lazy-import
 * discipline for one string.
 */
export const CATALOG_TRANSFER_FLAG = "--run-transfer";

/** Record the resolve of the catalog transfer on its row, and ignore every other event. */
function recordResolvedManifest(event: StoreDownloadProgress): void {
    if (event.type !== "manifest_resolved") return;
    // The write is discarded on failure, and deliberately: the row is a progress readout, thus a
    // database this process cannot write must never abort a transfer that is otherwise succeeding.
    recordTransferResolve("catalog", { digest: event.manifestDigest, totalBytes: event.totalBytes, totalLayers: event.totalLayers }).unwrapOr(0);
}

/**
 * Start the detached catalog transfer child, or report why no process was necessary.
 *
 * The command that calls this exits at once. The resolve happens HERE and not in the child for the
 * two cases that must answer synchronously. A receipt that pins the manifest the registry serves now
 * means the store is up to date, and a receipt that pins a different one means an update is
 * available. Neither starts a transfer, and `update` is the consent that applies the moved tag. With
 * no receipt there is nothing to compare, thus the start needs no network at all.
 */
export async function startCatalogTransfer(params: {
    readonly storeRoot: string;
    readonly update: boolean;
    /** Fetch implementation for the resolve; defaults to the runtime fetch. Injected by a test. */
    readonly fetch?: FetchLike;
    /** The architecture to resolve; defaults to the host architecture. Injected by a test. */
    readonly arch?: StoreArch;
    /** Put the detached child on the machine and report its pid. Injected by a test, so no test ever spawns one. */
    readonly spawn?: (argv: readonly string[]) => number;
}): Promise<Result<CatalogTransferStart, StoreDownloadError>> {
    const report = readTransferReport("catalog");
    // The lock gives single-flight for free: one live holder means one child, and this start yields.
    if (report.live) return ok({ type: "already_running", report });

    if ((await inspectStoreContent(params.storeRoot)) === "installed") {
        // A valid receipt is there, thus this call resolves the manifest and transfers nothing
        // whatever the outcome — `downloadPackageStore` short-circuits on a present receipt when
        // `force` is absent.
        const resolved = await downloadPackageStore({
            storeRoot: params.storeRoot,
            onProgress: recordResolvedManifest,
            ...(params.fetch === undefined ? {} : { fetch: params.fetch }),
            ...(params.arch === undefined ? {} : { arch: params.arch }),
        });
        if (resolved.isErr()) return err(resolved.error);
        if (resolved.value.type === "up_to_date") return ok({ type: "up_to_date", manifestDigest: resolved.value.manifestDigest });
        if (resolved.value.type === "update_available" && !params.update) {
            return ok({ type: "update_available", installedDigest: resolved.value.installedDigest, latestDigest: resolved.value.latestDigest });
        }
    }

    // `pending` before the spawn, so a reader between the write and the child taking the lock sees a
    // run that is starting rather than the terminal state the last run left. Discarded on failure:
    // the row is a readout, and a database this process cannot write must not stop the transfer.
    startTransferRun("catalog", { state: "pending", holderPid: null }).unwrapOr(undefined);
    const argv = ["store", "download", ...(params.update ? ["--update"] : []), CATALOG_TRANSFER_FLAG];
    try {
        return ok({ type: "started", pid: (params.spawn ?? spawnDetachedSelf)(argv) });
    } catch (cause) {
        const message = "Could not start the package-store downloader. Run `inflexa store download` again.";
        settleTransfer("catalog", { state: "failed", message }).unwrapOr(undefined);
        return err({ type: "io_failed", message, cause });
    }
}

/**
 * How often the live transfer writes its running counts.
 *
 * A multi-gigabyte transfer emits a byte event for every chunk, which is many thousands of events.
 * One row write for each of them would be pure waste for a readout that a user reads at a human
 * rate. Every layer edge writes regardless, so the recorded counts are exact at each layer boundary.
 */
const PROGRESS_WRITE_INTERVAL_MS = 500;

/** Whether a thrown cause, or anything it wraps, is the out-of-disk error. */
function isDiskFull(cause: unknown): boolean {
    let current = cause;
    for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
        if (typeof current === "object" && "code" in current && (current as { code?: unknown }).code === "ENOSPC") return true;
        current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
    }
    return false;
}

/** Render a byte count in the largest unit that keeps it readable, for a message a user acts on. */
function describeBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}

/** The bytes the filesystem under `path` still offers this user, or `null` when the question cannot be answered. */
async function availableBytes(path: string): Promise<number | null> {
    try {
        const fs = await statfs(path);
        return Number(fs.bavail) * Number(fs.bsize);
    } catch {
        return null;
    }
}

/**
 * The message the row carries for a failure: the fault, and what to do about it.
 *
 * A disk that ran out gets the two figures a user needs to act. A bare "no space left" tells nobody
 * how much disk to free, and the manifest already declares exactly how much the transfer still
 * wants.
 */
async function describeTransferFailure(error: StoreDownloadError, storeRoot: string, remaining: number | null): Promise<string> {
    if (isDiskFull("cause" in error ? error.cause : undefined)) {
        const free = await availableBytes(storeRoot);
        const need = remaining === null ? "the rest of the catalog" : describeBytes(remaining);
        const have = free === null ? "less than that" : describeBytes(free);
        return `The disk ran out while the package store downloaded. The transfer needs ${need} more and ${storeRoot} offers ${have}. Free the difference, then run \`inflexa store download\`.`;
    }
    return `${error.message} Run \`inflexa store download\` to try again.`;
}

/**
 * Move the bytes in THIS process: hold the lock for the whole life of the run, write the row as the
 * transfer advances, and settle the row on every exit path.
 *
 * This is the body of the detached child. It takes the lock first, because the lock is what makes
 * the run visible as live to every other process — a run that wrote `running` without it would read
 * as failed at once. A start that loses the race writes nothing and returns, thus two children can
 * never both transfer.
 */
export async function runCatalogTransfer(params: {
    readonly storeRoot: string;
    readonly update: boolean;
    /** Fetch implementation for the transfer; defaults to the runtime fetch. Injected by a test. */
    readonly fetch?: FetchLike;
    /** Retry schedule for a blob GET; defaults to the module schedule. Injected by a test, so a failure fails at once. */
    readonly retry?: DownloadRetry;
    /** The architecture to transfer; defaults to the host architecture. Injected by a test. */
    readonly arch?: StoreArch;
    /** The silence that ends a layer decompress; defaults to the download window. Injected by a test. */
    readonly unpackWindowMs?: number;
    /** The wall bound of one `tar` run; defaults to the bound that scales with the tar. Injected by a test. */
    readonly tarBoundMs?: number;
}): Promise<void> {
    const lock = acquireInstanceLock(transferLockKey("catalog"));
    if (!lock.acquired) return;
    startTransferRun("catalog", { state: "running", holderPid: process.pid }).unwrapOr(undefined);

    let totalBytes: number | null = null;
    let completedBytes = 0;
    let inFlightBytes = 0;
    let layersCompleted = 0;
    let lastWrite = 0;
    let phase: TransferPhase = "download";
    const writeProgress = (force: boolean): void => {
        const now = Date.now();
        if (!force && now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
        lastWrite = now;
        recordTransferProgress("catalog", { bytesTransferred: completedBytes + inFlightBytes, layersCompleted, phase }).unwrapOr(0);
    };

    try {
        const result = await downloadPackageStore({
            storeRoot: params.storeRoot,
            force: params.update,
            ...(params.fetch === undefined ? {} : { fetch: params.fetch }),
            ...(params.retry === undefined ? {} : { retry: params.retry }),
            ...(params.arch === undefined ? {} : { arch: params.arch }),
            ...(params.unpackWindowMs === undefined ? {} : { unpackWindowMs: params.unpackWindowMs }),
            ...(params.tarBoundMs === undefined ? {} : { tarBoundMs: params.tarBoundMs }),
            onProgress: (event) => {
                switch (event.type) {
                    case "manifest_resolved":
                        totalBytes = event.totalBytes;
                        recordResolvedManifest(event);
                        return;
                    case "layer_started":
                        inFlightBytes = 0;
                        return;
                    case "layer_bytes":
                        inFlightBytes += event.bytes;
                        writeProgress(false);
                        return;
                    case "layer_completed":
                        completedBytes += event.bytes;
                        inFlightBytes = 0;
                        layersCompleted += 1;
                        writeProgress(true);
                        return;
                    case "staging":
                        // Every byte is in, thus the meter stays where it is and only the phase word moves.
                        phase = "unpacking";
                        writeProgress(true);
                        return;
                    case "unpack_bytes":
                        // The heartbeat of the unpacking: the counts do not change, and `updated_at` does.
                        writeProgress(false);
                        return;
                    default:
                        return;
                }
            },
        });

        if (result.isErr()) {
            // The staged tree is per-attempt debris that no retry reads, and a disk that ran out is
            // exactly the case where leaving it costs the user the space they must free. The blob cache
            // stays: a layer that completed is worth keeping, and the next run verifies each cached blob
            // by digest.
            await rm(storeDownloadPaths(params.storeRoot).staging, { recursive: true, force: true }).catch(() => undefined);
            const remaining = totalBytes === null ? null : Math.max(0, totalBytes - completedBytes - inFlightBytes);
            const message = await describeTransferFailure(result.error, params.storeRoot, remaining);
            settleTransfer("catalog", { state: "failed", message }).unwrapOr(undefined);
            return;
        }

        // Each ok outcome leaves the published bytes on disk: `downloaded` activated them, and the two
        // no-op outcomes mean a receipt already pins them. Whether a sandbox can mount the farm of its
        // analysis is a separate question, which the sandbox gate asks against the filesystem.
        writeProgress(true);
        settleTransfer("catalog", { state: "installed", message: null }).unwrapOr(undefined);
    } finally {
        releaseInstanceLock(transferLockKey("catalog"));
    }
}

/**
 * What a cancel did. `no_run` is a normal answer, not a failure: a cancel of
 * nothing changes nothing. `timed_out` names a child that outlived the wait —
 * the staged tree and the row then stay, because the child still owns both.
 */
export type CatalogTransferCancel =
    { readonly type: "canceled"; readonly holderPid: number } | { readonly type: "timed_out"; readonly holderPid: number } | { readonly type: "no_run" };

/**
 * Stop the live catalog transfer, record `canceled`, and remove the partial staged tree.
 *
 * The child is detached, thus it outlives both `inflexa setup` and the app, and a command is the
 * only thing that reaches it from another terminal. The staged tree is dropped only after the holder
 * is gone, so a rename that is in flight is never raced. A stop that timed out therefore removes
 * nothing: a removal under a live writer can tear a rename mid-flight, and the torn merge can read
 * back as a complete local store.
 *
 * It removes NO installed content. The staged tree is per-attempt debris under the installer-owned
 * metadata directory, and each child that the store root holds stays where it is.
 */
export async function cancelCatalogTransfer(storeRoot: string, stop: typeof stopTransferChild = stopTransferChild): Promise<CatalogTransferCancel> {
    const stopped = await stop("catalog");
    if (stopped.type === "no_run") return { type: "no_run" };
    if (stopped.type === "timed_out") return { type: "timed_out", holderPid: stopped.holderPid };
    await rm(storeDownloadPaths(storeRoot).staging, { recursive: true, force: true }).catch(() => undefined);
    settleTransfer("catalog", { state: "canceled", message: null }).unwrapOr(undefined);
    return { type: "canceled", holderPid: stopped.holderPid };
}
