import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUIDv7 } from "bun";

import { REFERENCE_DATA_CATALOG_VERSION, UnknownReferenceDatasetError, type ReferenceDataCatalog } from "@inflexa-ai/harness";
import { err, ok } from "neverthrow";

import {
    inspectReferenceStore,
    installReferenceDatasets,
    referenceDownloadBytes,
    referenceStorePaths,
    resolvePublicArtifactUrl,
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

function catalog(files: readonly { key: string; path: string; body: string }[] = [{ key: "demo/a.txt", path: "a.txt", body: "alpha" }]): ReferenceDataCatalog {
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
                artifacts: files.map((file) => ({ key: file.key, path: file.path, bytes: Buffer.byteLength(file.body), sha256: sha(file.body) })),
            },
        ],
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

function resolver(key: string) {
    return resolvePublicArtifactUrl(key, "https://refs.example.test/releases/");
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

describe("reference installation", () => {
    test("activates multiple verified final files, writes a receipt, cleans partials, and preserves user content", async () => {
        const path = root();
        const fixture = catalog([
            { key: "demo/a.txt", path: "nested/a.txt", body: "alpha" },
            { key: "demo/b.txt", path: "b.txt", body: "beta" },
        ]);
        mkdirSync(join(path, "user"), { recursive: true });
        writeFileSync(join(path, "user", "mine.fa"), "mine");
        const bodies = new Map([
            ["https://refs.example.test/releases/demo/a.txt", "alpha"],
            ["https://refs.example.test/releases/demo/b.txt", "beta"],
        ]);
        const result = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            resolveArtifactUrl: resolver,
            fetch: async (input) => new Response(bodies.get(String(input)) ?? "missing"),
            now: () => new Date("2026-07-14T12:00:00.000Z"),
            attemptId: () => "attempt",
        });
        expect(result._unsafeUnwrap().installed[0]).toMatchObject({ id: "demo", version: "2026.07", bytesDownloaded: 9 });
        const paths = referenceStorePaths(path);
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "nested", "a.txt"), "utf8")).toBe("alpha");
        expect(readFileSync(join(paths.managed, "demo", "2026.07", "b.txt"), "utf8")).toBe("beta");
        expect(JSON.parse(readFileSync(join(paths.receipts, "demo.json"), "utf8"))).toMatchObject({ datasetId: "demo", datasetVersion: "2026.07" });
        expect(readFileSync(join(path, "user", "mine.fa"), "utf8")).toBe("mine");
        expect((await Array.fromAsync(new Bun.Glob("*.part").scan(paths.downloads))).length).toBe(0);
        expect((await inspectReferenceStore(path, fixture))._unsafeUnwrap().datasets[0]?.state).toBe("installed");
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.state).toBe("valid");
        expect((await referenceDownloadBytes(["demo"], path, source(fixture)))._unsafeUnwrap()).toBe(0);

        let fetched = false;
        const repeated = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            resolveArtifactUrl: resolver,
            fetch: async () => {
                fetched = true;
                return new Response("unexpected");
            },
        });
        expect(repeated._unsafeUnwrap().installed[0]?.bytesDownloaded).toBe(0);
        expect(fetched).toBe(false);
    });

    test("resumes a partial response with Range and refuses digest damage without activation", async () => {
        const path = root();
        const fixture = catalog([{ key: "demo/a.txt", path: "a.txt", body: "alpha" }]);
        const paths = referenceStorePaths(path);
        const partName = `${sha("demo/a.txt")}.part`;
        mkdirSync(paths.downloads, { recursive: true });
        writeFileSync(join(paths.downloads, partName), "al");
        let range: string | null = null;
        const installed = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            resolveArtifactUrl: resolver,
            fetch: async (_input, init) => {
                range = new Headers(init?.headers).get("range");
                return new Response("pha", { status: 206 });
            },
            attemptId: () => "resume",
        });
        expect(installed.isOk()).toBe(true);
        expect(String(range)).toBe("bytes=2-");

        rmSync(join(paths.managed, "demo", "2026.07"), { recursive: true, force: true });
        rmSync(join(paths.receipts, "demo.json"), { force: true });
        mkdirSync(paths.downloads, { recursive: true });
        writeFileSync(join(paths.downloads, partName), "ALPHA");
        const damaged = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            resolveArtifactUrl: resolver,
            fetch: async () => new Response("ALPHA"),
            attemptId: () => "damage",
        });
        expect(damaged._unsafeUnwrapErr().type).toBe("digest_mismatch");
        expect(await Bun.file(join(paths.receipts, "demo.json")).exists()).toBe(false);
    });

    test("unknown ids and reserved symlink conflicts mutate nothing", async () => {
        const path = root();
        const unknownCatalog = catalog();
        const unknown = await installReferenceDatasets(["unknown"], { root: path, source: source(unknownCatalog), resolveArtifactUrl: resolver });
        expect(unknown._unsafeUnwrapErr().type).toBe("unknown_dataset");
        expect(await Bun.file(path).exists()).toBe(false);

        const outside = root();
        mkdirSync(path, { recursive: true });
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(path, ".inflexa"));
        const conflict = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(catalog()),
            resolveArtifactUrl: resolver,
            fetch: async () => new Response("alpha"),
        });
        expect(conflict._unsafeUnwrapErr().type).toBe("managed_path_conflict");
        expect(Array.from(new Bun.Glob("**/*").scanSync(outside))).toEqual([]);
    });

    test("size mismatch and interrupted streams never activate partial data", async () => {
        const path = root();
        const fixture = catalog();
        const short = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            resolveArtifactUrl: resolver,
            fetch: async () => new Response("a"),
            attemptId: () => "short",
        });
        expect(short._unsafeUnwrapErr().type).toBe("size_mismatch");
        expect(await Bun.file(join(referenceStorePaths(path).receipts, "demo.json")).exists()).toBe(false);

        const interrupted = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            resolveArtifactUrl: resolver,
            fetch: async () => Promise.reject(new Error("connection lost")),
            attemptId: () => "interrupted",
        });
        expect(interrupted._unsafeUnwrapErr().type).toBe("download_failed");
        expect(await Bun.file(join(referenceStorePaths(path).managed, "demo", "2026.07", "a.txt")).exists()).toBe(false);
    });

    test("failed updates preserve the prior active version and receipt", async () => {
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

        const failed = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(catalog()),
            resolveArtifactUrl: resolver,
            fetch: async () => new Response("ALPHA"),
            attemptId: () => "failed-update",
        });
        expect(failed._unsafeUnwrapErr().type).toBe("digest_mismatch");
        expect(readFileSync(receiptPath, "utf8")).toBe(prior);
        expect(readFileSync(join(paths.managed, "demo", "2025.01", "old.txt"), "utf8")).toBe("old");
    });

    test("verification detects deleted, modified, and symlinked managed files without following links", async () => {
        const path = root();
        const fixture = catalog([
            { key: "demo/a", path: "a.txt", body: "alpha" },
            { key: "demo/b", path: "b.txt", body: "beta" },
        ]);
        await installReferenceDatasets(["demo"], {
            root: path,
            source: source(fixture),
            resolveArtifactUrl: resolver,
            fetch: async (input) => new Response(String(input).endsWith("/a") ? "alpha" : "beta"),
        });
        const active = join(referenceStorePaths(path).managed, "demo", "2026.07");
        rmSync(join(active, "a.txt"));
        writeFileSync(join(active, "b.txt"), "BETA");
        const damaged = (await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0];
        expect(damaged?.files).toEqual([
            { path: "a.txt", state: "missing" },
            { path: "b.txt", state: "modified" },
        ]);

        rmSync(join(active, "b.txt"));
        const outside = root();
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "beta"), "beta");
        symlinkSync(join(outside, "beta"), join(active, "b.txt"));
        expect((await verifyReferenceDatasets(path, ["demo"], source(fixture)))._unsafeUnwrap()[0]?.files[1]?.state).toBe("missing");
    });

    test("unexpected managed files and directories are never overwritten", async () => {
        const path = root();
        const active = join(referenceStorePaths(path).managed, "demo", "2026.07");
        mkdirSync(join(active, "surprise"), { recursive: true });
        const conflict = await installReferenceDatasets(["demo"], {
            root: path,
            source: source(catalog()),
            resolveArtifactUrl: resolver,
            fetch: async () => new Response("alpha"),
        });
        expect(conflict._unsafeUnwrapErr().type).toBe("managed_path_conflict");
        expect(statSync(join(active, "surprise")).isDirectory()).toBe(true);
    });
});

describe("public artifact resolver", () => {
    test("keeps opaque keys under the configured base", () => {
        expect(resolvePublicArtifactUrl("demo/a file.fa", "https://refs.example/base")._unsafeUnwrap().href).toBe("https://refs.example/base/demo/a%20file.fa");
    });

    test("rejects missing configuration and escaping keys", () => {
        expect(resolvePublicArtifactUrl("demo/a", undefined).isErr()).toBe(true);
        expect(resolvePublicArtifactUrl("../secret", "https://refs.example/base").isErr()).toBe(true);
        expect(resolvePublicArtifactUrl("https://evil.example/a", "https://refs.example/base").isErr()).toBe(true);
    });
});
