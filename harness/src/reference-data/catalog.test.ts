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

function artifact(path: string, index = 0): Record<string, unknown> {
    return { path, url: `https://example.org/artifact-${index}`, format: "parquet", contents: "A fixture table." };
}

function dataset(id: string, artifacts: Record<string, unknown>[] = [artifact("reference.parquet")]): Record<string, unknown> {
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
            "ncbi-gene2ensembl",
            "ncbi-gene2refseq",
            "uniprot-idmapping-human",
            "uniprot-idmapping-mouse",
            "uniprot-idmapping-rat",
            "reactome-pathways",
            "reactome-mappings",
            "wikipathways-human",
            "wikipathways-mouse",
            "wikipathways-rat",
            "msigdb-hallmark-human",
            "msigdb-hallmark-mouse",
            "collectri-human",
            "progeny-human",
            "progeny-mouse",
            "dorothea-human",
            "dorothea-mouse",
            "gtex-v8",
            "hpa-proteinatlas",
            "celltypist-immune",
            "celltypist-pan-fetal",
            "celltypist-covid19",
            "panglaodb-markers",
            "azimuth-pbmc",
            "azimuth-tonsil",
            "gencode-human",
            "gencode-mouse",
            "ucsc-chrom-sizes-human",
            "ucsc-chrom-sizes-mouse",
            "encode-blacklist-human",
            "encode-blacklist-mouse",
            "clinvar-grch38",
            "silva-dada2",
            "unite-dada2",
            "pharmcat-grch38-fasta",
        ]);
    });

    // Large or domain-specific downloads are opt-in, so a default `setup` never silently pulls
    // hundreds of MB (or GB) the user did not ask for: the all-species NCBI mapping tables, the
    // Reactome mapping TSVs, the 443 MB tonsil reference, the amplicon taxonomy training sets,
    // and the 842 MB PharmCAT genome bundle.
    it("recommends every dataset except the very large or domain-specific opt-in downloads", () => {
        const notRecommended = REFERENCE_DATA_CATALOG.datasets.filter((dataset) => !dataset.recommendation.recommended).map(({ id }) => id);

        expect(notRecommended).toEqual([
            "ncbi-gene2ensembl",
            "ncbi-gene2refseq",
            "reactome-mappings",
            "azimuth-tonsil",
            "gencode-human",
            "gencode-mouse",
            "clinvar-grch38",
            "silva-dada2",
            "unite-dada2",
            "pharmcat-grch38-fasta",
        ]);
    });

    it("fetches every artifact from an official upstream over https", () => {
        const officialHosts = new Set([
            "ftp.ncbi.nlm.nih.gov",
            "ftp.uniprot.org",
            "reactome.org",
            "data.wikipathways.org",
            "data.broadinstitute.org",
            "zenodo.org",
            "gtexportal.org",
            "storage.googleapis.com",
            "www.proteinatlas.org",
            "panglaodb.se",
            "celltypist.cog.sanger.ac.uk",
            "www.celltypist.org",
            "github.com",
            "raw.githubusercontent.com",
            "ftp.ebi.ac.uk",
            "hgdownload.soe.ucsc.edu",
            "www.gencodegenes.org",
            "www.arb-silva.de",
            "doi.plutof.ut.ee",
            "s3.hpc.ut.ee",
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

    // The uniform trust-on-first-use model: an artifact carries where to fetch it and what it holds,
    // never a size or digest to compute, review, or let go stale. Integrity lives entirely in the
    // install receipt, off the bytes the user actually downloaded. Descriptive fields are welcome —
    // they cost no maintenance and are what lets a caller find a file without knowing its path —
    // but the exact key set is pinned so an integrity field cannot reappear unnoticed.
    it("describes every artifact without a checked-in size or digest", () => {
        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            for (const artifact of dataset.artifacts) {
                expect(Object.keys(artifact).sort()).toEqual(["contents", "format", "path", "url"]);
            }
        }
    });

    // Skills name no paths, so an entry is only findable through what it says about itself.
    it("gives every artifact a format and a non-restating description of its contents", () => {
        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            for (const artifact of dataset.artifacts) {
                expect(artifact.format).toMatch(/^[a-z0-9]+(?:[+-][a-z0-9]+)*$/);
                expect(artifact.contents.length).toBeGreaterThan(40);
                expect(artifact.contents).not.toBe(dataset.title);
            }
        }
    });

    // Wrong-species reference data still runs and silently produces wrong numbers, so a
    // single-organism dataset must say which one; multi-species sources correctly omit it.
    it("labels every single-organism dataset with its organism", () => {
        const multiSpecies = new Set([
            "ncbi-gene2ensembl",
            "ncbi-gene2refseq",
            "reactome-pathways",
            "reactome-mappings",
            "panglaodb-markers",
            // Microbial/fungal community references — a whole domain of life each, not one organism.
            "silva-dada2",
            "unite-dada2",
        ]);
        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            expect(dataset.organism === undefined).toBe(multiSpecies.has(dataset.id));
        }
    });

    it("keys every catalog artifact by its stable, URL-independent identity", () => {
        expect(referenceArtifactKey({ id: "alpha", version: "2026.07" }, { path: "nested/one.parquet" })).toBe("alpha/2026.07/nested/one.parquet");

        for (const dataset of REFERENCE_DATA_CATALOG.datasets) {
            for (const artifact of dataset.artifacts) {
                expect(referenceArtifactKey(dataset, artifact)).toBe(`${dataset.id}/${dataset.version}/${artifact.path}`);
            }
        }
    });

    it("accepts a path+url artifact and rejects missing fields or a stray size/digest", () => {
        expect(ReferenceArtifactSchema.safeParse(artifact("one.parquet")).success).toBe(true);
        expect(ReferenceArtifactSchema.safeParse({ path: "one.parquet" }).success).toBe(false);
        expect(ReferenceArtifactSchema.safeParse({ url: "https://example.org/one" }).success).toBe(false);
        // strictObject: a stray size or digest is a mistake (the catalog pins nothing), so it is rejected
        // outright rather than silently accepted and never verified.
        expect(ReferenceArtifactSchema.safeParse({ ...artifact("one.parquet"), bytes: 5 }).success).toBe(false);
        expect(ReferenceArtifactSchema.safeParse({ ...artifact("one.parquet"), sha256: HASH_A }).success).toBe(false);
        expect(ReferenceArtifactSchema.safeParse({ ...artifact("one.parquet"), integrity: "pinned" }).success).toBe(false);
    });

    it.each(["http://example.org/one", "ftp://ftp.example.org/one", "file:///etc/passwd", "example.org/one", ""])(
        "rejects non-https artifact url %s",
        (url) => {
            expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("bad-url", [{ ...artifact("one.parquet"), url }])])).success).toBe(false);
        },
    );

    it("rejects duplicate dataset ids and artifact destinations", () => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one"), dataset("one")])).success).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one", [artifact("a.parquet", 0), artifact("a.parquet", 1)])])).success).toBe(false);
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("one", [artifact("a.parquet", 0), artifact("b.parquet", 1)])])).success).toBe(true);
    });

    it.each(["/absolute/file", "../escape", "nested/../../escape", "nested//file", "nested/./file", "nested\\file", ""])(
        "rejects unsafe artifact path %s",
        (path) => {
            expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("unsafe", [artifact(path)])])).success).toBe(false);
        },
    );

    it("requires at least one artifact per dataset", () => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([dataset("empty", [])])).success).toBe(false);
    });

    it.each(["../escape", "nested/version", "nested\\version", ".", ".."])("rejects unsafe dataset version %s", (version) => {
        expect(ReferenceDataCatalogSchema.safeParse(catalog([{ ...dataset("unsafe-version"), version }])).success).toBe(false);
    });

    it("resolves a deterministic, deduplicated multi-file plan", () => {
        const parsed = ReferenceDataCatalogSchema.parse(catalog([dataset("zeta"), dataset("alpha", [artifact("one.parquet", 0), artifact("two.json", 1)])]));
        const plan = resolveReferenceInstallPlanFromCatalogForTesting(["zeta", "alpha", "zeta"], parsed)._unsafeUnwrap();

        expect(plan.catalogVersion).toBe(REFERENCE_DATA_CATALOG_VERSION);
        expect(plan.datasets.map((item) => item.id)).toEqual(["alpha", "zeta"]);
        expect(plan.datasets[0]!.installPath).toBe("alpha/2026.07");
        expect(plan.datasets[1]!.installPath).toBe("zeta/2026.07");
        expect(plan.datasets[0]!.artifacts.map((artifact) => artifact.path)).toEqual(["one.parquet", "two.json"]);
        expect(plan.datasets[0]!.artifacts.map((artifact) => artifact.url)).toEqual(["https://example.org/artifact-0", "https://example.org/artifact-1"]);
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
                "azimuth-pbmc",
                "azimuth-tonsil",
                "celltypist-covid19",
                "celltypist-immune",
                "celltypist-pan-fetal",
                "clinvar-grch38",
                "collectri-human",
                "dorothea-human",
                "dorothea-mouse",
                "encode-blacklist-human",
                "encode-blacklist-mouse",
                "gencode-human",
                "gencode-mouse",
                "gtex-v8",
                "hpa-proteinatlas",
                "msigdb-hallmark-human",
                "msigdb-hallmark-mouse",
                "ncbi-gene-human",
                "ncbi-gene-mouse",
                "ncbi-gene-rat",
                "ncbi-gene2ensembl",
                "ncbi-gene2refseq",
                "panglaodb-markers",
                "pharmcat-grch38-fasta",
                "progeny-human",
                "progeny-mouse",
                "reactome-mappings",
                "reactome-pathways",
                "silva-dada2",
                "ucsc-chrom-sizes-human",
                "ucsc-chrom-sizes-mouse",
                "uniprot-idmapping-human",
                "uniprot-idmapping-mouse",
                "uniprot-idmapping-rat",
                "unite-dada2",
                "wikipathways-human",
                "wikipathways-mouse",
                "wikipathways-rat",
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
            { path: "one.parquet", bytes: 42, sha256: HASH_A },
            { path: "nested/current.gz", bytes: 0, sha256: HASH_B },
        ],
    };

    it("records the observed size and digest for every artifact", () => {
        expect(parseReferenceInstallReceipt(valid)).toEqual(valid);
    });

    // A receipt written by an older build carries a now-removed `integrity` field. It must still
    // parse (the install stays valid across the upgrade); the unknown key is simply dropped.
    it("accepts a legacy receipt carrying an integrity field, ignoring it", () => {
        const legacy = { ...valid, artifacts: [{ ...valid.artifacts[0], integrity: "pinned" }] };
        expect(parseReferenceInstallReceipt(legacy)).toEqual({ ...valid, artifacts: [valid.artifacts[0]] });
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

    it("requires an observed size and digest on every receipt artifact", () => {
        const { sha256: _sha256, ...noDigest } = valid.artifacts[1]!;
        const { bytes: _bytes, ...noSize } = valid.artifacts[1]!;

        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [noDigest] })).toBeUndefined();
        expect(parseReferenceInstallReceipt({ ...valid, artifacts: [noSize] })).toBeUndefined();
    });
});
