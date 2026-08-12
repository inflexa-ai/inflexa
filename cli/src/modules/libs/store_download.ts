/**
 * The GHCR pull of the content-addressed package store, plus its receipt-backed staging.
 *
 * The store publishes to GHCR as an OCI artifact, one for each architecture (the publisher is
 * `.github/workflows/lib-store-provisioner.yml`). This module brings that artifact onto the user
 * machine without a container engine: an anonymous token GET, a manifest GET, then one digest-pinned
 * blob GET for each layer, all over https. Each blob rides `downloadToFile` (the bearer token in its
 * injectable `fetch` seam), and the returned sha256 must equal the descriptor digest or the layer is
 * refused.
 *
 * The layers are zstd-compressed tars: one for each track plus one base layer with the farms and the
 * `current` pointer. Extraction of every layer into one staged root reassembles the `/mnt/libs` tree
 * exactly, with the symlinks kept verbatim, so the harness `libStoreUsable` check accepts it. The
 * activation obeys the receipt pattern of the reference store (`modules/refs/store.ts`): stage, rename,
 * then write the receipt last. Thus a crash before the receipt reads back as incomplete, and the next
 * run repairs it.
 *
 * The activation MERGES the staged tree into the store root, and it removes nothing. The root is shared
 * with `inflexa store add`, which provisions into the same `store/` pool and writes its own farms beside
 * the published ones ({@link mergeStagedRoot}).
 *
 * The transfer runs in a DETACHED process that `inflexa setup` and `inflexa store download` start and
 * that outlives both ({@link startLibStoreDownloadProcess}). The lifecycle of that process — its state,
 * its byte totals, and its liveness — is the second half of this module. One database row records what
 * the process does now; the receipt on disk stays the truth of what the store holds. The two records
 * never merge, because a store root can arrive by a route that wrote no row.
 *
 * The gate that holds sandbox creation is the caller's wiring. This module gives the mechanisms it
 * operates: the download ({@link downloadLibStore}), the local state read
 * ({@link inspectLibStoreDownload}), and the lifecycle read ({@link readLibStoreDownloadReport}). No
 * configuration value suppresses any of them, because the runtime image bakes no library.
 */

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";

import { getLibStoreDownload } from "../../db/primary_query.ts";
import { recordLibStoreDownloadManifest, recordLibStoreDownloadProgress, settleLibStoreDownload, startLibStoreDownloadRun } from "../../db/primary_mutation.ts";
import { downloadToFile, type DownloadError, type DownloadProgress, type DownloadRetry, type FetchLike } from "../../lib/download.ts";
import { env } from "../../lib/env.ts";
import { sha256File } from "../../lib/hash.ts";
import { acquireInstanceLock, instanceLockHolder, releaseInstanceLock, LIB_STORE_DOWNLOAD_LOCK_KEY } from "../../lib/lock.ts";

/** The registry host the store publishes to. */
const STORE_REGISTRY = "ghcr.io";

/**
 * The store repository below the registry. The publisher writes `ghcr.io/<owner>/lib-store`
 * (`.github/workflows/lib-store-provisioner.yml`, `STORE_IMAGE`). The owner is the inflexa-ai org, the
 * same namespace the sandbox images publish under (`modules/libs/images.ts`).
 */
const STORE_REPOSITORY = "inflexa-ai/lib-store";

/** The media type of a per-track layer, from the publisher. */
const TRACK_MEDIA_TYPE = "application/vnd.inflexa.lib-store.track.v1.tar+zstd";

/** The media type of the base layer that carries the farms and the `current` pointer, from the publisher. */
const BASE_MEDIA_TYPE = "application/vnd.inflexa.lib-store.base.v1.tar+zstd";

/** The manifest media types the pull accepts; the arch tag resolves to an image manifest, never an index. */
const MANIFEST_ACCEPT = "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json";

/** The receipt schema version. A different value on disk reads as an invalid receipt, thus as incomplete. */
const RECEIPT_VERSION = 1;

/** The installer-owned metadata directory below the store root. Its dot name keeps it out of the store content. */
const METADATA_DIR = ".inflexa-download";

/**
 * The default retry schedule for a blob GET. GHCR names no contractual rate limit, so a shed or a
 * transient upstream status takes another attempt with exponential backoff. Only the request is retried,
 * never a body that already began arriving — the {@link downloadToFile} contract.
 */
const DEFAULT_BLOB_RETRY: DownloadRetry = {
    attempts: 4,
    baseMs: 500,
    shouldRetry: (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504,
};

/** A published store architecture, as the publisher tags it (`latest-<arch>`). */
export type StoreArch = "amd64" | "arm64";

/**
 * The lifecycle state of the one detached catalog downloader.
 *
 * `declined` records a setup answer of no, which starts no transfer and writes no staged tree.
 * `canceled` records a transfer that started and that the user stopped, which leaves a partial staged
 * tree that the cancel removes. The difference is load-bearing: only one of the two has a tree to drop.
 *
 * `failed`, `declined`, and `canceled` are terminal. Only a retry leaves one of them.
 */
export type LibStoreDownloadStatus = "pending" | "running" | "installed" | "failed" | "declined" | "canceled";

/**
 * The one persisted row that records what the download process does now.
 *
 * The receipt on disk stays the truth of what the store holds. This row is the truth of what the
 * process does, and it decides nothing about whether a sandbox can start. A store root can arrive by a
 * route that wrote no row, for example a manual pull or `inflexa store add`, thus an absent row is a
 * normal condition and never an unusable store.
 *
 * The shape lives beside the download rather than in `src/types/`, because the download is its one
 * consumer. `src/db/` takes it as a type-only import, thus the storage layer keeps no runtime
 * dependency on this module.
 */
export type LibStoreDownloadRow = {
    /** The stable row id. There is one store root, thus there is one row. */
    readonly id: string;
    /** When the first run wrote the row, epoch millis. */
    readonly createdAt: number;
    /** When the last write landed, epoch millis. */
    readonly updatedAt: number;
    /** The lifecycle state. */
    readonly state: LibStoreDownloadStatus;
    /** The bytes the transfer has moved so far. */
    readonly bytesTransferred: number;
    /** The bytes the manifest declares, or `null` before the manifest resolves. It never grows after that moment. */
    readonly totalBytes: number | null;
    /** The layers the transfer has completed so far. */
    readonly layersCompleted: number;
    /** The layers the manifest declares, or `null` before the manifest resolves. */
    readonly totalLayers: number | null;
    /**
     * The manifest digest the last resolve saw, which is the digest the registry serves now. A receipt
     * that pins a different digest means an update is available, and that comparison is the only way a
     * reader learns it without the network.
     */
    readonly manifestDigest: string | null;
    /** The user-facing message of a failure: the fault and the remedy, never a stack trace. */
    readonly message: string | null;
    /** The process identifier of the downloader, or `null` when no process holds the run. */
    readonly holderPid: number | null;
};

/** One layer descriptor from the manifest: the media type, the content digest, and the compressed size. */
export type LibStoreLayer = {
    readonly mediaType: string;
    readonly digest: string;
    readonly size: number;
};

/** The receipt the store download writes last, pinning the manifest it activated. */
export type LibStoreReceipt = {
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
    readonly layers: readonly LibStoreLayer[];
};

/**
 * The cheap local state of the store download, read without the network.
 *
 * `local` is a store the user built with `inflexa store add`: it holds real content and it carries no
 * receipt, because no download made it. It is never `missing`, and a download over it is a merge.
 */
export type LibStoreDownloadState = "missing" | "local" | "incomplete" | "installed" | "invalid_receipt";

/** Why a store download could not complete. Each variant names one stage. */
export type LibStoreDownloadError =
    | { readonly type: "unsupported_arch"; readonly arch: string; readonly message: string }
    | { readonly type: "token_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "manifest_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "digest_mismatch"; readonly message: string; readonly expected: string; readonly actual: string }
    | { readonly type: "download_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "extract_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "io_failed"; readonly message: string; readonly cause?: unknown };

/** What one activation merge did to the store root, so the caller can report the outcome of the merge. */
export type LibStoreMergeReport = {
    /** The `store/` directory names the download moved in. A name that was already there is not here. */
    readonly storeDirsAdded: readonly string[];
    /** The farm names the download moved in. */
    readonly farmsAdded: readonly string[];
    /** The farm names the download left alone, because the store root already holds a farm of each name. */
    readonly farmsKept: readonly string[];
    /** True when the merge set `current`, because the store root carried no active-farm pointer. */
    readonly currentSet: boolean;
};

/**
 * What a download attempt produced. `up_to_date` means the receipt already pins the resolved manifest.
 * `update_available` reports a moved tag WITHOUT applying it, so the caller can ask before it downloads.
 * `downloaded` is a completed, activated store, with the report of what the merge into the store root
 * changed.
 */
export type LibStoreDownloadOutcome =
    | { readonly type: "up_to_date"; readonly manifestDigest: string }
    | { readonly type: "update_available"; readonly installedDigest: string; readonly latestDigest: string }
    | { readonly type: "downloaded"; readonly manifestDigest: string; readonly bytes: number; readonly merge: LibStoreMergeReport };

/**
 * A fire-and-forget progress notification for one store download. A layer event carries its digest,
 * because several layers transfer in sequence and an unattributed byte count would be ambiguous.
 *
 * `manifest_resolved` carries the two totals. The manifest declares the size of every layer before the
 * first byte arrives, thus an observer that records them records exact figures and never an estimate.
 */
export type LibStoreDownloadProgress =
    | { readonly type: "resolving" }
    | { readonly type: "manifest_resolved"; readonly manifestDigest: string; readonly totalBytes: number; readonly totalLayers: number }
    | { readonly type: "layer_started"; readonly digest: string; readonly declaredBytes?: number }
    | { readonly type: "layer_bytes"; readonly digest: string; readonly bytes: number }
    | { readonly type: "layer_completed"; readonly digest: string; readonly bytes: number }
    | { readonly type: "staging" };

/** The seams the CLI composition edge supplies. Production passes only `storeRoot`; a test injects the rest. */
export type LibStoreDownloadDeps = {
    /** The CLI-owned store root (`env.libStoreDir`), supplied by the caller; this module never re-derives it. */
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
    readonly onProgress?: (event: LibStoreDownloadProgress) => void;
    /** Retry schedule for a blob GET; defaults to {@link DEFAULT_BLOB_RETRY}. */
    readonly retry?: DownloadRetry;
    /**
     * Download even when a receipt already pins a different manifest. The update ask sets this after the
     * user says yes; without it, a moved tag reports `update_available` and downloads nothing.
     */
    readonly force?: boolean;
};

/** Resolve the host architecture to the publisher's arch label, or refuse an architecture with no store. */
export function resolveStoreArch(arch: string): Result<StoreArch, LibStoreDownloadError> {
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
export type LibStoreDownloadPaths = {
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
export function libStoreDownloadPaths(storeRoot: string): LibStoreDownloadPaths {
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
function reportProgress(onProgress: ((event: LibStoreDownloadProgress) => void) | undefined, event: LibStoreDownloadProgress): void {
    if (onProgress === undefined) return;
    try {
        onProgress(event);
    } catch {
        // A progress readout is decoration over a transfer that is otherwise succeeding.
    }
}

/** Translate a single-file download event into a layer-attributed store event. */
function forwardLayerProgress(onProgress: ((event: LibStoreDownloadProgress) => void) | undefined, digest: string, event: DownloadProgress): void {
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
 * A local write fault stays an io fault, because its remedy is the user's disk. Every wire fault — an
 * unreachable host, a bad status, a redirect downgraded off https — is one thing to the caller: the
 * layer did not arrive.
 */
function mapDownloadError(error: DownloadError): LibStoreDownloadError {
    return error.type === "io_failed"
        ? { type: "io_failed", message: error.message, cause: error.cause }
        : { type: "download_failed", message: error.message, ...("cause" in error ? { cause: error.cause } : {}) };
}

/** The digest is the content id; a colon is not a portable path segment, so it becomes the file stem. */
function blobFileName(digest: string): string {
    return `${digest.replace(":", "-")}.tar.zst`;
}

/** GET an anonymous pull token for the store repository. */
async function fetchAnonymousToken(doFetch: FetchLike): Promise<Result<string, LibStoreDownloadError>> {
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
type ResolvedLibStoreManifest = {
    readonly manifestDigest: string;
    readonly layers: readonly LibStoreLayer[];
};

/** Read the layer descriptors from a parsed manifest, refusing any unexpected shape or media type. */
function readManifestLayers(manifest: unknown): Result<readonly LibStoreLayer[], LibStoreDownloadError> {
    if (typeof manifest !== "object" || manifest === null) return err({ type: "manifest_failed", message: "The manifest was not an object." });
    const layersRaw = (manifest as Record<string, unknown>).layers;
    if (!Array.isArray(layersRaw) || layersRaw.length === 0) return err({ type: "manifest_failed", message: "The manifest declared no layers." });
    const layers: LibStoreLayer[] = [];
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
async function resolveManifest(doFetch: FetchLike, reference: string, token: string): Promise<Result<ResolvedLibStoreManifest, LibStoreDownloadError>> {
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
    // The digest comes from the raw bytes, not from a header: it is the value the receipt pins, so a later
    // run compares against exactly what was served rather than a value the registry can restate.
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
 * The transfer is {@link downloadToFile}: the bearer token rides its injectable `fetch` seam, and GHCR
 * answers a blob GET with an https redirect to a GitHub CDN host, which the utility's `insecure_redirect`
 * check accepts. The utility hashes the bytes and the caller owns the verification, so a blob whose
 * sha256 differs from the descriptor is discarded and refused. A verified cache hit skips the network,
 * so a repaired run does not refetch bytes it already holds.
 */
async function downloadLayerBlob(
    doFetch: FetchLike,
    token: string,
    layer: LibStoreLayer,
    dest: string,
    retry: DownloadRetry,
    onProgress: ((event: LibStoreDownloadProgress) => void) | undefined,
): Promise<Result<number, LibStoreDownloadError>> {
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
        // downloadToFile sends no headers of its own; the bearer rides here, on the initial request. `fetch`
        // strips Authorization on a cross-origin redirect, which is correct — the CDN URL is pre-signed.
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
 * `Retrying...` more than a thousand times over that same run. Thus the exit code alone is not a verdict,
 * and a run that prints one of these words extracted less than the archive holds. Each marker is compared
 * in lower case, because the two `tar` implementations differ in their capitals.
 */
const TAR_DAMAGE_MARKERS = ["damaged", "truncated", "unexpected eof", "retrying", "skipping to next header"] as const;

/** How many `lstat` calls {@link verifyStagedLayer} keeps in flight. A window of 64 reads 78,000 members in about 90 ms, against about 900 ms one at a time. */
const COMPLETENESS_WINDOW = 64;

/** How many absent members a completeness failure names. The count carries the scale, thus a few examples are enough to act on. */
const MISSING_EXAMPLE_LIMIT = 3;

/** What one `tar` run produced. Both streams are read every time, because a warning is the only signal of a damaged archive. */
type TarRun = { readonly code: number; readonly stdout: string; readonly stderr: string };

/**
 * Run `tar` and collect its exit code and both of its streams.
 *
 * The two reads and the exit wait run together. A sequential read would let the other pipe fill and stop
 * the child, and a member list of a large layer is several megabytes.
 */
async function runTar(args: readonly string[]): Promise<TarRun> {
    const proc = Bun.spawn(["tar", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
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
 * WHAT THIS PROVES. The blob hashed to its descriptor digest before the extraction, and the decompression
 * of a zstd frame is total, thus the inflated tar is byte-for-byte what the publisher made. The archive is
 * therefore the one authority on what the layer holds, and it states its own member list. This check reads
 * that list and confirms that each name is an entry on disk. As a result, a `tar` that stopped part-way is
 * refused, which is the exact fault this module carried.
 *
 * WHAT THIS DOES NOT PROVE. It reads the presence of an entry, never its bytes: a member whose body landed
 * short still counts as present. It does not read the mode, the owner, or the timestamp. It does not
 * resolve a symlink, because a farm link bakes an absolute `/mnt/libs/...` target that dangles on the host
 * by design. It says nothing about the store as a whole, because a layer descriptor carries a size and a
 * digest and no entry count, thus no count is invented from outside the archive.
 *
 * The one known limit is a member name that carries a newline. `tar -t` writes one name for each line,
 * thus such a name reads as two absent names. The publisher feeds `tar` a newline-delimited member list,
 * so such a name cannot reach a layer in the first place.
 *
 * Exported so a test proves the guarantee directly against a tree that the test made partial. This check
 * is the only thing between a partial extraction and a receipt that calls it installed.
 */
export async function verifyStagedLayer(tarPath: string, stageRoot: string): Promise<Result<number, LibStoreDownloadError>> {
    const listed = await runTar(["-tf", tarPath]);
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
 * inflated tar to a temporary file, then `tar -xf` reads that file. The operating system moves every byte,
 * and no stream crosses the JS bridge. That bridge is exactly what failed before: a `Readable.toWeb` pump
 * into the stdin of `tar` broke with `EINVAL` on `send` part-way through a 1.33 GB layer, and it left 142
 * of 451 store directories on disk under an exit code of 0.
 *
 * THE REJECTED ALTERNATIVE. A shell pipeline, `zstd -d -c <blob> | tar -x`, moves the same bytes through
 * the operating system. It is refused because `zstd` is not a system program. macOS ships `tar` at
 * `/usr/bin/tar` and ships no `zstd`, thus the pipeline adds a dependency that a user machine does not
 * carry. `tar --zstd` is refused for the same reason: the system libarchive links zlib, liblzma, and
 * bz2lib, and it falls back to the same absent `zstd` program. A pipeline also hides the exit code of its
 * left side behind `PIPESTATUS`, which is one more thing to get right for no gain.
 *
 * THE ACCEPTED COST. The temporary file is the whole inflated layer: about 4.3 GB for the python layer,
 * written in about 7 seconds. It is removed as soon as `tar` has read it, thus the peak cost is one layer
 * and never the whole store. The download already holds the compressed store in its blob cache and the
 * inflated store in its staged tree, so this is a bounded increment over what the transfer already wants.
 *
 * THE VERDICT. The exit code is not trusted on its own, and the stderr text is read on every run — refer
 * to {@link TAR_DAMAGE_MARKERS}. A clean run then goes to {@link verifyStagedLayer}, thus a partial
 * extraction returns an error and never an ok.
 */
async function extractLayer(blobPath: string, stageRoot: string): Promise<Result<void, LibStoreDownloadError>> {
    // The temporary tar sits beside its blob, thus it lands on the filesystem of the store root rather than
    // on a small system temp volume. The uuid keeps two attempts over one blob apart.
    const tarPath = `${blobPath}.${randomUUIDv7()}.tar`;
    try {
        try {
            // `pipeline` propagates a decompressor fault and a write fault, thus a truncated zstd frame or a
            // disk that ran out fails here and never reaches `tar` as a short archive.
            await pipeline(createReadStream(blobPath), createZstdDecompress(), createWriteStream(tarPath));
        } catch (cause) {
            return err({ type: "extract_failed", message: `Could not decompress a store layer: ${errorText(cause)}.`, cause });
        }
        const extracted = await runTar(["-x", "-f", tarPath, "-C", stageRoot]);
        const damage = tarDamage(extracted.stderr);
        if (extracted.code !== 0 || damage !== undefined) {
            const detail = damage ?? extracted.stderr.trim();
            return err({
                type: "extract_failed",
                message: `Extracting a store layer failed (tar exit ${extracted.code})${detail === "" ? "" : `: ${detail}`}.`,
            });
        }
        return (await verifyStagedLayer(tarPath, stageRoot)).map(() => undefined);
    } catch (cause) {
        return err({ type: "extract_failed", message: `Extracting a store layer failed: ${errorText(cause)}.`, cause });
    } finally {
        await rm(tarPath, { force: true }).catch(() => undefined);
    }
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
 * correct, because the store is content-addressed and write-once: the directory name carries the hash of
 * the content, so the same name is the same bytes. Under `farms/` the skip is the whole point. A farm is
 * the curated closure of the user, and the packages of that farm survive in `store/`, because this merge
 * adds and never removes.
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
 * Merge each staged top-level entry into the store root, and remove nothing.
 *
 * The whole `/mnt/libs` tree lives directly at the store root — the harness reads `<root>/current` — and
 * the root is shared. `inflexa store add` provisions into the same `store/` pool and writes its own farms
 * beside the published ones. A replacement would destroy that work, so the download moves in only what the
 * root does not have. `store/` and `farms/` merge one level deeper, because both owners write into them.
 * Any other top-level entry, for example an empty mount point, moves in only when it is absent.
 *
 * `current` is the active-farm pointer, and it lands last. An absent pointer takes the farm the download
 * brought, so a fresh install is usable at once. A pointer that is already there stays, because a download
 * must never move the user onto a different environment without a word. The last position also keeps a
 * concurrent reader from seeing a `current` that points past content which is still on its way.
 *
 * The merge keeps the crash safety of the receipt pattern. Each move is a `rename` inside one filesystem,
 * thus a child is complete or absent and never half-written. A crash part-way leaves the receipt unwritten,
 * so the store reads back as incomplete and the next run merges again — where each child that already
 * landed is simply skipped.
 */
async function mergeStagedRoot(stageRoot: string, storeRoot: string, metadataName: string): Promise<Result<LibStoreMergeReport, LibStoreDownloadError>> {
    let entries: readonly string[];
    try {
        entries = (await readdir(stageRoot)).filter((name) => name !== metadataName);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not read the staged store at ${stageRoot}.`, cause });
    }
    const ordered = [...entries].sort((a, b) => (a === "current" ? 1 : b === "current" ? -1 : a.localeCompare(b)));
    const storeDirsAdded: string[] = [];
    const farmsAdded: string[] = [];
    const farmsKept: string[] = [];
    let currentSet = false;
    try {
        for (const name of ordered) {
            const to = join(storeRoot, name);
            if (name === "store") {
                storeDirsAdded.push(...(await mergeChildren(join(stageRoot, name), to)).added);
                continue;
            }
            if (name === "farms") {
                const merged = await mergeChildren(join(stageRoot, name), to);
                farmsAdded.push(...merged.added);
                farmsKept.push(...merged.kept);
                continue;
            }
            if (await entryExists(to)) continue;
            await rename(join(stageRoot, name), to);
            if (name === "current") currentSet = true;
        }
        return ok({ storeDirsAdded, farmsAdded, farmsKept, currentSet });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not merge the staged store into ${storeRoot}.`, cause });
    }
}

/** Extract every layer into a fresh staging root, then merge it into the store root. */
async function stageAndMerge(
    storeRoot: string,
    paths: LibStoreDownloadPaths,
    layers: readonly LibStoreLayer[],
    attemptId: string,
): Promise<Result<LibStoreMergeReport, LibStoreDownloadError>> {
    const attemptRoot = join(paths.staging, attemptId);
    try {
        await rm(attemptRoot, { recursive: true, force: true });
        await mkdir(attemptRoot, { recursive: true });
        for (const layer of layers) {
            const extracted = await extractLayer(join(paths.blobs, blobFileName(layer.digest)), attemptRoot);
            if (extracted.isErr()) return err(extracted.error);
        }
        return await mergeStagedRoot(attemptRoot, storeRoot, paths.metadataName);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not stage the package store under ${storeRoot}.`, cause });
    } finally {
        // The merge renames the staged entries out, leaving the attempt dir behind; every attempt gets a
        // fresh id, so without this they accumulate. A skipped child stays here, and this drops it.
        await rm(attemptRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Validate a parsed receipt, returning `undefined` for any shape the reader cannot trust. */
function parseLibStoreReceipt(raw: unknown): LibStoreReceipt | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    if (record.version !== RECEIPT_VERSION) return undefined;
    if (typeof record.manifestDigest !== "string" || typeof record.reference !== "string") return undefined;
    if (record.arch !== "amd64" && record.arch !== "arm64") return undefined;
    if (typeof record.activatedAt !== "string") return undefined;
    if (!Array.isArray(record.layers)) return undefined;
    const layers: LibStoreLayer[] = [];
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
async function readLibStoreReceipt(receiptPath: string): Promise<{ readonly exists: boolean; readonly receipt?: LibStoreReceipt }> {
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
        return { exists: true, receipt: parseLibStoreReceipt(raw) };
    } catch {
        return { exists: true };
    }
}

/** Write the receipt through a temp file and an atomic rename, so a reader never sees a half-written receipt. */
async function writeLibStoreReceipt(receiptPath: string, receipt: LibStoreReceipt): Promise<Result<void, LibStoreDownloadError>> {
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
 * The cheap local state of the store download, read without the network.
 *
 * The receipt is written last, so its presence attests the content landed. But the content is a
 * directory on the user machine and can be removed, so a vanished `current` degrades to incomplete
 * rather than a false `installed`.
 *
 * With no receipt there are three states, and only content separates them. A staging directory is the
 * fingerprint of a download that started, thus the store is an interrupted one that the next run repairs.
 * Without that fingerprint, content in the root is the store the user built with `inflexa store add`,
 * which is a complete store of its own and never a missing one. An empty root is the genuine first run.
 * The staging check comes first, because a crash part-way through a merge leaves both marks and a repair
 * is what that store wants.
 */
export async function inspectLibStoreDownload(storeRoot: string): Promise<LibStoreDownloadState> {
    if (!existsSync(storeRoot)) return "missing";
    const paths = libStoreDownloadPaths(storeRoot);
    const receiptRead = await readLibStoreReceipt(paths.receipt);
    if (receiptRead.exists && receiptRead.receipt === undefined) return "invalid_receipt";
    if (receiptRead.receipt !== undefined) return existsSync(join(storeRoot, "current")) ? "installed" : "incomplete";
    if (existsSync(paths.staging)) return "incomplete";
    const hasContent = existsSync(join(storeRoot, "store")) || existsSync(join(storeRoot, "farms")) || existsSync(join(storeRoot, "current"));
    return hasContent ? "local" : "missing";
}

/** Prepare the store root and the installer-owned directories the download writes into. */
async function prepareDownloadDirs(storeRoot: string, paths: LibStoreDownloadPaths): Promise<Result<void, LibStoreDownloadError>> {
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
 * The tag resolves to a manifest digest one time at the start, then every fetch uses digests only, so a
 * moved `latest` cannot mix two versions in one store. When a receipt already pins the resolved manifest,
 * the pull is a no-op (`up_to_date`); when it pins a different one, the pull reports `update_available`
 * and downloads nothing, unless `deps.force` says the user agreed to the update. Otherwise it downloads
 * and verifies each layer, stages, merges into the store root, and writes the receipt last. The merge
 * keeps every locally provisioned package and farm — refer to {@link mergeStagedRoot}.
 */
export async function downloadLibStore(deps: LibStoreDownloadDeps): Promise<Result<LibStoreDownloadOutcome, LibStoreDownloadError>> {
    const archResult = deps.arch !== undefined ? ok<StoreArch, LibStoreDownloadError>(deps.arch) : resolveStoreArch(process.arch);
    if (archResult.isErr()) return err(archResult.error);
    const arch = archResult.value;
    const doFetch = deps.fetch ?? fetch;
    const reference = `latest-${arch}`;

    reportProgress(deps.onProgress, { type: "resolving" });
    const token = await fetchAnonymousToken(doFetch);
    if (token.isErr()) return err(token.error);
    const manifest = await resolveManifest(doFetch, reference, token.value);
    if (manifest.isErr()) return err(manifest.error);
    // Reported before the receipt comparison below, so a resolve that transfers nothing still tells the
    // caller which manifest the registry serves now. That digest is what an installed receipt is compared
    // against, thus it is how a reader with no network learns that an update is available.
    reportProgress(deps.onProgress, {
        type: "manifest_resolved",
        manifestDigest: manifest.value.manifestDigest,
        totalBytes: manifest.value.layers.reduce((sum, layer) => sum + layer.size, 0),
        totalLayers: manifest.value.layers.length,
    });

    const paths = libStoreDownloadPaths(deps.storeRoot);
    const receiptRead = await readLibStoreReceipt(paths.receipt);
    const installed = receiptRead.receipt;
    if (installed !== undefined && deps.force !== true) {
        if (installed.manifestDigest === manifest.value.manifestDigest) return ok({ type: "up_to_date", manifestDigest: installed.manifestDigest });
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
    const staged = await stageAndMerge(deps.storeRoot, paths, manifest.value.layers, attemptId);
    if (staged.isErr()) return err(staged.error);

    const receipt: LibStoreReceipt = {
        version: RECEIPT_VERSION,
        manifestDigest: manifest.value.manifestDigest,
        reference,
        arch,
        activatedAt: (deps.now?.() ?? new Date()).toISOString(),
        layers: manifest.value.layers,
    };
    const written = await writeLibStoreReceipt(paths.receipt, receipt);
    if (written.isErr()) return err(written.error);

    // The blobs are consumed once staged, and the receipt is now durable, so dropping them frees a second
    // copy of the whole store. Nothing resumes from them after this point.
    await rm(paths.blobs, { recursive: true, force: true }).catch(() => undefined);
    return ok({ type: "downloaded", manifestDigest: manifest.value.manifestDigest, bytes, merge: staged.value });
}

// --- the detached download process --------------------------------------------
//
// One process transfers the catalog, and it outlives the command that started it. The state of that
// process lives in one database row; the liveness of that process comes from one instance lock. The two
// together answer every question a reader has, and neither needs a heartbeat or a clock.

/**
 * The manifest digest the receipt pins, or `null` when the store carries no valid receipt.
 *
 * This is the installed half of the update comparison. The other half is the digest the last resolve
 * recorded on the row. When the two differ, an update is available — and that is the only way a reader
 * with no network learns it.
 */
export async function installedLibStoreManifest(storeRoot: string): Promise<string | null> {
    const read = await readLibStoreReceipt(libStoreDownloadPaths(storeRoot).receipt);
    return read.receipt?.manifestDigest ?? null;
}

/** The lifecycle of the one downloader, as any reader sees it. */
export type LibStoreDownloadReport = {
    /** The row as it stands, or `null` when no download ever ran on this machine. */
    readonly row: LibStoreDownloadRow | null;
    /**
     * The state a reader must act on, which is NOT always `row.state`. A row that reports `running` with
     * no live holder reads as `failed`: a killed process writes no failure row, thus the lock is the only
     * sound signal that the run is over. `null` means that no download ran.
     */
    readonly state: LibStoreDownloadStatus | null;
    /** True while a downloader holds the lock. `inflexa store add` refuses through this, and a second start yields to it. */
    readonly live: boolean;
    /** The pid of the live downloader, or `null`. A cancel signals exactly this process. */
    readonly holderPid: number | null;
};

/**
 * Read the lifecycle of the one downloader: the row, corrected by the liveness of the lock holder.
 *
 * A read failure degrades to "no download ran" rather than an error. The database is a file on the
 * machine of the user, and a store with a valid receipt is usable whatever this row says — a hard
 * failure here would refuse a store that works.
 */
export function readLibStoreDownloadReport(): LibStoreDownloadReport {
    const holderPid = instanceLockHolder(LIB_STORE_DOWNLOAD_LOCK_KEY);
    const row = getLibStoreDownload().unwrapOr(null);
    if (row === null) return { row: null, state: null, live: false, holderPid };
    const started = row.state === "pending" || row.state === "running";
    const live = started && holderPid !== null;
    // A `pending` row belongs to a starter that has not yet spawned, or to a process that died before it
    // took the lock. Neither is live, and only the second is a failure — but the two are indistinguishable
    // from here, so `pending` keeps its own state and only `running` degrades.
    const state = row.state === "running" && holderPid === null ? "failed" : row.state;
    return { row, state, live, holderPid };
}

/** What a start attempt did. Only `started` puts a process on the machine. */
export type LibStoreDownloadStart =
    | { readonly type: "started"; readonly pid: number }
    | { readonly type: "already_running"; readonly report: LibStoreDownloadReport }
    | { readonly type: "up_to_date"; readonly manifestDigest: string }
    | { readonly type: "update_available"; readonly installedDigest: string; readonly latestDigest: string };

/**
 * The argv that runs this CLI again. A dev run has no compiled binary, so the source entry is executed by
 * the `bun` runtime; a release binary IS the `inflexa` executable. This module lives at
 * `src/modules/libs/`, thus the CLI source entry is three levels up.
 */
function selfInvocation(argv: readonly string[]): string[] {
    return env.isDevelopment ? [process.execPath, join(import.meta.dir, "../../index.ts"), ...argv] : [process.execPath, ...argv];
}

/**
 * Start the detached downloader, or report why no process was necessary.
 *
 * The command that calls this exits at once. The child is `.unref()`ed and its output is discarded, so
 * it holds no event loop and it writes nothing to the terminal of the starter — the row is where it
 * reports, and `inflexa store ls` is where a user reads it.
 *
 * The resolve happens HERE and not in the child for the two cases that must answer synchronously. A
 * receipt that pins the manifest the registry serves now means the store is up to date, and a receipt
 * that pins a different one means an update is available. Neither starts a transfer, and `update` is the
 * consent that applies the moved tag. With no receipt there is nothing to compare, thus the start needs
 * no network at all.
 */
export async function startLibStoreDownloadProcess(params: {
    readonly storeRoot: string;
    readonly update: boolean;
    /** Fetch implementation for the resolve; defaults to the runtime fetch. Injected by a test. */
    readonly fetch?: FetchLike;
    /** The architecture to resolve; defaults to the host architecture. Injected by a test. */
    readonly arch?: StoreArch;
    /** Put the detached child on the machine and report its pid. Injected by a test, so no test ever spawns one. */
    readonly spawn?: (cmd: readonly string[]) => number;
}): Promise<Result<LibStoreDownloadStart, LibStoreDownloadError>> {
    const report = readLibStoreDownloadReport();
    // The lock gives single-flight for free: one live holder means one downloader, and this start yields.
    if (report.live) return ok({ type: "already_running", report });

    if ((await inspectLibStoreDownload(params.storeRoot)) === "installed") {
        // A valid receipt is there, thus this call resolves the manifest and transfers nothing whatever the
        // outcome — `downloadLibStore` short-circuits on a present receipt when `force` is absent.
        const resolved = await downloadLibStore({
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

    // `pending` before the spawn, so a reader between the write and the child taking the lock sees a run
    // that is starting rather than the terminal state the last run left. Discarded on failure: the row is
    // a readout, and a database this process cannot write must not stop the transfer from happening.
    startLibStoreDownloadRun({ state: "pending", holderPid: null }).unwrapOr(undefined);
    const cmd = selfInvocation(["store", "download", ...(params.update ? ["--update"] : []), DETACHED_TRANSFER_FLAG]);
    try {
        return ok({ type: "started", pid: (params.spawn ?? spawnDetached)(cmd) });
    } catch (cause) {
        const message = `Could not start the package-store downloader. Run \`inflexa store download\` again.`;
        settleLibStoreDownload({ state: "failed", message }).unwrapOr(undefined);
        return err({ type: "io_failed", message, cause });
    }
}

/**
 * The flag that tells the child to move the bytes itself rather than start a third process.
 *
 * The registry (`src/cli/index.ts`) declares the same spelling as a hidden option on `store download`,
 * because a command registry that imported this module would give up its lazy-import discipline for one
 * string. `store_download.test.ts` pins the two spellings against each other.
 */
export const DETACHED_TRANSFER_FLAG = "--run-transfer";

/**
 * Put the child on the machine and report its pid.
 *
 * `.unref()` and the ignored streams are what make it detached: it holds no event loop of the starter, it
 * writes nothing to the terminal of the starter, and it survives that exit. The same pattern as
 * `lib/open_external.ts`.
 */
function spawnDetached(cmd: readonly string[]): number {
    const child = Bun.spawn({ cmd: [...cmd], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
    return child.pid;
}

/** Record the two exact totals when the manifest resolves, and ignore every other event. */
function recordResolvedManifest(event: LibStoreDownloadProgress): void {
    if (event.type !== "manifest_resolved") return;
    // The write is discarded on failure, and that is deliberate: the row is a progress readout, thus a
    // database this process cannot write must never abort a transfer that is otherwise succeeding.
    recordLibStoreDownloadManifest({
        manifestDigest: event.manifestDigest,
        totalBytes: event.totalBytes,
        totalLayers: event.totalLayers,
    }).unwrapOr(undefined);
}

/**
 * How often the live transfer writes its running counts.
 *
 * A multi-gigabyte transfer emits a byte event for every chunk, which is many thousands of events. One
 * row write for each of them would be pure waste for a readout that a user reads at a human rate. Every
 * layer edge writes regardless, so the recorded counts are exact at each layer boundary.
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
 * A disk that ran out gets the two figures a user needs to act. A bare "no space left" tells nobody how
 * much disk to free, and the manifest already declares exactly how much the transfer still wants.
 */
async function describeTransferFailure(error: LibStoreDownloadError, storeRoot: string, remaining: number | null): Promise<string> {
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
 * This is the body of the detached child. It takes the lock first, because the lock is what makes the run
 * visible as live to every other process — a run that wrote `running` without it would read as failed at
 * once. A start that loses the race writes nothing and returns, thus two children can never both transfer.
 */
export async function runLibStoreTransfer(params: {
    readonly storeRoot: string;
    readonly update: boolean;
    /** Fetch implementation for the transfer; defaults to the runtime fetch. Injected by a test. */
    readonly fetch?: FetchLike;
    /** Retry schedule for a blob GET; defaults to the module schedule. Injected by a test, so a failure fails at once. */
    readonly retry?: DownloadRetry;
    /** The architecture to transfer; defaults to the host architecture. Injected by a test. */
    readonly arch?: StoreArch;
}): Promise<void> {
    const lock = acquireInstanceLock(LIB_STORE_DOWNLOAD_LOCK_KEY);
    if (!lock.acquired) return;
    startLibStoreDownloadRun({ state: "running", holderPid: process.pid }).unwrapOr(undefined);

    let totalBytes: number | null = null;
    let completedBytes = 0;
    let inFlightBytes = 0;
    let layersCompleted = 0;
    let lastWrite = 0;
    const writeProgress = (force: boolean): void => {
        const now = Date.now();
        if (!force && now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
        lastWrite = now;
        recordLibStoreDownloadProgress({ bytesTransferred: completedBytes + inFlightBytes, layersCompleted }).unwrapOr(undefined);
    };

    try {
        const result = await downloadLibStore({
            storeRoot: params.storeRoot,
            force: params.update,
            ...(params.fetch === undefined ? {} : { fetch: params.fetch }),
            ...(params.retry === undefined ? {} : { retry: params.retry }),
            ...(params.arch === undefined ? {} : { arch: params.arch }),
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
                    default:
                        return;
                }
            },
        });

        if (result.isErr()) {
            // The staged tree is per-attempt debris that no retry reads, and a disk that ran out is exactly
            // the case where leaving it costs the user the space they must free. The blob cache stays: a
            // layer that completed is worth keeping, and the next run verifies each cached blob by digest.
            await rm(libStoreDownloadPaths(params.storeRoot).staging, { recursive: true, force: true }).catch(() => undefined);
            const remaining = totalBytes === null ? null : Math.max(0, totalBytes - completedBytes - inFlightBytes);
            const message = await describeTransferFailure(result.error, params.storeRoot, remaining);
            settleLibStoreDownload({ state: "failed", message }).unwrapOr(undefined);
            return;
        }

        // Each ok outcome leaves the published bytes on disk: `downloaded` activated them, and the two
        // no-op outcomes mean a receipt already pins them. Whether the active farm is one a sandbox can
        // mount is a separate question, which the sandbox gate asks against the filesystem.
        writeProgress(true);
        settleLibStoreDownload({ state: "installed", message: null }).unwrapOr(undefined);
    } finally {
        releaseInstanceLock(LIB_STORE_DOWNLOAD_LOCK_KEY);
    }
}

/** What a cancel did. `no_run` is a normal answer, not a failure: a cancel of nothing changes nothing. */
export type LibStoreDownloadCancel = { readonly type: "canceled"; readonly holderPid: number } | { readonly type: "no_run" };

/** How long the cancel waits for the signalled downloader to go away before it drops the staged tree. */
const CANCEL_EXIT_WAIT_MS = 3000;

/** How often the cancel tests whether the signalled downloader is gone. */
const CANCEL_POLL_MS = 50;

/**
 * Stop the live transfer, record `canceled`, and remove the partial staged tree.
 *
 * The downloader is detached, thus it outlives both `inflexa setup` and the app, and a command is the
 * only thing that reaches it from another terminal. The signal is SIGTERM and the wait is bounded: the
 * staged tree is dropped only after the holder is gone, so a rename that is in flight is never raced.
 *
 * It removes NO installed content. The staged tree is per-attempt debris under the installer-owned
 * metadata directory, and each child that the store root holds stays where it is.
 */
export async function cancelLibStoreDownload(storeRoot: string): Promise<LibStoreDownloadCancel> {
    const report = readLibStoreDownloadReport();
    if (!report.live || report.holderPid === null) return { type: "no_run" };
    const holderPid = report.holderPid;
    try {
        process.kill(holderPid, "SIGTERM");
    } catch {
        // The process went away between the probe and the signal. The cleanup below is what matters.
    }
    for (let waited = 0; waited < CANCEL_EXIT_WAIT_MS; waited += CANCEL_POLL_MS) {
        if (instanceLockHolder(LIB_STORE_DOWNLOAD_LOCK_KEY) === null) break;
        await Promise.sleep(CANCEL_POLL_MS);
    }
    await rm(libStoreDownloadPaths(storeRoot).staging, { recursive: true, force: true }).catch(() => undefined);
    settleLibStoreDownload({ state: "canceled", message: null }).unwrapOr(undefined);
    return { type: "canceled", holderPid };
}
