---
name: mdv-preparation
description: Read before you make an MDV (Multi-Dimensional Viewer) project from single-cell, scATAC, spatial transcriptomics, or spatial proteomics data. It gives the route from each input to a project with readable labels, the tissue images, and the first views, and the two checks before delivery.
metadata:
  version: 2.0.0
  tags: [mdv, multi-dimensional-viewer, visualization, mdv-project, anndata, spatialdata, h5ad, zarr, cosmx, xenium, visium, merfish, codex, imc, mibi]
  category: methods
---

# MDV Project Preparation

The deliverable is an MDV project: the project folder and its zip, which the user imports into
MDV. `inflexa-mdvtools` makes the project from a curated AnnData, the asset. For spatial data, it
makes the project from a SpatialData store that holds the asset and the tissue images.

An asset is **MDV-ready** when:

1. the table validator in `references/validation.md` reports zero errors, so the conversion
   cannot stop or corrupt it, and
2. a person who did not make it can read each column and each category in MDV without help:
   readable labels, labeled clusters, only useful columns, and a README that explains the
   columns and the processing.

A project is ready for delivery when its asset is MDV-ready and the project check in
`references/validation.md` reports zero errors.

## The gotchas of this environment

- **The package is `inflexa-mdvtools`.** Put it in the packages of each step that makes a
  project. Its import name is `mdvtools`. Never put `mdvtools` in the packages, because its pins
  conflict with the package store.
- **A readable label is not a column name.** SpatialData refuses a column name with a space or a
  unit. The column keeps its source name as its field. The label goes into `uns["mdv_labels"]`,
  and the project helpers give it to MDV.
- **anndata 0.13 also lists X under the key `None` of `adata.layers`.** A loop over the layers
  must skip that key. The helpers do this.
- **One table in a spatial store**, with `obsm["spatial"]` or with shapes that it annotates.
  mdvtools merges each table of a store into one `cells` table.
- **The import of MDV 1.3.0** refuses a zip above 20,000 MiB, and an entry with `..` or an
  absolute path. `zip_project` writes the correct layout.
- **mdvtools copies the full store into the project.** `drop_unused` removes the transcript
  points. Keep the shapes and the labels: for Xenium, mdvtools places the cells on the image with
  the transform of a Xenium shape.

## Deliverable

Deliver the project folder, the zip, the README, the asset, the reports of the two checks, and
the analysis AnnData.

- Estimate the size of the input before you load it (`memory-and-scale.md`).
- Build one analysis-ready AnnData first: counts, QC, log-normalized sparse X, embeddings,
  clusters, and labels with evidence. The modality reference gives the method.
- Make the asset and the project with `asset-route.md`. For spatial data, put the asset into the
  store first (`spatial-transcriptomics.md`).
- If a check reports an error, fix the step that made the problem. Then make the project again.
  Deliver only reports with zero errors.

## Input Decision Tree

```
Input?
├── AnnData (.h5ad)
│   ├── raw counts only            → QC + normalization + embedding + clusters (single-cell pack) → project
│   └── already processed          → X must be log-normalized and sparse; keep the labels of the author → project
├── 10x Cell Ranger / count matrix → read into AnnData → as raw counts above
├── Seurat / SingleCellExperiment  → convert to AnnData (shared omics-general pack) → project
├── SpatialData store (.zarr)      → curate its table, put_table → spatial project
├── scATAC-seq / multiome          → scatac-multiome.md: genes as features (gene activity), never peaks → project
├── Spatial transcriptomics        → spatial-transcriptomics.md → spatial project with the images
│   ├── Xenium                     → spatialdata_io.xenium
│   ├── Visium / Visium HD         → spatialdata_io.visium / visium_hd; one project for each bin size
│   ├── CosMx flat-file export     → spatialdata_io.cosmx
│   ├── CosMx raw instrument run   → cosmx_raw.py: FOV orientation check (mandatory), stitched image
│   └── MERFISH / MERSCOPE         → spatialdata_io.merscope
└── Spatial proteomics             → spatial-proteomics.md → spatial project with the images
    (CODEX/PhenoCycler, IMC, MIBI)   markers as features, arcsinh intensities
```

Each branch ends in a project. If a spatial input has no image, make the project with
`spatial=False` in `add_views`, and say so in the README.

## Conventions

- **The label is the name that MDV shows.** MDV has no description field. Use words and units:
  `Cell area (µm²)`, `Transcripts per cell`, `Cell type (putative)`. Never `|` in a label. Put the
  meaning of each column in the README glossary, because the README is the glossary.
- **Safe fields.** A field uses only letters, digits, `_`, `.`, and `-`, and is unique without
  regard to case. Do not use a field that mdvtools writes (`x`, `y`, `mdv_cell_id`, …).
- **Readable categories.** Never deliver bare cluster IDs. Number the clusters by size and add
  the label: `C01 Oligodendrocytes`. Map codes and booleans to words. Mark an inferred label as
  putative, and keep its evidence in a context table.
- **Grouping columns stay `text`.** Use a maximum of 256 categories. Above 256, MDV makes the
  column `text16`, and most category charts (stacked row, violin, box, heat map, pie, Sankey)
  refuse it.
- **Text as categorical, names as plain `str`.** With pandas ≥ 3, a plain text column or the
  obs and var names can become a nullable string array, and the conversion stops. `build_asset`
  writes them safely.
- **Expression.** X is library-size-normalized, log1p, and **sparse**. MDV shows it as "Gene
  Scores". Use no layers by default, because each layer adds one more expression set as large as
  X. Keep the raw counts in the analysis AnnData.
- **Only what a person uses.** `obsm` holds the embeddings to plot, under a readable key
  (`UMAP`). No `X_pca`, `varm`, `obsp`, or `raw`.
- **Positions as the store gives them.** The tissue chart draws the cells on the image, in the
  coordinates of the image. Do not flip y.
- **The first views.** `add_views` writes "Tissue" (spatial) or "Cells", then "QC", then "About
  this project". The project opens on the first view.
- **Context tables in the project.** The tables of the clusters, the samples, and the FOVs are
  datasources of the project (`add_table`).
- **Deterministic.** Fix each seed, and make the same project from the same input. Write the
  parameters and the package versions in the README.
- **Memory and disk first.** Estimate the matrix size before you load it
  (`memory-and-scale.md`). A scanpy step can hold three copies of X. A spatial project is on
  disk three times before delivery.

## Anti-Patterns

- **`mdvtools` in the packages of a step.** Its pins conflict with the package store. Use
  `inflexa-mdvtools`.
- **Readable labels as column names of a SpatialData table.** SpatialData refuses the table.
- **A loop over `adata.layers` that does not skip the key `None`.** h5py stops with
  "path must not be None".
- **A spatial store with more than one table**, or a table with no `obsm["spatial"]` and no
  annotated shapes.
- **A zip that the import refuses**: above 20,000 MiB, an entry with `..` or an absolute path, or
  the project files under more than one folder.
- **The transcript points in the store.** They can be larger than the images, and MDV does not
  show them.
- **A Xenium store without its shapes.** mdvtools reads µm as image pixels, the cells do not sit
  on the image, and no check reports an error.
- **Snake_case keys with no label** (`total_counts`, `leiden`): MDV shows them as they are.
- **Bare IDs as labels**: Leiden `"0"…"23"`, float IDs that become `"1.0"`, sample barcodes as
  the only sample name.
- **Grouping columns above 256 categories**, or a FOV or sample ID as text with hundreds of
  values.
- **Duplicate obs or var names.** MDV multiplies the duplicated rows with no error.
- **Pandas dtypes that MDV does not map** (`Int64`, `string`, `uint64`, `float16`, nullable
  booleans): the conversion stops. `build_asset` sanitizes them.
- **`|` or `(` in gene names**, or `|` in a label.
- **Dense X, scaled X, or extra layers** in the asset.
- **`X_pca` or other multi-column embeddings in `obsm`**: MDV adds three meaningless columns for
  each.
- **Raw CosMx FOVs placed without the orientation check.** A wrong axis sign scrambles the tissue,
  and nothing reports an error.
- **A flipped y in a spatial project.** The cells do not align with the image.
- **Unlabeled inferences.** A cell type from markers is a putative label. Say so, and give the
  evidence.

## References

| File | Read it when |
|---|---|
| `references/mdv-asset-contract.md` | You need the exact rules: the project layout, the two conversions, the import, what mdvtools does with each AnnData slot, the dtype mapping, the reserved fields |
| `references/asset-route.md` | Each project: readable labels, the helper modules, the asset, the project, the views, the context tables, the README, the zip |
| `references/validation.md` | Before delivery: the table validator, the project check, and how to read their reports |
| `references/spatial-transcriptomics.md` | Xenium, Visium, Visium HD, CosMx (flat files and raw instrument output), MERFISH: readers, the store, the orientation check, the stitched image |
| `references/spatial-proteomics.md` | CODEX/PhenoCycler, IMC, MIBI: markers as features, transforms, a store with no reader |
| `references/scatac-multiome.md` | scATAC-seq and multiome: gene activity, peaks, chromVAR |
| `references/memory-and-scale.md` | More than ~50,000 cells, a large panel, or large images: estimates, backed reads, chunked loads, the size of the project, the import limit |
