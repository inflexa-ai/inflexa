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
                artifacts: files.map((file) => ({ path: file.path, url: url(file.path) })),
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
        expect(fixture.datasets[0]?.artifacts[0]).toEqual({ path: "gene_info.gz", url: url("gene_info.gz") });

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
                    artifacts: [{ path: "a.txt", url: "https://upstream.test/a.txt" }],
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
                    artifacts: [{ path: "b.txt", url: "https://upstream.test/b.txt" }],
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
