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
                            "Mouse hallmark sets, one per line, tab-separated: set name, source URL, then member gene symbols (MGI). Hallmark only; GO, oncogenic and immunologic sets are separate datasets, and the remaining MSigDB collections are not staged at all.",
                    },
                ],
            },
            {
                // The only route to GO-based enrichment here: no GAF, no OBO, and no
                // org.*.eg.db GO mapping is staged anywhere else in this catalog.
                // Split by branch rather than shipping the combined c5.go, because the
                // three answer different questions and testing all of them together
                // triples the multiple-testing burden for an analyst who wanted one.
                id: "msigdb-go-human",
                version: "2026.1",
                title: "MSigDB human GO gene sets",
                description:
                    "Gene Ontology gene sets for Homo sapiens from the MSigDB C5 collection (symbols GMT), as three per-branch files: biological process, cellular component, molecular function. The mechanism-level complement to hallmark — hallmark names 50 broad states, these name ~10,500 specific processes, compartments and activities. From the immutable MSigDB 2026.1 human release, roughly 6.6 MB combined.",
                organism: "human",
                sourceUrl: "https://data.broadinstitute.org/gsea-msigdb/msigdb/",
                license: { identifier: "MSigDB-License", url: "https://www.gsea-msigdb.org/gsea/msigdb/license.jsp" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        path: "c5.go.bp.v2026.1.Hs.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Hs/c5.go.bp.v2026.1.Hs.symbols.gmt",
                        format: "gmt",
                        contents:
                            "7,538 GO Biological Process sets, one per line, tab-separated: set name (GOBP_*), source URL, then member gene symbols (HGNC). The branch to reach for when the question is 'what process changed'. GO is a nested hierarchy, so parent and child sets share most of their members — expect blocks of correlated significant hits rather than independent findings, and collapse them before reporting a count.",
                    },
                    {
                        path: "c5.go.cc.v2026.1.Hs.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Hs/c5.go.cc.v2026.1.Hs.symbols.gmt",
                        format: "gmt",
                        contents:
                            "1,080 GO Cellular Component sets (GOCC_*), same tab-separated GMT shape and HGNC symbols. Localization rather than activity — the branch that detects a shift in where proteins sit (mitochondrial, ribosomal, cell-surface), which a process-level test often misses entirely.",
                    },
                    {
                        path: "c5.go.mf.v2026.1.Hs.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Hs/c5.go.mf.v2026.1.Hs.symbols.gmt",
                        format: "gmt",
                        contents:
                            "1,872 GO Molecular Function sets (GOMF_*), same tab-separated GMT shape and HGNC symbols. Biochemical activity of the gene product — binding, catalysis, transport. The narrowest of the three branches and the one whose sets are smallest, so it is the most sensitive to a low gene-count cutoff.",
                    },
                ],
            },
            {
                id: "msigdb-go-mouse",
                version: "2026.1",
                title: "MSigDB mouse GO gene sets",
                description:
                    "Gene Ontology gene sets for Mus musculus from the MSigDB M5 collection (symbols GMT), as three per-branch files: biological process, cellular component, molecular function. From the immutable MSigDB 2026.1 mouse release, roughly 6.9 MB combined. Native mouse annotation with MGI symbols — not the human collection mapped across, so no ortholog step is needed or wanted.",
                organism: "mouse",
                sourceUrl: "https://data.broadinstitute.org/gsea-msigdb/msigdb/",
                license: { identifier: "MSigDB-License", url: "https://www.gsea-msigdb.org/gsea/msigdb/license.jsp" },
                recommendation: { group: "pathways", recommended: true },
                artifacts: [
                    {
                        path: "m5.go.bp.v2026.1.Mm.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Mm/m5.go.bp.v2026.1.Mm.symbols.gmt",
                        format: "gmt",
                        contents:
                            "7,781 GO Biological Process sets (GOBP_*), one per line, tab-separated: set name, source URL, then member gene symbols in MGI nomenclature. Nested hierarchy, so parent and child sets overlap heavily. Running this against human symbols matches almost nothing — case differs (Actb vs ACTB) and it fails silently as an empty result, not an error.",
                    },
                    {
                        path: "m5.go.cc.v2026.1.Mm.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Mm/m5.go.cc.v2026.1.Mm.symbols.gmt",
                        format: "gmt",
                        contents: "1,067 GO Cellular Component sets (GOCC_*), same GMT shape, MGI symbols. Subcellular localization rather than process.",
                    },
                    {
                        path: "m5.go.mf.v2026.1.Mm.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Mm/m5.go.mf.v2026.1.Mm.symbols.gmt",
                        format: "gmt",
                        contents: "1,899 GO Molecular Function sets (GOMF_*), same GMT shape, MGI symbols. Biochemical activity of the gene product.",
                    },
                ],
            },
            {
                // Human-only, and that is upstream's shape rather than an omission here:
                // MSigDB publishes no mouse C6 counterpart (m6 returns 404), because the
                // signatures are defined from perturbed human cancer cell lines.
                id: "msigdb-oncogenic-human",
                version: "2026.1",
                title: "MSigDB human oncogenic signature gene sets",
                description:
                    "The MSigDB C6 oncogenic signatures for Homo sapiens (symbols GMT): 189 gene sets, each the expression response to a defined oncogene or tumour-suppressor perturbation in cancer cell lines. Used to read out which oncogenic pathway looks active in a tumour expression profile, which hallmark cannot resolve. Immutable MSigDB 2026.1 human release, ~206 KB.",
                organism: "human",
                sourceUrl: "https://data.broadinstitute.org/gsea-msigdb/msigdb/",
                license: { identifier: "MSigDB-License", url: "https://www.gsea-msigdb.org/gsea/msigdb/license.jsp" },
                recommendation: { group: "pathways", recommended: false },
                artifacts: [
                    {
                        path: "c6.all.v2026.1.Hs.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Hs/c6.all.v2026.1.Hs.symbols.gmt",
                        format: "gmt",
                        contents:
                            "189 sets, one per line, tab-separated: set name, source URL, then member gene symbols (HGNC). Set names encode the perturbation and its direction — a _UP suffix means genes rising when that oncogene is active, _DN means falling — so the two halves of one signature must be read as a pair and never merged. These are empirical cell-line responses, not curated pathways: enrichment says the profile resembles that perturbation, not that the pathway is mechanistically engaged.",
                    },
                ],
            },
            {
                id: "msigdb-immunologic-human",
                version: "2026.1",
                title: "MSigDB human immunologic signature gene sets",
                description:
                    "ImmuneSigDB for Homo sapiens (MSigDB C7, symbols GMT): 4,872 gene sets from published contrasts between immune cell states — cell types, stimulation conditions, and activation timepoints. The reference for interpreting an immune expression signature against what has been observed before. Immutable MSigDB 2026.1 human release, ~6.7 MB. This is the ImmuneSigDB subset; the vaccine-response subset is not staged.",
                organism: "human",
                sourceUrl: "https://data.broadinstitute.org/gsea-msigdb/msigdb/",
                license: { identifier: "MSigDB-License", url: "https://www.gsea-msigdb.org/gsea/msigdb/license.jsp" },
                recommendation: { group: "pathways", recommended: false },
                artifacts: [
                    {
                        path: "c7.immunesigdb.v2026.1.Hs.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Hs/c7.immunesigdb.v2026.1.Hs.symbols.gmt",
                        format: "gmt",
                        contents:
                            "4,872 sets, one per line, tab-separated: set name, source URL, then member gene symbols (HGNC). Every set is one side of a specific published two-condition comparison, and the name encodes both arms plus a _UP/_DN direction — so a hit means 'resembles that contrast', and reporting it without naming the contrast's cell type and stimulus is uninterpretable. The set count is large enough that FDR across the whole collection is severe; restrict to a relevant subset by name before testing where the question allows it.",
                    },
                ],
            },
            {
                id: "msigdb-immunologic-mouse",
                version: "2026.1",
                title: "MSigDB mouse immunologic signature gene sets",
                description:
                    "The MSigDB M7 immunologic signature collection for Mus musculus (symbols GMT): 787 gene sets from murine immune cell state and stimulation contrasts. Immutable MSigDB 2026.1 mouse release, ~523 KB. Far smaller than the human collection — mouse has no ImmuneSigDB-scale counterpart, so absence of a match here is weaker evidence than it would be for human.",
                organism: "mouse",
                sourceUrl: "https://data.broadinstitute.org/gsea-msigdb/msigdb/",
                license: { identifier: "MSigDB-License", url: "https://www.gsea-msigdb.org/gsea/msigdb/license.jsp" },
                recommendation: { group: "pathways", recommended: false },
                artifacts: [
                    {
                        path: "m7.all.v2026.1.Mm.symbols.gmt",
                        url: "https://data.broadinstitute.org/gsea-msigdb/msigdb/release/2026.1.Mm/m7.all.v2026.1.Mm.symbols.gmt",
                        format: "gmt",
                        contents:
                            "787 sets, one per line, tab-separated: set name, source URL, then member gene symbols in MGI nomenclature. Each set is one arm of a published immune contrast with a _UP/_DN direction; name the contrast when reporting a hit. Mouse symbols, so it cannot be run against human data without an ortholog mapping step.",
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
                // The publisher's static archive of exactly what its web service returns.
                // OmniPath's documented access route is a REST client, which is unreachable
                // with egress blocked; this dump is the same content as a file. Sign and
                // direction are what make it usable as a causal prior — a scored but
                // unsigned PPI (see the STRING entry) cannot substitute, because a method
                // that infers which way a signal flowed has nothing to infer from.
                id: "omnipath-interactions",
                version: "current",
                title: "OmniPath signed, directed molecular interaction network",
                description:
                    "The OmniPath integrated interaction network as a static bulk export: literature-curated molecular interactions with direction and sign (stimulation or inhibition), the prior-knowledge network causal signalling inference needs. Covers human, mouse and rat in one 95 MB gzipped table. The publisher rebuilds this export in place, so it is verified against what you downloaded rather than a checked-in digest.",
                sourceUrl: "https://archive.omnipathdb.org/",
                // OmniPath integrates dozens of upstream resources and states that each one
                // carries over its own licence, so there is no single identifier to name. A
                // few components are CC BY-NC; the commercial-use filter exists only as a
                // REST parameter, so this dump is the unfiltered academic superset.
                license: { identifier: "LicenseRef-OmniPath-Per-Resource", url: "https://omnipathdb.org/info" },
                recommendation: { group: "interaction-networks", recommended: false },
                artifacts: [
                    {
                        path: "omnipath_webservice_interactions__latest.tsv.gz",
                        url: "https://archive.omnipathdb.org/omnipath_webservice_interactions__latest.tsv.gz",
                        format: "tsv",
                        contents:
                            "Gzipped TSV, 37 columns, ~1.95 million rows. MULTI-SPECIES — filter ncbi_tax_id_source and ncbi_tax_id_target to one organism first (9606 human, 10090 mouse, 10116 rat); there is no per-organism file, and leaving it unfiltered silently mixes species into one graph. Use source_genesymbol/target_genesymbol, NOT the source/target columns, which are UniProt accessions: node names have to match the TF-activity vector they will be scored against, and those carry gene symbols. To derive a signed causal network: keep type == 'post_translational', require is_directed, and take is_stimulation XOR is_inhibition, mapping to +1 and -1. Restricting further to the 'omnipath' core column with the consensus_* columns yields roughly 71,000 edges over 7,100 nodes, which is the usual working size; curation_effort >= 2 cuts that to about 15,500 for a high-confidence variant.",
                    },
                ],
            },
            {
                // Sized and shaped for network proximity, which needs breadth over precision:
                // a genome-scale graph where path lengths between a drug's targets and a
                // disease module are meaningful. Unsigned and undirected, so it cannot serve
                // as a causal prior — that is the OmniPath entry above.
                id: "string-ppi-human",
                version: "12.0",
                title: "STRING human protein-protein interaction network",
                description:
                    "STRING v12.0 functional protein association network for Homo sapiens: every protein pair with a combined confidence score, the genome-scale graph network-proximity methods measure distances over. Roughly 85 MB across two files — the network itself and the identifier mapping it cannot be read without. Immutable v12.0 release.",
                organism: "human",
                sourceUrl: "https://string-db.org/cgi/access",
                license: { identifier: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
                recommendation: { group: "interaction-networks", recommended: false },
                artifacts: [
                    {
                        path: "9606.protein.links.v12.0.txt.gz",
                        url: "https://stringdb-downloads.org/download/protein.links.v12.0/9606.protein.links.v12.0.txt.gz",
                        format: "tsv",
                        contents:
                            "Gzipped and SPACE-delimited despite the .txt name — a tab-expecting reader parses every row into one column without erroring. Header 'protein1 protein2 combined_score', ~13.7 million rows. Nodes are STRING internal ids ('9606.ENSP00000000233'), which are taxid-prefixed Ensembl protein ids and NOT gene symbols, so this file is unusable on its own: join the info file beside it to get names. Every edge appears twice, once per direction, which an undirected graph constructor collapses for you but a naive edge count will not. Scores are 0-1000 confidence, unsigned and undirected. The conventional high-confidence cut is combined_score >= 700, leaving roughly 237,000 unique edges over 16,200 proteins; the full graph is 6.9 million edges and too dense for distance measures to mean much.",
                    },
                    {
                        path: "9606.protein.info.v12.0.txt.gz",
                        url: "https://stringdb-downloads.org/download/protein.info.v12.0/9606.protein.info.v12.0.txt.gz",
                        format: "tsv",
                        contents:
                            "Gzipped TSV, ~19,700 rows, header '#string_protein_id preferred_name protein_size annotation'. Mandatory rather than supplementary: preferred_name is the gene symbol for each STRING id in the links file, and without this join the network cannot be connected to a gene list, a drug-target set, or any other dataset here.",
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
                // Comprehensive rather than `basic`: this is what "the GENCODE annotation" means, and a
                // silently reduced transcript set is a worse surprise than a larger download.
                id: "gencode-human",
                version: "50",
                title: "GENCODE human gene annotation (GRCh38)",
                description:
                    "GENCODE release 50 comprehensive gene annotation for Homo sapiens on GRCh38 — gene, transcript, exon, CDS and UTR features with HGNC symbols and versioned Ensembl identifiers. The annotation behind TSS and promoter definition, nearest-gene assignment, and gene-body overlap. Immutable release, roughly 125 MB gzipped.",
                organism: "human",
                sourceUrl: "https://www.gencodegenes.org/human/",
                license: { identifier: "NOASSERTION", url: "https://www.ensembl.org/info/about/legal/disclaimer.html" },
                recommendation: { group: "genome-annotation", recommended: false },
                artifacts: [
                    {
                        path: "gencode.v50.annotation.gtf.gz",
                        url: "https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_50/gencode.v50.annotation.gtf.gz",
                        format: "gtf",
                        contents:
                            "Gzipped GTF on GRCh38, contigs named UCSC-style with the 'chr' prefix ('chr1'), which matches the UCSC chromosome-sizes and ENCODE blacklist entries but NOT the Ensembl/NCBI-style naming ClinVar and the NCBI mapping tables use — intersecting across the two conventions returns zero rows without erroring. Column 9 holds gene_id (versioned Ensembl), gene_type, gene_name. GTF is 1-based inclusive; BED is 0-based half-open.",
                    },
                ],
            },
            {
                id: "gencode-mouse",
                version: "M39",
                title: "GENCODE mouse gene annotation (GRCm39)",
                description:
                    "GENCODE release M39 comprehensive gene annotation for Mus musculus on GRCm39 — gene, transcript, exon, CDS and UTR features with MGI symbols and versioned Ensembl identifiers. Immutable release, roughly 92 MB gzipped. Note the build: GRCm39/mm39, which does NOT match the mm10 ENCODE blacklist.",
                organism: "mouse",
                sourceUrl: "https://www.gencodegenes.org/mouse/",
                license: { identifier: "NOASSERTION", url: "https://www.ensembl.org/info/about/legal/disclaimer.html" },
                recommendation: { group: "genome-annotation", recommended: false },
                artifacts: [
                    {
                        path: "gencode.vM39.annotation.gtf.gz",
                        url: "https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_mouse/release_M39/gencode.vM39.annotation.gtf.gz",
                        format: "gtf",
                        contents:
                            "Gzipped GTF on GRCm39 (mm39), contigs named UCSC-style with the 'chr' prefix. Column 9 holds gene_id (versioned Ensembl), gene_type, gene_name. GTF is 1-based inclusive; BED is 0-based half-open. Coordinates are GRCm39 — mm10/GRCm38 intervals are a different coordinate space and must be lifted over, not mixed.",
                    },
                ],
            },
            {
                // Tiny (a few KB) and it unblocks the whole bedtools genome-file family, so the
                // opt-in rationale — never silently pull hundreds of MB — simply does not apply.
                id: "ucsc-chrom-sizes-human",
                version: "hg38",
                title: "UCSC human chromosome sizes (hg38)",
                description:
                    "Chromosome names and lengths for GRCh38/hg38 — the 'genome file' that bedtools slop, flank, complement, genomecov and random require, and that pybedtools' built-in chromsizes() lookup can only obtain over the network. A few kilobytes.",
                organism: "human",
                sourceUrl: "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/",
                license: { identifier: "UCSC-Genome-Browser-Data-License", url: "https://genome.ucsc.edu/license/" },
                recommendation: { group: "genome-annotation", recommended: true },
                artifacts: [
                    {
                        path: "hg38.chrom.sizes",
                        url: "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/bigZips/hg38.chrom.sizes",
                        format: "tsv",
                        contents:
                            "Two columns, no header: contig name then length in bp ('chr1\\t248956422'). UCSC 'chr'-prefixed naming, matching the GENCODE and ENCODE blacklist entries. Includes scaffolds and alts alongside the primary chromosomes — filter to the primary set if downstream output should not carry them.",
                    },
                ],
            },
            {
                id: "ucsc-chrom-sizes-mouse",
                version: "mm39",
                title: "UCSC mouse chromosome sizes (mm39)",
                description:
                    "Chromosome names and lengths for GRCm39/mm39 — the 'genome file' bedtools interval operations require. A few kilobytes. Build-matched to the GENCODE M39 annotation, NOT to the mm10 ENCODE blacklist.",
                organism: "mouse",
                sourceUrl: "https://hgdownload.soe.ucsc.edu/goldenPath/mm39/bigZips/",
                license: { identifier: "UCSC-Genome-Browser-Data-License", url: "https://genome.ucsc.edu/license/" },
                recommendation: { group: "genome-annotation", recommended: true },
                artifacts: [
                    {
                        path: "mm39.chrom.sizes",
                        url: "https://hgdownload.soe.ucsc.edu/goldenPath/mm39/bigZips/mm39.chrom.sizes",
                        format: "tsv",
                        contents:
                            "Two columns, no header: contig name then length in bp. UCSC 'chr'-prefixed naming. Lengths are GRCm39/mm39 — using them with mm10 intervals produces silently truncated or out-of-bounds coordinates rather than an error.",
                    },
                ],
            },
            {
                // Ensembl's `dna_index/` directory, NOT the `dna/` one beside it, and that
                // choice is forced rather than preferential. Every other candidate — UCSC
                // (plain and analysis set), NCBI's analysis sets, GENCODE, and Ensembl's own
                // `dna/` — ships plain gzip, which htslib refuses outright ("Cannot index
                // files compressed with gzip, please use bgzip"). `dna_index/` is the one
                // upstream publishing BGZF, and the only one publishing the .fai and .gzi
                // alongside. That second point is the load-bearing one: samtools, bcftools,
                // bedtools and pyfaidx all build a missing index NEXT TO the FASTA, which a
                // read-only mount makes impossible — so an upstream-published index is not a
                // convenience here, it is the difference between usable and inert.
                id: "ensembl-genome-human",
                version: "116",
                title: "Ensembl human reference genome sequence (GRCh38)",
                description:
                    "The GRCh38 reference genome sequence for Homo sapiens as BGZF-compressed FASTA with its published faidx and BGZF-block indexes — the genome behind sequence extraction at intervals, VCF left-alignment and normalisation, and CRAM decoding. Ensembl release 116, roughly 848 MB. Contigs are named WITHOUT a 'chr' prefix, the opposite convention from the GENCODE annotation and UCSC chromosome sizes in this catalog; see the artifact notes.",
                organism: "human",
                sourceUrl: "https://ftp.ensembl.org/pub/release-116/fasta/homo_sapiens/dna_index/",
                license: { identifier: "Ensembl-Terms-Of-Use", url: "https://www.ensembl.org/info/about/legal/disclaimer.html" },
                recommendation: { group: "genome-sequence", recommended: false },
                artifacts: [
                    {
                        path: "Homo_sapiens.GRCh38.dna.toplevel.fa.gz",
                        url: "https://ftp.ensembl.org/pub/release-116/fasta/homo_sapiens/dna_index/Homo_sapiens.GRCh38.dna.toplevel.fa.gz",
                        format: "fasta",
                        contents:
                            "BGZF-compressed FASTA — block-compressed, so it opens for random access, NOT plain gzip despite the .gz suffix. Contigs are '1', '2', ... 'X', 'Y', 'MT' with NO 'chr' prefix: this matches the ClinVar VCF and the common-SNP site list here, and clashes with the GENCODE GTF, UCSC chromosome sizes and ENCODE blacklist, which are all 'chr'-prefixed. Crossing the two conventions returns empty output without erroring, so strip or add the prefix on the interval side before extracting. This is the 'toplevel' set: 706 contigs and 3.29 Gbp, of which 510 are patch and haplotype scaffolds on top of the 3.10 Gbp primary assembly — restrict to the primary contigs when extra scaffolds would change a result. Ensembl publishes no dna_index build of primary_assembly alone.",
                    },
                    {
                        path: "Homo_sapiens.GRCh38.dna.toplevel.fa.gz.fai",
                        url: "https://ftp.ensembl.org/pub/release-116/fasta/homo_sapiens/dna_index/Homo_sapiens.GRCh38.dna.toplevel.fa.gz.fai",
                        format: "fai",
                        contents:
                            "Faidx index over the BGZF FASTA, giving each contig's length and offset. Must sit beside the FASTA and is never opened directly. It is staged rather than generated because the reference store is read-only and every reader here writes a missing index next to the source file, which fails with EACCES instead of falling back.",
                    },
                    {
                        path: "Homo_sapiens.GRCh38.dna.toplevel.fa.gz.gzi",
                        url: "https://ftp.ensembl.org/pub/release-116/fasta/homo_sapiens/dna_index/Homo_sapiens.GRCh38.dna.toplevel.fa.gz.gzi",
                        format: "gzi",
                        contents:
                            "BGZF block index mapping uncompressed offsets to compressed blocks — what turns the .fai's coordinates into a seek without decompressing the whole file. Required alongside the .fai for compressed random access; without it a reader falls back to a linear scan of an 848 MB file per query.",
                    },
                ],
            },
            {
                // Mouse toplevel IS the primary assembly here — 61 contigs, no patches or
                // alts — so unlike human there is nothing to restrict away.
                id: "ensembl-genome-mouse",
                version: "116",
                title: "Ensembl mouse reference genome sequence (GRCm39)",
                description:
                    "The GRCm39 reference genome sequence for Mus musculus as BGZF-compressed FASTA with its published faidx and BGZF-block indexes. Ensembl release 116, roughly 730 MB. Build-matched to the GENCODE M39 annotation and mm39 chromosome sizes in this catalog, though named without their 'chr' prefix — and NOT matched to the mm10 ENCODE blacklist, which is a different coordinate space.",
                organism: "mouse",
                sourceUrl: "https://ftp.ensembl.org/pub/release-116/fasta/mus_musculus/dna_index/",
                license: { identifier: "Ensembl-Terms-Of-Use", url: "https://www.ensembl.org/info/about/legal/disclaimer.html" },
                recommendation: { group: "genome-sequence", recommended: false },
                artifacts: [
                    {
                        path: "Mus_musculus.GRCm39.dna.toplevel.fa.gz",
                        url: "https://ftp.ensembl.org/pub/release-116/fasta/mus_musculus/dna_index/Mus_musculus.GRCm39.dna.toplevel.fa.gz",
                        format: "fasta",
                        contents:
                            "BGZF-compressed FASTA — block-compressed for random access, NOT plain gzip despite the .gz suffix. Contigs are '1'...'19', 'X', 'Y', 'MT' with NO 'chr' prefix, so they must be reconciled with the 'chr'-prefixed GENCODE M39 GTF and mm39 chromosome sizes before any interval operation; mismatched naming yields empty output rather than an error. Toplevel here is exactly the primary assembly — 61 contigs, 2.73 Gbp, no patch or haplotype scaffolds — so no filtering is needed. Coordinates are GRCm39: mm10/GRCm38 intervals are a different space and must be lifted over, not mixed.",
                    },
                    {
                        path: "Mus_musculus.GRCm39.dna.toplevel.fa.gz.fai",
                        url: "https://ftp.ensembl.org/pub/release-116/fasta/mus_musculus/dna_index/Mus_musculus.GRCm39.dna.toplevel.fa.gz.fai",
                        format: "fai",
                        contents:
                            "Faidx index over the BGZF FASTA. Must sit beside it and is never opened directly. Staged rather than generated because the reference store is read-only and readers write a missing index next to the source file, failing with EACCES.",
                    },
                    {
                        path: "Mus_musculus.GRCm39.dna.toplevel.fa.gz.gzi",
                        url: "https://ftp.ensembl.org/pub/release-116/fasta/mus_musculus/dna_index/Mus_musculus.GRCm39.dna.toplevel.fa.gz.gzi",
                        format: "gzi",
                        contents:
                            "BGZF block index pairing with the .fai to make compressed random access possible. Without it every coordinate query degrades to a linear scan of the whole compressed file.",
                    },
                ],
            },
            {
                id: "encode-blacklist-human",
                version: "2",
                title: "ENCODE blacklist regions, human (hg38)",
                description:
                    "ENCODE blacklist v2 for GRCh38/hg38: the low-mappability and anomalous-high-signal regions that produce artefactual peaks in ChIP-seq, ATAC-seq and CUT&RUN. Excluded before peak calling or differential binding. A few kilobytes.",
                organism: "human",
                sourceUrl: "https://github.com/Boyle-Lab/Blacklist",
                license: { identifier: "GPL-3.0", url: "https://github.com/Boyle-Lab/Blacklist/blob/master/LICENSE" },
                recommendation: { group: "genome-annotation", recommended: true },
                artifacts: [
                    {
                        path: "hg38-blacklist.v2.bed.gz",
                        url: "https://raw.githubusercontent.com/Boyle-Lab/Blacklist/master/lists/hg38-blacklist.v2.bed.gz",
                        format: "bed",
                        contents:
                            "Gzipped BED, no header: chrom, start, end, then a reason label ('Low Mappability' or 'High Signal Region'). 'chr'-prefixed hg38 naming. Subtract these intervals from peaks rather than intersecting — the point is exclusion, and the file lists regions to discard, not to keep.",
                    },
                ],
            },
            {
                // Upstream ships no mm39 blacklist — v2 stops at mm10 — so this is the one entry in
                // the mouse set on a different build from the others. Stated everywhere it is visible.
                id: "encode-blacklist-mouse",
                version: "2",
                title: "ENCODE blacklist regions, mouse (mm10)",
                description:
                    "ENCODE blacklist v2 for mouse: low-mappability and anomalous-high-signal regions excluded before peak calling. Published for mm10/GRCm38 only — there is no mm39 release — so it is on a DIFFERENT build from the GENCODE M39 annotation and mm39 chromosome sizes. Lift it over to GRCm39, or work in mm10 throughout; do not mix. A few kilobytes.",
                organism: "mouse",
                sourceUrl: "https://github.com/Boyle-Lab/Blacklist",
                license: { identifier: "GPL-3.0", url: "https://github.com/Boyle-Lab/Blacklist/blob/master/LICENSE" },
                recommendation: { group: "genome-annotation", recommended: true },
                artifacts: [
                    {
                        path: "mm10-blacklist.v2.bed.gz",
                        url: "https://raw.githubusercontent.com/Boyle-Lab/Blacklist/master/lists/mm10-blacklist.v2.bed.gz",
                        format: "bed",
                        contents:
                            "Gzipped BED, no header: chrom, start, end, reason label. 'chr'-prefixed mm10/GRCm38 coordinates — NOT mm39. Applying it to GRCm39 intervals silently masks the wrong regions. Subtract rather than intersect: the file lists regions to discard.",
                    },
                ],
            },
            {
                // Tiny, and they close a gap the catalog otherwise creates for itself: the
                // mouse annotation here is GRCm39 while the mouse blacklist is mm10, so the
                // two cannot be used together without a conversion. Same rationale as the
                // chromosome-sizes entries — a few hundred KB never justifies opt-in.
                id: "ucsc-liftover-chains-human",
                version: "current",
                title: "UCSC human liftOver chain files (hg19 <-> hg38)",
                description:
                    "UCSC alignment chains for converting genomic coordinates between GRCh37/hg19 and GRCh38/hg38, in both directions. What lets an older published interval set, a legacy VCF, or a GEO supplementary table be compared against hg38 work. A few hundred KB. UCSC regenerates these in place, so they are verified against what you downloaded rather than a checked-in digest.",
                organism: "human",
                sourceUrl: "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/liftOver/",
                license: { identifier: "UCSC-Genome-Browser-Data-License", url: "https://genome.ucsc.edu/conditions.html" },
                recommendation: { group: "genome-annotation", recommended: true },
                artifacts: [
                    {
                        path: "hg19ToHg38.over.chain.gz",
                        url: "https://hgdownload.soe.ucsc.edu/goldenPath/hg19/liftOver/hg19ToHg38.over.chain.gz",
                        format: "chain",
                        contents:
                            "UCSC chain format, gzipped, 1,278 chain blocks, 'chr'-prefixed on both sides. GUNZIP IT INTO A WRITABLE DIRECTORY BEFORE READING: the standard R chain reader is plain C stdio with no gzip support and rejects a non-local path, so it fails on the staged .gz — loudly, with a header-parse error rather than a wrong result, but it does fail. Conversion is lossy in both directions: intervals in regions that were rearranged between builds drop out entirely, so count what went in against what came out and report the loss rather than assuming a complete mapping.",
                    },
                    {
                        path: "hg38ToHg19.over.chain.gz",
                        url: "https://hgdownload.soe.ucsc.edu/goldenPath/hg38/liftOver/hg38ToHg19.over.chain.gz",
                        format: "chain",
                        contents:
                            "The reverse direction, gzipped, 25,374 chain blocks — twenty times more fragmented than the forward file, which is real rather than a packaging artefact and means proportionally more intervals split or fail to map going hg38 to hg19. Decompress into a writable directory before reading, as above. Prefer converting the older dataset forward to hg38 over dragging modern data backwards.",
                    },
                ],
            },
            {
                id: "ucsc-liftover-chains-mouse",
                version: "current",
                title: "UCSC mouse liftOver chain files (mm10 <-> mm39)",
                description:
                    "UCSC alignment chains for converting genomic coordinates between GRCm38/mm10 and GRCm39/mm39, in both directions. Directly relevant here: the mouse ENCODE blacklist in this catalog exists only for mm10 while the mouse annotation, chromosome sizes and genome sequence are all GRCm39, and this is what bridges them. Under 100 KB.",
                organism: "mouse",
                sourceUrl: "https://hgdownload.soe.ucsc.edu/goldenPath/mm39/liftOver/",
                license: { identifier: "UCSC-Genome-Browser-Data-License", url: "https://genome.ucsc.edu/conditions.html" },
                recommendation: { group: "genome-annotation", recommended: true },
                artifacts: [
                    {
                        path: "mm10ToMm39.over.chain.gz",
                        url: "https://hgdownload.soe.ucsc.edu/goldenPath/mm10/liftOver/mm10ToMm39.over.chain.gz",
                        format: "chain",
                        contents:
                            "UCSC chain format, gzipped, 236 chain blocks, 'chr'-prefixed both sides. Decompress into a writable directory before reading — the standard R chain reader has no gzip support and errors on the staged .gz. This is the direction to use for the mm10-only blacklist: lift it forward to mm39 once, rather than pulling GRCm39 data back to mm10.",
                    },
                    {
                        path: "mm39ToMm10.over.chain.gz",
                        url: "https://hgdownload.soe.ucsc.edu/goldenPath/mm39/liftOver/mm39ToMm10.over.chain.gz",
                        format: "chain",
                        contents:
                            "The reverse direction, gzipped, 910 chain blocks. Decompress into a writable directory before reading. Needed only when a downstream resource exists for mm10 alone and cannot be lifted forward; otherwise convert toward mm39, which is the build the rest of the mouse data here uses.",
                    },
                ],
            },
            {
                // ~193 MB and only variant-interpretation workflows need it, so it is opt-in. gnomAD and
                // dbSNP are deliberately absent: both are far too large to stage this way.
                id: "clinvar-grch38",
                version: "current",
                title: "ClinVar variant clinical significance (GRCh38)",
                description:
                    "NCBI ClinVar variant summary as VCF on GRCh38, with its tabix index — clinical significance, review status, and condition names for variant interpretation. NCBI rebuilds this weekly in place, so it is verified against what you downloaded rather than a checked-in digest. Roughly 193 MB.",
                organism: "human",
                sourceUrl: "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/",
                license: { identifier: "NCBI-Molecular-Data-Usage-Policy", url: "https://www.ncbi.nlm.nih.gov/home/about/policies/" },
                recommendation: { group: "variant-annotation", recommended: false },
                artifacts: [
                    {
                        path: "clinvar.vcf.gz",
                        url: "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz",
                        format: "vcf",
                        contents:
                            "Bgzipped VCF on GRCh38. Chromosome names carry NO 'chr' prefix ('1', 'X') — the opposite convention from the GENCODE and UCSC entries here, so joining across them without renaming returns zero matches silently. Key INFO fields: CLNSIG (clinical significance), CLNREVSTAT (review status — filter on it, a single-submitter assertion is not a reviewed one), CLNDN (condition), GENEINFO, ALLELEID.",
                    },
                    {
                        path: "clinvar.vcf.gz.tbi",
                        url: "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz.tbi",
                        format: "tbi",
                        contents:
                            "Tabix index for clinvar.vcf.gz, required for random access by region with pysam/cyvcf2/tabix. Must sit beside the VCF; never opened directly. Without it, region queries fall back to a full scan or fail outright.",
                    },
                ],
            },
            {
                // The DADA2-formatted derivative of SILVA, not SILVA itself: assignTaxonomy() parses a
                // FASTA whose header IS the taxonomy string, which a stock SILVA export is not. ~210 MB
                // across both files and only amplicon workflows need it, so it is opt-in.
                id: "silva-dada2",
                version: "138.2",
                title: "SILVA 16S/18S taxonomy training set (DADA2-formatted)",
                description:
                    "SILVA release 138.2 reformatted as DADA2 taxonomy training data for 16S/18S amplicon classification, covering Bacteria, Archaea and Eukaryota. Two files with different jobs: a genus-level training set for assignTaxonomy() and a separate exact-match species file for addSpecies(). Immutable Zenodo record 14169026, roughly 210 MB combined.",
                sourceUrl: "https://zenodo.org/records/14169026",
                license: { identifier: "CC-BY-4.0", url: "https://www.arb-silva.de/silva-license-information/" },
                recommendation: { group: "amplicon-taxonomy", recommended: false },
                artifacts: [
                    {
                        path: "silva_nr99_v138.2_toGenus_trainset.fa.gz",
                        url: "https://zenodo.org/records/14169026/files/silva_nr99_v138.2_toGenus_trainset.fa.gz",
                        format: "fasta",
                        contents:
                            "Gzipped FASTA, ~140 MB, for assignTaxonomy(). Each header IS the semicolon-delimited lineage and nothing else — 'Bacteria;Pseudomonadota;Gammaproteobacteria;Enterobacterales;Vibrionaceae;Vibrio;' — ranked Kingdom through Genus with a trailing semicolon. Read it gzipped; do not decompress first. Matched to the 16S/18S rRNA gene: running it against ITS reads completes and returns nonsense.",
                    },
                    {
                        path: "silva_v138.2_assignSpecies.fa.gz",
                        url: "https://zenodo.org/records/14169026/files/silva_v138.2_assignSpecies.fa.gz",
                        format: "fasta",
                        contents:
                            "Gzipped FASTA, ~70 MB, for addSpecies() only — a different header shape from the training set: accession then binomial, '>AB000390.1.1428 Vibrio halioticoli'. Exact-match species assignment applied to an already-assigned taxonomy table. Passing this to assignTaxonomy(), or the training set to addSpecies(), fails to parse or yields an all-NA table.",
                    },
                ],
            },
            {
                // Distributed only as a .tgz behind an opaque UUID URL, so `path` names it here; the
                // DOI landing page is the citable provenance. ITS-specific, hence opt-in.
                id: "unite-dada2",
                version: "2025.02.19",
                title: "UNITE ITS taxonomy training set for eukaryotes (DADA2-formatted)",
                description:
                    "UNITE general FASTA release for eukaryotes (version 19.02.2025) — the DADA2-compatible ITS taxonomy reference for fungal and broader eukaryotic amplicon classification, ~157,000 reference sequences. The all-eukaryote release rather than the fungi-only one, because ITS primers amplify non-fungal eukaryotes and a fungi-only reference forces those reads onto fungal lineages. Roughly 50 MB compressed.",
                sourceUrl: "https://doi.plutof.ut.ee/doi/10.15156/BIO/3301231",
                license: { identifier: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
                recommendation: { group: "amplicon-taxonomy", recommended: false },
                artifacts: [
                    {
                        path: "unite_general_release_eukaryotes_2025.02.19.tgz",
                        url: "https://s3.hpc.ut.ee/plutof-public/original/e861a3d6-54f4-42dc-882a-5f129beac39a.tgz",
                        format: "tgz",
                        contents:
                            "Gzipped tar holding two FASTAs: sh_general_release_dynamic_all_19.02.2025.fasta (use this one) and a *_dev.fasta variant. Extract to a writable directory first — the store is read-only and dada2 cannot read inside the archive. Headers are pipe-delimited then semicolon-delimited with rank prefixes: '>Abrothallus_subhalei|MT153946|SH1227328.10FU|refs|k__Fungi;p__Ascomycota;...;s__Abrothallus_subhalei'. Matched to ITS: running it against 16S reads completes and returns nonsense.",
                    },
                ],
            },
            {
                // Staged as gene sets rather than the Level 5 z-score matrix, because the
                // consumer scores a ranked list against sets — it never needs the raw matrix,
                // which is 20-33 GB and unreadable without two companion metadata tables to
                // recover gene symbols and drug names from bare Entrez ids and BRD accessions.
                //
                // From the NIH-funded DCIC's static object storage rather than the smaller
                // aggregation served through a lab's `?libraryName=` query endpoint: a live
                // query endpoint is not an artifact, the same reason `progeny-human` is
                // sourced from a repository file instead of the web service that computes it.
                id: "lincs-l1000-chem-pert",
                version: "2021",
                title: "LINCS L1000 chemical perturbation signatures",
                description:
                    "Drug-perturbation transcriptional signatures from the NIH LINCS L1000 programme, as up- and down-regulated gene sets per compound-cell-dose experiment — the reference profiles connectivity scoring queries a disease signature against, to find drugs that reverse it. Roughly 2.1 GB of plain-text gene sets. The distributor states no licence for this derived file; the underlying LINCS data is NIH-funded and published for unrestricted reuse subject to citation, so it is fetched from them directly and never mirrored. Cite Subramanian et al. 2017 (PMID 29195078).",
                organism: "human",
                sourceUrl: "https://lincsportal.ccs.miami.edu/",
                license: { identifier: "LicenseRef-No-Declared-Licence", url: "https://lincsportal.ccs.miami.edu/" },
                recommendation: { group: "perturbation-signatures", recommended: false },
                artifacts: [
                    {
                        path: "l1000_cp.gmt",
                        url: "https://lincs-dcic.s3.amazonaws.com/LINCS-sigs-2021/gmt/l1000_cp.gmt",
                        format: "gmt",
                        contents:
                            "Uncompressed GMT, ~2.1 GB, one gene set per line: term name, an EMPTY second field, then member gene symbols. The blank description column is valid GMT and parses normally — do not treat it as malformed. Genes are HGNC symbols, so a ranked query list of symbols needs no identifier conversion. Term names are self-describing and need no metadata table: they encode plate, cell line, well, compound and dose, and end in ' up' or ' down'. That direction suffix is the whole point — connectivity is the enrichment of the up set MINUS the enrichment of the down set, so the two halves of one experiment must be paired by their shared prefix and never scored independently. Chemical perturbagens only ('cp'); genetic knockdown and overexpression signatures are not in this file. Every cell line is human cancer-derived, so a signature is a cell-line response, not a tissue or patient one.",
                    },
                ],
            },
            {
                // The one entry here that is chemistry rather than biology, so it carries no
                // organism: a fragmentation spectrum belongs to a compound, not a species.
                // Staged uncompressed, which is rare in this catalog and worth relying on —
                // no extraction step stands between the store and matchms.
                id: "massbank-spectra",
                version: "2026.03",
                title: "MassBank MS/MS reference spectral library",
                description:
                    "The MassBank Europe reference library of experimental tandem mass spectra — roughly 139,000 records covering both ionisation modes — for identifying compounds in untargeted metabolomics by matching measured fragmentation against known spectra. This is the terminal annotation step: without a library, feature detection and statistics finish but nothing gets a compound name. Immutable 2026.03 release, ~137 MB, plain uncompressed text. Licensing is per-record and partly non-commercial; see the artifact notes before any commercial use.",
                sourceUrl: "https://github.com/MassBank/MassBank-data",
                // No single identifier is honest here: records carry CC BY, CC BY-SA, CC0,
                // dl-de/by-2-0, and several non-commercial variants, assigned per contributor.
                license: { identifier: "LicenseRef-MassBank-Per-Record", url: "https://github.com/MassBank/MassBank-data" },
                recommendation: { group: "spectral-libraries", recommended: false },
                artifacts: [
                    {
                        path: "MassBank_NISTformat.msp",
                        url: "https://github.com/MassBank/MassBank-data/releases/download/2026.03/MassBank_NISTformat.msp",
                        format: "msp",
                        contents:
                            "Uncompressed NIST-format MSP, ~139,000 records, readable directly by a spectral-matching library with ion mode normalising to positive/negative. Composition: ~117,000 genuine fragmentation spectra (MS2 and deeper) plus ~21,000 MS1 records — FILTER TO MS2 BEFORE MATCHING, because MS1 entries carry no fragments and will either match nothing or match on precursor mass alone and look like a hit. Ion modes are ~97,700 positive and ~41,300 negative; match only within the mode your data was acquired in. Every spectrum is experimentally measured, with no in-silico predictions mixed in, so a match is evidence rather than a model output. LICENCE CAVEAT: the MSP export carries no licence field at all, while the underlying records span CC0, CC BY, share-alike and non-commercial terms, and roughly 30% are non-commercial. Recovering a given record's terms means joining its DB# accession back to the source repository — necessary before redistributing or using a specific identification commercially, not for research use.",
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
            {
                // The three variant-phasing entries below are one capability, not three
                // independent datasets: haplotype-aware single-cell CNV calling needs a
                // common-SNP site list to pile up against, a recombination map, and a phased
                // reference panel, and is unreachable if any one is absent. They are grouped
                // so a caller that finds one finds the set.
                //
                // Sites-only, so it carries genotypes for nobody — safe to stage despite
                // deriving from 1000 Genomes phase 3.
                id: "cellsnp-common-snps-hg38",
                version: "phase3",
                title: "Common SNP site list for single-cell allele pileup (GRCh38)",
                description:
                    "The 1000 Genomes phase 3 common-variant site list (allele frequency > 5%) distributed by the cellsnp-lite project, ~7.4 million biallelic SNVs and roughly 92 MB. Restricts a single-cell allele pileup to sites informative for phasing rather than calling variants de novo across the whole genome. Genotypes are inferred from the pileup itself, so no donor genotype data is needed. The distributor publishes no explicit licence for the packaged list; the underlying 1000 Genomes call set is unrestricted.",
                organism: "human",
                sourceUrl: "https://sourceforge.net/projects/cellsnp/files/SNPlist/",
                license: { identifier: "IGSR-unrestricted", url: "https://www.internationalgenome.org/IGSR_disclaimer" },
                recommendation: { group: "variant-phasing", recommended: false },
                artifacts: [
                    {
                        path: "genome1K.phase3.SNP_AF5e2.chr1toX.hg38.vcf.gz",
                        url: "https://sourceforge.net/projects/cellsnp/files/SNPlist/genome1K.phase3.SNP_AF5e2.chr1toX.hg38.vcf.gz/download",
                        format: "vcf",
                        contents:
                            "BGZF-compressed sites-only VCFv4.1: no sample columns and no genotypes, one record per common SNV with an AF INFO field. Contigs are 1-22 and X with NO 'chr' prefix — the opposite convention from the phasing panel it is used alongside, so a pileup and a panel joined without renaming return zero overlap silently. The header still carries b37 provenance (##reference=hs37d5, assembly=b37) because only the coordinates were lifted; the coordinates themselves are genuinely GRCh38. Pass it as the pileup's target-region list, not as a variant call set.",
                    },
                ],
            },
            {
                // Distributed inside the 225 MB Eagle release tarball as well; this standalone
                // copy is byte-identical, so the tarball is not staged.
                id: "eagle-genetic-map-hg38",
                version: "2.4.1",
                title: "Eagle v2 genetic recombination map (GRCh38)",
                description:
                    "Genome-wide recombination map published with Eagle v2.4.1, ~56 MB, giving the genetic (centimorgan) position of physical coordinates. Statistical phasing needs it to weigh how likely two nearby alleles are to travel together; the phaser refuses to run on VCF/BCF input without one. Distributed as software with the GPLv3 Eagle release, though the map tables themselves carry no separate licence statement.",
                organism: "human",
                sourceUrl: "https://alkesgroup.broadinstitute.org/Eagle/",
                license: { identifier: "GPL-3.0-or-later", url: "https://alkesgroup.broadinstitute.org/Eagle/" },
                recommendation: { group: "variant-phasing", recommended: false },
                artifacts: [
                    {
                        path: "genetic_map_hg38_withX.txt.gz",
                        url: "https://storage.googleapis.com/broad-alkesgroup-public/Eagle/downloads/tables/genetic_map_hg38_withX.txt.gz",
                        format: "tsv",
                        contents:
                            "Gzipped space-delimited table, ~3.28 million rows, header 'chr position COMBINED_rate(cM/Mb) Genetic_Map(cM)'. Chromosomes are numeric 1-22 plus 23 for X — not 'chrN', and not 'X'. Keep the build token in the filename: numbat's preprocessing infers the genome build by testing this path for the substring 'hg19', so a copy renamed without it is silently treated as GRCh38. Read it gzipped.",
                    },
                ],
            },
            {
                // numbat's preprocessing reads this as `{paneldir}/chr{N}.genotypes.bcf`, but the
                // 20190312 release is published as bgzipped VCF and the installer stages bytes
                // verbatim — so a `bcftools view -Ob` pass into a writable directory is part of
                // using it, not an optional optimisation. Each artifact's contents says so.
                // Autosomes only: phasing is driven per chromosome over 1..22 and never reads X
                // or Y, so the sex chromosomes in the upstream directory are deliberately not
                // staged. ~12.4 GB, the largest entry in this catalog by an order of magnitude.
                id: "1000g-phasing-panel-hg38",
                version: "20190312",
                title: "1000 Genomes phased haplotype reference panel (GRCh38)",
                description:
                    "The 1000 Genomes Project GRCh38 phased call set (2,548 samples, biallelic SNVs and indels, SHAPEIT2-integrated release 20190312) — the haplotype reference statistical phasing compares against. Autosomes 1-22 as 22 bgzipped VCFs plus tabix indexes, roughly 12.4 GB total, so this is opt-in and slow to install: budget an hour or more. Published as VCF, while phasing tools expect BCF; see the artifact notes for the one conversion step that implies.",
                organism: "human",
                sourceUrl: "https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000_genomes_project/release/20190312_biallelic_SNV_and_INDEL/",
                license: { identifier: "IGSR-unrestricted", url: "https://www.internationalgenome.org/IGSR_disclaimer" },
                recommendation: { group: "variant-phasing", recommended: false },
                // 22 autosomes x (call set + index). Written as a fold rather than 44 literal
                // blocks: the entries differ only by chromosome number, and spelling them out
                // would bury that in repetition without adding a single fact.
                artifacts: Array.from({ length: 22 }, (_unused, index) => index + 1).flatMap((chromosome) => [
                    {
                        path: `chr${chromosome}.genotypes.vcf.gz`,
                        url: `https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000_genomes_project/release/20190312_biallelic_SNV_and_INDEL/ALL.chr${chromosome}.shapeit2_integrated_snvindels_v2a_27022019.GRCh38.phased.vcf.gz`,
                        format: "vcf",
                        contents: `Phased genotypes for chromosome ${chromosome}, 2,548 samples, bgzipped VCF. Contig IDs ARE 'chr'-prefixed ('chr${chromosome}'), unlike the common-SNP site list used with it. Phasing tools want BCF: convert once into a writable directory with 'bcftools view -Ob' and name the output chr${chromosome}.genotypes.bcf, which is the layout haplotype-aware callers expect to find beside its siblings. The store is read-only, so the conversion cannot be written back here, and re-converting per step wastes the whole cost.`,
                    },
                    {
                        path: `chr${chromosome}.genotypes.vcf.gz.tbi`,
                        url: `https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000_genomes_project/release/20190312_biallelic_SNV_and_INDEL/ALL.chr${chromosome}.shapeit2_integrated_snvindels_v2a_27022019.GRCh38.phased.vcf.gz.tbi`,
                        format: "tbi",
                        contents: `Tabix index for chr${chromosome}.genotypes.vcf.gz. Must sit beside the call set; never opened directly. Reading the VCF without it forces a full scan, and the conversion to BCF needs it to address regions.`,
                    },
                ]),
            },
            {
                // What makes a pySCENIC regulon a regulon rather than a co-expression module:
                // the motif-pruning step reads these and nothing substitutes for them. Rankings
                // and annotation must come from the SAME version — the directory says
                // `mc_v10_clust` and the annotation says `v10nr_clust`, which are the same
                // release under two spellings, and pairing across releases yields empty regulons
                // without erroring. Two window sizes ship because the choice is analytical, not a
                // default: 500bp/100bp is promoter-proximal, 10kbp is distal-inclusive.
                id: "cistarget-hg38",
                version: "v10-clust",
                title: "cisTarget motif rankings and annotations (human, hg38)",
                description:
                    "The motif-ranking databases and motif-to-TF annotation that gene regulatory network inference needs to prune co-expression modules down to motif-supported regulons. Human hg38, RefSeq r80, v10 clustered motif collection — two ranking databases at different regulatory window sizes plus the annotation table that maps each motif to its transcription factors. Roughly 723 MB combined. The publisher states no licence for this data, so it is fetched from them directly and never mirrored.",
                organism: "human",
                sourceUrl: "https://resources.aertslab.org/cistarget/",
                license: { identifier: "LicenseRef-No-Declared-Licence", url: "https://resources.aertslab.org/cistarget/" },
                recommendation: { group: "regulatory-networks", recommended: false },
                artifacts: [
                    {
                        path: "hg38_500bp_up_100bp_down_full_tx_v10_clust.genes_vs_motifs.rankings.feather",
                        url: "https://resources.aertslab.org/cistarget/databases/homo_sapiens/hg38/refseq_r80/mc_v10_clust/gene_based/hg38_500bp_up_100bp_down_full_tx_v10_clust.genes_vs_motifs.rankings.feather",
                        format: "feather",
                        contents:
                            "Feather v2, ~313 MB: genes x motifs, each cell the rank of that gene for that motif. Promoter-proximal window (500bp upstream to 100bp downstream of the TSS) — the conservative choice, and the one to prefer when a regulon should reflect direct promoter binding. Must be a *.rankings.feather; the *.scores.feather files served beside these are inputs for building databases and produce nothing useful here.",
                    },
                    {
                        path: "hg38_10kbp_up_10kbp_down_full_tx_v10_clust.genes_vs_motifs.rankings.feather",
                        url: "https://resources.aertslab.org/cistarget/databases/homo_sapiens/hg38/refseq_r80/mc_v10_clust/gene_based/hg38_10kbp_up_10kbp_down_full_tx_v10_clust.genes_vs_motifs.rankings.feather",
                        format: "feather",
                        contents:
                            "Feather v2, ~311 MB: same genes x motifs rank matrix as its sibling, scored over a 10 kbp window either side of the TSS. Admits distal regulatory elements, so it recovers more targets and more false positives than the promoter-proximal database. Pick one deliberately and say which; running both and merging is not a defined operation.",
                    },
                    {
                        path: "motifs-v10nr_clust-nr.hgnc-m0.001-o0.0.tbl",
                        url: "https://resources.aertslab.org/cistarget/motif2tf/motifs-v10nr_clust-nr.hgnc-m0.001-o0.0.tbl",
                        format: "tsv",
                        contents:
                            "13-column TAB-separated table despite the .tbl extension — read it as TSV, not as a fixed-width or custom format. Maps each motif id to the transcription factors it represents, with the evidence class (direct annotation vs inferred by orthology or motif similarity) that lets a caller keep only directly-annotated motifs. Gene symbols are HGNC, so this is the human file; the MGI-suffixed sibling is mouse and pairing it with hg38 rankings silently matches nothing.",
                    },
                ],
            },
            {
                // The mouse counterpart, kept as its own dataset so an installer takes one
                // organism rather than both. Note mm39 does not exist upstream: mm10 is current.
                id: "cistarget-mm10",
                version: "v10-clust",
                title: "cisTarget motif rankings and annotations (mouse, mm10)",
                description:
                    "Mouse mm10 counterpart of the human cisTarget set — one ranking database plus the MGI motif-to-TF annotation, for pruning co-expression modules into motif-supported regulons. RefSeq r80, v10 clustered motif collection, roughly 589 MB. mm10 is the current build here; there is no mm39 release. The publisher states no licence for this data, so it is fetched from them directly and never mirrored.",
                organism: "mouse",
                sourceUrl: "https://resources.aertslab.org/cistarget/",
                license: { identifier: "LicenseRef-No-Declared-Licence", url: "https://resources.aertslab.org/cistarget/" },
                recommendation: { group: "regulatory-networks", recommended: false },
                artifacts: [
                    {
                        path: "mm10_10kbp_up_10kbp_down_full_tx_v10_clust.genes_vs_motifs.rankings.feather",
                        url: "https://resources.aertslab.org/cistarget/databases/mus_musculus/mm10/refseq_r80/mc_v10_clust/gene_based/mm10_10kbp_up_10kbp_down_full_tx_v10_clust.genes_vs_motifs.rankings.feather",
                        format: "feather",
                        contents:
                            "Feather v2: genes x motifs rank matrix for mouse mm10, 10 kbp either side of the TSS. Must be a *.rankings.feather, not the *.scores.feather served beside it. Pair only with the MGI annotation below and only with mouse counts — running human rankings over mouse data completes and returns nonsense.",
                    },
                    {
                        path: "motifs-v10nr_clust-nr.mgi-m0.001-o0.0.tbl",
                        url: "https://resources.aertslab.org/cistarget/motif2tf/motifs-v10nr_clust-nr.mgi-m0.001-o0.0.tbl",
                        format: "tsv",
                        contents:
                            "13-column TAB-separated table despite the .tbl extension. Maps motif ids to mouse transcription factors with their evidence class, symbols in MGI nomenclature. The HGNC-suffixed sibling is the human file; crossing the two against the wrong rankings matches nothing and reports no error.",
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
