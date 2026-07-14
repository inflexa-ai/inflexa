import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";

import { REFERENCE_DATA_CATALOG_VERSION, UnknownReferenceDatasetError, type ReferenceDataCatalog, type ReferenceIntegrity } from "@inflexa-ai/harness";
import { err, ok } from "neverthrow";

import {
    inspectReferenceStore,
    installReferenceDatasets,
    referenceDownloadBytes,
    referenceStorePaths,
    verifyReferenceDatasets,
    type ReferenceCatalogSource,
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
    /** Which integrity class the catalog publishes it under. */
    readonly integrity: ReferenceIntegrity;
};

/** Every fixture artifact is fetched straight from its own third-party upstream — there is no distribution base. */
function url(path: string): string {
    return `https://upstream.test/${path}`;
}

const PINNED: readonly Fixture[] = [{ path: "a.txt", body: "alpha", integrity: "pinned" }];

function catalog(files: readonly Fixture[] = PINNED): ReferenceDataCatalog {
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
                artifacts: files.map((file) =>
                    file.integrity === "pinned"
                        ? {
                              integrity: "pinned" as const,
                              path: file.path,
                              url: url(file.path),
                              bytes: Buffer.byteLength(file.body),
                              sha256: sha(file.body),
                          }
                        : { integrity: "unpinned" as const, path: file.path, url: url(file.path) },
                ),
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

/** What the installer asked the upstream for; `range` is the resume request, absent on a fresh transfer. */
type Asked = { readonly url: string; readonly range: string | null };

/** Offline upstream. Serves each fixture's bytes and honors a Range request the way a real server would. */
function serve(files: readonly Fixture[], asked: Asked[] = []): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    const bodies = new Map(files.map((file) => [url(file.path), file.body]));
    return async (input, init) => {
        const target = String(input);
        const range = new Headers(init?.headers).get("range");
        asked.push({ url: target, range });
        const body = bodies.get(target);
        if (body === undefined) return new Response("missing", { status: 404, statusText: "Not Found" });
        if (range === null) return new Response(body);
        // Bodies are ASCII in every fixture, so a character offset is a byte offset.
        return new Response(body.slice(Number(range.slice("bytes=".length, -1))), { status: 206 });
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
                artifacts: [{ path: "old.txt", bytes: 3, sha256: sha("old"), integrity: "pinned" }],
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

describe("pinned installation", () => {
    test("verifies size and digest, activates atomically, and records the observed bytes in the receipt", async () => {
        const path = root();
        const files: readonly Fixture[] = [
            { path: "nested/a.txt", body: "alpha", integrity: "pinned" },
            { path: "b.txt", body: "beta", integrity: "pinned" },
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
                { path: "nested/a.txt", bytes: 5, sha256: sha("alpha"), integrity: "pinned" },
                { path: "b.txt", bytes: 4, sha256: sha("beta"), integrity: "pinned" },
            ],
        });
        expect(readFileSync(join(path, "user", "mine.fa"), "utf8")).toBe("mine");
        expect(await Array.fromAsync(new Bun.Glob("*.part").scan(paths.downloads))).toEqual([]);
        // Every attempt gets a fresh staging id, so a leftover attempt dir would accumulate forever.
        expect(readdirSync(paths.staging)).toEqual([]);
        expect((await inspectReferenceStore(path, fixture))._unsafeUnwrap().datasets[0]?.state).toBe("installed");
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("valid");
        expect((await referenceDownloadBytes(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ bytes: 0, unsizedArtifacts: 0 });

        // An intact install is skipped: the hostile upstream below would fail the digest check if it
        // were ever contacted, so a clean `ok` with zero bytes is the proof that it was not.
        const repeated = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serve([
                { path: "nested/a.txt", body: "ALPHA", integrity: "pinned" },
                { path: "b.txt", body: "BETA", integrity: "pinned" },
            ]),
        });
        expect(repeated._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(0);
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "nested", "a.txt"), "utf8")).toBe("alpha");
    });

    test("resumes a partial transfer with Range, because the catalog knows the final size and digest", async () => {
        const path = root();
        const fixture = catalog();
        const paths = referenceStorePaths(path);
        mkdirSync(paths.downloads, { recursive: true });
        writeFileSync(join(paths.downloads, `${sha("demo/2026.07/a.txt")}.part`), "al");

        const asked: Asked[] = [];
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(PINNED, asked) });
        expect(installed._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(3);
        expect(asked).toEqual([{ url: url("a.txt"), range: "bytes=2-" }]);
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "a.txt"), "utf8")).toBe("alpha");
    });

    test("a digest mismatch activates nothing and leaves an existing activation intact", async () => {
        const path = root();
        const fixture = catalog();
        const paths = referenceStorePaths(path);
        const corrupt: readonly Fixture[] = [{ path: "a.txt", body: "ALPHA", integrity: "pinned" }];

        const damaged = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(corrupt) });
        expect(damaged._unsafeUnwrapErr()).toMatchObject({ type: "digest_mismatch", path: "a.txt", expected: sha("alpha"), actual: sha("ALPHA") });
        expect(existsSync(join(paths.managed, "demo", "2026.07"))).toBe(false);
        expect(existsSync(join(paths.receipts, "demo.json"))).toBe(false);

        const good = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(PINNED) });
        expect(good.isOk()).toBe(true);
        const receipt = readFileSync(join(paths.receipts, "demo.json"), "utf8");

        const forced = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(corrupt) }, { force: true });
        expect(forced._unsafeUnwrapErr().type).toBe("digest_mismatch");
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "a.txt"), "utf8")).toBe("alpha");
        expect(readFileSync(join(paths.receipts, "demo.json"), "utf8")).toBe(receipt);
    });

    test("size mismatch and interrupted streams never activate partial data", async () => {
        const path = root();
        const fixture = catalog();
        const paths = referenceStorePaths(path);

        const short = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: serve([{ path: "a.txt", body: "a", integrity: "pinned" }]),
        });
        expect(short._unsafeUnwrapErr()).toMatchObject({ type: "size_mismatch", path: "a.txt", expected: 5, actual: 1 });
        expect(existsSync(join(paths.receipts, "demo.json"))).toBe(false);

        const interrupted = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            fetch: async () => Promise.reject(new Error("connection lost")),
        });
        expect(interrupted._unsafeUnwrapErr().type).toBe("download_failed");
        expect(existsSync(join(paths.managed, "demo", "2026.07", "a.txt"))).toBe(false);
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
            artifacts: [{ path: "old.txt", bytes: 3, sha256: sha("old"), integrity: "pinned" }],
        });
        writeFileSync(receiptPath, prior);

        const failed = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(catalog()),
            fetch: serve([{ path: "a.txt", body: "ALPHA", integrity: "pinned" }]),
        });
        expect(failed._unsafeUnwrapErr().type).toBe("digest_mismatch");
        expect(readFileSync(receiptPath, "utf8")).toBe(prior);
        expect(readFileSync(join(paths.managed, "demo", "2025.01", "old.txt"), "utf8")).toBe("old");
    });
});

describe("unpinned installation", () => {
    test("installs without a catalog digest and records what the mutable upstream actually served", async () => {
        const path = root();
        const files: readonly Fixture[] = [{ path: "gene_info.gz", body: "mutable-bytes", integrity: "unpinned" }];
        const fixture = catalog(files);
        // The catalog carries no size or digest for an upstream that rebuilds the file in place.
        expect(fixture.datasets[0]?.artifacts[0]).toEqual({ integrity: "unpinned", path: "gene_info.gz", url: url("gene_info.gz") });

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
            { path: "gene_info.gz", bytes: 13, sha256: sha("mutable-bytes"), integrity: "unpinned" },
        ]);
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]).toMatchObject({
            state: "valid",
            files: [{ path: "gene_info.gz", state: "valid", integrity: "unpinned" }],
        });
    });

    test("never resumes a stale partial — a rebuilt upstream would splice two files together", async () => {
        const path = root();
        const files: readonly Fixture[] = [{ path: "gene_info.gz", body: "fresh-upstream", integrity: "unpinned" }];
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
        const files: readonly Fixture[] = [{ path: "gene_info.gz", body: "release-a", integrity: "unpinned" }];
        const fixture = catalog(files);
        const paths = referenceStorePaths(path);
        const active = join(paths.managed, "demo", "2026.07", "gene_info.gz");
        const refreshed: readonly Fixture[] = [{ path: "gene_info.gz", body: "release-b-longer", integrity: "unpinned" }];

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
            { path: "gene_info.gz", bytes: 16, sha256: sha("release-b-longer"), integrity: "unpinned" },
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

        const first = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(PINNED) });
        expect(first._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(5);

        writeFileSync(active, "ALPHA");
        // `refs list` state is deliberately cheap (size-only), so it still reads as installed — but the
        // install gate hashes, so the damage must be seen and healed rather than skipped.
        expect((await inspectReferenceStore(path, fixture))._unsafeUnwrap().datasets[0]?.state).toBe("installed");
        expect((await referenceDownloadBytes(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ bytes: 5, unsizedArtifacts: 0 });
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("modified");

        const healed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(PINNED) });
        expect(healed._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(5);
        expect(readFileSync(active, "utf8")).toBe("alpha");
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("valid");
    });
});

describe("verification", () => {
    test("reports each file against the integrity it was checked with, and detects same-size damage", async () => {
        const path = root();
        const files: readonly Fixture[] = [
            { path: "a.txt", body: "alpha", integrity: "pinned" },
            { path: "b.txt", body: "bravo", integrity: "unpinned" },
        ];
        const fixture = catalog(files);
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(files) });
        expect(installed.isOk()).toBe(true);

        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]).toEqual({
            datasetId: "demo",
            version: "2026.07",
            state: "valid",
            files: [
                { path: "a.txt", state: "valid", integrity: "pinned" },
                { path: "b.txt", state: "valid", integrity: "unpinned" },
            ],
        });

        const active = join(referenceStorePaths(path).managed, "demo", "2026.07");
        writeFileSync(join(active, "a.txt"), "ALPHA");
        rmSync(join(active, "b.txt"));
        const damaged = (await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0];
        expect(damaged?.state).toBe("modified");
        expect(damaged?.files).toEqual([
            { path: "a.txt", state: "modified", integrity: "pinned" },
            { path: "b.txt", state: "missing", integrity: "unpinned" },
        ]);
    });

    test("a symlinked managed file is never followed", async () => {
        const path = root();
        const fixture = catalog();
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(PINNED) });
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
            integrity: "pinned",
        });
    });
});

describe("download estimate", () => {
    test("sums pinned bytes, counts unsized artifacts, and subtracts resumable partials", async () => {
        const path = root();
        const files: readonly Fixture[] = [
            { path: "a.txt", body: "alpha", integrity: "pinned" },
            { path: "b.bin", body: "mutable", integrity: "unpinned" },
        ];
        const fixture = catalog(files);
        const paths = referenceStorePaths(path);

        // Only the mutable upstream can report its own size, and the estimate never goes to the network.
        expect((await referenceDownloadBytes(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ bytes: 5, unsizedArtifacts: 1 });

        mkdirSync(paths.downloads, { recursive: true });
        writeFileSync(join(paths.downloads, `${sha("demo/2026.07/a.txt")}.part`), "al");
        expect((await referenceDownloadBytes(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ bytes: 3, unsizedArtifacts: 1 });

        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(files) });
        expect(installed.isOk()).toBe(true);
        expect((await referenceDownloadBytes(["demo"], path, source(fixture)))._unsafeUnwrap()).toEqual({ bytes: 0, unsizedArtifacts: 0 });
        expect((await referenceDownloadBytes(["demo"], path, source(fixture), { force: true }))._unsafeUnwrap()).toEqual({ bytes: 5, unsizedArtifacts: 1 });
        expect((await referenceDownloadBytes(["unknown"], path, source(fixture)))._unsafeUnwrapErr().type).toBe("unknown_dataset");
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
        const conflict = await installReferenceDatasets(["demo"], { root: path, source: source(catalog()), fetch: serve(PINNED) });
        expect(conflict._unsafeUnwrapErr().type).toBe("managed_path_conflict");
        expect(Array.from(new Bun.Glob("**/*").scanSync(outside))).toEqual([]);
    });

    test("unexpected managed files and directories are never overwritten", async () => {
        const path = root();
        const active = join(referenceStorePaths(path).managed, "demo", "2026.07");
        mkdirSync(join(active, "surprise"), { recursive: true });
        const conflict = await installReferenceDatasets(["demo"], { root: path, source: source(catalog()), fetch: serve(PINNED) });
        expect(conflict._unsafeUnwrapErr().type).toBe("managed_path_conflict");
        expect(statSync(join(active, "surprise")).isDirectory()).toBe(true);
    });

    // The catalog can only promise https for the URL we ask for. An unpinned artifact has no digest
    // to catch a hostile substitution, so a downgraded redirect would be trusted on first use.
    test("refuses bytes served from a non-https location after a redirect", async () => {
        for (const integrity of ["pinned", "unpinned"] as const) {
            const path = root();
            const fixture = catalog([{ path: "a.txt", body: "alpha", integrity }]);
            const redirected = await installReferenceDatasets(["demo"], {
                root: path,
                source: source(fixture),
                fetch: serveRedirectedTo("http://downgraded.test/a.txt", [{ path: "a.txt", body: "alpha", integrity }]),
            });

            expect(redirected._unsafeUnwrapErr().type).toBe("download_failed");
            expect(redirected._unsafeUnwrapErr().message).toContain("non-https");
            expect(existsSync(join(referenceStorePaths(path).managed, "demo"))).toBe(false);
            expect(existsSync(join(referenceStorePaths(path).receipts, "demo.json"))).toBe(false);
        }
    });

    // A receipt is a plain file on disk that anyone can edit, so it is untrusted input. A traversal
    // segment must never let verification reach out of the dataset into `user/` or a sibling.
    test("a receipt whose artifact path escapes the dataset is rejected, and reads no file outside it", async () => {
        const path = root();
        const paths = referenceStorePaths(path);
        const fixture = catalog();
        const installed = await installReferenceDatasets(["demo"], { root: path, source: source(fixture), fetch: serve(PINNED) });
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
                artifacts: [{ path: "../../../user/private.txt", bytes: 42, sha256: sha("alpha"), integrity: "pinned" }],
            }),
        );

        const verified = await verifyReferenceDatasets(path, ["demo"], source(fixture));
        expect(verified._unsafeUnwrap()[0]).toMatchObject({ datasetId: "demo", state: "invalid_receipt", files: [] });

        const inspected = await inspectReferenceStore(path, fixture);
        expect(inspected._unsafeUnwrap().datasets[0]).toMatchObject({ state: "invalid_receipt" });
        expect(readFileSync(secret, "utf8")).toBe("user content the installer must never adopt");
    });
});
