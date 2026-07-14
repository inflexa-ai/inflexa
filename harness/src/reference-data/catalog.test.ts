import { describe, expect, it } from "bun:test";

import {
    REFERENCE_DATA_CATALOG,
    REFERENCE_DATA_CATALOG_VERSION,
    ReferenceDataCatalogSchema,
    UnknownReferenceDatasetError,
    resolveReferenceInstallPlan,
    resolveReferenceInstallPlanFromCatalogForTesting,
} from "./catalog.js";
import { REFERENCE_INSTALL_RECEIPT_VERSION, parseReferenceInstallReceipt } from "./receipt.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function dataset(id: string, paths = ["reference.parquet"]) {
    return {
        id,
        version: "2026.07",
        title: `Dataset ${id}`,
        description: "A fixture reference dataset.",
        sourceUrl: "https://example.org/source",
        license: { identifier: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
        recommendation: { group: "fixtures", recommended: true },
        artifacts: paths.map((path, index) => ({
            key: `fixtures/${id}/${path}`,
            path,
            bytes: index + 1,
            sha256: index === 0 ? HASH_A : HASH_B,
        })),
    };
}

function catalog(datasets: unknown[]) {
    return { version: REFERENCE_DATA_CATALOG_VERSION, datasets };
}

describe("reference-data catalog", () => {
    it("ships validated trusted catalog data", () => {
        expect(ReferenceDataCatalogSchema.safeParse(REFERENCE_DATA_CATALOG).success).toBe(true);
        expect(Object.isFrozen(REFERENCE_DATA_CATALOG)).toBe(true);
        expect(Object.isFrozen(REFERENCE_DATA_CATALOG.datasets)).toBe(true);
        expect(REFERENCE_DATA_CATALOG.datasets.map(({ id }) => id)).toEqual([
            "ncbi-gene-human",
            "ncbi-gene-mouse",
            "ncbi-gene-rat",
            "reactome-pathways",
            "wikipathways-human",
            "collectri-human",
            "gtex-v8",
            "celltypist-immune",
        ]);
    });

    it("records only official upstream dataset sources", () => {
        const officialHosts = new Set(["ftp.ncbi.nlm.nih.gov", "reactome.org", "data.wikipathways.org", "zenodo.org", "gtexportal.org", "www.celltypist.org"]);

        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            expect(officialHosts.has(new URL(dataset.sourceUrl).hostname)).toBe(true);
            for (const artifact of dataset.artifacts) {
                expect(artifact.key).toBe(`${dataset.id}/${dataset.version}/${artifact.path}`);
            }
        }
    });

    it("rejects duplicate dataset ids and artifact destinations", () => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one"), dataset("one")])).success).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one", ["a.parquet", "a.parquet"])]))).toMatchObject({ success: false });
    });

    it.each(["/absolute/file", "../escape", "nested/../../escape", "nested//file", "nested/./file", "nested\\file"])(
        "rejects unsafe artifact path %s",
        (path) => {
            expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("unsafe", [path])])).success).toBe(false);
        },
    );

    it("rejects malformed digests and non-positive sizes", () => {
        const badDigest = dataset("bad-digest");
        badDigest.artifacts[0]!.sha256 = "abc";
        expect(ReferenceDataCatalogSchema.safeParse(catalog([badDigest])).success).toBe(false);

        const badSize = dataset("bad-size");
        badSize.artifacts[0]!.bytes = 0;
        expect(ReferenceDataCatalogSchema.safeParse(catalog([badSize])).success).toBe(false);
    });

    it.each(["../escape", "nested/version", "nested\\version", ".", ".."])("rejects unsafe dataset version %s", (version) => {
        const unsafe = dataset("unsafe-version");
        unsafe.version = version;
        expect(ReferenceDataCatalogSchema.safeParse(catalog([unsafe])).success).toBe(false);
    });

    it("resolves a deterministic, deduplicated multi-file plan", () => {
        const parsed = ReferenceDataCatalogSchema.parse(catalog([dataset("zeta"), dataset("alpha", ["one.parquet", "two.json"])]));
        const plan = resolveReferenceInstallPlanFromCatalogForTesting(["zeta", "alpha", "zeta"], parsed)._unsafeUnwrap();

        expect(plan.datasets.map((item) => item.id)).toEqual(["alpha", "zeta"]);
        expect(plan.datasets[0]!.installPath).toBe("alpha/2026.07");
        expect(plan.datasets[0]!.artifacts.map((artifact) => artifact.path)).toEqual(["one.parquet", "two.json"]);
    });

    it("returns a typed error without a partial plan for an unknown id", () => {
        const parsed = ReferenceDataCatalogSchema.parse(catalog([dataset("zeta"), dataset("alpha")]));
        const error = resolveReferenceInstallPlanFromCatalogForTesting(["alpha", "missing"], parsed)._unsafeUnwrapErr();
        expect(error).toBeInstanceOf(UnknownReferenceDatasetError);
        expect(error).toMatchObject({ unknownId: "missing", availableIds: ["alpha", "zeta"] });
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
                "reactome-pathways",
                "wikipathways-human",
            ],
        });
    });
});

describe("reference installation receipt", () => {
    const valid = {
        version: REFERENCE_INSTALL_RECEIPT_VERSION,
        datasetId: "alpha",
        datasetVersion: "2026.07",
        activatedAt: "2026-07-14T10:30:00.000Z",
        artifacts: [{ path: "one.parquet", bytes: 42, sha256: HASH_A }],
    };

    it("parses valid versioned receipts", () => {
        expect(parseReferenceInstallReceipt(valid)).toEqual(valid);
    });

    it("degrades invalid receipt metadata to undefined", () => {
        expect(parseReferenceInstallReceipt({ ...valid, version: 99 })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, activatedAt: "yesterday" })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, datasetVersion: "../escape" })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [{ ...valid.artifacts[0], path: "../escape" }] })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [valid.artifacts[0], valid.artifacts[0]] })).toBeUndefined();
    });
});
