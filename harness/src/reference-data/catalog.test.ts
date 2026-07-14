import { describe, expect, it } from "bun:test";

import {
    REFERENCE_DATA_CATALOG,
    REFERENCE_DATA_CATALOG_VERSION,
    ReferenceArtifactSchema,
    ReferenceDataCatalogSchema,
    UnknownReferenceDatasetError,
    referenceArtifactKey,
    resolveReferenceInstallPlan,
    resolveReferenceInstallPlanFromCatalogForTesting,
} from "./catalog.js";
import { REFERENCE_INSTALL_RECEIPT_VERSION, parseReferenceInstallReceipt } from "./receipt.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function pinned(path: string, index = 0): Record<string, unknown> {
    return {
        integrity: "pinned",
        path,
        url: `https://example.org/immutable/artifact-${index}`,
        bytes: index + 1,
        sha256: index === 0 ? HASH_A : HASH_B,
    };
}

function unpinned(path: string, index = 0): Record<string, unknown> {
    return { integrity: "unpinned", path, url: `https://example.org/current/artifact-${index}` };
}

function dataset(id: string, artifacts: Record<string, unknown>[] = [pinned("reference.parquet")]): Record<string, unknown> {
    return {
        id,
        version: "2026.07",
        title: `Dataset ${id}`,
        description: "A fixture reference dataset.",
        sourceUrl: "https://example.org/source",
        license: { identifier: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
        recommendation: { group: "fixtures", recommended: true },
        artifacts,
    };
}

function catalog(datasets: unknown[]) {
    return { version: REFERENCE_DATA_CATALOG_VERSION, datasets };
}

describe("reference-data catalog", () => {
    // The shipped catalog is parsed at module load, so a malformed entry throws on
    // import and every test in this file fails — re-parsing here only pins the shape.
    it("ships validated trusted catalog data", () => {
        expect(ReferenceDataCatalogSchema.safeParse(REFERENCE_DATA_CATALOG).success).toBe(true);
        expect(Object.isFrozen(REFERENCE_DATA_CATALOG)).toBe(true);
        expect(Object.isFrozen(REFERENCE_DATA_CATALOG.datasets)).toBe(true);
        expect(REFERENCE_DATA_CATALOG.datasets.map(({ id }) => id)).toEqual([
            "ncbi-gene-human",
            "ncbi-gene-mouse",
            "ncbi-gene-rat",
            "reactome-pathways",
            "reactome-mappings",
            "wikipathways-human",
            "collectri-human",
            "gtex-v8",
            "celltypist-immune",
        ]);
    });

    // The ~700 MB of uncompressed Reactome mapping TSV is opt-in, so a default `setup` never
    // silently pulls two orders of magnitude more than the gene sets it actually asked for.
    it("recommends every dataset except the very large opt-in mapping tables", () => {
        const notRecommended = REFERENCE_DATA_CATALOG.datasets.filter((dataset) => !dataset.recommendation.recommended).map(({ id }) => id);

        expect(notRecommended).toEqual(["reactome-mappings"]);
    });

    it("fetches every artifact from an official upstream over https", () => {
        const officialHosts = new Set([
            "ftp.ncbi.nlm.nih.gov",
            "reactome.org",
            "data.wikipathways.org",
            "zenodo.org",
            "gtexportal.org",
            "storage.googleapis.com",
            "celltypist.cog.sanger.ac.uk",
            "www.celltypist.org",
        ]);

        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            expect(officialHosts.has(new URL(dataset.sourceUrl).hostname)).toBe(true);
            for (const artifact of dataset.artifacts) {
                expect(artifact.url.startsWith("https://")).toBe(true);
                expect(new URL(artifact.url).protocol).toBe("https:");
                expect(officialHosts.has(new URL(artifact.url).hostname)).toBe(true);
            }
        }
    });

    it("pins size and digest exactly for the immutable upstreams and for no other", () => {
        const byIntegrity = { pinned: [] as string[], unpinned: [] as string[] };

        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            for (const artifact of dataset.artifacts) {
                byIntegrity[artifact.integrity].push(dataset.id);
                if (artifact.integrity === "pinned") {
                    expect(artifact.bytes).toBeGreaterThan(0);
                    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
                } else {
                    // A mutable upstream admits no checked-in digest: the receipt is the record.
                    expect(artifact).not.toHaveProperty("bytes");
                    expect(artifact).not.toHaveProperty("sha256");
                    expect(dataset.version).toBe("current");
                }
            }
        }

        expect([...new Set(byIntegrity.pinned)]).toEqual(["wikipathways-human", "collectri-human", "gtex-v8", "celltypist-immune"]);
        expect([...new Set(byIntegrity.unpinned)]).toEqual([
            "ncbi-gene-human",
            "ncbi-gene-mouse",
            "ncbi-gene-rat",
            "reactome-pathways",
            "reactome-mappings",
        ]);
    });

    it("keys every catalog artifact by its stable, URL-independent identity", () => {
        expect(referenceArtifactKey({ id: "alpha", version: "2026.07" }, { path: "nested/one.parquet" })).toBe("alpha/2026.07/nested/one.parquet");

        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            for (const artifact of dataset.artifacts) {
                expect(referenceArtifactKey(dataset, artifact)).toBe(`${dataset.id}/${dataset.version}/${artifact.path}`);
            }
        }
    });

    it("accepts both integrity classes and rejects an unknown discriminant", () => {
        expect(ReferenceArtifactSchema.safeParse(pinned("one.parquet")).success).toBe(true);
        expect(ReferenceArtifactSchema.safeParse(unpinned("current.gz")).success).toBe(true);
        expect(ReferenceArtifactSchema.safeParse({ path: "one.parquet", url: "https://example.org/one" }).success).toBe(false);
        expect(ReferenceArtifactSchema.safeParse({ integrity: "trusted", path: "one.parquet", url: "https://example.org/one" }).success).toBe(false);
    });

    // A digest on an unpinned artifact is a category error: the upstream rewrites that URL, so the
    // digest is guaranteed to go stale. Silently stripping it would let the mistake reach review
    // looking like a pinned entry, so the schema rejects it outright.
    it("rejects a size and digest offered for an unpinned artifact", () => {
        expect(ReferenceArtifactSchema.safeParse({ ...unpinned("current.gz"), bytes: 5, sha256: HASH_A }).success).toBe(false);
        expect(ReferenceArtifactSchema.safeParse({ ...unpinned("current.gz"), sha256: HASH_A }).success).toBe(false);
        expect(ReferenceArtifactSchema.safeParse(unpinned("current.gz")).success).toBe(true);
    });

    it.each(["http://example.org/one", "ftp://ftp.example.org/one", "file:///etc/passwd", "example.org/one", ""])(
        "rejects non-https artifact url %s",
        (url) => {
            expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("bad-url", [{ ...pinned("one.parquet"), url }])])).success).toBe(false);
        },
    );

    it("requires a size and digest on a pinned artifact", () => {
        const { sha256: _sha256, ...noDigest } = pinned("one.parquet");
        const { bytes: _bytes, ...noSize } = pinned("one.parquet");

        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("no-digest", [noDigest])])).success).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("no-size", [noSize])])).success).toBe(false);
    });

    it("rejects duplicate dataset ids and artifact destinations", () => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one"), dataset("one")])).success).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one", [pinned("a.parquet", 0), pinned("a.parquet", 1)])])).success).toBe(false);
        // A path collides across integrity classes too — the destination is what must be unique.
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one", [pinned("a.parquet"), unpinned("a.parquet")])])).success).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one", [pinned("a.parquet", 0), pinned("b.parquet", 1)])])).success).toBe(true);
    });

    it.each(["/absolute/file", "../escape", "nested/../../escape", "nested//file", "nested/./file", "nested\\file", ""])(
        "rejects unsafe artifact path %s",
        (path) => {
            expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("unsafe", [pinned(path)])])).success).toBe(false);
            expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("unsafe", [unpinned(path)])])).success).toBe(false);
        },
    );

    it("rejects malformed digests and non-positive sizes", () => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("bad-digest", [{ ...pinned("a.parquet"), sha256: "abc" }])])).success).toBe(false);
        expect(
            ReferenceDataCatalogSchema.safeParse(catalog([dataset("upper-digest", [{ ...pinned("a.parquet"), sha256: HASH_A.toUpperCase() }])])).success,
        ).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("bad-size", [{ ...pinned("a.parquet"), bytes: 0 }])])).success).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("float-size", [{ ...pinned("a.parquet"), bytes: 1.5 }])])).success).toBe(false);
    });

    it("requires at least one artifact per dataset", () => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("empty", [])])).success).toBe(false);
    });

    it.each(["../escape", "nested/version", "nested\\version", ".", ".."])("rejects unsafe dataset version %s", (version) => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([{ ...dataset("unsafe-version"), version }])).success).toBe(false);
    });

    it("resolves a deterministic, deduplicated multi-file plan across both integrity classes", () => {
        const parsed = ReferenceDataCatalogSchema.parse(catalog([dataset("zeta"), dataset("alpha", [pinned("one.parquet", 0), unpinned("two.json", 1)])]));
        const plan = resolveReferenceInstallPlanFromCatalogForTesting(["zeta", "alpha", "zeta"], parsed)._unsafeUnwrap();

        expect(plan.catalogVersion).toBe(REFERENCE_DATA_CATALOG_VERSION);
        expect(plan.datasets.map((item) => item.id)).toEqual(["alpha", "zeta"]);
        expect(plan.datasets[0]!.installPath).toBe("alpha/2026.07");
        expect(plan.datasets[1]!.installPath).toBe("zeta/2026.07");
        expect(plan.datasets[0]!.artifacts.map((artifact) => artifact.path)).toEqual(["one.parquet", "two.json"]);
        expect(plan.datasets[0]!.artifacts.map((artifact) => artifact.integrity)).toEqual(["pinned", "unpinned"]);
        expect(plan.datasets[0]!.artifacts.map((artifact) => artifact.url)).toEqual([
            "https://example.org/immutable/artifact-0",
            "https://example.org/current/artifact-1",
        ]);
        expect(referenceArtifactKey(plan.datasets[0]!, plan.datasets[0]!.artifacts[0]!)).toBe("alpha/2026.07/one.parquet");
    });

    it("returns a typed error without a partial plan for an unknown id", () => {
        const parsed = ReferenceDataCatalogSchema.parse(catalog([dataset("zeta"), dataset("alpha")]));
        const error = resolveReferenceInstallPlanFromCatalogForTesting(["alpha", "missing"], parsed)._unsafeUnwrapErr();
        expect(error).toBeInstanceOf(UnknownReferenceDatasetError);
        expect(error).toMatchObject({ code: "unknown_reference_dataset", unknownId: "missing", availableIds: ["alpha", "zeta"] });
    });

    it("resolves public selections only against the canonical catalog", () => {
        expect(resolveReferenceInstallPlan(["fixture-only"])._unsafeUnwrapErr()).toMatchObject({
            unknownId: "fixture-only",
            availableIds: [
                "celltypist-immune",
                "collectri-human",
                "gtex-v8",
                "ncbi-gene-human",
                "ncbi-gene-mouse",
                "ncbi-gene-rat",
                "reactome-mappings",
                "reactome-pathways",
                "wikipathways-human",
            ],
        });

        const plan = resolveReferenceInstallPlan(["reactome-pathways", "gtex-v8"])._unsafeUnwrap();
        expect(plan.datasets.map((item) => item.installPath)).toEqual(["gtex-v8/8", "reactome-pathways/current"]);
    });
});

describe("reference installation receipt", () => {
    const valid = {
        version: REFERENCE_INSTALL_RECEIPT_VERSION,
        datasetId: "alpha",
        datasetVersion: "2026.07",
        activatedAt: "2026-07-14T10:30:00.000Z",
        artifacts: [
            { path: "one.parquet", bytes: 42, sha256: HASH_A, integrity: "pinned" as const },
            { path: "nested/current.gz", bytes: 0, sha256: HASH_B, integrity: "unpinned" as const },
        ],
    };

    it("records observed bytes and digest for both integrity classes", () => {
        expect(parseReferenceInstallReceipt(valid)).toEqual(valid);
    });

    it("degrades invalid receipt metadata to undefined", () => {
        expect(parseReferenceInstallReceipt(undefined)).toBeUndefined();
        expect(parseReferenceInstallReceipt("garbage")).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, version: 99 })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, activatedAt: "yesterday" })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, datasetVersion: "../escape" })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [] })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [{ ...valid.artifacts[0], path: "../escape" }] })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [{ ...valid.artifacts[0], sha256: "abc" }] })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [valid.artifacts[0], valid.artifacts[0]] })).toBeUndefined();
    });

    it("requires an observed integrity class on every receipt artifact", () => {
        const { integrity: _integrity, ...noIntegrity } = valid.artifacts[0]!;

        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [noIntegrity] })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [{ ...valid.artifacts[0], integrity: "trusted" }] })).toBeUndefined();
    });

    it("requires an observed digest even where the catalog could not pin one", () => {
        const { sha256: _sha256, ...noDigest } = valid.artifacts[1]!;
        const { bytes: _bytes, ...noSize } = valid.artifacts[1]!;

        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [noDigest] })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [noSize] })).toBeUndefined();
    });
});
