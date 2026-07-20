---
name: omics-general
description: Cross-cutting principles for all omics analysis — AnnData/MuData universal containers, Python-first policy, data format detection, analysis phases, and shared analytical methods
version: 2.0.0
tags: [omics, bioinformatics, general-principles, anndata, mudata, python-first]
---

# Omics General Principles

Cross-cutting guidance loaded by ALL sandbox agents.

## Language Policy

**Python is the default language.** Use R when:
- No Python equivalent exists (e.g., minfi, ANCOM-BC2, ChAMP)
- The R implementation is significantly more mature (e.g., DESeq2 for complex contrasts)

**Choose native R or rpy2 based on scope:**
- **Isolated R calls** in a Python pipeline → use rpy2 bridge
- **R-dominant pipeline** (most steps are R packages) → write native R scripts

## AnnData/MuData: Universal Data Containers

**AnnData (.h5ad)** is the universal container for ALL sample-by-feature data — not just single-cell:

| Modality | .obs (samples) | .var (features) | .X (values) |
|----------|---------------|-----------------|-------------|
| Bulk RNA-seq | samples, condition, batch | genes, ensembl_id, biotype | raw counts |
| Proteomics | samples, condition, batch | proteins, uniprot_id | intensities |
| Metabolomics | samples, condition, batch | metabolite features, mz, rt | abundances |
| Microarray | samples, condition, batch | probes/genes | normalized expression |
| Single-cell | cells, cell_type, condition | genes | counts or normalized |
| Methylation (results) | samples, condition, age | CpG sites, chr, pos | beta or M-values |

**MuData (.h5mu)** for multi-modal data: CITE-seq (RNA+protein), Multiome (RNA+ATAC), multi-omics integration.

### AnnData Conventions
- Sample metadata → `.obs` columns (never separate CSV files)
- Feature annotations → `.var` columns
- Dimensionality reductions → `.obsm` (e.g., `X_pca`, `X_umap`)
- Processed layers → `.layers` (e.g., `raw`, `normalized`, `log1p`)
- Unstructured results → `.uns` (DE results, method parameters)
- Save as `.h5ad` / `.h5mu` — never `.rds` or `.pkl`

### Converting from R Objects
When R produces objects (DESeqDataSet, phyloseq, SummarizedExperiment):
1. Extract the data matrix, sample metadata, and feature metadata via rpy2
2. Construct AnnData in Python from the extracted components
3. Save as .h5ad for downstream steps

## Data Format Detection

When receiving input data, detect the format before processing:
- `.h5ad` → AnnData (load with `anndata.read_h5ad`)
- `.h5mu` → MuData (load with `mudata.read`)
- `.csv`/`.tsv` → tabular (load with `pandas.read_csv`, consider converting to AnnData)
- `.rds` → R object (load via rpy2, convert to AnnData)
- `.h5`/`.hdf5` → HDF5 (inspect structure, may be AnnData)
- `.mtx` + `barcodes.tsv` + `features.tsv` → 10x sparse (use `scanpy.read_10x_mtx`)
- `.loom` → Loom format (use `scanpy.read_loom`, convert to AnnData)

## Output Format Standards

- **Intermediate data**: `.h5ad` or `.h5mu` (universal, travels with metadata)
- **Tabular results**: CSV with descriptive column names (`log2_fold_change`, `adjusted_pvalue`)
- **Figures**: PNG (300 DPI) + PDF (vector) with same base filename
- **Dual-format output**: Save both native format AND generic CSV for cross-cutting agents

## Analysis Plan Phases

1. **Data ingestion & QC** — format detection, quality metrics, sample/feature filtering
2. **Preprocessing** — normalization, batch correction, feature selection
3. **Core analysis** — the primary analytical methods (DE, clustering, etc.)
4. **Downstream interpretation** — pathway enrichment, regulatory inference, integration
5. **Visualization & reporting** — publication-quality figures, summary tables

## Key Cross-Cutting Methods

- **Differential analysis**: PyDESeq2 (bulk counts), limma via rpy2 (microarray/intensity), pseudobulk + PyDESeq2 (single-cell). Longitudinal: dream (variancePartition, R via rpy2)
- **Pathway enrichment**: decoupler with gene sets or pathway weights from the reference store; gseapy for GSEA/ORA
- **TF activity**: decoupler with a TF-target regulon network from the reference store
- **Cell-cell communication**: LIANA+
- **GRN inference**: pySCENIC / SCENIC+
- **Trajectory**: scVelo, CellRank, Palantir
- **Clustering**: Leiden (preferred over Louvain)
- **Batch correction**: scVI (complex), Harmony (moderate), ComBat (bulk)

See `references/general-principles.md` for complete details.

## Reference Data

Gene sets, regulons, pathway weights, and annotation resources are provisioned
as an optional reference store. **Never assume a particular dataset is present
and never hardcode a path to one.** Query the available references for what you
need, described by what the data *is* (e.g. "TF-target regulon network",
"hallmark gene sets"), and read the returned entry's stated format and column
layout before choosing a reader. Rules that hold regardless of which datasets
are installed:

- The store is **read-only**, and the sandbox has **no network access** — a
  missing dataset cannot be downloaded or installed at runtime.
- If what you need is not there, report the gap and proceed with what is
  available. Do not invent a path, and do not silently fall back to a
  different organism's data.
- Match the reader to the declared format, not to the file extension:
  - `.gmt` gene sets are **ragged** (variable-length rows) — parse them
    line-by-line, splitting on tabs. `pandas.read_csv` cannot read a GMT.
  - `.rda` / `.rds` are R serialized objects — load them through rpy2 (or in
    native R), never with a pandas reader.
  - `.csv` / `.tsv` tables load with pandas; check whether the file has a
    header, and whether it is gzipped or zipped, before reading.
  - Multi-species files must be filtered to the organism under analysis
    before use — a human network silently runs over mouse counts.

## Gene Annotation (R via rpy2)

When you need gene ID conversion, annotation, or organism databases:
- **AnnotationDbi** + **org.Hs.eg.db** / **org.Mm.eg.db** / **org.Rn.eg.db** / **org.Dr.eg.db** / **org.Cf.eg.db** / **org.Bt.eg.db**: Map between gene symbols, Entrez IDs, Ensembl IDs, UniProt IDs. Use `mapIds()` or `select()`.
- **biomaRt**: Query Ensembl BioMart for gene annotations, GO terms, orthologs across species. Use `useMart()`, `getBM()`.
- **ensembldb** + **EnsDb.Hsapiens.v86** / **EnsDb.Mmusculus.v79**: Gene models with coordinates, transcripts, exons. Use `genes()`, `transcripts()`.
- **babelgene**: Cross-species gene name conversion (human ↔ mouse ↔ rat). Use `orthologs()`.

## R ↔ Python Format Conversion

- **zellkonverter** (R via rpy2): Convert between AnnData (.h5ad) and SingleCellExperiment (.rds). Use `readH5AD()` / `writeH5AD()` in R when an R package requires SCE input.

## Visualization Utilities

### Python
- **matplotlib** + **seaborn**: Primary plotting (always available)
- **plotly**: Interactive plots (HTML export via `kaleido`)
- **upsetplot**: UpSet plots for set intersections (enrichment overlap, shared genes)
- **matplotlib-venn**: Venn diagrams (2-3 set comparisons)
- **adjustText**: Automatic label positioning to avoid overlap in scatter/volcano plots
- **conorm**: Count normalization utilities (CPM, TPM, RPKM/FPKM conversion)

### R (via rpy2)
- **ggplot2** + **ggrepel**: Publication-quality plots with non-overlapping labels
- **pheatmap** / **ComplexHeatmap**: Heatmaps with clustering dendrograms. ComplexHeatmap for advanced multi-track annotations.
- **EnhancedVolcano**: Publication-ready volcano plots with automatic labeling
- **corrplot**: Correlation matrix visualization
- **patchwork** / **cowplot**: Multi-panel figure layouts (combine ggplot panels)
- **plotly** (R): Interactive plots from R
