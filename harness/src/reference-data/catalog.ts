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

/** One immutable final file distributed for a reference dataset. */
export const ReferenceArtifactSchema = z.object({
    key: z.string().min(1),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(SHA256, "Expected a lowercase SHA-256 digest"),
    path: z.string().refine(isSafeRelativePath, "Expected a safe dataset-relative path"),
});

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

function deepFreeze<T>(value: T): DeepReadonly<T> {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value)) deepFreeze(nested);
        Object.freeze(value);
    }
    return value as DeepReadonly<T>;
}

/**
 * Canonical release catalog. Release-data publication is deliberately separate
 * from this contract; entries are added only with real immutable files, sizes,
 * digests, provenance, and licensing data.
 */
export const REFERENCE_DATA_CATALOG: ReferenceDataCatalog = deepFreeze(
    ReferenceDataCatalogSchema.parse({
        version: REFERENCE_DATA_CATALOG_VERSION,
        datasets: [
            {
                id: "ncbi-gene-human",
                version: "2026.07.13",
                title: "NCBI human gene identifiers",
                description: "Entrez Gene identifiers and approved symbols for Homo sapiens (NCBI taxonomy 9606).",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        key: "ncbi-gene-human/2026.07.13/entrez_to_symbol_9606.parquet",
                        path: "entrez_to_symbol_9606.parquet",
                        bytes: 2_211_032,
                        sha256: "98069fffcf0207437541dae8b67d515d460122785731322b817d2b6e2bd4c111",
                    },
                    {
                        key: "ncbi-gene-human/2026.07.13/ensembl_to_symbol_9606.parquet",
                        path: "ensembl_to_symbol_9606.parquet",
                        bytes: 888_646,
                        sha256: "70f713757a2f53c4b487c3f9b9328263f4d3a28b4e7bbce599ac585df0e336fe",
                    },
                    {
                        key: "ncbi-gene-human/2026.07.13/refseq_rna_to_symbol_9606.parquet",
                        path: "refseq_rna_to_symbol_9606.parquet",
                        bytes: 4_366_526,
                        sha256: "5d379282d370ab3e182c634a0aa6c2c4eea5a107a5570e5945f766872ae4b402",
                    },
                    {
                        key: "ncbi-gene-human/2026.07.13/refseq_protein_to_symbol_9606.parquet",
                        path: "refseq_protein_to_symbol_9606.parquet",
                        bytes: 3_014_150,
                        sha256: "c66b67e9791a39dc0e724447d26754115a2ea0497ff33a7e4a9522eab448449b",
                    },
                    {
                        key: "ncbi-gene-human/2026.07.13/refseq_genomic_to_symbol_9606.parquet",
                        path: "refseq_genomic_to_symbol_9606.parquet",
                        bytes: 7_682_265,
                        sha256: "16627f33ec4895192ce72a73ade8c9c6f3f73ffb5a3fff30b8b528ca013e2d49",
                    },
                ],
            },
            {
                id: "ncbi-gene-mouse",
                version: "2026.07.13",
                title: "NCBI mouse gene identifiers",
                description: "Entrez Gene identifiers and approved symbols for Mus musculus (NCBI taxonomy 10090).",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        key: "ncbi-gene-mouse/2026.07.13/entrez_to_symbol_10090.parquet",
                        path: "entrez_to_symbol_10090.parquet",
                        bytes: 1_441_782,
                        sha256: "ff38eb371626380fc2953d2b605ba14b4c2de32ca1a615add353d3ff2dd53c4b",
                    },
                    {
                        key: "ncbi-gene-mouse/2026.07.13/ensembl_to_symbol_10090.parquet",
                        path: "ensembl_to_symbol_10090.parquet",
                        bytes: 795_156,
                        sha256: "1e4f63138d7deefa81e9158085254b6208ef74822400aead0b10e7f4a8416826",
                    },
                    {
                        key: "ncbi-gene-mouse/2026.07.13/refseq_rna_to_symbol_10090.parquet",
                        path: "refseq_rna_to_symbol_10090.parquet",
                        bytes: 2_595_845,
                        sha256: "d1536e7c76063ab5875d35059d7c1509d6fdf71fcd16d9bcd5b3bef80625755a",
                    },
                    {
                        key: "ncbi-gene-mouse/2026.07.13/refseq_protein_to_symbol_10090.parquet",
                        path: "refseq_protein_to_symbol_10090.parquet",
                        bytes: 1_822_348,
                        sha256: "ec7105e2a56ba459f3de8f3818bfb330deabc0347852b1fe51e870a95f4461ff",
                    },
                    {
                        key: "ncbi-gene-mouse/2026.07.13/refseq_genomic_to_symbol_10090.parquet",
                        path: "refseq_genomic_to_symbol_10090.parquet",
                        bytes: 2_414_497,
                        sha256: "c9285ab759a14cd5c4ac9c08e7b8f63b0ce08c7045f1232a05a3f387c4c91290",
                    },
                ],
            },
            {
                id: "ncbi-gene-rat",
                version: "2026.07.13",
                title: "NCBI rat gene identifiers",
                description: "Entrez Gene identifiers and approved symbols for Rattus norvegicus (NCBI taxonomy 10116).",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        key: "ncbi-gene-rat/2026.07.13/entrez_to_symbol_10116.parquet",
                        path: "entrez_to_symbol_10116.parquet",
                        bytes: 690_739,
                        sha256: "1fd12f59344c270788ce8fc4cf9ec45d7f0d4f4b4d8063c19d5c1bff606b6bb7",
                    },
                    {
                        key: "ncbi-gene-rat/2026.07.13/ensembl_to_symbol_10116.parquet",
                        path: "ensembl_to_symbol_10116.parquet",
                        bytes: 569_330,
                        sha256: "3a42f41e2558470fc5a8b07c34d34f4762dc97626067f6a0cbdcccf9239186b2",
                    },
                    {
                        key: "ncbi-gene-rat/2026.07.13/refseq_rna_to_symbol_10116.parquet",
                        path: "refseq_rna_to_symbol_10116.parquet",
                        bytes: 2_315_288,
                        sha256: "6dafb16d2385e575b7710c320da92f552467a0f7f2bf268b2513e2945323b544",
                    },
                    {
                        key: "ncbi-gene-rat/2026.07.13/refseq_protein_to_symbol_10116.parquet",
                        path: "refseq_protein_to_symbol_10116.parquet",
                        bytes: 1_741_627,
                        sha256: "843fe6a6721189b5ec77bdcfc4deccea0dad6f74df46a43898fcc7a78dbb9392",
                    },
                    {
                        key: "ncbi-gene-rat/2026.07.13/refseq_genomic_to_symbol_10116.parquet",
                        path: "refseq_genomic_to_symbol_10116.parquet",
                        bytes: 744_008,
                        sha256: "755264d887c4dbf0ef6719cae9a210e99e9b173285fee17b4cce301a6934424a",
                    },
                ],
            },
            {
                id: "reactome-pathways",
                version: "97",
                title: "Reactome pathways",
                description: "Reactome pathway gene sets for pathway enrichment and annotation workflows.",
                sourceUrl: "https://reactome.org/download-data",
                license: { identifier: "CC0-1.0", url: "https://reactome.org/license" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        key: "reactome-pathways/97/ReactomePathways.gmt",
                        path: "ReactomePathways.gmt",
                        bytes: 1_032_186,
                        sha256: "89983d5c1f0af11c52edfeee7323eb425580ac6281d387a528562ab1787ce56b",
                    },
                    {
                        key: "reactome-pathways/97/ReactomePathways.parquet",
                        path: "ReactomePathways.parquet",
                        bytes: 277_654,
                        sha256: "776899a3705cc62a990e9679215c0b4e9a2dafeb0e14cdb21d4673e089a2e295",
                    },
                    {
                        key: "reactome-pathways/97/Ensembl2Reactome_All_Levels.parquet",
                        path: "Ensembl2Reactome_All_Levels.parquet",
                        bytes: 22_872_142,
                        sha256: "a41c547c9ade3798383b8e85e6c1e77e7c196e0887977b92295d236c408ca16d",
                    },
                    {
                        key: "reactome-pathways/97/NCBI2Reactome_All_Levels.parquet",
                        path: "NCBI2Reactome_All_Levels.parquet",
                        bytes: 7_008_817,
                        sha256: "e882959816d92e9e762490bfa6e6617f7fe62ddd5a90b879b93c1aac8cc86291",
                    },
                    {
                        key: "reactome-pathways/97/UniProt2Reactome_All_Levels.parquet",
                        path: "UniProt2Reactome_All_Levels.parquet",
                        bytes: 8_612_412,
                        sha256: "0f80922ce23c24af3718cf706149432d9a4ed3c099ebaf4d758941e884384efd",
                    },
                    {
                        key: "reactome-pathways/97/reactome_homo_sapiens_interactions.parquet",
                        path: "reactome_homo_sapiens_interactions.parquet",
                        bytes: 2_136_397,
                        sha256: "a19cdb33cd304fe1e090219850db8f7fe59e12754e930ad4568edfb887110517",
                    },
                ],
            },
            {
                id: "wikipathways-human",
                version: "2026.07.10",
                title: "WikiPathways human pathways",
                description: "Community-curated Homo sapiens pathway gene sets and a tabular membership index.",
                sourceUrl: "https://data.wikipathways.org/20260710/gmt/wikipathways-20260710-gmt-Homo_sapiens.gmt",
                license: { identifier: "CC0-1.0", url: "https://www.wikipathways.org/about/terms.html" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        key: "wikipathways-human/2026.07.10/wikipathways_Homo_sapiens.gmt",
                        path: "wikipathways_Homo_sapiens.gmt",
                        bytes: 341_474,
                        sha256: "79615a079246bb0b07cc3505265b1f75ea6cffec88001ce27f644dd86a39c97d",
                    },
                    {
                        key: "wikipathways-human/2026.07.10/wikipathways_Homo_sapiens.parquet",
                        path: "wikipathways_Homo_sapiens.parquet",
                        bytes: 165_089,
                        sha256: "8fafff05009b10c8bdf6ce4601542e87c772a07950c183a96e658efe6229a8d8",
                    },
                ],
            },
            {
                id: "collectri-human",
                version: "2.0",
                title: "CollecTRI human regulatory network",
                description: "A literature-curated human transcription-factor target interaction network.",
                sourceUrl: "https://zenodo.org/records/8192729/files/CollecTRI_regulons.csv",
                license: { identifier: "CC-BY-4.0", url: "https://zenodo.org/records/8192729" },
                recommendation: { group: "regulatory-networks", recommended: true },
                artifacts: [
                    {
                        key: "collectri-human/2.0/collectri_human.parquet",
                        path: "collectri_human.parquet",
                        bytes: 709_038,
                        sha256: "fefa0f04541982b9240317d8e7a0d6f090bd5510dab589b5436d1f9f52cb0c6d",
                    },
                ],
            },
            {
                id: "gtex-v8",
                version: "8",
                title: "GTEx v8 normal tissue expression",
                description: "GTEx v8 median gene expression by tissue with sample metadata for normal-reference workflows.",
                sourceUrl: "https://gtexportal.org/home/downloads/adult-gtex/bulk_tissue_expression",
                license: { identifier: "GTEx-Portal-Data-License", url: "https://gtexportal.org/home/license" },
                recommendation: { group: "normal-expression", recommended: true },
                artifacts: [
                    {
                        key: "gtex-v8/8/median_tpm.parquet",
                        path: "median_tpm.parquet",
                        bytes: 16_950_024,
                        sha256: "93d387307b70aa2cd3f8081fd32a7ac4a307b24c50ba619725d6b06933685ef4",
                    },
                    {
                        key: "gtex-v8/8/metadata.parquet",
                        path: "metadata.parquet",
                        bytes: 5_176_784,
                        sha256: "cc01f5a5bf16ba486b0d88a931e71d197cebbbd10a47f3f5aad5c6536540d756",
                    },
                ],
            },
            {
                id: "celltypist-immune",
                version: "2",
                title: "CellTypist immune cell models",
                description: "CellTypist Immune All low- and high-resolution models for immune cell-type annotation.",
                sourceUrl: "https://www.celltypist.org/models",
                license: { identifier: "NOASSERTION" },
                recommendation: { group: "cell-typing", recommended: true },
                artifacts: [
                    {
                        key: "celltypist-immune/2/Immune_All_Low.pkl",
                        path: "Immune_All_Low.pkl",
                        bytes: 2_824_990,
                        sha256: "290874d35dac039d4c9218c343fde4aac1077709b72a331ce7266f6828c36502",
                    },
                    {
                        key: "celltypist-immune/2/Immune_All_High.pkl",
                        path: "Immune_All_High.pkl",
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

/** Deterministic content-addressed plan; embedders resolve artifact keys. */
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
