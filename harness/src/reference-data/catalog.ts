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
 * Logical content format, independent of compression: a `.txt.gz` mapping table
 * is `tsv`, not `gz`. Agents pick a reader from this rather than guessing from
 * the extension, so it stays a free token instead of an enum — a new source must
 * remain cheap to add, and an unrecognized format degrades to "unknown reader"
 * rather than failing catalog validation.
 */
export const ReferenceArtifactFormatSchema = z.string().regex(/^[a-z0-9]+(?:[+-][a-z0-9]+)*$/, "Expected a lowercase format token");

/**
 * One final file distributed for a reference dataset: a stable install-relative
 * path and the third-party https URL it is fetched from. The catalog carries no
 * size or digest — every upstream is authenticated over TLS at download time,
 * and the installer records the bytes it actually received in the receipt so
 * `verify` can later prove the local copy has not changed since install. This is
 * one uniform trust-on-first-use model; there is deliberately no per-artifact
 * integrity class, so adding a source is only ever a URL, and no checked-in
 * digest is ours to maintain or lets go stale when a `current` upstream rebuilds.
 *
 * `format` and `contents` exist because skills name no paths: an agent asked for
 * "a TF-target regulon network" can only match that against an inventory entry if
 * the entry says what it holds and how to read it. `contents` should name the
 * shape a caller must know — key columns, identifier space — not restate the title.
 */
export const ReferenceArtifactSchema = z.strictObject({
    path: ReferenceArtifactPathSchema,
    url: ReferenceArtifactUrlSchema,
    format: ReferenceArtifactFormatSchema,
    contents: z.string().min(1),
});

/**
 * Common-name organism the dataset describes, lowercase (`human`, `mouse`, `rat`).
 * Omitted for species-agnostic or multi-species sources. This is the axis a wrong
 * choice is most silently wrong on — human regulons over mouse counts still run —
 * so it is a first-class field rather than something inferred from the id suffix.
 */
export const ReferenceOrganismSchema = z.string().regex(/^[a-z][a-z0-9]*(?:[ -][a-z0-9]+)*$/, "Expected a lowercase organism common name");

/** Provenance and licensing information for one supported reference dataset. */
export const ReferenceDatasetSchema = z.object({
    id: z.string().regex(SAFE_ID, "Expected a stable lowercase dataset id"),
    version: z.string().regex(SAFE_VERSION, "Expected a safe dataset version path segment"),
    title: z.string().min(1),
    description: z.string().min(1),
    organism: ReferenceOrganismSchema.optional(),
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
 * nothing. Entries are added with a real upstream https URL, provenance and
 * licensing data, and a description of what the file holds — but never a size or
 * digest to compute and keep in sync. The descriptive half is what makes a
 * dataset findable: this catalog is the only place that says what a reference
 * file is, so nothing downstream has to encode a path or a filename to use it.
 *
 * `version` is the dataset's upstream release identifier. Datasets built on an
 * upstream that has no immutable release — NCBI regenerates `gene_info` daily,
 * Reactome overwrites `current` and deletes prior releases — are versioned
 * `current`; those with an immutable release carry it verbatim.
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
                organism: "human",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        path: "Homo_sapiens.gene_info.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Homo_sapiens.gene_info.gz",
                        format: "tsv",
                        contents:
                            "One row per gene, gzipped, header line prefixed '#'. Key columns: GeneID (Entrez), Symbol (HGNC), Synonyms, dbXrefs (holds Ensembl: and HGNC: cross-references, '|'-separated), type_of_gene.",
                    },
                ],
            },
            {
                id: "ncbi-gene-mouse",
                version: "current",
                title: "NCBI mouse gene identifiers",
                description:
                    "Entrez Gene records for Mus musculus (NCBI taxonomy 10090): identifiers, approved symbols, synonyms, and cross-references (Ensembl, MGI) in the dbXrefs column. Tab-separated, gzipped. NCBI rebuilds this file in place, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "mouse",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        path: "Mus_musculus.gene_info.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Mus_musculus.gene_info.gz",
                        format: "tsv",
                        contents:
                            "One row per gene, gzipped, header line prefixed '#'. Key columns: GeneID (Entrez), Symbol (MGI), Synonyms, dbXrefs (holds Ensembl: and MGI: cross-references, '|'-separated), type_of_gene.",
                    },
                ],
            },
            {
                id: "ncbi-gene-rat",
                version: "current",
                title: "NCBI rat gene identifiers",
                description:
                    "Entrez Gene records for Rattus norvegicus (NCBI taxonomy 10116): identifiers, approved symbols, synonyms, and cross-references (Ensembl, RGD) in the dbXrefs column. Tab-separated, gzipped. NCBI rebuilds this file in place, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "rat",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        path: "Rattus_norvegicus.gene_info.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/GENE_INFO/Mammalia/Rattus_norvegicus.gene_info.gz",
                        format: "tsv",
                        contents:
                            "One row per gene, gzipped, header line prefixed '#'. Key columns: GeneID (Entrez), Symbol (RGD), Synonyms, dbXrefs (holds Ensembl: and RGD: cross-references, '|'-separated), type_of_gene.",
                    },
                ],
            },
            {
                // All-species monolithic table (~274 MB), not the per-organism split the gene_info entries use:
                // NCBI publishes Entrez↔Ensembl only in this one combined file. Opt-in for that reason.
                id: "ncbi-gene2ensembl",
                version: "current",
                title: "NCBI Entrez-to-Ensembl gene mapping (all species)",
                description:
                    "NCBI Gene's Entrez Gene ID ↔ Ensembl gene/transcript/protein identifier cross-reference for every species (gene2ensembl), tab-separated and gzipped — roughly 274 MB. NCBI rebuilds this file in place, so it is verified against what you downloaded rather than a checked-in digest.",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: false },
                artifacts: [
                    {
                        path: "gene2ensembl.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/gene2ensembl.gz",
                        format: "tsv",
                        contents:
                            "Every species in one gzipped table — filter on #tax_id first (9606 human, 10090 mouse, 10116 rat). Columns: #tax_id, GeneID, Ensembl_gene_identifier, RNA_nucleotide_accession.version, Ensembl_rna_identifier, protein_accession.version, Ensembl_protein_identifier.",
                    },
                ],
            },
            {
                // ~2.2 GB all-species monolithic table — the largest catalog entry. Opt-in like reactome-mappings.
                id: "ncbi-gene2refseq",
                version: "current",
                title: "NCBI Entrez-to-RefSeq accession mapping (all species, large)",
                description:
                    "NCBI Gene's Entrez Gene ID ↔ RefSeq RNA/protein/genomic accession cross-reference for every species (gene2refseq), tab-separated and gzipped — roughly 2.2 GB. NCBI rebuilds this file in place, so it is verified against what you downloaded rather than a checked-in digest. Only needed to join RefSeq accessions onto genes.",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/",
                license: {
                    identifier: "NCBI-Molecular-Data-Usage-Policy",
                    url: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
                },
                recommendation: { group: "gene-identifiers", recommended: false },
                artifacts: [
                    {
                        path: "gene2refseq.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/gene/DATA/gene2refseq.gz",
                        format: "tsv",
                        contents:
                            "Every species in one gzipped table (~2.2 GB) — filter on #tax_id first, and prefer a streaming read. Columns: #tax_id, GeneID, status, RNA_nucleotide_accession.version, protein_accession.version, genomic_nucleotide_accession.version, Symbol.",
                    },
                ],
            },
            {
                id: "uniprot-idmapping-human",
                version: "current",
                title: "UniProt human ID mapping",
                description:
                    "UniProtKB accession ↔ Entrez, Ensembl, RefSeq and other identifiers for Homo sapiens (idmapping_selected, ~61 MB gzipped). UniProt overwrites `current_release` each cycle, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "human",
                sourceUrl: "https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/idmapping/by_organism/",
                license: { identifier: "CC-BY-4.0", url: "https://www.uniprot.org/help/license" },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        path: "HUMAN_9606_idmapping_selected.tab.gz",
                        url: "https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/idmapping/by_organism/HUMAN_9606_idmapping_selected.tab.gz",
                        format: "tsv",
                        contents:
                            "Gzipped, 22 columns, NO header. Positional: 1 UniProtKB-AC, 2 UniProtKB-ID, 3 GeneID (Entrez), 4 RefSeq, 19 Ensembl, 20 Ensembl_TRS, 21 Ensembl_PRO. Multi-valued cells are '; '-separated.",
                    },
                ],
            },
            {
                id: "uniprot-idmapping-mouse",
                version: "current",
                title: "UniProt mouse ID mapping",
                description:
                    "UniProtKB accession ↔ Entrez, Ensembl, RefSeq and other identifiers for Mus musculus (idmapping_selected, ~18 MB gzipped). UniProt overwrites `current_release` each cycle, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "mouse",
                sourceUrl: "https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/idmapping/by_organism/",
                license: { identifier: "CC-BY-4.0", url: "https://www.uniprot.org/help/license" },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        path: "MOUSE_10090_idmapping_selected.tab.gz",
                        url: "https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/idmapping/by_organism/MOUSE_10090_idmapping_selected.tab.gz",
                        format: "tsv",
                        contents:
                            "Gzipped, 22 columns, NO header. Positional: 1 UniProtKB-AC, 2 UniProtKB-ID, 3 GeneID (Entrez), 4 RefSeq, 19 Ensembl, 20 Ensembl_TRS, 21 Ensembl_PRO. Multi-valued cells are '; '-separated.",
                    },
                ],
            },
            {
                id: "uniprot-idmapping-rat",
                version: "current",
                title: "UniProt rat ID mapping",
                description:
                    "UniProtKB accession ↔ Entrez, Ensembl, RefSeq and other identifiers for Rattus norvegicus (idmapping_selected, ~6 MB gzipped). UniProt overwrites `current_release` each cycle, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "rat",
                sourceUrl: "https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/idmapping/by_organism/",
                license: { identifier: "CC-BY-4.0", url: "https://www.uniprot.org/help/license" },
                recommendation: { group: "gene-identifiers", recommended: true },
                artifacts: [
                    {
                        path: "RAT_10116_idmapping_selected.tab.gz",
                        url: "https://ftp.uniprot.org/pub/databases/uniprot/current_release/knowledgebase/idmapping/by_organism/RAT_10116_idmapping_selected.tab.gz",
                        format: "tsv",
                        contents:
                            "Gzipped, 22 columns, NO header. Positional: 1 UniProtKB-AC, 2 UniProtKB-ID, 3 GeneID (Entrez), 4 RefSeq, 19 Ensembl, 20 Ensembl_TRS, 21 Ensembl_PRO. Multi-valued cells are '; '-separated.",
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
                    {
                        path: "ReactomePathways.gmt",
                        url: "https://reactome.org/download/current/ReactomePathways.gmt",
                        format: "gmt",
                        contents:
                            "One pathway per line, tab-separated: pathway name, Reactome stable ID, then member gene symbols. Covers every Reactome species in one file — filter by pathway name suffix or join ReactomePathways.txt to restrict to one.",
                    },
                    {
                        path: "ReactomePathways.txt",
                        url: "https://reactome.org/download/current/ReactomePathways.txt",
                        format: "tsv",
                        contents: "Pathway index, no header: stable ID, display name, species name. Join on stable ID to restrict the GMT to one species.",
                    },
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
                        path: "NCBI2Reactome_All_Levels.txt",
                        url: "https://reactome.org/download/current/NCBI2Reactome_All_Levels.txt",
                        format: "tsv",
                        contents:
                            "No header, every species: Entrez gene ID, Reactome pathway stable ID, pathway URL, pathway name, evidence code, species name. Filter on the species column.",
                    },
                    {
                        path: "Ensembl2Reactome_All_Levels.txt",
                        url: "https://reactome.org/download/current/Ensembl2Reactome_All_Levels.txt",
                        format: "tsv",
                        contents:
                            "No header, every species: Ensembl gene ID, Reactome pathway stable ID, pathway URL, pathway name, evidence code, species name. Filter on the species column.",
                    },
                    {
                        path: "UniProt2Reactome_All_Levels.txt",
                        url: "https://reactome.org/download/current/UniProt2Reactome_All_Levels.txt",
                        format: "tsv",
                        contents:
                            "No header, every species: UniProtKB accession, Reactome pathway stable ID, pathway URL, pathway name, evidence code, species name. Filter on the species column.",
                    },
                ],
            },
            {
                id: "wikipathways-human",
                version: "2026.07.10",
                title: "WikiPathways human pathways",
                description: "Community-curated Homo sapiens pathway gene sets (GMT) from the immutable 2026-07-10 WikiPathways snapshot.",
                organism: "human",
                sourceUrl: "https://data.wikipathways.org/20260710/gmt/",
                license: { identifier: "CC0-1.0", url: "https://www.wikipathways.org/about/terms.html" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        path: "wikipathways_Homo_sapiens.gmt",
                        url: "https://data.wikipathways.org/20260710/gmt/wikipathways-20260710-gmt-Homo_sapiens.gmt",
                        format: "gmt",
                        contents:
                            "One pathway per line, tab-separated: '%'-delimited descriptor (name, WikiPathways ID, species), pathway URL, then member gene symbols (HGNC). Split the first field on '%' to recover a readable set name.",
                    },
                ],
            },
            {
                id: "wikipathways-mouse",
                version: "2026.07.10",
                title: "WikiPathways mouse pathways",
                description: "Community-curated Mus musculus pathway gene sets (GMT) from the immutable 2026-07-10 WikiPathways snapshot.",
                organism: "mouse",
                sourceUrl: "https://data.wikipathways.org/20260710/gmt/",
                license: { identifier: "CC0-1.0", url: "https://www.wikipathways.org/about/terms.html" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        path: "wikipathways_Mus_musculus.gmt",
                        url: "https://data.wikipathways.org/20260710/gmt/wikipathways-20260710-gmt-Mus_musculus.gmt",
                        format: "gmt",
                        contents:
                            "One pathway per line, tab-separated: '%'-delimited descriptor (name, WikiPathways ID, species), pathway URL, then member gene symbols (MGI). Split the first field on '%' to recover a readable set name.",
                    },
                ],
            },
            {
                id: "wikipathways-rat",
                version: "2026.07.10",
                title: "WikiPathways rat pathways",
                description: "Community-curated Rattus norvegicus pathway gene sets (GMT) from the immutable 2026-07-10 WikiPathways snapshot.",
                organism: "rat",
                sourceUrl: "https://data.wikipathways.org/20260710/gmt/",
                license: { identifier: "CC0-1.0", url: "https://www.wikipathways.org/about/terms.html" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        path: "wikipathways_Rattus_norvegicus.gmt",
                        url: "https://data.wikipathways.org/20260710/gmt/wikipathways-20260710-gmt-Rattus_norvegicus.gmt",
                        format: "gmt",
                        contents:
                            "One pathway per line, tab-separated: '%'-delimited descriptor (name, WikiPathways ID, species), pathway URL, then member gene symbols (RGD). Split the first field on '%' to recover a readable set name.",
                    },
                ],
            },
            {
                id: "msigdb-hallmark-human",
                version: "2026.1",
                title: "MSigDB human hallmark gene sets",
                description:
                    "The 50 MSigDB hallmark gene sets for Homo sapiens (symbols GMT) — coherent, well-defined biological states and processes for enrichment. From the immutable MSigDB 2026.1 human release.",
                organism: "human",
                sourceUrl: "https://data.broadinstitute.org/gsea-msigdb/msigdb/",
                license: { identifier: "MSigDB-License", url: "https://www.gsea-msigdb.org/gsea/msigdb/license.jsp" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        path: "h.all.v2026.1.Hs.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Hs/h.all.v2026.1.Hs.symbols.gmt",
                        format: "gmt",
                        contents:
                            "50 hallmark sets, one per line, tab-separated: set name (HALLMARK_*), source URL, then member gene symbols (HGNC). Hallmark only — the C2/C5/C6/C7/C8 collections are not part of this dataset.",
                    },
                ],
            },
            {
                id: "msigdb-hallmark-mouse",
                version: "2026.1",
                title: "MSigDB mouse hallmark gene sets",
                description:
                    "The MSigDB mouse hallmark gene sets for Mus musculus (symbols GMT) — the murine ortholog-mapped hallmark collection for enrichment. From the immutable MSigDB 2026.1 mouse release.",
                organism: "mouse",
                sourceUrl: "https://data.broadinstitute.org/gsea-msigdb/msigdb/",
                license: { identifier: "MSigDB-License", url: "https://www.gsea-msigdb.org/gsea/msigdb/license.jsp" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        path: "mh.all.v2026.1.Mm.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Mm/mh.all.v2026.1.Mm.symbols.gmt",
                        format: "gmt",
                        contents:
                            "Mouse hallmark sets, one per line, tab-separated: set name, source URL, then member gene symbols (MGI). Hallmark only — the C2/C5/C6/C7/C8 collections are not part of this dataset.",
                    },
                ],
            },
            {
                id: "collectri-human",
                version: "2.0",
                title: "CollecTRI human regulatory network",
                description: "A literature-curated human transcription-factor target interaction network (CSV) from the immutable Zenodo record 8192729.",
                organism: "human",
                sourceUrl: "https://zenodo.org/records/8192729",
                license: { identifier: "CC-BY-4.0", url: "https://zenodo.org/records/8192729" },
                recommendation: { group: "regulatory-networks", recommended: true },
                artifacts: [
                    {
                        path: "CollecTRI_regulons.csv",
                        url: "https://zenodo.org/records/8192729/files/CollecTRI_regulons.csv",
                        format: "csv",
                        contents:
                            "TF-target regulons, one interaction per row: source (TF symbol), target (gene symbol), weight (+1 activating, -1 repressing), then curation provenance columns. This is the prior a TF-activity method consumes — read it with a CSV reader and pass the frame directly as decoupler's network argument. It is CSV, not Parquet.",
                    },
                ],
            },
            {
                // Sourced from the package repository's data/ directory rather than the OmniPath web
                // service that `dc.op.progeny()` calls: a live query endpoint is not an artifact, and
                // an install that depends on one breaks whenever the service does.
                id: "progeny-human",
                version: "current",
                title: "PROGENy human pathway weights",
                description:
                    "PROGENy footprint-based pathway responsive genes for Homo sapiens — per-gene weights for 14 signalling pathways (EGFR, MAPK, PI3K, TNFa, p53, Hypoxia and others), the standard prior for pathway-activity inference from expression. Tracks the package's default branch, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "human",
                sourceUrl: "https://github.com/saezlab/progeny",
                license: { identifier: "Apache-2.0", url: "https://github.com/saezlab/progeny/blob/master/LICENSE" },
                recommendation: { group: "pathway-activity", recommended: true },
                artifacts: [
                    {
                        path: "model_human_full.rda",
                        url: "https://raw.githubusercontent.com/saezlab/progeny/master/data/model_human_full.rda",
                        format: "rda",
                        contents:
                            "R serialized data frame `model_human_full` of pathway weights: columns gene, weight, p.value, pathway. Load in R with load(); from Python read it through rpy2 rather than a pandas reader. Rename to source/target/weight if a decoupler-style network is expected.",
                    },
                ],
            },
            {
                id: "progeny-mouse",
                version: "current",
                title: "PROGENy mouse pathway weights",
                description:
                    "PROGENy footprint-based pathway responsive genes for Mus musculus — per-gene weights for 14 signalling pathways, the standard prior for pathway-activity inference from expression. Tracks the package's default branch, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "mouse",
                sourceUrl: "https://github.com/saezlab/progeny",
                license: { identifier: "Apache-2.0", url: "https://github.com/saezlab/progeny/blob/master/LICENSE" },
                recommendation: { group: "pathway-activity", recommended: true },
                artifacts: [
                    {
                        path: "model_mouse_full.rda",
                        url: "https://raw.githubusercontent.com/saezlab/progeny/master/data/model_mouse_full.rda",
                        format: "rda",
                        contents:
                            "R serialized data frame `model_mouse_full` of pathway weights: columns gene, weight, p.value, pathway. Load in R with load(); from Python read it through rpy2 rather than a pandas reader. Rename to source/target/weight if a decoupler-style network is expected.",
                    },
                ],
            },
            {
                id: "dorothea-human",
                version: "current",
                title: "DoRothEA human TF regulons",
                description:
                    "DoRothEA transcription-factor regulons for Homo sapiens with per-interaction confidence levels A-E, where A is the best-supported. The confidence-filtered alternative to CollecTRI for TF-activity inference; most analyses keep levels A-C. Tracks the package's default branch, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "human",
                sourceUrl: "https://github.com/saezlab/dorothea",
                license: { identifier: "GPL-3.0", url: "https://github.com/saezlab/dorothea/blob/master/LICENSE" },
                recommendation: { group: "regulatory-networks", recommended: true },
                artifacts: [
                    {
                        path: "dorothea_hs.rda",
                        url: "https://raw.githubusercontent.com/saezlab/dorothea/master/data/dorothea_hs.rda",
                        format: "rda",
                        contents:
                            "R serialized data frame `dorothea_hs` of TF-target regulons: columns tf, confidence (A-E), target, mor (+1 activating, -1 repressing). Load in R with load(); from Python read it through rpy2. Filter on confidence before use, then rename tf/target/mor to source/target/weight for a decoupler-style network.",
                    },
                ],
            },
            {
                id: "dorothea-mouse",
                version: "current",
                title: "DoRothEA mouse TF regulons",
                description:
                    "DoRothEA transcription-factor regulons for Mus musculus with per-interaction confidence levels A-E, where A is the best-supported. The confidence-filtered alternative to CollecTRI for TF-activity inference; most analyses keep levels A-C. Tracks the package's default branch, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "mouse",
                sourceUrl: "https://github.com/saezlab/dorothea",
                license: { identifier: "GPL-3.0", url: "https://github.com/saezlab/dorothea/blob/master/LICENSE" },
                recommendation: { group: "regulatory-networks", recommended: true },
                artifacts: [
                    {
                        path: "dorothea_mm.rda",
                        url: "https://raw.githubusercontent.com/saezlab/dorothea/master/data/dorothea_mm.rda",
                        format: "rda",
                        contents:
                            "R serialized data frame `dorothea_mm` of TF-target regulons: columns tf, confidence (A-E), target, mor (+1 activating, -1 repressing). Load in R with load(); from Python read it through rpy2. Filter on confidence before use, then rename tf/target/mor to source/target/weight for a decoupler-style network.",
                    },
                ],
            },
            {
                id: "gtex-v8",
                version: "8",
                title: "GTEx v8 normal tissue expression",
                description:
                    "GTEx v8 median gene TPM by tissue (GCT) with the sample attributes table, for normal-reference workflows. Immutable v8 release files.",
                organism: "human",
                sourceUrl: "https://gtexportal.org/home/downloads/adult-gtex/bulk_tissue_expression",
                license: { identifier: "GTEx-Portal-Data-License", url: "https://gtexportal.org/home/license" },
                recommendation: { group: "normal-expression", recommended: true },
                artifacts: [
                    {
                        path: "GTEx_Analysis_2017-06-05_v8_RNASeQCv1.1.9_gene_median_tpm.gct.gz",
                        url: "https://storage.googleapis.com/adult-gtex/bulk-gex/v8/rna-seq/GTEx_Analysis_2017-06-05_v8_RNASeQCv1.1.9_gene_median_tpm.gct.gz",
                        format: "gct",
                        contents:
                            "Gzipped GCT: skip 2 header lines, then columns Name (versioned Ensembl gene ID — strip the suffix to join) and Description (symbol), followed by one median-TPM column per tissue.",
                    },
                    {
                        path: "GTEx_Analysis_v8_Annotations_SampleAttributesDS.txt",
                        url: "https://storage.googleapis.com/adult-gtex/annotations/v8/metadata-files/GTEx_Analysis_v8_Annotations_SampleAttributesDS.txt",
                        format: "tsv",
                        contents:
                            "Per-sample attributes; key columns SAMPID, SMTS (tissue) and SMTSD (detailed tissue). Only needed to interpret or regroup the tissue columns.",
                    },
                ],
            },
            {
                id: "hpa-proteinatlas",
                version: "current",
                title: "Human Protein Atlas",
                description:
                    "The full Human Protein Atlas table (proteinatlas.tsv.zip, ~7 MB): per-gene RNA/protein tissue expression, tissue specificity, subcellular location, secretome and blood-concentration annotations for Homo sapiens. HPA republishes this file per release, so it is verified against what you downloaded rather than a checked-in digest.",
                organism: "human",
                sourceUrl: "https://www.proteinatlas.org/about/download",
                license: { identifier: "CC-BY-SA-3.0", url: "https://www.proteinatlas.org/about/licence" },
                recommendation: { group: "normal-expression", recommended: true },
                artifacts: [
                    {
                        path: "proteinatlas.tsv.zip",
                        url: "https://www.proteinatlas.org/download/proteinatlas.tsv.zip",
                        format: "zip",
                        contents:
                            "Zip holding a single proteinatlas.tsv — one row per gene with Ensembl and Gene columns plus RNA/protein tissue expression, tissue specificity, subcellular location, secretome and blood-concentration annotations. Read the member from the archive; do not expect a bare .tsv on disk.",
                    },
                ],
            },
            {
                id: "celltypist-immune",
                version: "2",
                title: "CellTypist immune cell models",
                description:
                    "CellTypist Immune All low- and high-resolution models for immune cell-type annotation. Load by absolute path — CellTypist's by-name lookup expects its own cache layout, which the reference store deliberately does not impersonate.",
                organism: "human",
                sourceUrl: "https://www.celltypist.org/models",
                license: { identifier: "NOASSERTION" },
                recommendation: { group: "cell-typing", recommended: true },
                artifacts: [
                    {
                        path: "Immune_All_Low.pkl",
                        url: "https://celltypist.cog.sanger.ac.uk/models/Pan_Immune_CellTypist/v2/Immune_All_Low.pkl",
                        format: "pickle",
                        contents:
                            "Trained CellTypist model, fine-grained immune labels. Load by absolute path through CellTypist's model loader; passing the bare name makes it search its own cache and fail.",
                    },
                    {
                        path: "Immune_All_High.pkl",
                        url: "https://celltypist.cog.sanger.ac.uk/models/Pan_Immune_CellTypist/v2/Immune_All_High.pkl",
                        format: "pickle",
                        contents:
                            "Trained CellTypist model, coarse-grained immune labels. Load by absolute path through CellTypist's model loader; passing the bare name makes it search its own cache and fail.",
                    },
                ],
            },
            {
                id: "celltypist-pan-fetal",
                version: "2",
                title: "CellTypist pan-fetal human model",
                description:
                    "CellTypist Pan_Fetal_Human model — cell-type annotation across human fetal tissues. Load by absolute path; CellTypist's by-name lookup expects its own cache layout, which the reference store deliberately does not impersonate.",
                organism: "human",
                sourceUrl: "https://www.celltypist.org/models",
                license: { identifier: "NOASSERTION" },
                recommendation: { group: "cell-typing", recommended: true },
                artifacts: [
                    {
                        path: "Pan_Fetal_Human.pkl",
                        url: "https://celltypist.cog.sanger.ac.uk/models/Pan_Fetal_Suo/v2/Pan_Fetal_Human.pkl",
                        format: "pickle",
                        contents:
                            "Trained CellTypist model covering human fetal tissues. Load by absolute path through CellTypist's model loader; passing the bare name makes it search its own cache and fail.",
                    },
                ],
            },
            {
                id: "celltypist-covid19",
                version: "1",
                title: "CellTypist COVID-19 immune model",
                description:
                    "CellTypist COVID19_Immune_Landscape model — immune cell-type annotation trained on the cross-study COVID-19 immune atlas. Load by absolute path; CellTypist's by-name lookup expects its own cache layout, which the reference store deliberately does not impersonate.",
                organism: "human",
                sourceUrl: "https://www.celltypist.org/models",
                license: { identifier: "NOASSERTION" },
                recommendation: { group: "cell-typing", recommended: true },
                artifacts: [
                    {
                        path: "COVID19_Immune_Landscape.pkl",
                        url: "https://celltypist.cog.sanger.ac.uk/models/COVID19_Immune_Ren/v1/COVID19_Immune_Landscape.pkl",
                        format: "pickle",
                        contents:
                            "Trained CellTypist model from the cross-study COVID-19 immune atlas. Load by absolute path through CellTypist's model loader; passing the bare name makes it search its own cache and fail.",
                    },
                ],
            },
            {
                id: "panglaodb-markers",
                version: "2020.03.27",
                title: "PanglaoDB cell-type markers",
                description:
                    "PanglaoDB cell-type marker panel (tab-separated, gzipped): curated marker genes per cell type across human and mouse, for marker-based annotation. From the immutable 27 March 2020 PanglaoDB marker release.",
                sourceUrl: "https://panglaodb.se/markers.html",
                license: { identifier: "NOASSERTION" },
                recommendation: { group: "cell-typing", recommended: true },
                artifacts: [
                    {
                        path: "PanglaoDB_markers_27_Mar_2020.tsv.gz",
                        url: "https://panglaodb.se/markers/PanglaoDB_markers_27_Mar_2020.tsv.gz",
                        format: "tsv",
                        contents:
                            "Gzipped marker table covering human and mouse together — filter the species column ('Hs', 'Mm', or both) before use. Key columns: species, official gene symbol, cell type, organ, ubiquitousness index.",
                    },
                ],
            },
            {
                id: "azimuth-pbmc",
                version: "1.0.0",
                title: "Azimuth human PBMC reference",
                description:
                    "Azimuth annotated reference for human peripheral blood mononuclear cells: the Seurat reference object plus its Annoy nearest-neighbour index, for supervised mapping and cell-type label transfer. Immutable Zenodo release 4546839.",
                organism: "human",
                sourceUrl: "https://zenodo.org/records/4546839",
                license: { identifier: "CC-BY-4.0", url: "https://zenodo.org/records/4546839" },
                recommendation: { group: "cell-typing", recommended: true },
                artifacts: [
                    {
                        path: "ref.Rds",
                        url: "https://zenodo.org/records/4546839/files/ref.Rds",
                        format: "rds",
                        contents: "Seurat reference object (PBMC) for Azimuth label transfer, read with readRDS. Requires idx.annoy in the same directory.",
                    },
                    {
                        path: "idx.annoy",
                        url: "https://zenodo.org/records/4546839/files/idx.annoy",
                        format: "annoy",
                        contents:
                            "Annoy neighbour index paired with ref.Rds. Never opened directly — Azimuth loads it via the reference object, which needs both files side by side.",
                    },
                ],
            },
            {
                // ~443 MB (ref + index), so it is opt-in rather than part of a default setup.
                id: "azimuth-tonsil",
                version: "1.0.0",
                title: "Azimuth human tonsil reference",
                description:
                    "Azimuth annotated reference for human tonsil: the Seurat reference object plus its Annoy nearest-neighbour index, for supervised mapping and cell-type label transfer. Immutable Zenodo release 7032928, roughly 443 MB.",
                organism: "human",
                sourceUrl: "https://zenodo.org/records/7032928",
                license: { identifier: "CC-BY-4.0", url: "https://zenodo.org/records/7032928" },
                recommendation: { group: "cell-typing", recommended: false },
                artifacts: [
                    {
                        path: "ref.Rds",
                        url: "https://zenodo.org/records/7032928/files/ref.Rds",
                        format: "rds",
                        contents: "Seurat reference object (tonsil) for Azimuth label transfer, read with readRDS. Requires idx.annoy in the same directory.",
                    },
                    {
                        path: "idx.annoy",
                        url: "https://zenodo.org/records/7032928/files/idx.annoy",
                        format: "annoy",
                        contents:
                            "Annoy neighbour index paired with ref.Rds. Never opened directly — Azimuth loads it via the reference object, which needs both files side by side.",
                    },
                ],
            },
            {
                // ~842 MB reference genome bundle, PGx-specific, so it is opt-in rather than a default download.
                id: "pharmcat-grch38-fasta",
                version: "GRCh38.p13",
                title: "PharmCAT GRCh38 reference FASTA",
                description:
                    "The GRCh38.p13 reference genome FASTA that PharmCAT's VCF preprocessor expects (bgzip'd with a .fai/.gzi faidx), bundled as a tar — roughly 842 MB. Immutable Zenodo release 7288118. Needed only for pharmacogenomics (PharmCAT) workflows.",
                organism: "human",
                sourceUrl: "https://zenodo.org/records/7288118",
                license: { identifier: "CC-BY-4.0", url: "https://zenodo.org/records/7288118" },
                recommendation: { group: "pharmacogenomics", recommended: false },
                artifacts: [
                    {
                        path: "PharmCAT_GRCh38_reference_fasta.tar",
                        url: "https://zenodo.org/records/7288118/files/GRCh38_reference_fasta.tar?download=1",
                        format: "tar",
                        contents:
                            "Tar bundle of the GRCh38.p13 bgzip-compressed FASTA with its .fai and .gzi indexes. Extract to a writable directory first, then point the tool at the extracted .fna.bgz — the store is read-only, and nothing reads this tar in place.",
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
