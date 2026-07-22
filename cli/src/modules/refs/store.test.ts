import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";

import { REFERENCE_DATA_CATALOG_VERSION, UnknownReferenceDatasetError, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok } from "neverthrow";

import {
    buildReferenceListDocument,
    buildReferenceVerifyDocument,
    inspectReferenceStore,
    installReferenceDatasets,
    referenceDownloadEstimate,
    referenceStorePaths,
    verifyReferenceDatasets,
    type ReferenceCatalogSource,
    type ReferenceDownloadProgress,
    type ReferenceStoreInspection,
    type ReferenceVerification,
} from "./store.ts";

const roots: string[] = [];

function root(): string {
    const path = join(tmpdir(), `inflexa-refs-${randomUUIDv7()}`);
    roots.push(path);
    return path;
}

function sha(bytes: string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** One catalog artifact paired with the bytes its (offline) upstream serves for it. */
type Fixture = {
    /** Dataset-relative final path. */
    readonly path: string;
    /** Bytes the stub upstream returns. */
    readonly body: string;
};

/** Every fixture artifact is fetched straight from its own third-party upstream — there is no distribution base. */
function url(path: string): string {
    return `https://upstream.test/${path}`;
}

const ARTIFACTS: readonly Fixture[] = [{ path: "a.txt", body: "alpha" }];

function catalog(files: readonly Fixture[] = ARTIFACTS): ReferenceDataCatalog {
    return {
        version: REFERENCE_DATA_CATALOG_VERSION,
        datasets: [
            {
                id: "demo",
                version: "2026.07",
                title: "Demo reference",
                description: "Offline fixture",
                sourceUrl: "https://example.test/source",
                license: { identifier: "CC0-1.0", url: "https://example.test/license" },
                recommendation: { group: "testing", recommended: true },
                // The catalog pins nothing but the https URL: no size, no digest, no integrity class.
                artifacts: files.map((file) => ({ path: file.path, url: url(file.path), format: "txt", contents: "test fixture artifact" })),
            },
        ],
    };
}

/** An upstream that answers from a different, downgraded location — what a redirect hop looks like. */
function serveRedirectedTo(finalUrl: string, files: readonly Fixture[]): (input: string | URL | Request) => Promise<Response> {
    const bodies = new Map(files.map((file) => [url(file.path), file.body]));
    return async (input) => {
        const response = new Response(bodies.get(String(input)) ?? "");
        // fetch reports the post-redirect location here; Response leaves it "" unless it redirected.
        Object.defineProperty(response, "url", { value: finalUrl });
        return response;
    };
}

function source(value: ReferenceDataCatalog): ReferenceCatalogSource {
    return {
        catalog: value,
        resolveInstallPlan: (ids) => {
            const byId = new Map(value.datasets.map((dataset) => [dataset.id, dataset]));
            const selected = [...new Set(ids)].sort();
            const unknown = selected.find((id) => !byId.has(id));
            if (unknown !== undefined) return err(new UnknownReferenceDatasetError(unknown, [...byId.keys()].sort()));
            return ok({
                catalogVersion: value.version,
                datasets: selected.flatMap((id) => {
                    const dataset = byId.get(id);
                    return dataset === undefined ? [] : [{ ...dataset, installPath: `${dataset.id}/${dataset.version}` }];
                }),
            });
        },
    };
}

/** What the installer asked the upstream for; the installer never resumes, so `range` is always null. */
type Asked = { readonly url: string; readonly range: string | null };

/** Offline upstream. Serves each fixture's bytes fresh; records the (never-present) Range header so a
 * test can prove the installer refetches whole rather than resuming from a partial. */
function serve(files: readonly Fixture[], asked: Asked[] = []): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    const bodies = new Map(files.map((file) => [url(file.path), file.body]));
    return async (input, init) => {
        const target = String(input);
        asked.push({ url: target, range: new Headers(init?.headers).get("range") });
        const body = bodies.get(target);
        if (body === undefined) return new Response("missing", { status: 404, statusText: "Not Found" });
        return new Response(body);
    };
}

/** An upstream that declares each body's length, as a well-behaved one does for a fixed-size file. */
function serveWithContentLength(files: readonly Fixture[]): (input: string | URL | Request) => Promise<Response> {
    const bodies = new Map(files.map((file) => [url(file.path), file.body]));
    return async (input) => {
        const body = bodies.get(String(input));
        if (body === undefined) return new Response("missing", { status: 404, statusText: "Not Found" });
        return new Response(body, { headers: { "content-length": String(Buffer.byteLength(body)) } });
    };
}

afterEach(() => {
    for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("reference store inspection", () => {
    test("an absent store is missing and passive inspection creates nothing", async () => {
        const path = root();
        const result = await inspectReferenceStore(path, catalog());
        expect(result._unsafeUnwrap()).toMatchObject({ exists: false, datasets: [{ state: "missing" }] });
        expect(await Bun.file(path).exists()).toBe(false);
    });

    test("setup-created empty user namespace is not reported as user content", async () => {
        const path = root();
        mkdirSync(join(path, "user"), { recursive: true });
        expect((await inspectReferenceStore(path, catalog()))._unsafeUnwrap().userContent).toEqual([]);
        writeFileSync(join(path, "user", "custom.fa"), "custom");
        expect((await inspectReferenceStore(path, catalog()))._unsafeUnwrap().userContent).toEqual(["user/custom.fa"]);
    });

    test("invalid and stale receipts are recoverable states", async () => {
        const path = root();
        const paths = referenceStorePaths(path);
        mkdirSync(paths.receipts, { recursive: true });
        writeFileSync(join(paths.receipts, "demo.json"), "not-json");
        expect((await inspectReferenceStore(path, catalog()))._unsafeUnwrap().datasets[0]?.state).toBe("invalid_receipt");

        writeFileSync(
            join(paths.receipts, "demo.json"),
            JSON.stringify({
                version: 1,
                datasetId: "demo",
                datasetVersion: "2025.01",
                activatedAt: "2026-07-14T12:00:00.000Z",
                artifacts: [{ path: "old.txt", bytes: 3, sha256: sha("old") }],
            }),
        );
        mkdirSync(join(paths.managed, "demo", "2025.01"), { recursive: true });
        writeFileSync(join(paths.managed, "demo", "2025.01", "old.txt"), "old");
        expect((await inspectReferenceStore(path, catalog()))._unsafeUnwrap().datasets[0]?.state).toBe("update_available");
    });

    test("receipt metadata symlinks are not followed", async () => {
        const path = root();
        const outside = root();
        mkdirSync(join(path, ".inflexa"), { recursive: true });
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "demo.json"), "{}");
        symlinkSync(outside, join(path, ".inflexa", "receipts"));
        expect((await inspectReferenceStore(path, catalog()))._unsafeUnwrap().datasets[0]?.state).toBe("invalid_receipt");
    });
});

describe("installation", () => {
    test("activates atomically and records the observed bytes and digest in the receipt", async () => {
        const path = root();
        const files: readonly Fixture[] = [
            { path: "nested/a.txt", body: "alpha" },
            { path: "b.txt", body: "beta" },
        ];
        const fixture = catalog(files);
        mkdirSync(join(path, "user"), { recursive: true });
        writeFileSync(join(path, "user", "mine.fa"), "mine");

        const result = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serve(files),
            now: () => new Date("2026-07-14T12:00:00.000Z"),
            attemptId: () => "attempt",
        });
        expect(result._unsafeUnwrap().installed[0]).toEqual({ id: "demo", version: "2026.07", bytesDownloaded: 9 });

        const paths = referenceStorePaths(path);
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "nested", "a.txt"), "utf8")).toBe("alpha");
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "b.txt"), "utf8")).toBe("beta");
        expect(JSON.parse(readFileSync(join(paths.receipts, "demo.json"), "utf8"))).toEqual({
            version: 1,
            datasetId: "demo",
            datasetVersion: "2026.07",
            activatedAt: "2026-07-14T12:00:00.000Z",
            artifacts: [
                { path: "nested/a.txt", bytes: 5, sha256: sha("alpha") },
                { path: "b.txt", bytes: 4, sha256: sha("beta") },
            ],
        });
        expect(readFileSync(join(path, "user", "mine.fa"), "utf8")).toBe("mine");
        expect(await Array.fromAsync(new Bun.Glob("*.part").scan(paths.downloads))).toEqual([]);
        // Every attempt gets a fresh staging id, so a leftover attempt dir would accumulate forever.
        expect(readdirSync(paths.staging)).toEqual([]);
        expect((await inspectReferenceStore(path, fixture))._unsafeUnwrap().datasets[0]?.state).toBe("installed");
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("valid");
        expect((await referenceDownloadEstimate(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ artifactsToFetch: 0 });

        // An intact install is skipped: the upstream below serves entirely different bytes, so a clean
        // `ok` with zero bytes downloaded and the file left unchanged is the proof it was never contacted.
        const repeated = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serve([
                { path: "nested/a.txt", body: "ALPHA" },
                { path: "b.txt", body: "BETA" },
            ]),
        });
        expect(repeated._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(0);
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "nested", "a.txt"), "utf8")).toBe("alpha");
    });

    // Removed: the model no longer pins a catalog size/digest, so there is nothing to resume against
    // or to fail a download on — a size_mismatch/digest_mismatch install failure is unrepresentable.
    // The installer always refetches whole (covered below) and trusts-on-first-use whatever https
    // serves, recording the observed bytes in the receipt (covered above).

    test("an interrupted stream never activates partial data", async () => {
        const path = root();
        const fixture = catalog();
        const paths = referenceStorePaths(path);

        const interrupted = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: async () => Promise.reject(new Error("connection lost")),
        });
        expect(interrupted._unsafeUnwrapErr().type).toBe("download_failed");
        expect(existsSync(join(paths.managed, "demo", "2026.07", "a.txt"))).toBe(false);
        expect(existsSync(join(paths.receipts, "demo.json"))).toBe(false);
    });

    test("a failed update preserves the prior active version and its receipt", async () => {
        const path = root();
        const paths = referenceStorePaths(path);
        const receiptPath = join(paths.receipts, "demo.json");
        mkdirSync(join(paths.managed, "demo", "2025.01"), { recursive: true });
        mkdirSync(dirname(receiptPath), { recursive: true });
        writeFileSync(join(paths.managed, "demo", "2025.01", "old.txt"), "old");
        const prior = JSON.stringify({
            version: 1,
            datasetId: "demo",
            datasetVersion: "2025.01",
            activatedAt: "2025-01-01T00:00:00.000Z",
            artifacts: [{ path: "old.txt", bytes: 3, sha256: sha("old") }],
        });
        writeFileSync(receiptPath, prior);

        // The update fetch fails outright (a 404 from the upstream); activation is atomic, so the prior
        // active version and its receipt must survive untouched.
        const failed = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(catalog()),
            fetch: serve([]),
        });
        expect(failed._unsafeUnwrapErr().type).toBe("download_failed");
        expect(readFileSync(receiptPath, "utf8")).toBe(prior);
        expect(readFileSync(join(paths.managed, "demo", "2025.01", "old.txt"), "utf8")).toBe("old");
    });
});

describe("mutable upstream installation", () => {
    test("installs without a catalog digest and records what the mutable upstream actually served", async () => {
        const path = root();
        const files: readonly Fixture[] = [{ path: "gene_info.gz", body: "mutable-bytes" }];
        const fixture = catalog(files);
        // The catalog carries only the https URL — no size or digest — for an upstream that rebuilds in place.
        expect(fixture.datasets[0]?.artifacts[0]).toEqual({ path: "gene_info.gz", url: url("gene_info.gz"), format: "txt", contents: "test fixture artifact" });

        const installed = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serve(files),
            now: () => new Date("2026-07-14T12:00:00.000Z"),
        });
        expect(installed._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(13);

        const paths = referenceStorePaths(path);
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "gene_info.gz"), "utf8")).toBe("mutable-bytes");
        expect(JSON.parse(readFileSync(join(paths.receipts, "demo.json"), "utf8")).artifacts).toEqual([
            { path: "gene_info.gz", bytes: 13, sha256: sha("mutable-bytes") },
        ]);
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]).toMatchObject({
            state: "valid",
            files: [{ path: "gene_info.gz", state: "valid" }],
        });
    });

    test("never resumes a stale partial — a rebuilt upstream would splice two files together", async () => {
        const path = root();
        const files: readonly Fixture[] = [{ path: "gene_info.gz", body: "fresh-upstream" }];
        const fixture = catalog(files);
        const paths = referenceStorePaths(path);
        mkdirSync(paths.downloads, { recursive: true });
        writeFileSync(join(paths.downloads, `${sha("demo/2026.07/gene_info.gz")}.part`), "stale-prefix");

        const asked: Asked[] = [];
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(files, asked) });
        expect(installed._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(14);
        expect(asked).toEqual([{ url: url("gene_info.gz"), range: null }]);
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "gene_info.gz"), "utf8")).toBe("fresh-upstream");
    });

    test("--force is the only way to pull a refreshed copy of a mutable upstream", async () => {
        const path = root();
        const files: readonly Fixture[] = [{ path: "gene_info.gz", body: "release-a" }];
        const fixture = catalog(files);
        const paths = referenceStorePaths(path);
        const active = join(paths.managed, "demo", "2026.07", "gene_info.gz");
        const refreshed: readonly Fixture[] = [{ path: "gene_info.gz", body: "release-b-longer" }];

        const first = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(files) });
        expect(first.isOk()).toBe(true);

        // Without --force an intact install is indistinguishable from an up-to-date one, so the newer
        // upstream release is deliberately not picked up.
        const skipped = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(refreshed) });
        expect(skipped._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(0);
        expect(readFileSync(active, "utf8")).toBe("release-a");

        const forced = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(refreshed) }, { force: true });
        expect(forced._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(16);
        expect(readFileSync(active, "utf8")).toBe("release-b-longer");
        expect(JSON.parse(readFileSync(join(paths.receipts, "demo.json"), "utf8")).artifacts).toEqual([
            { path: "gene_info.gz", bytes: 16, sha256: sha("release-b-longer") },
        ]);
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("valid");
    });
});

describe("self-healing installs", () => {
    test("a same-size corruption is re-downloaded without --force instead of being reported installed", async () => {
        const path = root();
        const fixture = catalog();
        const paths = referenceStorePaths(path);
        const active = join(paths.managed, "demo", "2026.07", "a.txt");

        const first = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(ARTIFACTS) });
        expect(first._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(5);

        writeFileSync(active, "ALPHA");
        // `refs list` state is deliberately cheap (size-only), so it still reads as installed — but the
        // install gate hashes, so the damage must be seen and healed rather than skipped.
        expect((await inspectReferenceStore(path, fixture))._unsafeUnwrap().datasets[0]?.state).toBe("installed");
        expect((await referenceDownloadEstimate(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ artifactsToFetch: 1 });
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("modified");

        const healed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(ARTIFACTS) });
        expect(healed._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(5);
        expect(readFileSync(active, "utf8")).toBe("alpha");
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("valid");
    });
});

describe("verification", () => {
    test("reports each file against the digest recorded at install, and detects same-size damage", async () => {
        const path = root();
        const files: readonly Fixture[] = [
            { path: "a.txt", body: "alpha" },
            { path: "b.txt", body: "bravo" },
        ];
        const fixture = catalog(files);
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(files) });
        expect(installed.isOk()).toBe(true);

        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]).toEqual({
            datasetId: "demo",
            version: "2026.07",
            state: "valid",
            files: [
                { path: "a.txt", state: "valid" },
                { path: "b.txt", state: "valid" },
            ],
        });

        const active = join(referenceStorePaths(path).managed, "demo", "2026.07");
        writeFileSync(join(active, "a.txt"), "ALPHA");
        rmSync(join(active, "b.txt"));
        const damaged = (await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0];
        expect(damaged?.state).toBe("modified");
        expect(damaged?.files).toEqual([
            { path: "a.txt", state: "modified" },
            { path: "b.txt", state: "missing" },
        ]);
    });

    test("a symlinked managed file is never followed", async () => {
        const path = root();
        const fixture = catalog();
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(ARTIFACTS) });
        expect(installed.isOk()).toBe(true);

        const active = join(referenceStorePaths(path).managed, "demo", "2026.07");
        const outside = root();
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "alpha"), "alpha");
        rmSync(join(active, "a.txt"));
        symlinkSync(join(outside, "alpha"), join(active, "a.txt"));
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.files[0]).toEqual({
            path: "a.txt",
            state: "missing",
        });
    });
});

describe("transfer progress reporting", () => {
    const FILES: readonly Fixture[] = [
        { path: "nested/a.txt", body: "alpha" },
        { path: "b.txt", body: "beta" },
    ];

    test("reports every artifact's start, bytes, and completion in transfer order", async () => {
        const path = root();
        const fixture = catalog(FILES);
        const events: ReferenceDownloadProgress[] = [];

        const result = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serveWithContentLength(FILES),
            onProgress: (event) => events.push(event),
        });
        expect(result._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(9);

        // Artifacts within one dataset stay sequential (datasets are what run concurrently), so this
        // stream is strictly start → bytes… → completed per artifact; a renderer accumulating byte
        // deltas must land on the same total the receipt records.
        expect(events.filter((event) => event.type !== "artifact_bytes")).toEqual([
            { type: "artifact_started", datasetId: "demo", path: "nested/a.txt", declaredBytes: 5 },
            { type: "artifact_completed", datasetId: "demo", path: "nested/a.txt", bytes: 5 },
            { type: "artifact_started", datasetId: "demo", path: "b.txt", declaredBytes: 4 },
            { type: "artifact_completed", datasetId: "demo", path: "b.txt", bytes: 4 },
        ]);
        const streamed = events.reduce((total, event) => (event.type === "artifact_bytes" ? total + event.bytes : total), 0);
        expect(streamed).toBe(9);
    });

    test("an upstream that declares no size still reports a start, and installs identically", async () => {
        const path = root();
        const fixture = catalog(FILES);
        const events: ReferenceDownloadProgress[] = [];

        const result = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            // `serve` sets no content-length — the normal case for a chunked or on-the-fly-compressed
            // upstream, and the reason the readout can never be a percentage of a known total.
            fetch: serve(FILES),
            onProgress: (event) => events.push(event),
        });
        expect(result._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(9);

        const started = events.filter((event) => event.type === "artifact_started");
        expect(started).toHaveLength(2);
        expect(started.every((event) => !("declaredBytes" in event))).toBe(true);
    });

    test("no artifact is reported as completed when its transfer fails", async () => {
        const path = root();
        const fixture = catalog(FILES);
        const events: ReferenceDownloadProgress[] = [];

        const result = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serve([]), // every artifact 404s
            onProgress: (event) => events.push(event),
        });
        expect(result.isErr()).toBe(true);
        expect(events).toEqual([]);
    });

    test("a throwing observer cannot fail the install or change what it produces", async () => {
        const quiet = root();
        const noisy = root();
        const fixture = catalog(FILES);
        const stamp = { now: () => new Date("2026-07-14T12:00:00.000Z"), attemptId: () => "attempt" };

        const baseline = await installReferenceDatasets(["demo"], { root: quiet, source: source(fixture), fetch: serve(FILES), ...stamp });
        const observed = await installReferenceDatasets(["demo"], {
            root: noisy,
            source: source(fixture),
            fetch: serve(FILES),
            ...stamp,
            onProgress: () => {
                throw new Error("renderer exploded");
            },
        });

        expect(observed._unsafeUnwrap()).toEqual(baseline._unsafeUnwrap());
        const receipt = (store: string): unknown => JSON.parse(readFileSync(join(referenceStorePaths(store).receipts, "demo.json"), "utf8"));
        expect(receipt(noisy)).toEqual(receipt(quiet));
        expect((await verifyReferenceDatasets(noisy, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("valid");
    });

    test("an intact dataset is skipped without emitting any progress", async () => {
        const path = root();
        const fixture = catalog(FILES);
        const first = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(FILES) });
        expect(first.isOk()).toBe(true);

        const events: ReferenceDownloadProgress[] = [];
        const repeated = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serve(FILES),
            onProgress: (event) => events.push(event),
        });
        expect(repeated._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(0);
        // The zero-artifact plan a renderer must not draw a bar for: nothing was fetched, so nothing
        // was reported.
        expect(events).toEqual([]);
    });
});

describe("download estimate", () => {
    test("counts every artifact not already intact, ignoring leftover partials, and never hits the network", async () => {
        const path = root();
        const files: readonly Fixture[] = [
            { path: "a.txt", body: "alpha" },
            { path: "b.bin", body: "mutable" },
        ];
        const fixture = catalog(files);
        const paths = referenceStorePaths(path);

        // The catalog knows no sizes and there is no resume to net out, so the estimate is a count of
        // the artifacts a fresh install would fetch — never going to the network to size them.
        expect((await referenceDownloadEstimate(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ artifactsToFetch: 2 });

        // A leftover partial nets out nothing now: the installer always refetches the whole artifact.
        mkdirSync(paths.downloads, { recursive: true });
        writeFileSync(join(paths.downloads, `${sha("demo/2026.07/a.txt")}.part`), "al");
        expect((await referenceDownloadEstimate(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ artifactsToFetch: 2 });

        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(files) });
        expect(installed.isOk()).toBe(true);
        expect((await referenceDownloadEstimate(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ artifactsToFetch: 0 });
        expect((await referenceDownloadEstimate(["demo"], path, source(fixture), { force: true }))._unsafeUnwrap()).toEqual({ artifactsToFetch: 2 });
        expect((await referenceDownloadEstimate(["unknown"], path, source(fixture)))._unsafeUnwrapErr().type).toBe("unknown_dataset");
    });
});

describe("installer-owned path safety", () => {
    test("unknown ids and reserved symlink conflicts mutate nothing", async () => {
        const path = root();
        const unknown = await installReferenceDatasets(["unknown"], { root: path, source: source(catalog()) });
        expect(unknown._unsafeUnwrapErr().type).toBe("unknown_dataset");
        expect(await Bun.file(path).exists()).toBe(false);

        const outside = root();
        mkdirSync(path, { recursive: true });
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(path, ".inflexa"));
        const conflict = await installReferenceDatasets(["demo"], { root: path, source: source(catalog()), fetch: serve(ARTIFACTS) });
        expect(conflict._unsafeUnwrapErr().type).toBe("managed_path_conflict");
        expect(Array.from(new Bun.Glob("**/*").scanSync(outside))).toEqual([]);
    });

    test("unexpected managed files and directories are never overwritten", async () => {
        const path = root();
        const active = join(referenceStorePaths(path).managed, "demo", "2026.07");
        mkdirSync(join(active, "surprise"), { recursive: true });
        const conflict = await installReferenceDatasets(["demo"], { root: path, source: source(catalog()), fetch: serve(ARTIFACTS) });
        expect(conflict._unsafeUnwrapErr().type).toBe("managed_path_conflict");
        expect(statSync(join(active, "surprise")).isDirectory()).toBe(true);
    });

    // The catalog can only promise https for the URL we ask for, and nothing downstream re-checks the
    // bytes against a reviewed digest (trust-on-first-use), so a downgraded redirect must be refused.
    test("refuses bytes served from a non-https location after a redirect", async () => {
        const path = root();
        const fixture = catalog([{ path: "a.txt", body: "alpha" }]);
        const redirected = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serveRedirectedTo("http://downgraded.test/a.txt", [{ path: "a.txt", body: "alpha" }]),
        });

        expect(redirected._unsafeUnwrapErr().type).toBe("download_failed");
        expect(redirected._unsafeUnwrapErr().message).toContain("non-https");
        expect(existsSync(join(referenceStorePaths(path).managed, "demo"))).toBe(false);
        expect(existsSync(join(referenceStorePaths(path).receipts, "demo.json"))).toBe(false);
    });

    // A receipt is a plain file on disk that anyone can edit, so it is untrusted input. A traversal
    // segment must never let verification reach out of the dataset into `user/` or a sibling.
    test("a receipt whose artifact path escapes the dataset is rejected, and reads no file outside it", async () => {
        const path = root();
        const paths = referenceStorePaths(path);
        const fixture = catalog();
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(ARTIFACTS) });
        expect(installed.isOk()).toBe(true);

        const secret = join(paths.user, "private.txt");
        mkdirSync(paths.user, { recursive: true });
        writeFileSync(secret, "user content the installer must never adopt");

        writeFileSync(
            join(paths.receipts, "demo.json"),
            JSON.stringify({
                version: 1,
                datasetId: "demo",
                datasetVersion: "2026.07",
                activatedAt: "2026-07-14T10:30:00.000Z",
                artifacts: [{ path: "../../../user/private.txt", bytes: 42, sha256: sha("alpha") }],
            }),
        );

        const verified = await verifyReferenceDatasets(path, ["demo"], source(fixture));
        expect(verified._unsafeUnwrap()[0]).toMatchObject({ datasetId: "demo", state: "invalid_receipt", files: [] });

        const inspected = await inspectReferenceStore(path, fixture);
        expect(inspected._unsafeUnwrap().datasets[0]).toMatchObject({ state: "invalid_receipt" });
        expect(readFileSync(secret, "utf8")).toBe("user content the installer must never adopt");
    });
});

describe("projection documents", () => {
    // Two datasets in catalog order: the first installed (a valid receipt present), the second missing
    // (no receipt) — so the same fixture exercises both the present-facts and absent-keys branches.
    const inspection: ReferenceStoreInspection = {
        exists: true,
        datasets: [
            {
                dataset: {
                    id: "alpha",
                    version: "2026.07",
                    title: "Alpha reference",
                    description: "First fixture",
                    sourceUrl: "https://example.test/alpha",
                    license: { identifier: "CC0-1.0", url: "https://example.test/license" },
                    recommendation: { group: "testing", recommended: true },
                    artifacts: [{ path: "a.txt", url: "https://upstream.test/a.txt", format: "txt", contents: "test fixture artifact" }],
                },
                state: "installed",
                receipt: {
                    version: 1,
                    datasetId: "alpha",
                    datasetVersion: "2026.07",
                    activatedAt: "2026-07-14T12:00:00.000Z",
                    artifacts: [{ path: "a.txt", bytes: 5, sha256: sha("alpha") }],
                },
            },
            {
                dataset: {
                    id: "beta",
                    version: "2026.01",
                    title: "Beta reference",
                    description: "Second fixture",
                    sourceUrl: "https://example.test/beta",
                    license: { identifier: "MIT" },
                    recommendation: { group: "extras", recommended: false },
                    artifacts: [{ path: "b.txt", url: "https://upstream.test/b.txt", format: "txt", contents: "test fixture artifact" }],
                },
                state: "missing",
            },
        ],
        userContent: ["user/mine.fa"],
    };

    test("list builder copies fields by name, flattens recommendation, and preserves catalog order", () => {
        expect(buildReferenceListDocument(inspection, "/store/root")).toStrictEqual({
            root: "/store/root",
            exists: true,
            datasets: [
                {
                    id: "alpha",
                    version: "2026.07",
                    title: "Alpha reference",
                    description: "First fixture",
                    sourceUrl: "https://example.test/alpha",
                    license: { identifier: "CC0-1.0", url: "https://example.test/license" },
                    group: "testing",
                    recommended: true,
                    state: "installed",
                    installedVersion: "2026.07",
                    installedAt: "2026-07-14T12:00:00.000Z",
                    artifacts: [{ path: "a.txt", url: "https://upstream.test/a.txt" }],
                },
                {
                    id: "beta",
                    version: "2026.01",
                    title: "Beta reference",
                    description: "Second fixture",
                    sourceUrl: "https://example.test/beta",
                    license: { identifier: "MIT" },
                    group: "extras",
                    recommended: false,
                    state: "missing",
                    artifacts: [{ path: "b.txt", url: "https://upstream.test/b.txt" }],
                },
            ],
            userContent: ["user/mine.fa"],
        });
    });

    test("list builder omits install facts and the license url as absent keys, never null", () => {
        const document = buildReferenceListDocument(inspection, "/store/root");
        const missing = document.datasets[1];
        expect(missing).not.toHaveProperty("installedVersion");
        expect(missing).not.toHaveProperty("installedAt");
        expect(missing?.license).not.toHaveProperty("url");
    });

    test("list builder withholds install facts for a partial install even though it carries a receipt", () => {
        // `inspectReferenceStore` produces `partial` both with and without a receipt; a valid-receipt
        // partial (files incomplete) must not report install facts, or key presence would read as usable
        // while `state` says otherwise. `state` stays the authoritative signal.
        const partial: ReferenceStoreInspection = {
            exists: true,
            datasets: [
                {
                    dataset: {
                        id: "gamma",
                        version: "2026.07",
                        title: "Gamma reference",
                        description: "Damaged fixture",
                        sourceUrl: "https://example.test/gamma",
                        license: { identifier: "CC0-1.0" },
                        recommendation: { group: "testing", recommended: true },
                        artifacts: [{ path: "g.txt", url: "https://upstream.test/g.txt", format: "txt", contents: "test fixture artifact" }],
                    },
                    state: "partial",
                    receipt: {
                        version: 1,
                        datasetId: "gamma",
                        datasetVersion: "2026.07",
                        activatedAt: "2026-07-14T12:00:00.000Z",
                        artifacts: [{ path: "g.txt", bytes: 5, sha256: sha("gamma") }],
                    },
                },
            ],
            userContent: [],
        };
        const entry = buildReferenceListDocument(partial, "/store/root").datasets[0];
        expect(entry?.state).toBe("partial");
        expect(entry).not.toHaveProperty("installedVersion");
        expect(entry).not.toHaveProperty("installedAt");
    });

    test("list document key order is pinned and serialization is byte-stable across builds", () => {
        const first = JSON.stringify(buildReferenceListDocument(inspection, "/store/root"), null, 2);
        const second = JSON.stringify(buildReferenceListDocument(inspection, "/store/root"), null, 2);
        expect(first).toBe(second);
        // The optional install facts sit between `state` and `artifacts`, in that order — the documented
        // shape, pinned by explicit literal construction rather than object-spread happenstance.
        expect(first.indexOf('"state"')).toBeLessThan(first.indexOf('"installedVersion"'));
        expect(first.indexOf('"installedVersion"')).toBeLessThan(first.indexOf('"installedAt"'));
        expect(first.indexOf('"installedAt"')).toBeLessThan(first.indexOf('"artifacts"'));
    });

    test("verify builder wraps results, copies file states, and omits an absent version", () => {
        const verifications: readonly ReferenceVerification[] = [
            { datasetId: "alpha", version: "2026.07", state: "valid", files: [{ path: "a.txt", state: "valid" }] },
            { datasetId: "beta", state: "missing", files: [] },
        ];
        const document = buildReferenceVerifyDocument(verifications);
        expect(document).toStrictEqual({
            datasets: [
                { datasetId: "alpha", version: "2026.07", state: "valid", files: [{ path: "a.txt", state: "valid" }] },
                { datasetId: "beta", state: "missing", files: [] },
            ],
        });
        expect(document.datasets[1]).not.toHaveProperty("version");
        expect(JSON.stringify(document, null, 2)).toBe(JSON.stringify(buildReferenceVerifyDocument(verifications), null, 2));
    });
});

/** N single-artifact datasets — the catalog's dominant shape, and what concurrency actually spans. */
function multiDatasetCatalog(ids: readonly string[]): ReferenceDataCatalog {
    return {
        version: REFERENCE_DATA_CATALOG_VERSION,
        datasets: ids.map((id) => ({
            id,
            version: "2026.07",
            title: id,
            description: "Offline fixture",
            sourceUrl: "https://example.test/source",
            license: { identifier: "CC0-1.0", url: "https://example.test/license" },
            recommendation: { group: "testing", recommended: true },
            artifacts: [{ path: `${id}.txt`, url: url(`${id}.txt`), format: "txt" as const, contents: "test fixture artifact" }],
        })),
    };
}

function datasetFixtures(ids: readonly string[]): readonly Fixture[] {
    return ids.map((id) => ({ path: `${id}.txt`, body: id }));
}

/**
 * An upstream that holds each request open long enough to overlap with others, recording how many
 * were in flight at once. `delayByPath` slows specific artifacts so completion order can be forced
 * to differ from plan order.
 */
function serveConcurrently(
    files: readonly Fixture[],
    state: { active: number; peak: number },
    delayByPath: Record<string, number> = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    const inner = serve(files);
    return async (input, init) => {
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        try {
            const path = String(input).replace("https://upstream.test/", "");
            await new Promise((resolve) => setTimeout(resolve, delayByPath[path] ?? 20));
            return await inner(input, init);
        } finally {
            state.active -= 1;
        }
    };
}

describe("bounded-concurrency installs", () => {
    const IDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    // The plan resolver sorts the selection, so "plan order" is alphabetical — deliberately not the
    // order the ids are requested in, which is what makes the ordering assertions meaningful.
    const PLAN_ORDER = [...IDS].sort();

    test("several datasets transfer at once, capped, and all of them install", async () => {
        const path = root();
        const fixture = multiDatasetCatalog(IDS);
        const state = { active: 0, peak: 0 };

        const result = await installReferenceDatasets(IDS, {
            root: path,
            source: source(fixture),
            fetch: serveConcurrently(datasetFixtures(IDS), state),
            concurrency: 2,
        });

        expect(result._unsafeUnwrap().installed.map((installed) => installed.id)).toEqual(PLAN_ORDER);
        expect(state.peak).toBe(2);
        for (const id of IDS) {
            expect(readFileSync(join(referenceStorePaths(path).managed, id, "2026.07", `${id}.txt`), "utf8")).toBe(id);
        }
    });

    test("a single-slot cap reproduces the serial transfer exactly", async () => {
        const path = root();
        const fixture = multiDatasetCatalog(IDS);
        const state = { active: 0, peak: 0 };

        const result = await installReferenceDatasets(IDS, {
            root: path,
            source: source(fixture),
            fetch: serveConcurrently(datasetFixtures(IDS), state),
            concurrency: 1,
        });

        expect(result._unsafeUnwrap().installed.map((installed) => installed.id)).toEqual(PLAN_ORDER);
        expect(state.peak).toBe(1);
    });

    test("an unusable concurrency request installs on the default instead of throwing", async () => {
        const ids = ["alpha", "beta"];
        const fixture = multiDatasetCatalog(ids);

        // p-queue's setter throws a TypeError below 1 or on a non-number, which would leave this
        // Result-returning call as an exception rather than an `err`. Every shape must still install.
        for (const concurrency of [Number.NaN, 0, -3, 1.5]) {
            const result = await installReferenceDatasets(ids, {
                root: root(),
                source: source(fixture),
                fetch: serveConcurrently(datasetFixtures(ids), { active: 0, peak: 0 }),
                concurrency,
            });
            expect(result._unsafeUnwrap().installed.map((installed) => installed.id)).toEqual(ids);
        }
    });

    test("a caller-supplied attempt id no longer means a shared staging root", async () => {
        const path = root();
        const fixture = multiDatasetCatalog(IDS);
        const state = { active: 0, peak: 0 };

        // Every dataset gets the SAME attempt id — the shape every test seam uses. Staging is wiped on
        // entry and again in `finally`, so before the dataset discriminator was appended unconditionally
        // these installs would have deleted each other's staged files mid-flight.
        const result = await installReferenceDatasets(IDS, {
            root: path,
            source: source(fixture),
            fetch: serveConcurrently(datasetFixtures(IDS), state),
            attemptId: () => "attempt",
        });

        expect(result._unsafeUnwrap().installed).toHaveLength(IDS.length);
        const verified = (await verifyReferenceDatasets(path, IDS, source(fixture)))._unsafeUnwrap();
        expect(verified.map((dataset) => dataset.state)).toEqual(IDS.map(() => "valid"));
        expect(readdirSync(referenceStorePaths(path).staging)).toEqual([]);
    });

    test("the result is in plan order even when completion order is not", async () => {
        const path = root();
        const ids = ["alpha", "beta", "gamma"];
        const fixture = multiDatasetCatalog(ids);
        const state = { active: 0, peak: 0 };

        // The first dataset in plan order finishes last.
        const result = await installReferenceDatasets(ids, {
            root: path,
            source: source(fixture),
            fetch: serveConcurrently(datasetFixtures(ids), state, { "alpha.txt": 80, "beta.txt": 10, "gamma.txt": 5 }),
        });

        expect(result._unsafeUnwrap().installed.map((installed) => installed.id)).toEqual(ids);
    });

    test("the lowest-ordered failure is reported, not whichever failed first", async () => {
        const path = root();
        const ids = ["alpha", "beta", "gamma"];
        const fixture = multiDatasetCatalog(ids);
        const state = { active: 0, peak: 0 };

        // Both alpha and beta 404 (only gamma is served), and beta fails sooner. The reported error
        // must still be alpha's, so the failure is a property of the plan rather than of scheduling.
        const result = await installReferenceDatasets(ids, {
            root: path,
            source: source(fixture),
            fetch: serveConcurrently(datasetFixtures(["gamma"]), state, { "alpha.txt": 60, "beta.txt": 5 }),
        });

        expect(result._unsafeUnwrapErr().message).toContain("alpha.txt");
    });
});
