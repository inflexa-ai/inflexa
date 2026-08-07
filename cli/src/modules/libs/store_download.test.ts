import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Result } from "neverthrow";

import { Database } from "bun:sqlite";

import { db } from "../../db/primary.ts";
import { getLibStoreDownload } from "../../db/primary_query.ts";
import { recordLibStoreDownloadManifest, recordLibStoreDownloadProgress, settleLibStoreDownload, startLibStoreDownloadRun } from "../../db/primary_mutation.ts";
import type { FetchLike } from "../../lib/download.ts";
import { env } from "../../lib/env.ts";
import { instanceLockHolder, instanceLockPath, releaseInstanceLock, LIB_STORE_DOWNLOAD_LOCK_KEY } from "../../lib/lock.ts";
import {
    cancelLibStoreDownload,
    downloadLibStore,
    inspectLibStoreDownload,
    libStoreDownloadPaths,
    readLibStoreDownloadReport,
    resolveStoreArch,
    runLibStoreTransfer,
    startLibStoreDownloadProcess,
    DETACHED_TRANSFER_FLAG,
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

// --- the detached download process --------------------------------------------
//
// The lifecycle runs against the real SQLite database of the test sandbox and the real lock directory,
// because those two ARE the mechanism: the row is how a second process reads the progress, and the lock
// is how any process learns whether a downloader is live. Only the network and the spawn are stubbed —
// no test ever puts a real process on the machine.

/** Drop the lifecycle row and the download lock, so each test starts from a machine on which nothing ran. */
function resetLifecycle(): void {
    releaseInstanceLock(LIB_STORE_DOWNLOAD_LOCK_KEY);
    rmSync(instanceLockPath(LIB_STORE_DOWNLOAD_LOCK_KEY), { force: true });
    db()
        .map((conn) => conn.query("DELETE FROM lib_store_downloads").run())
        ._unsafeUnwrap();
}

/** Seed the lock file with `pid`, the way a live downloader of that pid would hold it. */
function seedLock(pid: number): void {
    mkdirSync(dirname(instanceLockPath(LIB_STORE_DOWNLOAD_LOCK_KEY)), { recursive: true });
    writeFileSync(instanceLockPath(LIB_STORE_DOWNLOAD_LOCK_KEY), String(pid));
}

/** A stub registry over the two-layer store, plus the fetch seam the lifecycle functions take. */
function stubRegistry(layers: { readonly base: BuiltLayer; readonly track: BuiltLayer }): FetchLike {
    return makeStub({
        token: "T",
        manifest: manifestBytes([layers.base, layers.track]),
        blobs: new Map([
            [layers.base.digest, layers.base.bytes],
            [layers.track.digest, layers.track.bytes],
        ]),
        log: { tokenCalls: 0, authHeaders: [] },
    });
}

describe("the download row and the lock", () => {
    beforeEach(() => resetLifecycle());
    afterEach(() => resetLifecycle());

    test("an absent row reads as `null` on the ok channel, never as an error", () => {
        expect(getLibStoreDownload()._unsafeUnwrap()).toBeNull();
        expect(readLibStoreDownloadReport()).toEqual({ row: null, state: null, live: false, holderPid: null });
    });

    test("each permitted transition lands, and only a retry leaves a terminal state", () => {
        startLibStoreDownloadRun({ state: "pending", holderPid: null })._unsafeUnwrap();
        expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("pending");

        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("running");

        for (const terminal of ["installed", "failed", "declined", "canceled"] as const) {
            settleLibStoreDownload({ state: terminal, message: null })._unsafeUnwrap();
            const row = getLibStoreDownload()._unsafeUnwrap();
            expect(row?.state).toBe(terminal);
            // A settled run holds no process, thus a later cancel signals nothing.
            expect(row?.holderPid).toBeNull();
            // The state does not change by itself: a second read gives the same terminal state.
            expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe(terminal);
            // Only a retry leaves it.
            startLibStoreDownloadRun({ state: "pending", holderPid: null })._unsafeUnwrap();
            expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("pending");
        }
    });

    test("a start resets every counter, so a retry never inherits the figures of the run before it", () => {
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        recordLibStoreDownloadManifest({ manifestDigest: "sha256:a", totalBytes: 900, totalLayers: 3 })._unsafeUnwrap();
        recordLibStoreDownloadProgress({ bytesTransferred: 300, layersCompleted: 1 })._unsafeUnwrap();
        settleLibStoreDownload({ state: "failed", message: "the layer did not arrive." })._unsafeUnwrap();

        startLibStoreDownloadRun({ state: "pending", holderPid: null })._unsafeUnwrap();
        const row = getLibStoreDownload()._unsafeUnwrap();
        expect(row?.bytesTransferred).toBe(0);
        expect(row?.totalBytes).toBeNull();
        expect(row?.totalLayers).toBeNull();
        expect(row?.message).toBeNull();
    });

    test("a second connection reads the row while the writer writes it", () => {
        // WAL mode is what makes this true, and it is the whole reason a detached writer and a reading app
        // can share one file. A second HANDLE on the same path is the closest in-process stand-in for the
        // second PROCESS the design has.
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        const reader = new Database(env.dbPath, { readonly: true });
        try {
            for (const bytes of [100, 200, 300]) {
                recordLibStoreDownloadProgress({ bytesTransferred: bytes, layersCompleted: 1 })._unsafeUnwrap();
                const row = reader.query("SELECT bytes_transferred AS b FROM lib_store_downloads").get() as { b: number } | null;
                expect(row?.b).toBe(bytes);
            }
        } finally {
            reader.close();
        }
    });

    test("a `running` row with no live holder reads as failed, with no heartbeat and no clock", () => {
        startLibStoreDownloadRun({ state: "running", holderPid: 999_999 })._unsafeUnwrap();
        // No lock file at all: nothing live holds the key.
        const report = readLibStoreDownloadReport();
        expect(report.row?.state).toBe("running");
        expect(report.state).toBe("failed");
        expect(report.live).toBe(false);
    });

    test("the probe reports a live holder and leaves the lock exactly as it was", () => {
        seedLock(process.pid);
        expect(instanceLockHolder(LIB_STORE_DOWNLOAD_LOCK_KEY)).toBe(process.pid);
        // Read-only: a probe that took the lock would refuse the next real downloader.
        expect(readFileSync(instanceLockPath(LIB_STORE_DOWNLOAD_LOCK_KEY), "utf8")).toBe(String(process.pid));
        expect(instanceLockHolder(LIB_STORE_DOWNLOAD_LOCK_KEY)).toBe(process.pid);
    });
});

describe("startLibStoreDownloadProcess", () => {
    beforeEach(() => resetLifecycle());
    afterEach(() => resetLifecycle());

    test("a fresh machine starts one detached process and writes a pending row, with no network", async () => {
        const spawned: (readonly string[])[] = [];
        const started = await startLibStoreDownloadProcess({
            storeRoot: join(work, "store"),
            update: false,
            fetch: async () => new Response("no network expected", { status: 500 }),
            spawn: (cmd) => {
                spawned.push(cmd);
                return 4242;
            },
        });
        expect(started._unsafeUnwrap()).toEqual({ type: "started", pid: 4242 });
        expect(spawned.length).toBe(1);
        // The child is told to move the bytes itself, rather than start a third process.
        expect(spawned[0]).toContain(DETACHED_TRANSFER_FLAG);
        expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("pending");
    });

    test("a second start finds the lock held, starts no process, and reports the live run", async () => {
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        recordLibStoreDownloadProgress({ bytesTransferred: 300, layersCompleted: 1 })._unsafeUnwrap();
        seedLock(process.pid);

        const spawned: (readonly string[])[] = [];
        const started = await startLibStoreDownloadProcess({ storeRoot: join(work, "store"), update: false, spawn: (cmd) => spawned.push(cmd) });
        const outcome = started._unsafeUnwrap();
        expect(outcome.type).toBe("already_running");
        if (outcome.type === "already_running") expect(outcome.report.row?.bytesTransferred).toBe(300);
        expect(spawned).toEqual([]);
    });

    test("a receipt that pins the resolved manifest reports up to date, with and without `--update`", async () => {
        const storeRoot = join(work, "store");
        const layers = storeLayers();
        (await downloadStore(storeRoot, layers))._unsafeUnwrap();

        for (const update of [false, true]) {
            const spawned: (readonly string[])[] = [];
            const started = await startLibStoreDownloadProcess({
                storeRoot,
                update,
                arch: "amd64",
                fetch: stubRegistry(layers),
                spawn: (cmd) => spawned.push(cmd),
            });
            expect(started._unsafeUnwrap().type).toBe("up_to_date");
            // `--update` is the consent to apply a MOVED tag, not a way to transfer a healthy store again.
            expect(spawned).toEqual([]);
        }
    });

    test("a receipt that pins a different manifest reports an update, and `--update` then starts the transfer", async () => {
        const storeRoot = join(work, "store");
        const installed = storeLayers();
        (await downloadStore(storeRoot, installed))._unsafeUnwrap();
        // The row a completed `inflexa store download` leaves. The resolve ANNOTATES a row and never mints
        // one, because a store that a manual pull made must keep reporting that no download ran.
        settleLibStoreDownload({ state: "installed", message: null })._unsafeUnwrap();
        // A moved `latest`: the registry now serves a manifest whose track layer differs.
        const moved = { base: installed.base, track: buildLayer([{ path: "store/foo-2.0-def/data.txt", content: "newer\n" }], TRACK_MEDIA_TYPE) };

        const spawned: (readonly string[])[] = [];
        const reported = await startLibStoreDownloadProcess({
            storeRoot,
            update: false,
            arch: "amd64",
            fetch: stubRegistry(moved),
            spawn: (cmd) => spawned.push(cmd),
        });
        expect(reported._unsafeUnwrap().type).toBe("update_available");
        expect(spawned).toEqual([]);
        // The resolve recorded the digest the registry serves now, which is how a reader with no network
        // learns that an update is available.
        expect(getLibStoreDownload()._unsafeUnwrap()?.manifestDigest).toBeTruthy();

        const applied = await startLibStoreDownloadProcess({
            storeRoot,
            update: true,
            arch: "amd64",
            fetch: stubRegistry(moved),
            spawn: () => 4242,
        });
        expect(applied._unsafeUnwrap()).toEqual({ type: "started", pid: 4242 });
    });
});

describe("runLibStoreTransfer — the detached child", () => {
    beforeEach(() => resetLifecycle());
    afterEach(() => resetLifecycle());

    test("a completed transfer records the exact totals, and neither total grows", async () => {
        const storeRoot = join(work, "store");
        const layers = storeLayers();
        const declared = layers.base.size + layers.track.size;

        await runLibStoreTransfer({ storeRoot, update: false, fetch: stubRegistry(layers), retry: NO_RETRY });

        const row = getLibStoreDownload()._unsafeUnwrap();
        expect(row?.state).toBe("installed");
        // The manifest declares the size of every layer, so the totals are exact rather than an estimate.
        expect(row?.totalBytes).toBe(declared);
        expect(row?.totalLayers).toBe(2);
        expect(row?.bytesTransferred).toBe(declared);
        expect(row?.layersCompleted).toBe(2);
        // The receipt is what makes the store usable; the row only reports that the run ended.
        expect(existsSync(libStoreDownloadPaths(storeRoot).receipt)).toBe(true);
        // The lock is released on every exit path, thus a later run is not refused by a ghost.
        expect(instanceLockHolder(LIB_STORE_DOWNLOAD_LOCK_KEY)).toBeNull();
    });

    test("an exhausted disk names the bytes necessary and the bytes available, and leaves no staged tree", async () => {
        const storeRoot = join(work, "store");
        const layers = storeLayers();
        const manifest = manifestBytes([layers.base, layers.track]);
        // A genuinely full filesystem is not something a unit test can create, so the out-of-disk fault is
        // injected at the transfer seam instead. What is under test is the CLASSIFICATION: the transfer
        // stops with a cause that carries ENOSPC, and the message must then name the two byte figures.
        const outOfDisk: FetchLike = async (input) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("/token")) return new Response(JSON.stringify({ token: "T" }), { status: 200 });
            if (url.includes("/manifests/")) return new Response(manifest, { status: 200 });
            const cause = new Error("ENOSPC: no space left on device, write");
            (cause as NodeJS.ErrnoException).code = "ENOSPC";
            throw cause;
        };

        await runLibStoreTransfer({ storeRoot, update: false, fetch: outOfDisk, retry: NO_RETRY });

        const row = getLibStoreDownload()._unsafeUnwrap();
        expect(row?.state).toBe("failed");
        // A bare "no space left" tells a user nothing about how much disk to free.
        expect(row?.message).toContain("The disk ran out");
        expect(row?.message).toContain("more and");
        expect(row?.message).toContain("inflexa store download");
        // The partial transfer is gone, and the store root holds what it held before the run.
        expect(existsSync(libStoreDownloadPaths(storeRoot).staging)).toBe(false);
        expect(existsSync(join(storeRoot, "current"))).toBe(false);
    });

    test("a second child that loses the lock race transfers nothing and writes nothing", async () => {
        // pid 1 is live and is NOT this process: our own pid would re-acquire the lock re-entrantly, which
        // is the right behavior for a re-entrant caller and the wrong fixture for a losing child.
        seedLock(1);
        settleLibStoreDownload({ state: "canceled", message: null })._unsafeUnwrap();
        // The lock is already held by a live pid other than a reclaimable one, so this child returns at once.
        const storeRoot = join(work, "store");
        await runLibStoreTransfer({
            storeRoot,
            update: false,
            fetch: async () => {
                throw new Error("the losing child must reach no network");
            },
            retry: NO_RETRY,
        });
        expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("canceled");
        expect(existsSync(storeRoot)).toBe(false);
    });
});

describe("cancelLibStoreDownload", () => {
    beforeEach(() => resetLifecycle());
    afterEach(() => resetLifecycle());

    test("a cancel with no live run reports that fact and changes nothing", async () => {
        const storeRoot = join(work, "store");
        mkdirSync(join(storeRoot, "store", "foo-1.0-abc"), { recursive: true });
        expect(await cancelLibStoreDownload(storeRoot)).toEqual({ type: "no_run" });
        // It writes no row, it removes no tree, and it stops no process.
        expect(getLibStoreDownload()._unsafeUnwrap()).toBeNull();
        expect(existsSync(join(storeRoot, "store", "foo-1.0-abc"))).toBe(true);
    });

    test("a cancel records `canceled`, removes the partial staged tree, and keeps every installed child", async () => {
        const storeRoot = join(work, "store");
        makeLocalStore(storeRoot, { farm: "mine", current: true });
        const staging = libStoreDownloadPaths(storeRoot).staging;
        mkdirSync(join(staging, "attempt-1", "store"), { recursive: true });
        writeFileSync(join(staging, "attempt-1", "store", "half.txt"), "part\n");

        // A REAL child process holds the run, because the cancel genuinely signals the holder pid. Our own
        // pid would take the test process down with it, and a foreign live pid is somebody else's process.
        const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
        startLibStoreDownloadRun({ state: "running", holderPid: child.pid })._unsafeUnwrap();
        seedLock(child.pid);

        const canceling = cancelLibStoreDownload(storeRoot);
        // Reaped, so the pid probe reads it as gone and the bounded wait ends — which is exactly the signal
        // a real downloader gives when it exits and releases the lock.
        await child.exited;
        expect(await canceling).toEqual({ type: "canceled", holderPid: child.pid });

        expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("canceled");
        expect(existsSync(staging)).toBe(false);
        // No installed content was touched: each child the store root holds stays where it is.
        expect(existsSync(join(storeRoot, "store", "six-1.16-local"))).toBe(true);
        expect(existsSync(join(storeRoot, "farms", "mine"))).toBe(true);
        expect(readlinkSync(join(storeRoot, "current"))).toBe("farms/mine");
    });

    test("a download after a cancel moves the state to pending, then to running", async () => {
        settleLibStoreDownload({ state: "canceled", message: null })._unsafeUnwrap();
        const started = await startLibStoreDownloadProcess({ storeRoot: join(work, "store"), update: false, spawn: () => 4242 });
        expect(started._unsafeUnwrap().type).toBe("started");
        expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("pending");

        // The child takes the lock and moves it on, which is the second half of the retry transition.
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        expect(getLibStoreDownload()._unsafeUnwrap()?.state).toBe("running");
    });
});

describe("the detached-transfer flag", () => {
    test("the registry declares the exact flag the spawn passes", () => {
        // The registry keeps its lazy-import discipline, so the spelling lives in two places. Reading the
        // registry SOURCE rather than importing it keeps the whole command tree out of this test process,
        // which is what the file-descriptor budget of the shared `bun test` run depends on (cli/CLAUDE.md).
        const registry = readFileSync(join(import.meta.dir, "../../cli/index.ts"), "utf8");
        expect(registry).toContain(`new Option("${DETACHED_TRANSFER_FLAG}"`);

        // Commander maps the flag onto a camelCase key of the options object, and the handler reads that
        // key. A rename of the flag moves the key too, and a handler left on the old spelling would read
        // `undefined` and start a third process. Derive the key from the same constant, thus the two
        // spellings cannot drift apart in silence.
        const optionKey = DETACHED_TRANSFER_FLAG.replace("--", "").replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
        expect(registry).toContain(`options.${optionKey}`);
    });
});
