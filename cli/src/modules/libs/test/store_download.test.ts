import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    closeSync,
    constants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import { z } from "zod";

import { recordTransferProgress, startTransferRun } from "../../../db/primary_mutation.ts";
import { getTransfer } from "../../../db/primary_query.ts";
import type { DownloadRetry, FetchLike } from "../../../lib/download.ts";
import { env } from "../../../lib/env.ts";
import { instanceLockPath, PACKAGE_STORE_METADATA_LOCK_KEY } from "../../../lib/lock.ts";
import { freshDb } from "../../../test_support/db.ts";
import { assertTestSandbox } from "../../../test_support/sandbox.ts";
import type { TransferRow } from "../../../types/store.ts";
import { downloadPackageStore, inspectStoreContent, runCatalogTransfer, storeDownloadPaths, type StoreDownloadOutcome } from "../store_download.ts";
import { transferLockKey } from "../transfers.ts";

// The scenarios of the `package-store-download` spec, against a fake registry on
// the fetch seam. The layers are real zstd-compressed tars, because the module
// extracts with the system `tar` and a stub archive would prove nothing.

/** The two layer media types, as the module accepts them. The module keeps them private, thus the test restates them. */
const TRACK_MEDIA_TYPE = "application/vnd.inflexa.package-store.track.v1.tar+zstd";
const BASE_MEDIA_TYPE = "application/vnd.inflexa.package-store.base.v1.tar+zstd";

/** A pool directory the catalog publishes. The name shape matches the store contract: name-version-hash. */
const ALPHA = "alpha-1.2.0-000000000000aaaa";
/** A pool directory only the second catalog version holds, thus it marks an applied update. */
const BETA = "beta-0.4.1-000000000000bbbb";
/** A pool directory the user acquired locally. The download must never remove it. */
const LOCAL = "localpkg-9.9-00000000000ff001";

/** One attempt, no backoff: a test failure must fail at once, not after the production schedule. */
const FAST_RETRY: DownloadRetry = { attempts: 1, baseMs: 0, shouldRetry: () => false };

const created: string[] = [];

function tempDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    created.push(root);
    return root;
}

type FakeLayer = { readonly bytes: Uint8Array<ArrayBuffer>; readonly digest: string; readonly mediaType: string; readonly size: number };

/** Build the tar of one layer: a tree on disk, then one tar over its top entries. */
async function makeLayerTar(build: (root: string) => void): Promise<Buffer> {
    const root = tempDir("inflexa-layer-");
    build(root);
    const proc = Bun.spawn(["tar", "-cf", "-", "-C", root, ...readdirSync(root)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [tar, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    expect(code).toBe(0);
    return Buffer.from(tar);
}

/** Describe one layer blob to the fake registry: its digest, its media type, and its size. */
function describeLayer(bytes: Uint8Array<ArrayBuffer>, mediaType: string): FakeLayer {
    return { bytes, digest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`, mediaType, size: bytes.byteLength };
}

/** Build one layer blob: the tar of a tree on disk, in one zstd frame. */
async function makeLayerBlob(mediaType: string, build: (root: string) => void): Promise<FakeLayer> {
    return describeLayer(new Uint8Array(zstdCompressSync(await makeLayerTar(build))), mediaType);
}

/**
 * The two layers of one published catalog version. Version 2 differs in every
 * record an update moves: the pool gains a directory, and the graph and the
 * image record change.
 */
async function catalogLayers(version: 1 | 2): Promise<readonly [FakeLayer, FakeLayer]> {
    const track = await makeLayerBlob(TRACK_MEDIA_TYPE, (root) => {
        mkdirSync(join(root, "store", ALPHA), { recursive: true });
        writeFileSync(join(root, "store", ALPHA, "content.txt"), "alpha\n");
        if (version === 2) {
            mkdirSync(join(root, "store", BETA), { recursive: true });
            writeFileSync(join(root, "store", BETA, "content.txt"), "beta\n");
        }
    });
    const base = await makeLayerBlob(BASE_MEDIA_TYPE, (root) => {
        mkdirSync(join(root, "farms", "catalog"), { recursive: true });
        writeFileSync(join(root, "farms", "catalog", "inflexa.lock"), `catalog-v${version}\n`);
        writeFileSync(join(root, "deps.json"), JSON.stringify({ catalog: version }));
        writeFileSync(join(root, "image-packages.json"), JSON.stringify({ image: version }));
    });
    return [track, base];
}

/**
 * One layer whose blob is a CHAIN of small zstd frames, plus the frames themselves.
 *
 * A decompressor writes out the content of each frame as that frame arrives. Thus a test that feeds
 * the frames one at a time drives a decompress that is slow and alive at the same time, which is the
 * state the unpacking heartbeat reports. One frame over the whole tar cannot do this: its output
 * arrives in one burst.
 */
async function makeFramedLayer(
    mediaType: string,
    build: (root: string) => void,
    frameCount: number,
): Promise<{ readonly layer: FakeLayer; readonly frames: readonly Uint8Array[] }> {
    const tar = await makeLayerTar(build);
    const sliceBytes = Math.ceil(tar.byteLength / frameCount);
    const frames: Uint8Array[] = [];
    for (let start = 0; start < tar.byteLength; start += sliceBytes) {
        frames.push(new Uint8Array(zstdCompressSync(tar.subarray(start, start + sliceBytes))));
    }
    return { layer: describeLayer(new Uint8Array(Buffer.concat(frames)), mediaType), frames };
}

/** The path of one cached blob. The digest becomes the file stem with its colon swapped, per the module's naming. */
function blobPath(storeRoot: string, digest: string): string {
    return join(storeDownloadPaths(storeRoot).blobs, `${digest.replace(":", "-")}.tar.zst`);
}

/** The writer ends the tests hold open. A pipe with no writer reads as an end of file, thus the fd is the whole stall. */
const writers = new Set<number>();

/**
 * Replace a downloaded blob with a named pipe, and give back a writer end of it.
 *
 * A pipe is the one source a test can hold silent: a file always reads to its end, thus a decompress
 * over a file never stops part way. `O_RDWR` opens the writer end with no reader present, thus
 * neither the open nor a small write of the test blocks the process.
 */
function pipeBlob(path: string): number {
    rmSync(path, { force: true });
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    const fd = openSync(path, constants.O_RDWR);
    writers.add(fd);
    return fd;
}

/** Close one writer end, at most one time. The reader then reaches the end of the file. */
function closeWriter(fd: number): void {
    if (writers.delete(fd)) closeSync(fd);
}

const receiptDigestSchema = z.object({ manifestDigest: z.string() });

type FakeRegistry = {
    readonly fetch: FetchLike;
    readonly manifestDigest: string;
    /** Blob GET count for each layer digest. A digest with no entry was never fetched. */
    readonly blobGets: Map<string, number>;
    /** Digests that answer HTTP 503. Mutable, thus a test heals the registry between two runs. */
    readonly failing: Set<string>;
};

/** A registry that serves the token, one manifest, and the layer blobs, and that counts each blob GET. */
function makeRegistry(layers: readonly FakeLayer[]): FakeRegistry {
    const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
            schemaVersion: 2,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            layers: layers.map((layer) => ({ mediaType: layer.mediaType, digest: layer.digest, size: layer.size })),
        }),
    );
    const manifestDigest = `sha256:${new Bun.CryptoHasher("sha256").update(manifestBytes).digest("hex")}`;
    const blobGets = new Map<string, number>();
    const failing = new Set<string>();
    const doFetch: FetchLike = (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/token")) return Promise.resolve(Response.json({ token: "test-token" }));
        if (url.includes("/manifests/")) {
            // The module must resolve the arch tag the test pins, never the tag of the host.
            expect(url.endsWith("/manifests/latest-arm64")).toBe(true);
            return Promise.resolve(new Response(manifestBytes));
        }
        const layer = layers.find((candidate) => url.endsWith(`/blobs/${candidate.digest}`));
        if (layer === undefined) return Promise.resolve(new Response("no such blob", { status: 404, statusText: "Not Found" }));
        blobGets.set(layer.digest, (blobGets.get(layer.digest) ?? 0) + 1);
        if (failing.has(layer.digest)) return Promise.resolve(new Response("shed", { status: 503, statusText: "Service Unavailable" }));
        return Promise.resolve(new Response(layer.bytes));
    };
    return { fetch: doFetch, manifestDigest, blobGets, failing };
}

function download(storeRoot: string, registry: FakeRegistry, force?: boolean): ReturnType<typeof downloadPackageStore> {
    return downloadPackageStore({
        storeRoot,
        arch: "arm64",
        fetch: registry.fetch,
        retry: FAST_RETRY,
        force,
    });
}

/** Narrow an outcome to `downloaded`, because the merge report exists on that variant only. */
function expectDownloaded(outcome: StoreDownloadOutcome): Extract<StoreDownloadOutcome, { type: "downloaded" }> {
    if (outcome.type !== "downloaded") throw new Error(`expected a downloaded outcome, got ${outcome.type}`);
    return outcome;
}

beforeEach(() => {
    // The graph merge takes the metadata mutex under `env.locksDir`, thus the sandbox
    // guard must pass before any test runs. Refer to `test_support/sandbox.ts`.
    assertTestSandbox(env.locksDir);
});

afterEach(() => {
    // A pipe that keeps a writer end open also keeps a blocked read of the module pending, thus the
    // close comes before the directory that holds the pipe goes away.
    for (const fd of writers) closeSync(fd);
    writers.clear();
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    // The mutex releases in a finally, thus this only sweeps the record of a crashed test.
    rmSync(instanceLockPath(PACKAGE_STORE_METADATA_LOCK_KEY), { force: true });
    // The lock of the transfer releases in a finally too. A record that stays would make the next
    // run yield to this process, and the transfer of that test would then do nothing at all.
    rmSync(instanceLockPath(transferLockKey("catalog")), { force: true });
});

describe("downloadPackageStore", () => {
    test("the first download activates the store, and the receipt pins the manifest", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const registry = makeRegistry(await catalogLayers(1));

        const outcome = expectDownloaded((await download(storeRoot, registry))._unsafeUnwrap());

        expect(outcome.manifestDigest).toBe(registry.manifestDigest);
        expect(outcome.merge.storeDirsAdded).toEqual([ALPHA]);
        expect(outcome.merge.farmsAdded).toEqual(["catalog"]);
        expect(readFileSync(join(storeRoot, "store", ALPHA, "content.txt"), "utf8")).toBe("alpha\n");
        expect(readFileSync(join(storeRoot, "deps.json"), "utf8")).toBe(JSON.stringify({ catalog: 1 }));
        // The image record rides in with the graph, thus the inventory tool reads the image the
        // catalog was proven beside from the store root.
        expect(readFileSync(join(storeRoot, "image-packages.json"), "utf8")).toBe(JSON.stringify({ image: 1 }));
        const paths = storeDownloadPaths(storeRoot);
        const receipt = receiptDigestSchema.parse(JSON.parse(readFileSync(paths.receipt, "utf8")));
        expect(receipt.manifestDigest).toBe(registry.manifestDigest);
        // The receipt is durable, thus the second copy of the store in the blob cache is dropped.
        expect(existsSync(paths.blobs)).toBe(false);
        // The artifact packs no mountpoint entry, and runc refuses a nested bind without one, thus
        // the download makes the three entries at the root it landed.
        for (const entry of ["farm", "current", "cache"]) expect(statSync(join(storeRoot, entry)).isDirectory()).toBe(true);
    });

    test("a second download over a valid receipt resolves the manifest and transfers nothing", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const registry = makeRegistry(await catalogLayers(1));
        expectDownloaded((await download(storeRoot, registry))._unsafeUnwrap());
        // A root that a download landed before the entries existed looks like this one.
        rmSync(join(storeRoot, "farm"), { recursive: true });

        const again = (await download(storeRoot, registry))._unsafeUnwrap();

        expect(again).toEqual({ type: "up_to_date", manifestDigest: registry.manifestDigest });
        for (const count of registry.blobGets.values()) expect(count).toBe(1);
        // The no-op run still owns the root, thus it restores the entry it found missing.
        for (const entry of ["farm", "current", "cache"]) expect(statSync(join(storeRoot, entry)).isDirectory()).toBe(true);
    });

    test("a moved tag reports the update, and it downloads nothing without the consent", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const registryV1 = makeRegistry(await catalogLayers(1));
        expectDownloaded((await download(storeRoot, registryV1))._unsafeUnwrap());

        // A root that a download landed before the entries existed looks like this one.
        rmSync(join(storeRoot, "farm"), { recursive: true });

        const registryV2 = makeRegistry(await catalogLayers(2));
        const outcome = (await download(storeRoot, registryV2))._unsafeUnwrap();

        expect(outcome).toEqual({ type: "update_available", installedDigest: registryV1.manifestDigest, latestDigest: registryV2.manifestDigest });
        expect(registryV2.blobGets.size).toBe(0);
        // The report applies nothing: the graph and the pool stay at version 1.
        expect(readFileSync(join(storeRoot, "deps.json"), "utf8")).toBe(JSON.stringify({ catalog: 1 }));
        expect(existsSync(join(storeRoot, "store", BETA))).toBe(false);
        // The run keeps the installed root, thus it restores the entry it found missing.
        for (const entry of ["farm", "current", "cache"]) expect(statSync(join(storeRoot, entry)).isDirectory()).toBe(true);
    });

    test("the update replaces the graph, the image record, and the catalog farm, and keeps each farm of the user", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        expectDownloaded((await download(storeRoot, makeRegistry(await catalogLayers(1))))._unsafeUnwrap());
        // State a user builds between the two versions: a farm, a local acquisition,
        // and a note inside the published catalog farm.
        mkdirSync(join(storeRoot, "farms", "my-analysis"), { recursive: true });
        writeFileSync(join(storeRoot, "farms", "my-analysis", "marker.txt"), "mine\n");
        mkdirSync(join(storeRoot, "store", LOCAL), { recursive: true });
        writeFileSync(join(storeRoot, "farms", "catalog", "user-note.txt"), "note\n");

        const registryV2 = makeRegistry(await catalogLayers(2));
        const outcome = expectDownloaded((await download(storeRoot, registryV2, true))._unsafeUnwrap());

        // The graph replaces whole: no node-level merge of two resolved sets.
        expect(readFileSync(join(storeRoot, "deps.json"), "utf8")).toBe(JSON.stringify({ catalog: 2 }));
        // The image record travels WITH the graph: it names the image the new resolved set was
        // proven inside, and a kept record would describe an older image beside a newer catalog.
        expect(readFileSync(join(storeRoot, "image-packages.json"), "utf8")).toBe(JSON.stringify({ image: 2 }));
        // The pool merge is add-only: version 1 and the local acquisition stay, version 2 joins.
        expect(existsSync(join(storeRoot, "store", ALPHA))).toBe(true);
        expect(existsSync(join(storeRoot, "store", LOCAL))).toBe(true);
        expect(existsSync(join(storeRoot, "store", BETA))).toBe(true);
        // The catalog farm travels WITH the graph: the old closure names the
        // store directories of the old graph, and a kept catalog farm beside
        // the new graph refuses every farm-less compose. Content inside it is
        // publisher territory, thus the note goes with the old farm.
        expect(outcome.merge.farmsReplaced).toEqual(["catalog"]);
        expect(outcome.merge.farmsKept).toEqual([]);
        expect(readFileSync(join(storeRoot, "farms", "catalog", "inflexa.lock"), "utf8")).toBe("catalog-v2\n");
        expect(existsSync(join(storeRoot, "farms", "catalog", "user-note.txt"))).toBe(false);
        // The farm of the analysis is untouched.
        expect(readFileSync(join(storeRoot, "farms", "my-analysis", "marker.txt"), "utf8")).toBe("mine\n");
        const receipt = receiptDigestSchema.parse(JSON.parse(readFileSync(storeDownloadPaths(storeRoot).receipt, "utf8")));
        expect(receipt.manifestDigest).toBe(registryV2.manifestDigest);
    });

    test("a plain download over a local store merges around the farms of the user", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        // A store the user built with `store add`: content, and no receipt.
        mkdirSync(join(storeRoot, "store", LOCAL), { recursive: true });
        mkdirSync(join(storeRoot, "farms", "catalog"), { recursive: true });
        writeFileSync(join(storeRoot, "farms", "catalog", "user-note.txt"), "note\n");

        const outcome = expectDownloaded((await download(storeRoot, makeRegistry(await catalogLayers(1))))._unsafeUnwrap());

        expect(outcome.merge.storeDirsAdded).toEqual([ALPHA]);
        expect(outcome.merge.farmsAdded).toEqual([]);
        expect(outcome.merge.farmsKept).toEqual(["catalog"]);
        // A kept farm is kept whole: the published catalog content does not land inside it.
        expect(existsSync(join(storeRoot, "farms", "catalog", "inflexa.lock"))).toBe(false);
        expect(readFileSync(join(storeRoot, "farms", "catalog", "user-note.txt"), "utf8")).toBe("note\n");
        expect(existsSync(join(storeRoot, "store", LOCAL))).toBe(true);
    });

    test("a plain download keeps the image record that is present", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        // A record of an older catalog, with no receipt beside it. The merge runs, and without the
        // consent of `--update` each record that the root already holds stays as it is.
        writeFileSync(join(storeRoot, "image-packages.json"), JSON.stringify({ image: 0 }));

        expectDownloaded((await download(storeRoot, makeRegistry(await catalogLayers(1))))._unsafeUnwrap());

        expect(readFileSync(join(storeRoot, "image-packages.json"), "utf8")).toBe(JSON.stringify({ image: 0 }));
        // The rest of the catalog still merged around it.
        expect(readFileSync(join(storeRoot, "deps.json"), "utf8")).toBe(JSON.stringify({ catalog: 1 }));
    });

    test("a failed transfer keeps the verified blobs, and the next run fetches only the missing layer", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const layers = await catalogLayers(1);
        const registry = makeRegistry(layers);
        const [track, base] = layers;
        registry.failing.add(base.digest);

        const failed = await download(storeRoot, registry);
        expect(failed._unsafeUnwrapErr().type).toBe("download_failed");
        // The verified track blob sits in the digest-keyed cache. The digest becomes
        // the file stem with its colon swapped, per the module's blob naming.
        expect(existsSync(join(storeDownloadPaths(storeRoot).blobs, `${track.digest.replace(":", "-")}.tar.zst`))).toBe(true);

        registry.failing.delete(base.digest);
        const healed = expectDownloaded((await download(storeRoot, registry))._unsafeUnwrap());

        expect(healed.manifestDigest).toBe(registry.manifestDigest);
        // The cache hit skips the network: one GET ever for the track layer, two for the base layer.
        expect(registry.blobGets.get(track.digest)).toBe(1);
        expect(registry.blobGets.get(base.digest)).toBe(2);
        expect(existsSync(join(storeRoot, "store", ALPHA))).toBe(true);
    });
});

// The scenarios of the unpacking watch, against the same fake registry. Each one drives the child
// body in this process: it takes the transfer lock, writes the row, and settles it on every exit.

/** The fetch of `base`, with the token body and the manifest body replaced. The blob routes stay. */
function withBodies(base: FakeRegistry, bodies: { readonly token?: unknown; readonly manifest?: unknown }): FetchLike {
    return (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes("/token") && bodies.token !== undefined) return Promise.resolve(Response.json(bodies.token));
        if (url.includes("/manifests/") && bodies.manifest !== undefined) return Promise.resolve(Response.json(bodies.manifest));
        return base.fetch(input, init);
    };
}

describe("the tolerant readers of a registry answer", () => {
    const LAYER = { mediaType: TRACK_MEDIA_TYPE, digest: "sha256:abc", size: 7 };

    test.each([
        ["a manifest that is null", null, "The manifest was not an object."],
        ["a manifest that is an array", [], "The manifest declared no layers."],
        ["a manifest with an empty layer list", { layers: [] }, "The manifest declared no layers."],
        ["a layer that is null between valid layers", { layers: [LAYER, null, LAYER] }, "A manifest layer was not an object."],
        ["a layer that is an array", { layers: [LAYER, []] }, "A manifest layer lacked a media type, a digest, or a size."],
        ["a layer with a size that is a string", { layers: [LAYER, { ...LAYER, size: "7" }] }, "A manifest layer lacked a media type, a digest, or a size."],
        [
            "a layer with a digest that is missing",
            { layers: [{ mediaType: TRACK_MEDIA_TYPE, size: 7 }] },
            "A manifest layer lacked a media type, a digest, or a size.",
        ],
        [
            "a layer of an unexpected media type",
            { layers: [LAYER, { ...LAYER, mediaType: "text/plain" }] },
            "A manifest layer carried an unexpected media type: text/plain.",
        ],
    ])("%s gives manifest_failed with the same message", async (_name, manifest, message) => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const registry = makeRegistry(await catalogLayers(1));

        const result = await downloadPackageStore({ storeRoot, arch: "arm64", fetch: withBodies(registry, { manifest }), retry: FAST_RETRY });

        expect(result._unsafeUnwrapErr()).toEqual({ type: "manifest_failed", message });
    });

    test("a token answer reads from `access_token`, and an answer of another kind carries no token", async () => {
        const registry = makeRegistry(await catalogLayers(1));

        const named = await downloadPackageStore({
            storeRoot: tempDir("inflexa-store-dl-"),
            arch: "arm64",
            fetch: withBodies(registry, { token: { access_token: "t" } }),
            retry: FAST_RETRY,
        });
        expectDownloaded(named._unsafeUnwrap());

        for (const token of [[], "text", null, {}, { token: "" }]) {
            const refused = await downloadPackageStore({
                storeRoot: tempDir("inflexa-store-dl-"),
                arch: "arm64",
                fetch: withBodies(registry, { token }),
                retry: FAST_RETRY,
            });
            expect(refused._unsafeUnwrapErr().type).toBe("token_failed");
        }
    });

    describe("the receipt", () => {
        /** Land a real receipt, then give the text of the next one. */
        async function installedRoot(): Promise<{ readonly storeRoot: string; readonly receiptPath: string; readonly receipt: Record<string, unknown> }> {
            const storeRoot = tempDir("inflexa-store-dl-");
            expectDownloaded((await download(storeRoot, makeRegistry(await catalogLayers(1))))._unsafeUnwrap());
            const receiptPath = storeDownloadPaths(storeRoot).receipt;
            return { storeRoot, receiptPath, receipt: z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(receiptPath, "utf8"))) };
        }

        test("a receipt with a key beyond the known ones still reads as installed", async () => {
            const { storeRoot, receiptPath, receipt } = await installedRoot();
            writeFileSync(receiptPath, JSON.stringify({ ...receipt, note: "extra" }));

            expect(await inspectStoreContent(storeRoot)).toBe("installed");
        });

        test.each([
            ["text that is not JSON", () => "{"],
            ["JSON null", () => "null"],
            ["an array", () => "[]"],
            ["a version of another number", (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, version: 2 })],
            ["an arch outside the two that the store serves", (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, arch: "ppc64" })],
            ["an activation time that is a number", (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, activatedAt: 1 })],
            [
                "a layer that is null between valid layers",
                (receipt: Record<string, unknown>) =>
                    JSON.stringify({ ...receipt, layers: [{ mediaType: "m", digest: "d", size: 1 }, null, { mediaType: "m", digest: "d", size: 1 }] }),
            ],
            [
                "a layer with a size that is a string",
                (receipt: Record<string, unknown>) => JSON.stringify({ ...receipt, layers: [{ mediaType: "m", digest: "d", size: "1" }] }),
            ],
        ])("a receipt with %s reads as invalid, and the store content stays", async (_name, corrupt) => {
            const { storeRoot, receiptPath, receipt } = await installedRoot();
            writeFileSync(receiptPath, corrupt(receipt));

            expect(await inspectStoreContent(storeRoot)).toBe("invalid_receipt");
            expect(existsSync(join(storeRoot, "store", ALPHA))).toBe(true);
        });
    });
});

describe("runCatalogTransfer", () => {
    /** The transfer row as it stands, or `null` when no run wrote one. */
    function catalogRow(): TransferRow | null {
        return getTransfer("catalog").unwrapOr(null);
    }

    /** Whether the child still holds the lock of the catalog transfer. */
    function lockHeld(): boolean {
        return existsSync(instanceLockPath(transferLockKey("catalog")));
    }

    test("a decompress that stops for the window settles the row as failed, and the lock frees", async () => {
        freshDb();
        const storeRoot = tempDir("inflexa-store-dl-");
        const layers = await catalogLayers(1);
        const [track, base] = layers;
        const registry = makeRegistry(layers);
        // The swap rides the GET of the SECOND layer: the first blob is on disk and hashed by then,
        // and only the unpack reads it again. The head of a zstd frame carries no block, thus the
        // decompressor emits nothing at all and the counter reports nothing.
        const stalling: FetchLike = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.endsWith(`/blobs/${base.digest}`)) writeSync(pipeBlob(blobPath(storeRoot, track.digest)), Buffer.from(track.bytes.subarray(0, 4)));
            return registry.fetch(input, init);
        };

        await runCatalogTransfer({ storeRoot, update: false, fetch: stalling, retry: FAST_RETRY, arch: "arm64", unpackWindowMs: 200 });

        const row = catalogRow();
        expect(row?.state).toBe("failed");
        expect(row?.message).toContain(track.digest);
        expect(row?.message).toContain("unpacking");
        expect(lockHeld()).toBe(false);
    });

    test("a `tar` run that lives past its bound settles the row as failed, and it names the retry", async () => {
        freshDb();
        const storeRoot = tempDir("inflexa-store-dl-");
        // Enough members that no `tar` run over the archive can finish inside a millisecond: the
        // bound of this test is shorter than the start of the child, thus the kill is the only end.
        const layer = await makeLayerBlob(TRACK_MEDIA_TYPE, (root) => {
            mkdirSync(join(root, "store", ALPHA), { recursive: true });
            for (let member = 0; member < 400; member += 1) writeFileSync(join(root, "store", ALPHA, `member-${member}.txt`), "member\n");
        });
        const registry = makeRegistry([layer]);

        await runCatalogTransfer({ storeRoot, update: false, fetch: registry.fetch, retry: FAST_RETRY, arch: "arm64", tarBoundMs: 1 });

        const row = catalogRow();
        expect(row?.state).toBe("failed");
        expect(row?.message).toContain(layer.digest);
        expect(row?.message).toContain("unpacking");
        expect(row?.message).toContain("inflexa store download");
        expect(lockHeld()).toBe(false);
    });

    test("the unpacking heartbeat moves the row while the counts hold still", async () => {
        freshDb();
        const storeRoot = tempDir("inflexa-store-dl-");
        const framed = await makeFramedLayer(
            TRACK_MEDIA_TYPE,
            (root) => {
                mkdirSync(join(root, "store", ALPHA), { recursive: true });
                writeFileSync(join(root, "store", ALPHA, "content.txt"), "alpha\n".repeat(4000));
            },
            16,
        );
        const base = await makeLayerBlob(BASE_MEDIA_TYPE, (root) => {
            mkdirSync(join(root, "farms", "catalog"), { recursive: true });
            writeFileSync(join(root, "farms", "catalog", "inflexa.lock"), "catalog-v1\n");
        });
        const registry = makeRegistry([framed.layer, base]);

        const samples: TransferRow[] = [];
        const poll = setInterval(() => {
            const row = catalogRow();
            if (row !== null) samples.push(row);
        }, 40);
        // The phase as the row reads it while the bytes still move. A poll cannot catch this, because
        // the fake registry serves a layer faster than any interval reads the row.
        let phaseWhileBytesMove: TransferRow["phase"] | undefined;
        // The feed starts on the GET of the second layer, thus the frames arrive while the unpack of
        // the first layer reads the pipe. One frame each 100 ms outlives the write cadence of 500 ms.
        const slow: FetchLike = (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (url.endsWith(`/blobs/${base.digest}`)) {
                phaseWhileBytesMove = catalogRow()?.phase;
                const fd = pipeBlob(blobPath(storeRoot, framed.layer.digest));
                let next = 0;
                const feed = setInterval(() => {
                    if (next < framed.frames.length) {
                        writeSync(fd, Buffer.from(framed.frames[next]!));
                        next += 1;
                        return;
                    }
                    clearInterval(feed);
                    closeWriter(fd);
                }, 100);
            }
            return registry.fetch(input, init);
        };

        await runCatalogTransfer({ storeRoot, update: false, fetch: slow, retry: FAST_RETRY, arch: "arm64" });
        clearInterval(poll);

        expect(catalogRow()?.state).toBe("installed");
        const unpacking = samples.filter((row) => row.phase === "unpacking");
        // The phase write, and then the heartbeats that the byte counter drives.
        expect(new Set(unpacking.map((row) => row.updatedAt)).size).toBeGreaterThanOrEqual(3);
        // The meter never moves backward: the byte count of the phase is the count the last layer left.
        expect(new Set(unpacking.map((row) => row.bytesTransferred)).size).toBe(1);
        expect(phaseWhileBytesMove).toBe("download");
    });

    test("an image transfer carries no phase", () => {
        freshDb();
        startTransferRun("runtime_image", { state: "running", holderPid: process.pid }).unwrapOr(undefined);
        // The image child writes its counts and names no phase, exactly as `transfers.ts` does.
        recordTransferProgress("runtime_image", { bytesTransferred: 4096, layersCompleted: 2 }).unwrapOr(0);

        const row = getTransfer("runtime_image")._unsafeUnwrap();

        expect(row?.phase).toBeNull();
        expect(row?.bytesTransferred).toBe(4096);
    });
});
