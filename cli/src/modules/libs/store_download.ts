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
 * The gate that holds sandbox creation, the app-open trigger, the first-download consent, and the
 * update ask are the caller's wiring. This module gives the mechanisms they operate: the download, the
 * local state read ({@link inspectLibStoreDownload}), and the not-configured no-op
 * ({@link maybeDownloadLibStore}).
 */

import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";

import { downloadToFile, type DownloadError, type DownloadProgress, type DownloadRetry, type FetchLike } from "../../lib/download.ts";
import { sha256File } from "../../lib/hash.ts";
import type { LibStoreLocation } from "../harness/config.ts";

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

/** The cheap local state of the store download, read without the network. */
export type LibStoreDownloadState = "missing" | "incomplete" | "installed" | "invalid_receipt";

/** Why a store download could not complete. Each variant names one stage. */
export type LibStoreDownloadError =
    | { readonly type: "unsupported_arch"; readonly arch: string; readonly message: string }
    | { readonly type: "token_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "manifest_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "digest_mismatch"; readonly message: string; readonly expected: string; readonly actual: string }
    | { readonly type: "download_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "extract_failed"; readonly message: string; readonly cause?: unknown }
    | { readonly type: "io_failed"; readonly message: string; readonly cause?: unknown };

/**
 * What a download attempt produced. `not_configured` is the rollback state (no store root). `up_to_date`
 * means the receipt already pins the resolved manifest. `update_available` reports a moved tag WITHOUT
 * applying it, so the caller can ask before it downloads. `downloaded` is a completed, activated store.
 */
export type LibStoreDownloadOutcome =
    | { readonly type: "not_configured" }
    | { readonly type: "up_to_date"; readonly manifestDigest: string }
    | { readonly type: "update_available"; readonly installedDigest: string; readonly latestDigest: string }
    | { readonly type: "downloaded"; readonly manifestDigest: string; readonly bytes: number };

/**
 * A fire-and-forget progress notification for one store download. A layer event carries its digest,
 * because several layers transfer in sequence and an unattributed byte count would be ambiguous.
 */
export type LibStoreDownloadProgress =
    | { readonly type: "resolving" }
    | { readonly type: "layer_started"; readonly digest: string; readonly declaredBytes?: number }
    | { readonly type: "layer_bytes"; readonly digest: string; readonly bytes: number }
    | { readonly type: "layer_completed"; readonly digest: string; readonly bytes: number }
    | { readonly type: "staging" };

/** The seams the CLI composition edge supplies. Production passes only `storeRoot`; a test injects the rest. */
export type LibStoreDownloadDeps = {
    /** The store root from `resolveLibStore`; this module never re-derives it. */
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
        if (cached.isOk() && `sha256:${cached.value}` === layer.digest) return ok((await stat(dest)).size);
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
 * Extract one layer into the staged root.
 *
 * The layer is a zstd-compressed tar. `node:zlib` decompresses zstd in-runtime, so the stream is
 * inflated here and piped straight into the system `tar`, which restores every member and its symlinks
 * verbatim (the extractArchive precedent in `modules/embedding/llama_runtime.ts`). The stream form keeps
 * a multi-gigabyte layer off the heap.
 */
async function extractLayer(blobPath: string, stageRoot: string): Promise<Result<void, LibStoreDownloadError>> {
    try {
        const inflating = createReadStream(blobPath).pipe(createZstdDecompress());
        // `Readable.toWeb` yields the node stream/web ReadableStream that Bun.spawn's stdin consumes; the
        // cast bridges the node and DOM ReadableStream declarations, which describe the same runtime object.
        const proc = Bun.spawn(["tar", "-x", "-f", "-", "-C", stageRoot], {
            stdin: Readable.toWeb(inflating) as unknown as ReadableStream<Uint8Array>,
            stdout: "ignore",
            stderr: "pipe",
        });
        const code = await proc.exited;
        if (code !== 0) {
            const stderr = await new Response(proc.stderr).text();
            return err({ type: "extract_failed", message: `Extracting a store layer failed (tar exit ${code})${stderr ? `: ${stderr.trim()}` : ""}.` });
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "extract_failed", message: `Extracting a store layer failed: ${errorText(cause)}.`, cause });
    }
}

/**
 * Move each staged top-level entry into the store root, replacing what is there.
 *
 * The whole `/mnt/libs` tree lives directly at the store root — the harness reads `<root>/current` — so
 * the store cannot be swapped by one rename. Each entry is renamed individually, which is atomic on the
 * same filesystem, and `current` lands last: until it is in place a concurrent reader sees an obviously
 * incomplete store, never a `current` that points past absent content. The installer metadata directory
 * is never a staged entry, so it is left untouched.
 */
async function activateStagedRoot(stageRoot: string, storeRoot: string, metadataName: string): Promise<Result<void, LibStoreDownloadError>> {
    let entries: readonly string[];
    try {
        entries = (await readdir(stageRoot)).filter((name) => name !== metadataName);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not read the staged store at ${stageRoot}.`, cause });
    }
    const ordered = [...entries].sort((a, b) => (a === "current" ? 1 : b === "current" ? -1 : a.localeCompare(b)));
    try {
        for (const name of ordered) {
            const to = join(storeRoot, name);
            await rm(to, { recursive: true, force: true });
            await rename(join(stageRoot, name), to);
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not activate the staged store into ${storeRoot}.`, cause });
    }
}

/** Extract every layer into a fresh staging root, then activate it into the store root. */
async function stageAndActivate(
    storeRoot: string,
    paths: LibStoreDownloadPaths,
    layers: readonly LibStoreLayer[],
    attemptId: string,
): Promise<Result<void, LibStoreDownloadError>> {
    const attemptRoot = join(paths.staging, attemptId);
    try {
        await rm(attemptRoot, { recursive: true, force: true });
        await mkdir(attemptRoot, { recursive: true });
        for (const layer of layers) {
            const extracted = await extractLayer(join(paths.blobs, blobFileName(layer.digest)), attemptRoot);
            if (extracted.isErr()) return err(extracted.error);
        }
        return await activateStagedRoot(attemptRoot, storeRoot, paths.metadataName);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not stage the package store under ${storeRoot}.`, cause });
    } finally {
        // The activation rename moves the staged entries out, leaving the attempt dir behind; every attempt
        // gets a fresh id, so without this they accumulate.
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
 * rather than a false `installed`. With no receipt, a bare store root is a first run and leftover
 * content or a staging directory is an interrupted one — which reads back as incomplete, and the next
 * run repairs it.
 */
export async function inspectLibStoreDownload(storeRoot: string): Promise<LibStoreDownloadState> {
    if (!existsSync(storeRoot)) return "missing";
    const paths = libStoreDownloadPaths(storeRoot);
    const receiptRead = await readLibStoreReceipt(paths.receipt);
    if (receiptRead.exists && receiptRead.receipt === undefined) return "invalid_receipt";
    if (receiptRead.receipt !== undefined) return existsSync(join(storeRoot, "current")) ? "installed" : "incomplete";
    if (existsSync(join(storeRoot, "store")) || existsSync(join(storeRoot, "current")) || existsSync(paths.staging)) return "incomplete";
    return "missing";
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
 * and verifies each layer, stages, activates, and writes the receipt last.
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
    const staged = await stageAndActivate(deps.storeRoot, paths, manifest.value.layers, attemptId);
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
    return ok({ type: "downloaded", manifestDigest: manifest.value.manifestDigest, bytes });
}

/**
 * Download the store only when a store root is configured. This is the mechanism the app-open trigger
 * operates: with no store configured there is nothing to download and nothing to record, so the rollback
 * of a cleared config key is a clean no-op. The store root is the single value `resolveLibStore` gives —
 * never re-derived here.
 */
export async function maybeDownloadLibStore(
    location: LibStoreLocation,
    deps: Omit<LibStoreDownloadDeps, "storeRoot"> = {},
): Promise<Result<LibStoreDownloadOutcome, LibStoreDownloadError>> {
    if (!location.configured) return ok({ type: "not_configured" });
    return downloadLibStore({ storeRoot: location.path, ...deps });
}
