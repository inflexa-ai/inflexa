import { posix as posixPath } from "node:path";

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

/** Schema version for the checked-in reference-data catalog. */
export const REFERENCE_DATA_CATALOG_VERSION = 1 as const;

const SAFE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SAFE_VERSION = /^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isSafeRelativePath(value: string): boolean {
    if (value.length === 0 || value.includes("\\") || value.startsWith("/")) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") && posixPath.normalize(value) === value;
}

/** Dataset-relative destination of one artifact below its install path. */
export const ReferenceArtifactPathSchema = z.string().refine(isSafeRelativePath, "Expected a safe dataset-relative path");

/** Lowercase SHA-256 digest of one artifact's bytes. */
export const ReferenceSha256Schema = z.string().regex(SHA256, "Expected a lowercase SHA-256 digest");

/**
 * Artifacts are fetched from the upstream that publishes them — this project
 * redistributes nothing — so the URL must be a real third-party https endpoint.
 */
const ReferenceArtifactUrlSchema = z.url().refine((value) => value.startsWith("https://"), "Reference artifacts must be fetched over https");

/**
 * An artifact whose upstream publishes immutable, versioned bytes. The catalog
 * carries the size and digest, so a download is verified against *this file*
 * before it is ever activated: a mismatch means the bytes are not what we
 * reviewed, and the install fails.
 */
const PinnedReferenceArtifactSchema = z.strictObject({
    integrity: z.literal("pinned"),
    path: ReferenceArtifactPathSchema,
    url: ReferenceArtifactUrlSchema,
    bytes: z.number().int().positive(),
    sha256: ReferenceSha256Schema,
});

/**
 * An artifact whose upstream regenerates the same URL in place — NCBI rebuilds
 * `gene_info` continuously and Reactome's `current` release is overwritten and
 * its predecessors deleted. No checked-in digest can survive that, and pinning
 * one would only guarantee a broken download. Integrity is therefore
 * trust-on-first-use: the installer records the bytes it actually received in
 * the receipt, and `verify` proves the files have not changed *since install*.
 * This is a weaker guarantee than `pinned` and is surfaced as such to the user.
 */
const UnpinnedReferenceArtifactSchema = z.strictObject({
    integrity: z.literal("unpinned"),
    path: ReferenceArtifactPathSchema,
    url: ReferenceArtifactUrlSchema,
});

/** One immutable final file distributed for a reference dataset. */
export const ReferenceArtifactSchema = z.discriminatedUnion("integrity", [PinnedReferenceArtifactSchema, UnpinnedReferenceArtifactSchema]);

/** Which integrity guarantee an artifact can actually offer. */
export type ReferenceIntegrity = z.infer<typeof ReferenceArtifactSchema>["integrity"];

/** Provenance and licensing information for one supported reference dataset. */
export const ReferenceDatasetSchema = z.object({
    id: z.string().regex(SAFE_ID, "Expected a stable lowercase dataset id"),
    version: z.string().regex(SAFE_VERSION, "Expected a safe dataset version path segment"),
    title: z.string().min(1),
    description: z.string().min(1),
    sourceUrl: z.url(),
    license: z.object({
        identifier: z.string().min(1),
        url: z.url().optional(),
    }),
    recommendation: z.object({
        group: z.string().min(1),
        recommended: z.boolean(),
    }),
    artifacts: z.array(ReferenceArtifactSchema).min(1),
});

/** Versioned canonical catalog consumed identically by every harness embedder. */
export const ReferenceDataCatalogSchema = z
    .object({
        version: z.literal(REFERENCE_DATA_CATALOG_VERSION),
        datasets: z.array(ReferenceDatasetSchema),
    })
    .superRefine((catalog, ctx) => {
        const ids = new Set<string>();
        for (const [datasetIndex, dataset] of catalog.datasets.entries()) {
            if (ids.has(dataset.id)) {
                ctx.addIssue({ code: "custom", message: `Duplicate dataset id: ${dataset.id}`, path: ["datasets", datasetIndex, "id"] });
            }
            ids.add(dataset.id);

            const paths = new Set<string>();
            for (const [artifactIndex, artifact] of dataset.artifacts.entries()) {
                if (paths.has(artifact.path)) {
                    ctx.addIssue({
                        code: "custom",
                        message: `Duplicate artifact path in ${dataset.id}: ${artifact.path}`,
                        path: ["datasets", datasetIndex, "artifacts", artifactIndex, "path"],
                    });
                }
                paths.add(artifact.path);
            }
        }
    });

type DeepReadonly<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type ReferenceArtifact = DeepReadonly<z.infer<typeof ReferenceArtifactSchema>>;
export type ReferenceDataset = DeepReadonly<z.infer<typeof ReferenceDatasetSchema>>;
export type ReferenceDataCatalog = DeepReadonly<z.infer<typeof ReferenceDataCatalogSchema>>;

/**
 * Stable identity of one artifact within the catalog, independent of its URL.
 * Embedders key resumable partials off this, so a moved upstream URL does not
 * orphan a half-finished transfer.
 */
export function referenceArtifactKey(dataset: { readonly id: string; readonly version: string }, artifact: { readonly path: string }): string {
    return `${dataset.id}/${dataset.version}/${artifact.path}`;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value)) deepFreeze(nested);
        Object.freeze(value);
    }
    return value as DeepReadonly<T>;
}

/**
 * Canonical release catalog. Every artifact is fetched directly from the third
 * party that publishes it; this project hosts, mirrors, and redistributes
 * nothing. Entries are added only with real upstream URLs, provenance, and
 * licensing data — plus a size and digest whenever the upstream publishes
 * immutable bytes we can pin to.
 *
 * `version` is the dataset's upstream release identifier. Datasets built on an
 * upstream that has no immutable release — NCBI regenerates `gene_info` daily,
 * Reactome overwrites `current` and deletes prior releases — are versioned
 * `current` and carry `unpinned` artifacts.
 */
export const REFERENCE_DATA_CATALOG: ReferenceDataCatalog = deepFreeze(
    ReferenceDataCatalogSchema.parse({
        version: REFERENCE_DATA_CATALOG_VERSION,
        datasets: [
            {
                id: "ncbi-gene-human",
                version: "current",
                title: "NCBI human gene identifiers",
                description:
                    "Entrez Gene records for Homo sapiens (NCBI taxonomy 9606): identifiers, approved symbols, synonyms, and cross-references (Ensembl, HGNC) in the dbXrefs column. Tab-separated, gzipped. NCBI rebuilds this file in place, so it is verified against what you downloaded rather than a checked-in digest.",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        integrity: "unpinned",
                        path: "Homo_sapiens.gene_info.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Homo_sapiens.gene_info.gz",
                    },
                ],
            },
            {
                id: "ncbi-gene-mouse",
                version: "current",
                title: "NCBI mouse gene identifiers",
                description:
                    "Entrez Gene records for Mus musculus (NCBI taxonomy 10090): identifiers, approved symbols, synonyms, and cross-references (Ensembl, MGI) in the dbXrefs column. Tab-separated, gzipped. NCBI rebuilds this file in place, so it is verified against what you downloaded rather than a checked-in digest.",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        integrity: "unpinned",
                        path: "Mus_musculus.gene_info.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Mus_musculus.gene_info.gz",
                    },
                ],
            },
            {
                id: "ncbi-gene-rat",
                version: "current",
                title: "NCBI rat gene identifiers",
                description:
                    "Entrez Gene records for Rattus norvegicus (NCBI taxonomy 10116): identifiers, approved symbols, synonyms, and cross-references (Ensembl, RGD) in the dbXrefs column. Tab-separated, gzipped. NCBI rebuilds this file in place, so it is verified against what you downloaded rather than a checked-in digest.",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        integrity: "unpinned",
                        path: "Rattus_norvegicus.gene_info.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Rattus_norvegicus.gene_info.gz",
                    },
                ],
            },
            {
                id: "reactome-pathways",
                version: "current",
                title: "Reactome pathways",
                description:
                    "Reactome pathway gene sets (GMT) and the pathway index — the enrichment workhorse, ~2 MB. Reactome overwrites its `current` release each quarter and removes the prior one, so this is verified against what you downloaded rather than a checked-in digest. For identifier-to-pathway mapping tables, add `reactome-mappings`.",
                sourceUrl: "https://reactome.org/download-data",
                license: { identifier: "CC0-1.0", url: "https://reactome.org/license" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    { integrity: "unpinned", path: "ReactomePathways.gmt", url: "https://reactome.org/download/current/ReactomePathways.gmt" },
                    { integrity: "unpinned", path: "ReactomePathways.txt", url: "https://reactome.org/download/current/ReactomePathways.txt" },
                ],
            },
            {
                // Split out of `reactome-pathways` and NOT recommended by default: upstream serves these
                // as uncompressed TSV and they total roughly 700 MB, two orders of magnitude more than the
                // GMT most workflows actually want. Anyone who needs Entrez/Ensembl/UniProt -> pathway
                // joins opts in deliberately, rather than every `setup` paying for them by accident.
                id: "reactome-mappings",
                version: "current",
                title: "Reactome identifier mappings (large)",
                description:
                    "Entrez/Ensembl/UniProt-to-Reactome mapping tables at all pathway levels. Large: roughly 700 MB of uncompressed TSV, because Reactome publishes no compressed form. Only needed to join external identifiers onto Reactome pathways; the gene sets themselves live in `reactome-pathways`.",
                sourceUrl: "https://reactome.org/download-data",
                license: { identifier: "CC0-1.0", url: "https://reactome.org/license" },
                recommendation: { group: "pathways", recommended: false },
                artifacts: [
                    {
                        integrity: "unpinned",
                        path: "NCBI2Reactome_All_Levels.txt",
                        url: "https://reactome.org/download/current/NCBI2Reactome_All_Levels.txt",
                    },
                    {
                        integrity: "unpinned",
                        path: "Ensembl2Reactome_All_Levels.txt",
                        url: "https://reactome.org/download/current/Ensembl2Reactome_All_Levels.txt",
                    },
                    {
                        integrity: "unpinned",
                        path: "UniProt2Reactome_All_Levels.txt",
                        url: "https://reactome.org/download/current/UniProt2Reactome_All_Levels.txt",
                    },
                ],
            },
            {
                id: "wikipathways-human",
                version: "2026.07.10",
                title: "WikiPathways human pathways",
                description: "Community-curated Homo sapiens pathway gene sets (GMT) from the immutable 2026-07-10 WikiPathways snapshot.",
                sourceUrl: "https://data.wikipathways.org/20260710/gmt/",
                license: { identifier: "CC0-1.0", url: "https://www.wikipathways.org/about/terms.html" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        integrity: "pinned",
                        path: "wikipathways_Homo_sapiens.gmt",
                        url: "https://data.wikipathways.org/20260710/gmt/wikipathways-20260710-gmt-Homo_sapiens.gmt",
                        bytes: 341_474,
                        sha256: "79615a079246bb0b07cc3505265b1f75ea6cffec88001ce27f644dd86a39c97d",
                    },
                ],
            },
            {
                id: "collectri-human",
                version: "2.0",
                title: "CollecTRI human regulatory network",
                description: "A literature-curated human transcription-factor target interaction network (CSV) from the immutable Zenodo record 8192729.",
                sourceUrl: "https://zenodo.org/records/8192729",
                license: { identifier: "CC-BY-4.0", url: "https://zenodo.org/records/8192729" },
                recommendation: { group: "regulatory-networks", recommended: true },
                artifacts: [
                    {
                        integrity: "pinned",
                        path: "CollecTRI_regulons.csv",
                        url: "https://zenodo.org/records/8192729/files/CollecTRI_regulons.csv",
                        bytes: 4_345_649,
                        sha256: "4473c9189dd53dacc80297709ad1452dda1086a1cc2185f9a56146c261668701",
                    },
                ],
            },
            {
                id: "gtex-v8",
                version: "8",
                title: "GTEx v8 normal tissue expression",
                description:
                    "GTEx v8 median gene TPM by tissue (GCT) with the sample attributes table, for normal-reference workflows. Immutable v8 release files.",
                sourceUrl: "https://gtexportal.org/home/downloads/adult-gtex/bulk_tissue_expression",
                license: { identifier: "GTEx-Portal-Data-License", url: "https://gtexportal.org/home/license" },
                recommendation: { group: "normal-expression", recommended: true },
                artifacts: [
                    {
                        integrity: "pinned",
                        path: "GTEx_Analysis_2017-06-05_v8_RNASeQCv1.1.9_gene_median_tpm.gct.gz",
                        url: "https://storage.googleapis.com/adult-gtex/bulk-gex/v8/rna-seq/GTEx_Analysis_2017-06-05_v8_RNASeQCv1.1.9_gene_median_tpm.gct.gz",
                        bytes: 6_952_331,
                        sha256: "ee7201ff2f280b0de5657d4b08e9a240362d9757efed7f7bd5dba35a5f8617b8",
                    },
                    {
                        integrity: "pinned",
                        path: "GTEx_Analysis_v8_Annotations_SampleAttributesDS.txt",
                        url: "https://storage.googleapis.com/adult-gtex/annotations/v8/metadata-files/GTEx_Analysis_v8_Annotations_SampleAttributesDS.txt",
                        bytes: 11_512_258,
                        sha256: "74f6ab4c34ed2648d708a0ae6e6dff324f6c86ea723ae7d1c37d76f5221148f0",
                    },
                ],
            },
            {
                id: "celltypist-immune",
                version: "2",
                title: "CellTypist immune cell models",
                description:
                    "CellTypist Immune All low- and high-resolution models for immune cell-type annotation. Load by absolute path — CellTypist's by-name lookup expects its own cache layout, which the reference store deliberately does not impersonate.",
                sourceUrl: "https://www.celltypist.org/models",
                license: { identifier: "NOASSERTION" },
                recommendation: { group: "cell-typing", recommended: true },
                artifacts: [
                    {
                        integrity: "pinned",
                        path: "Immune_All_Low.pkl",
                        url: "https://celltypist.cog.sanger.ac.uk/models/Pan_Immune_CellTypist/v2/Immune_All_Low.pkl",
                        bytes: 2_824_990,
                        sha256: "290874d35dac039d4c9218c343fde4aac1077709b72a331ce7266f6828c36502",
                    },
                    {
                        integrity: "pinned",
                        path: "Immune_All_High.pkl",
                        url: "https://celltypist.cog.sanger.ac.uk/models/Pan_Immune_CellTypist/v2/Immune_All_High.pkl",
                        bytes: 1_070_426,
                        sha256: "a715fec36c2c421f7c4e31cf4cb4bea883eedab7fd7b20a4b76f091c22660448",
                    },
                ],
            },
        ],
    }),
);

/** One selected dataset and its host-neutral installation location. */
export type ReferenceInstallPlanDataset = ReferenceDataset & { readonly installPath: string };

/** Deterministic plan; every artifact carries the upstream URL it is fetched from. */
export interface ReferenceInstallPlan {
    readonly catalogVersion: typeof REFERENCE_DATA_CATALOG_VERSION;
    readonly datasets: readonly ReferenceInstallPlanDataset[];
}

/** A requested dataset id was not present in the selected catalog. */
export class UnknownReferenceDatasetError extends Error {
    readonly code = "unknown_reference_dataset" as const;
    readonly unknownId: string;
    readonly availableIds: readonly string[];

    constructor(unknownId: string, availableIds: readonly string[]) {
        super(`Unknown reference dataset "${unknownId}". Available ids: ${availableIds.join(", ") || "(none)"}`);
        this.name = "UnknownReferenceDatasetError";
        this.unknownId = unknownId;
        this.availableIds = availableIds;
    }
}

/** Resolve dataset ids without I/O, preserving a stable dataset-id ordering. */
/** @internal Fixture seam for harness contract tests; not exported by the package barrel. */
export function resolveReferenceInstallPlanFromCatalogForTesting(
    datasetIds: readonly string[],
    catalog: ReferenceDataCatalog,
): Result<ReferenceInstallPlan, UnknownReferenceDatasetError> {
    const byId = new Map(catalog.datasets.map((dataset) => [dataset.id, dataset]));
    const availableIds = [...byId.keys()].sort();
    const selectedIds = [...new Set(datasetIds)].sort();

    for (const id of selectedIds) {
        if (!byId.has(id)) return err(new UnknownReferenceDatasetError(id, availableIds));
    }

    return ok({
        catalogVersion: catalog.version,
        datasets: selectedIds.map((id) => {
            const dataset = byId.get(id)!;
            return { ...dataset, installPath: `${dataset.id}/${dataset.version}` };
        }),
    });
}

/** Resolve ids strictly against the immutable canonical catalog shipped by this package. */
export function resolveReferenceInstallPlan(datasetIds: readonly string[]): Result<ReferenceInstallPlan, UnknownReferenceDatasetError> {
    return resolveReferenceInstallPlanFromCatalogForTesting(datasetIds, REFERENCE_DATA_CATALOG);
}
