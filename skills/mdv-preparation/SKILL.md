---
name: mdv-preparation
description: Prepare scRNA-seq, scATAC-seq, spatial transcriptomics, and spatial proteomics data as MDV-ready assets (AnnData plus context tables) for MDV, the Multi-Dimensional Viewer — input wrangling, metadata curation, human-readable labels, and validation against what MDV's upload does
version: 1.0.0
tags: [mdv, multi-dimensional-viewer, visualization, anndata, h5ad, cosmx, xenium, visium, merfish, codex, imc, mibi]
---

# MDV Asset Preparation

MDV (Multi-Dimensional Viewer) loads an AnnData through its upload: it reads the `.h5ad` and
converts it with mdvtools defaults into a `cells` table and a `genes` table, with expression
linked to the cells. CSV and TSV files become one table each. The deliverable is the input to
that upload, not an MDV project: you do not need mdvtools.

An asset is **MDV-ready** when:

1. the validator in `references/validation.md` reports zero errors, so MDV's default conversion
   cannot abort or corrupt it, and
2. a person who did not make it can read every column and every category in MDV without help:
   readable labels as column names, labelled clusters, only useful columns, and a README that
   explains the columns, the processing, and the first charts to make.

## Workflow

```
1. Inventory   what is the modality, the platform, the input form, the size?   (decision tree below)
2. Build       one analysis-ready AnnData: counts in, QC, log-normalised sparse X,
               embeddings, clusters, labels with evidence                       (modality reference)
3. Curate      choose the columns, give each a readable label with units, keep grouping
               columns at <= 256 categories, ids as words, dtypes that MDV maps  (asset-route.md)
4. Write       the asset (.mdv.h5ad), the context tables (.tsv), the README     (asset-route.md)
5. Validate    zero errors; fix and write again from step 3                     (validation.md)
6. Deliver     asset + TSVs + README + validator report, and the analysis AnnData
```

## Input Decision Tree

```
Input?
├── AnnData (.h5ad)
│   ├── raw counts only            → QC + normalise + embed + cluster (single-cell pack) → asset route
│   └── already processed          → check X is log-normalised and sparse; keep the author's labels → asset route
├── 10x Cell Ranger / count matrix → read into AnnData → as raw counts above
├── Seurat / SingleCellExperiment  → convert to AnnData (shared omics-general pack) → asset route
├── scATAC-seq / multiome          → scatac-multiome.md: genes as features (gene activity); never peaks
├── Spatial transcriptomics        → spatial-transcriptomics.md
│   ├── CosMx flat-file export     → spatialdata-io / pandas reader
│   ├── CosMx raw instrument run   → raw builder + FOV orientation check (mandatory)
│   ├── Xenium                     → spatialdata-io; cells table
│   ├── Visium / Visium HD         → spots or bins as rows; one asset per bin size
│   └── MERFISH / MERSCOPE         → cell-by-gene + cell metadata
└── Spatial proteomics             → spatial-proteomics.md
    (CODEX/PhenoCycler, IMC, MIBI)   markers as features; arcsinh-transformed intensities
```

## Conventions

- **The label is the column name.** MDV shows the AnnData column label as the column name and has
  no description field. Use words and units: `Cell area (µm²)`, `Transcripts per cell`,
  `Cell type (putative)`. Never `|` or `/` in a label. Put the meaning of each column in the
  README glossary.
- **Readable categories.** Never ship bare cluster ids. Number clusters by size and add the label:
  `C01 Oligodendrocytes`. Map codes and booleans to words. Mark inferred labels as putative and
  keep their evidence in a context table.
- **Grouping columns stay `text`.** At most 256 categories. Above 256 MDV makes the column
  `text16`, and most category charts (stacked row, violin, box, heat map, pie, Sankey) refuse it.
- **Text as categorical, names as plain `str`.** With pandas ≥ 3 a plain text column or the
  obs/var names can be written as a nullable string array; MDV's conversion then aborts.
  `build_asset` writes them safely.
- **Expression.** X = library-size-normalised, log1p, **sparse**. MDV shows it as "Gene Scores".
  No layers by default: each one doubles the expression data in MDV. Keep raw counts in the
  analysis AnnData.
- **Only what people use.** `obsm` holds the embeddings to plot under a readable key (`UMAP`);
  no `X_pca`, `varm`, `obsp`, or `raw`. Spatial positions are two `obs` columns in micrometres,
  with y pointing up (`image height − y`), because MDV scatter plots draw y upwards.
- **Deterministic.** Fix every seed and write the same asset from the same input. Record the
  parameters and the package versions in the README.
- **Memory first.** Estimate the matrix size before you load it (`memory-and-scale.md`). A
  scanpy step can hold three copies of X. MDV's upload holds two; keep the asset below 5 GB.

## Anti-Patterns

- **Snake_case keys as the only labels** (`total_counts`, `leiden`): MDV shows them as they are.
- **Bare ids as labels.** Leiden `"0"…"23"`, float ids that become `"1.0"`, sample barcodes as
  the only sample name.
- **Grouping columns above 256 categories**, or a FOV / sample id as text with hundreds of values.
- **Duplicate obs or var names.** MDV multiplies the duplicated rows with no error.
- **Pandas dtypes MDV does not map** (`Int64`, `string`, `uint64`, `float16`, nullable booleans):
  the upload aborts. `build_asset` sanitises them.
- **`|` or `(` in gene names**, or `|` / `/` in a column label.
- **Dense X, scaled X, or extra layers** in the asset.
- **`X_pca` or other multi-column embeddings in `obsm`**: MDV adds three meaningless columns each.
- **Raw CosMx FOVs placed without the orientation check.** A wrong axis sign scrambles the tissue
  and nothing reports an error.
- **Unlabelled inferences.** A cell type from markers is a putative label. Say so, and give the
  evidence.
- **Hand-written MDV project files.** The asset is an AnnData; MDV makes the project.

## References

| File | Read it when |
|---|---|
| `references/mdv-asset-contract.md` | You need the exact rules: what MDV's upload does with each AnnData slot, the dtype mapping, the limits, what an asset cannot carry |
| `references/asset-route.md` | Every asset: readable labels, the helper module, writing the asset, context tables, the README |
| `references/validation.md` | Before delivery: the validator script and how to read its report |
| `references/spatial-transcriptomics.md` | CosMx (flat files and raw instrument output), Xenium, Visium, MERFISH: readers, slide coordinates, the orientation check |
| `references/spatial-proteomics.md` | CODEX/PhenoCycler, IMC, MIBI: markers as features, transforms, morphology |
| `references/scatac-multiome.md` | scATAC-seq and multiome: gene activity, peaks, chromVAR |
| `references/memory-and-scale.md` | More than ~50,000 cells, or a large panel: estimates, backed reads, chunked loads, subsampling |
