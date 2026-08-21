import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";

import type { DownloadRetry, FetchLike } from "../../lib/download.ts";
import { env } from "../../lib/env.ts";
import { instanceLockPath, PACKAGE_STORE_METADATA_LOCK_KEY } from "../../lib/lock.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { downloadPackageStore, storeDownloadPaths, type StoreDownloadOutcome } from "./store_download.ts";

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

type FakeLayer = { readonly bytes: Uint8Array; readonly digest: string; readonly mediaType: string; readonly size: number };

/** Build one layer blob: a tree on disk, one tar over its top entries, then one zstd frame. */
async function makeLayerBlob(mediaType: string, build: (root: string) => void): Promise<FakeLayer> {
    const root = tempDir("inflexa-layer-");
    build(root);
    const proc = Bun.spawn(["tar", "-cf", "-", "-C", root, ...readdirSync(root)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [tar, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    expect(code).toBe(0);
    const bytes = new Uint8Array(zstdCompressSync(Buffer.from(tar)));
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    return { bytes, digest, mediaType, size: bytes.byteLength };
}

/**
 * The two layers of one published catalog version. Version 2 differs in every
 * record an update moves: the pool gains a directory, and the graph changes.
 */
async function catalogLayers(version: 1 | 2): Promise<readonly FakeLayer[]> {
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
    });
    return [track, base];
}

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
        ...(force === undefined ? {} : { force }),
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
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    // The mutex releases in a finally, thus this only sweeps the record of a crashed test.
    rmSync(instanceLockPath(PACKAGE_STORE_METADATA_LOCK_KEY), { force: true });
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
        const paths = storeDownloadPaths(storeRoot);
        const receipt = JSON.parse(readFileSync(paths.receipt, "utf8")) as { manifestDigest: string };
        expect(receipt.manifestDigest).toBe(registry.manifestDigest);
        // The receipt is durable, thus the second copy of the store in the blob cache is dropped.
        expect(existsSync(paths.blobs)).toBe(false);
    });

    test("a second download over a valid receipt resolves the manifest and transfers nothing", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const registry = makeRegistry(await catalogLayers(1));
        expectDownloaded((await download(storeRoot, registry))._unsafeUnwrap());

        const again = (await download(storeRoot, registry))._unsafeUnwrap();

        expect(again).toEqual({ type: "up_to_date", manifestDigest: registry.manifestDigest });
        for (const count of registry.blobGets.values()) expect(count).toBe(1);
    });

    test("a moved tag reports the update, and it downloads nothing without the consent", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const registryV1 = makeRegistry(await catalogLayers(1));
        expectDownloaded((await download(storeRoot, registryV1))._unsafeUnwrap());

        const registryV2 = makeRegistry(await catalogLayers(2));
        const outcome = (await download(storeRoot, registryV2))._unsafeUnwrap();

        expect(outcome).toEqual({ type: "update_available", installedDigest: registryV1.manifestDigest, latestDigest: registryV2.manifestDigest });
        expect(registryV2.blobGets.size).toBe(0);
        // The report applies nothing: the graph and the pool stay at version 1.
        expect(readFileSync(join(storeRoot, "deps.json"), "utf8")).toBe(JSON.stringify({ catalog: 1 }));
        expect(existsSync(join(storeRoot, "store", BETA))).toBe(false);
    });

    test("the update consent replaces the graph whole, and the merge removes nothing", async () => {
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
        // The pool merge is add-only: version 1 and the local acquisition stay, version 2 joins.
        expect(existsSync(join(storeRoot, "store", ALPHA))).toBe(true);
        expect(existsSync(join(storeRoot, "store", LOCAL))).toBe(true);
        expect(existsSync(join(storeRoot, "store", BETA))).toBe(true);
        // Each farm of the user is kept whole, the catalog farm included.
        expect(outcome.merge.farmsKept).toEqual(["catalog"]);
        expect(readFileSync(join(storeRoot, "farms", "my-analysis", "marker.txt"), "utf8")).toBe("mine\n");
        expect(readFileSync(join(storeRoot, "farms", "catalog", "user-note.txt"), "utf8")).toBe("note\n");
        expect(readFileSync(join(storeRoot, "farms", "catalog", "inflexa.lock"), "utf8")).toBe("catalog-v1\n");
        const receipt = JSON.parse(readFileSync(storeDownloadPaths(storeRoot).receipt, "utf8")) as { manifestDigest: string };
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

    test("a failed transfer keeps the verified blobs, and the next run fetches only the missing layer", async () => {
        const storeRoot = tempDir("inflexa-store-dl-");
        const layers = await catalogLayers(1);
        const registry = makeRegistry(layers);
        const [track, base] = layers as [FakeLayer, FakeLayer];
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
