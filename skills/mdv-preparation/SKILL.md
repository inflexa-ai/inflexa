---
name: mdv-preparation
description: Read before you make an MDV (Multi-Dimensional Viewer) project from single-cell, scATAC, spatial transcriptomics, or spatial proteomics data.
metadata:
  version: 2.0.0
  tags: [mdv, multi-dimensional-viewer, visualization, mdv-project, anndata, spatialdata, h5ad, zarr, cosmx, xenium, visium, merfish, codex, imc, mibi]
  category: methods
---

# MDV Project Preparation

The deliverable is an MDV project: the project folder and its zip, which the user adds to MDV. `inflexa-mdvtools` makes the project from a curated AnnData, the asset. For spatial data, it
makes the project from a SpatialData store that holds the asset and the tissue images.

An asset is **MDV-ready** when:

1. the table validator in `references/validation.md` reports zero errors, so the conversion
   cannot stop or corrupt it, and
2. a person who did not make it can read each column and each category in MDV without help:
   readable labels, labeled clusters, only useful columns, and a README that explains the
   columns and the processing.

A project is ready for delivery when its asset is MDV-ready and the project check in
`references/validation.md` reports zero errors.

## Deliverable

Deliver the project folder, the zip, the README, the asset, the reports of the two checks, and
the analysis AnnData.

- Estimate the memory and the disk before you load the input (`memory-and-scale.md`). A scanpy
  step can hold three copies of X, and a spatial project is on disk three times before delivery.
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
- **Readable categories.** Number the clusters by size and add the label: `C01 Oligodendrocytes`.
  Map codes, float IDs (`"1.0"`), and booleans to words. Give each sample a name, not only its
  barcode. Mark an inferred label as putative, and keep its evidence in a context table.
- **Grouping columns stay `text`.** Use a maximum of 256 categories. Above 256, MDV makes the
  column `text16`, and most category charts (stacked row, violin, box, heat map, pie, Sankey)
  refuse it.
- **Expression.** X is library-size-normalized, log1p, and **sparse**. MDV shows it as "Gene
  Scores". Use no layers by default, because each layer adds one more expression set as large as
  X. Keep the raw counts in the analysis AnnData.
- **Only what a person uses.** `obsm` holds the embeddings to plot, under a readable key
  (`UMAP`). No `X_pca`, `varm`, `obsp`, or `raw`.
- **Positions as the store gives them.** The tissue chart draws the cells on the image, in the
  coordinates of the image. Do not flip y.
- **Deterministic.** Fix each seed, and make the same project from the same input. Write the
  parameters and the package versions in the README.

## Anti-Patterns

The gotchas of this environment come first.

- **`mdvtools` in the packages of a step.** Its pins conflict with the package store. Put
  `inflexa-mdvtools` (import name `mdvtools`) in the packages of each step that makes a project.
  If `import mdvtools` fails, link `inflexa-mdvtools` into the step. If the store does not hold
  it, report it. Then deliver the asset, the validator report, and for spatial data the store, and
  say that the project is not built.
- **A readable label as the column name of a SpatialData table.** SpatialData refuses a column
  name with a space or a unit. The column keeps its source name as its field, and the label goes
  into `uns["mdv_labels"]`. The helpers give it to MDV.
- **A loop over `adata.layers` that does not skip the key `None`.** anndata 0.13 also lists X
  under that key, and h5py stops with "path must not be None". The helpers skip it.
- **A spatial store with more than one table.** mdvtools merges each table of a store into one
  `cells` table. Keep one table, with `obsm["spatial"]` or with shapes that it annotates
  (`put_table`).
- **A zip that the import refuses**: above 20,000 MiB, an entry with `..` or an absolute path, or
  the project files under more than one folder. `zip_project` writes the correct layout. A
  production build of MDV 1.3.0 hides the import. Then the operator unzips the zip into the
  projects directory of the server (`asset-route.md`, "The way into MDV").
- **The transcript points in the store.** mdvtools copies the full store into the project, and
  the points can be larger than the images. `drop_unused` removes them.
- **A Xenium store without its shapes.** mdvtools places the cells on the image with the
  transform of a Xenium shape. Without one, it reads µm as image pixels, the cells do not sit on
  the image, and no check reports an error. `drop_unused` keeps the shapes and the labels.
- **Duplicate obs or var names.** MDV multiplies the duplicated rows with no error.
- **Raw CosMx FOVs placed without the orientation check.** A wrong axis sign scrambles the tissue,
  and nothing reports an error.

## References

| File | Read it when |
|---|---|
| `references/asset-route.md` | Each project: readable labels, the helper modules, the asset, the project, the views, the context tables, the README, the zip, the way into MDV and its import, what mdvtools does with each AnnData slot, the dtype mapping |
| `references/validation.md` | Before delivery: the table validator, the project check, and how to read their reports |
| `references/spatial-transcriptomics.md` | Xenium, Visium, Visium HD, CosMx (flat files and raw instrument output), MERFISH: readers, the store, the orientation check, the stitched image |
| `references/spatial-proteomics.md` | CODEX/PhenoCycler, IMC, MIBI: markers as features, transforms, a store with no reader |
| `references/scatac-multiome.md` | scATAC-seq and multiome: gene activity, peaks, chromVAR |
| `references/memory-and-scale.md` | More than ~50,000 cells, a large panel, or large images: estimates, backed reads, chunked loads, the size of the project |
