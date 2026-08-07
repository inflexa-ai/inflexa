import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Result } from "neverthrow";

import type { FetchLike } from "../../lib/download.ts";
import {
    downloadLibStore,
    inspectLibStoreDownload,
    libStoreDownloadPaths,
    resolveStoreArch,
    type LibStoreDownloadError,
    type LibStoreDownloadOutcome,
} from "./store_download.ts";

const TRACK_MEDIA_TYPE = "application/vnd.inflexa.lib-store.track.v1.tar+zstd";
const BASE_MEDIA_TYPE = "application/vnd.inflexa.lib-store.base.v1.tar+zstd";
// A retry schedule that takes the first answer, so a failing stub fails the run at once instead of
// spinning through backoff sleeps.
const NO_RETRY = { attempts: 1, baseMs: 0, shouldRetry: (): boolean => false };

let work: string;

beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "inflexa-lib-store-"));
});

afterEach(() => {
    rmSync(work, { recursive: true, force: true });
});

/** One tar member: a file with content, or a symlink to a target. */
type LayerEntry = { readonly path: string; readonly content?: string; readonly symlink?: string };

/** One built layer: the compressed bytes, and the descriptor a manifest would carry for it. */
type BuiltLayer = { readonly mediaType: string; readonly digest: string; readonly size: number; readonly bytes: Uint8Array };

/** Build a zstd-compressed tar layer from a set of members, and its content-address descriptor. */
function buildLayer(entries: readonly LayerEntry[], mediaType: string): BuiltLayer {
    const src = mkdtempSync(join(work, "layer-src-"));
    for (const entry of entries) {
        const full = join(src, entry.path);
        mkdirSync(dirname(full), { recursive: true });
        if (entry.symlink !== undefined) symlinkSync(entry.symlink, full);
        else writeFileSync(full, entry.content ?? "");
    }
    const tar = Bun.spawnSync(["tar", "-c", "-C", src, "-f", "-", "."]);
    if (tar.exitCode !== 0) throw new Error(`fixture tar failed: ${new TextDecoder().decode(tar.stderr)}`);
    const bytes = new Uint8Array(Bun.zstdCompressSync(tar.stdout));
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
    rmSync(src, { recursive: true, force: true });
    return { mediaType, digest, size: bytes.length, bytes };
}

/** Encode an OCI image manifest that references the built layers by their descriptors. */
function manifestBytes(layers: readonly BuiltLayer[]): Uint8Array {
    const doc = {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        artifactType: "application/vnd.inflexa.lib-store.manifest.v1+json",
        config: { mediaType: "application/vnd.oci.empty.v1+json", digest: `sha256:${"0".repeat(64)}`, size: 0 },
        layers: layers.map((layer, index) => ({
            mediaType: layer.mediaType,
            digest: layer.digest,
            size: layer.size,
            annotations: { "org.opencontainers.image.title": `layer-${index}.tar.zst` },
        })),
    };
    return new TextEncoder().encode(JSON.stringify(doc));
}

/** A recording of what the stub registry saw, for the token-flow assertions. */
type StubLog = { tokenCalls: number; readonly authHeaders: string[] };

/** Options that steer the stub registry per test. */
type StubOptions = {
    readonly token: string;
    readonly manifest: Uint8Array;
    /** digest → the bytes the registry serves (tamper these to exercise the digest refusal). */
    readonly blobs: ReadonlyMap<string, Uint8Array>;
    readonly log: StubLog;
    /** When set, the served blob response reports this final URL, to exercise the https-redirect acceptance. */
    readonly blobUrl?: string;
    /** A gate the test flips: while true, every blob GET answers 503 (an interrupted download). */
    readonly failBlobs?: () => boolean;
};

/** A routing stub over the GHCR pull: the token endpoint, the manifest, and the digest-addressed blobs. */
function makeStub(options: StubOptions): FetchLike {
    return async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const auth = new Headers(init?.headers).get("authorization");
        if (url.includes("/token")) {
            options.log.tokenCalls += 1;
            return new Response(JSON.stringify({ token: options.token }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (auth !== null) options.log.authHeaders.push(auth);
        if (url.includes("/manifests/")) return new Response(options.manifest, { status: 200 });
        if (url.includes("/blobs/")) {
            if (options.failBlobs?.() === true) return new Response("upstream busy", { status: 503 });
            const digest = url.slice(url.indexOf("/blobs/") + "/blobs/".length);
            const body = options.blobs.get(digest);
            if (body === undefined) return new Response("not found", { status: 404 });
            const response = new Response(body, { status: 200 });
            // A manually built Response has an empty `url`; the redirect check reads `url`, so overriding it
            // simulates the followed https redirect to the GitHub CDN.
            if (options.blobUrl !== undefined) Object.defineProperty(response, "url", { value: options.blobUrl, configurable: true });
            return response;
        }
        return new Response("unexpected", { status: 500 });
    };
}

/**
 * The two-layer store the publisher emits: a base layer (farms + `current`) and one track layer. The farm
 * name is a parameter, because the publisher ships `catalog` while a local farm carries the name the user
 * chose, and the merge tests need both.
 */
function storeLayers(farm = "default"): { readonly base: BuiltLayer; readonly track: BuiltLayer } {
    const base = buildLayer(
        [
            { path: "current", symlink: `farms/${farm}` },
            { path: `farms/${farm}/packages.txt`, content: "foo==1.0\n" },
            { path: `farms/${farm}/meta.json`, content: "{}\n" },
        ],
        BASE_MEDIA_TYPE,
    );
    const track = buildLayer([{ path: "store/foo-1.0-abc/data.txt", content: "hello store\n" }], TRACK_MEDIA_TYPE);
    return { base, track };
}

/**
 * Build the store a user provisioned with `inflexa store add`: one content-addressed package, a farm that
 * links to it, and the `current` pointer at that farm. It carries no receipt, because no download made it.
 */
function makeLocalStore(storeRoot: string, options: { readonly farm: string; readonly current: boolean }): void {
    const pkgDir = join(storeRoot, "store", "six-1.16-local");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "data.txt"), "local six\n");
    const farmDir = join(storeRoot, "farms", options.farm);
    mkdirSync(farmDir, { recursive: true });
    writeFileSync(join(farmDir, "local.txt"), "mine\n");
    symlinkSync(join(storeRoot, "store", "six-1.16-local"), join(farmDir, "six"));
    if (options.current) symlinkSync(`farms/${options.farm}`, join(storeRoot, "current"));
}

/** Run one complete download against a stub registry that serves the given layers. */
async function downloadStore(
    storeRoot: string,
    layers: { readonly base: BuiltLayer; readonly track: BuiltLayer },
): Promise<Result<LibStoreDownloadOutcome, LibStoreDownloadError>> {
    const log: StubLog = { tokenCalls: 0, authHeaders: [] };
    const stub = makeStub({
        token: "T",
        manifest: manifestBytes([layers.base, layers.track]),
        blobs: new Map([
            [layers.base.digest, layers.base.bytes],
            [layers.track.digest, layers.track.bytes],
        ]),
        log,
    });
    return downloadLibStore({ storeRoot, arch: "amd64", fetch: stub, retry: NO_RETRY });
}

describe("resolveStoreArch", () => {
    test("maps the host arch labels and refuses an unpublished one", () => {
        expect(resolveStoreArch("x64")._unsafeUnwrap()).toBe("amd64");
        expect(resolveStoreArch("arm64")._unsafeUnwrap()).toBe("arm64");
        expect(resolveStoreArch("s390x")._unsafeUnwrapErr().type).toBe("unsupported_arch");
    });
});

describe("downloadLibStore — the GHCR pull", () => {
    test("obtains a token, carries the bearer, verifies each layer, and reassembles the store root", async () => {
        const { base, track } = storeLayers();
        const log: StubLog = { tokenCalls: 0, authHeaders: [] };
        const stub = makeStub({
            token: "TESTTOKEN",
            manifest: manifestBytes([base, track]),
            blobs: new Map([
                [base.digest, base.bytes],
                [track.digest, track.bytes],
            ]),
            log,
        });

        const storeRoot = join(work, "store-root");
        const result = await downloadLibStore({ storeRoot, arch: "amd64", fetch: stub, retry: NO_RETRY });

        const outcome = result._unsafeUnwrap();
        expect(outcome.type).toBe("downloaded");

        // The token flow: one token GET, and every authenticated request carried the bearer from it.
        expect(log.tokenCalls).toBe(1);
        expect(log.authHeaders.length).toBeGreaterThan(0);
        expect(log.authHeaders.every((header) => header === "Bearer TESTTOKEN")).toBe(true);

        // The reassembled root: the track content, the base farm files, and the symlinks kept verbatim.
        expect(readFileSync(join(storeRoot, "store", "foo-1.0-abc", "data.txt"), "utf8")).toBe("hello store\n");
        expect(readFileSync(join(storeRoot, "farms", "default", "packages.txt"), "utf8")).toBe("foo==1.0\n");
        expect(lstatSync(join(storeRoot, "current")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(storeRoot, "current"))).toBe("farms/default");

        // The receipt is present and pins the resolved manifest, so the state reads back installed.
        expect(await inspectLibStoreDownload(storeRoot)).toBe("installed");
        expect(existsSync(libStoreDownloadPaths(storeRoot).receipt)).toBe(true);
    });

    test("accepts a blob served from an https redirect target", async () => {
        const { base, track } = storeLayers();
        const log: StubLog = { tokenCalls: 0, authHeaders: [] };
        const stub = makeStub({
            token: "T",
            manifest: manifestBytes([base, track]),
            blobs: new Map([
                [base.digest, base.bytes],
                [track.digest, track.bytes],
            ]),
            log,
            blobUrl: "https://pkg-containers.githubusercontent.com/ghcr1/blob",
        });

        const storeRoot = join(work, "store-root");
        const result = await downloadLibStore({ storeRoot, arch: "amd64", fetch: stub, retry: NO_RETRY });

        expect(result._unsafeUnwrap().type).toBe("downloaded");
        expect(await inspectLibStoreDownload(storeRoot)).toBe("installed");
    });

    test("refuses a blob whose hash differs from its descriptor, and installs nothing", async () => {
        const { base, track } = storeLayers();
        const log: StubLog = { tokenCalls: 0, authHeaders: [] };
        // The registry serves tampered bytes for the track layer, so its sha256 will not match the descriptor.
        const tampered = new Uint8Array(track.bytes);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
        const stub = makeStub({
            token: "T",
            manifest: manifestBytes([base, track]),
            blobs: new Map([
                [base.digest, base.bytes],
                [track.digest, tampered],
            ]),
            log,
        });

        const storeRoot = join(work, "store-root");
        const result = await downloadLibStore({ storeRoot, arch: "amd64", fetch: stub, retry: NO_RETRY });

        expect(result._unsafeUnwrapErr().type).toBe("digest_mismatch");
        // No receipt was written, and the state never reads installed.
        expect(existsSync(libStoreDownloadPaths(storeRoot).receipt)).toBe(false);
        expect(await inspectLibStoreDownload(storeRoot)).not.toBe("installed");
    });

    test("an interrupted download reads back as incomplete, and the next run repairs it", async () => {
        const { base, track } = storeLayers();
        const log: StubLog = { tokenCalls: 0, authHeaders: [] };
        let down = true;
        const stub = makeStub({
            token: "T",
            manifest: manifestBytes([base, track]),
            blobs: new Map([
                [base.digest, base.bytes],
                [track.digest, track.bytes],
            ]),
            log,
            failBlobs: () => down,
        });

        const storeRoot = join(work, "store-root");

        // First run: every blob GET is refused, so the download fails after it prepared its staging.
        const first = await downloadLibStore({ storeRoot, arch: "amd64", fetch: stub, retry: NO_RETRY });
        expect(first._unsafeUnwrapErr().type).toBe("download_failed");
        expect(existsSync(libStoreDownloadPaths(storeRoot).receipt)).toBe(false);
        expect(await inspectLibStoreDownload(storeRoot)).toBe("incomplete");

        // The upstream recovers, and the next run repairs the store to a complete, receipted state.
        down = false;
        const second = await downloadLibStore({ storeRoot, arch: "amd64", fetch: stub, retry: NO_RETRY });
        expect(second._unsafeUnwrap().type).toBe("downloaded");
        expect(await inspectLibStoreDownload(storeRoot)).toBe("installed");
        expect(readFileSync(join(storeRoot, "store", "foo-1.0-abc", "data.txt"), "utf8")).toBe("hello store\n");
    });

    test("a second run against the same manifest is a no-op, and a moved tag reports an available update", async () => {
        const { base, track } = storeLayers();
        const log: StubLog = { tokenCalls: 0, authHeaders: [] };
        const blobs = new Map([
            [base.digest, base.bytes],
            [track.digest, track.bytes],
        ]);
        const storeRoot = join(work, "store-root");

        const install = await downloadLibStore({
            storeRoot,
            arch: "amd64",
            fetch: makeStub({ token: "T", manifest: manifestBytes([base, track]), blobs, log }),
            retry: NO_RETRY,
        });
        expect(install._unsafeUnwrap().type).toBe("downloaded");

        // Same manifest, so the receipt already pins it — no blob is fetched.
        const again = await downloadLibStore({
            storeRoot,
            arch: "amd64",
            fetch: makeStub({ token: "T", manifest: manifestBytes([base, track]), blobs, log }),
            retry: NO_RETRY,
        });
        expect(again._unsafeUnwrap().type).toBe("up_to_date");

        // A moved `latest` (a different track layer) is reported, never applied silently.
        const moved = buildLayer([{ path: "store/foo-2.0-def/data.txt", content: "newer\n" }], TRACK_MEDIA_TYPE);
        const movedBlobs = new Map([
            [base.digest, base.bytes],
            [moved.digest, moved.bytes],
        ]);
        const update = await downloadLibStore({
            storeRoot,
            arch: "amd64",
            fetch: makeStub({ token: "T", manifest: manifestBytes([base, moved]), blobs: movedBlobs, log }),
            retry: NO_RETRY,
        });
        expect(update._unsafeUnwrap().type).toBe("update_available");
        // The moved version did not land: the store still holds the first track content.
        expect(existsSync(join(storeRoot, "store", "foo-2.0-def"))).toBe(false);
        expect(existsSync(join(storeRoot, "store", "foo-1.0-abc"))).toBe(true);
    });
});

describe("downloadLibStore — the merge into a shared store root", () => {
    test("keeps a locally added package, its farm, and the active-farm pointer", async () => {
        const storeRoot = join(work, "store-root");
        makeLocalStore(storeRoot, { farm: "default", current: true });

        const result = await downloadStore(storeRoot, storeLayers("catalog"));

        const outcome = result._unsafeUnwrap();
        expect(outcome.type).toBe("downloaded");
        if (outcome.type !== "downloaded") throw new Error("the download did not complete");

        // The local content survives: the package, the farm file, and the farm symlink into the store.
        expect(readFileSync(join(storeRoot, "store", "six-1.16-local", "data.txt"), "utf8")).toBe("local six\n");
        expect(readFileSync(join(storeRoot, "farms", "default", "local.txt"), "utf8")).toBe("mine\n");
        expect(lstatSync(join(storeRoot, "farms", "default", "six")).isSymbolicLink()).toBe(true);

        // The published content landed beside it.
        expect(readFileSync(join(storeRoot, "store", "foo-1.0-abc", "data.txt"), "utf8")).toBe("hello store\n");
        expect(readFileSync(join(storeRoot, "farms", "catalog", "packages.txt"), "utf8")).toBe("foo==1.0\n");

        // The active farm of the user did not move.
        expect(readlinkSync(join(storeRoot, "current"))).toBe("farms/default");

        expect(outcome.merge.storeDirsAdded).toEqual(["foo-1.0-abc"]);
        expect(outcome.merge.farmsAdded).toEqual(["catalog"]);
        expect(outcome.merge.farmsKept).toEqual([]);
        expect(outcome.merge.currentSet).toBe(false);
        expect(await inspectLibStoreDownload(storeRoot)).toBe("installed");
    });

    test("a farm name collision keeps the local farm and reports the name", async () => {
        const storeRoot = join(work, "store-root");
        // The user named a farm exactly as the publisher names its own.
        makeLocalStore(storeRoot, { farm: "catalog", current: true });

        const result = await downloadStore(storeRoot, storeLayers("catalog"));

        const outcome = result._unsafeUnwrap();
        if (outcome.type !== "downloaded") throw new Error("the download did not complete");

        // The local farm is untouched, and the published farm did not merge into it.
        expect(readFileSync(join(storeRoot, "farms", "catalog", "local.txt"), "utf8")).toBe("mine\n");
        expect(existsSync(join(storeRoot, "farms", "catalog", "packages.txt"))).toBe(false);
        // The packages of the published farm still landed, because `store/` merges either way.
        expect(existsSync(join(storeRoot, "store", "foo-1.0-abc"))).toBe(true);

        expect(outcome.merge.farmsKept).toEqual(["catalog"]);
        expect(outcome.merge.farmsAdded).toEqual([]);
    });

    test("sets `current` when the store root carries no pointer", async () => {
        const storeRoot = join(work, "store-root");
        makeLocalStore(storeRoot, { farm: "default", current: false });

        const result = await downloadStore(storeRoot, storeLayers("catalog"));

        const outcome = result._unsafeUnwrap();
        if (outcome.type !== "downloaded") throw new Error("the download did not complete");

        expect(readlinkSync(join(storeRoot, "current"))).toBe("farms/catalog");
        expect(outcome.merge.currentSet).toBe(true);
    });
});

describe("inspectLibStoreDownload — a locally built store is not a missing one", () => {
    test("separates an absent root, an empty root, and a store the user built", async () => {
        expect(await inspectLibStoreDownload(join(work, "no-such-root"))).toBe("missing");

        const empty = join(work, "empty-root");
        mkdirSync(empty, { recursive: true });
        expect(await inspectLibStoreDownload(empty)).toBe("missing");

        // Content with no receipt is the store `inflexa store add` built, never a missing one.
        const local = join(work, "local-root");
        makeLocalStore(local, { farm: "default", current: true });
        expect(await inspectLibStoreDownload(local)).toBe("local");
        expect(existsSync(libStoreDownloadPaths(local).receipt)).toBe(false);
    });
});

// There is no opt-in gate left to test: nothing suppresses the download, so the module exposes exactly
// two entry points — the download itself and the local state read, both covered above.
