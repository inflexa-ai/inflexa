---
name: mdv-preparation
description: Prepare scRNA-seq, scATAC-seq, spatial transcriptomics, and spatial proteomics data as MDV (Multi-Dimensional Viewer) projects that load and are useful — input wrangling, metadata curation, human-readable labels, views, and headless validation with mdvtools
version: 1.0.0
tags: [mdv, mdvtools, multi-dimensional-viewer, visualization, anndata, mudata, spatialdata, cosmx, xenium, visium, merfish, codex, imc, mibi]
---

# MDV Project Preparation

An MDV project is a folder that the MDV web app opens: `datasources.json`, `views.json`,
`state.json`, `datafile.h5`, optional `images/`, and a `README.md`. Always write it with the
`mdvtools` Python package. A project is **MDV-ready** when:

1. the validator in `references/validation.md` reports zero errors, and
2. a person who did not make it can read every column name, every category, and every view
   without help: human-readable names, labelled clusters, fixed colours, views that open on
   the data, and a README that explains the columns and the processing.

A project that only loads is not ready. The browser validates its config but never refuses
it, so a broken column or a wrong category code shows as wrong data, not as an error.

## Workflow

Do the steps in this order. Each step has a reference.

```
1. Inventory      what is the modality, the platform, the input form, the size?   (decision tree below)
2. Build          one analysis-ready AnnData: counts in, QC, log-normalised sparse X,
                  embeddings, clusters, labels                                     (modality reference)
3. Curate         select columns, display names with units, categories at <=256 levels,
                  readable labels, fixed colours, dtypes that mdvtools maps          (anndata-route.md)
4. Convert        mdvtools into a NEW folder                                        (anndata-route.md)
5. Context        extra datasources: per-sample / per-FOV QC, cluster-label evidence (anndata-route.md)
6. Views          the standard view set of the modality                            (view-recipes.md)
7. Describe       README (glossary + provenance), state: name, edit, initial view  (anndata-route.md)
8. Validate       zero errors; fix and re-run from the failing step                (validation.md)
9. Deliver        project folder + zip, validation report, the curated .h5ad
```

## Input Decision Tree

```
Input?
├── AnnData (.h5ad)
│   ├── raw counts only            → QC + normalise + embed + cluster (single-cell pack) → AnnData route
│   └── already processed          → check X is log-normalised and sparse; keep the author's labels → AnnData route
├── 10x Cell Ranger / count matrix → read into AnnData → as raw counts above
├── Seurat / SingleCellExperiment  → convert to AnnData (shared omics-general pack) → AnnData route
├── MuData (.h5mu) / multiome      → scatac-multiome.md (MuData route, or AnnData route + extra links)
├── scATAC-seq                     → scatac-multiome.md: genes as features (gene activity); peaks never as the gene link
├── Spatial transcriptomics        → spatial-transcriptomics.md
│   ├── CosMx flat-file export     → spatialdata-io / pandas reader
│   ├── CosMx raw instrument run   → raw builder + FOV orientation check (mandatory)
│   ├── Xenium                     → spatialdata-io; cells table
│   ├── Visium / Visium HD         → spots or bins as rows; one project per bin size
│   └── MERFISH / MERSCOPE         → cell-by-gene + cell metadata
└── Spatial proteomics             → spatial-proteomics.md
    (CODEX/PhenoCycler, IMC, MIBI)   markers as features; arcsinh-transformed intensities
```

Spatial data goes through the **AnnData route with slide coordinates and a region image**
(`spatial-transcriptomics.md`). Use the SpatialData route only when the store already has an
image in the coordinate system of the table and the user needs the SpatialData viewer.

## Conventions

- **mdvtools version.** Read it with `importlib.metadata.version("mdvtools")` and write against
  that API. PyPI 1.3.0 has no `rename_column`, `soft_delete_column`, `set_display_name`, or
  `create_default_views`: set the column `name` and the state directly, and build views yourself.
  If mdvtools is not installed, do steps 1–3, save the curated `.h5ad`, report that conversion
  needs mdvtools, and stop. Never write `datasources.json` or `datafile.h5` by hand.
- **Two names per column.** `field` is the stable id: ASCII snake_case, unique, never `|` or `/`.
  `name` is what people read: words and units, for example `Cell area (µm²)`,
  `Transcripts per cell`. MDV has no column description field: put the meaning of each column
  in the README glossary.
- **Readable categories.** Never export bare cluster ids. Number clusters by size and add the
  label: `C01 Oligodendrocytes`. Map codes and booleans to words (`Yes`/`No`, `Tumour`/`Normal`).
  Mark inferred labels as putative in the column name, and keep the evidence in a datasource.
- **Grouping columns stay `text`.** At most 256 categories. Above 256 a column becomes `text16`
  and most category charts (stacked row, violin, box, heat map, pie, Sankey) refuse it.
- **Fixed colours.** Give every grouping column an explicit `#rrggbb` per value, the same in
  every view. Derive the cluster colour from its cell type. MDV ignores `uns["*_colors"]`.
- **Layers are opt-in.** Always call `convert_scanpy_to_mdv(..., add_layer_data=False)`. With
  anndata ≥ 0.13, `adata.layers` lists X under the key `None`; mdvtools 1.3.0 then fails on the
  default (`Argument 'path' must not be None`), and `convert_mudata_to_mdv` stores every matrix
  twice as `<modality>_None`. Add each wanted layer yourself (`anndata-route.md`).
- **Expression.** `X` = library-size-normalised, log1p, **sparse**. It becomes "Gene Scores".
  Never export a scaled or dense matrix (one float32 per cell per gene). Add raw counts as a
  layer only when the project stays small; otherwise keep counts in the delivered `.h5ad`.
- **Coordinates.** Micrometres. MDV scatter plots draw y upwards and images have y downwards:
  export `y_up = image_height − y`, so the tissue is upright.
- **Deterministic.** Fix every seed, sort categories by a stated rule, and write the same project
  from the same input. Record parameters and package versions in the README.
- **Memory first.** Estimate the matrix size before you load it (`memory-and-scale.md`). A
  scanpy step can hold three copies of X.

## Anti-Patterns

- **Hand-written MDV files.** Column encodings, link metadata, and h5 layouts are easy to get
  silently wrong. Use mdvtools.
- **Converter output delivered as-is.** `convert_scanpy_to_mdv(delete_existing=True)` makes one
  empty view: the project opens blank. Always build views and set `initial_view`.
- **No `permission: "edit"` in the state.** The project opens view-only and the user cannot save.
- **Bare ids as labels.** Leiden `"0"…"23"`, float ids that become `"1.0"`, sample barcodes as
  the only sample name.
- **Grouping columns above 256 categories**, or a FOV / sample id as `text16` used for charts.
- **Duplicate obs or var names.** The row count of the datasource changes silently.
- **Pandas dtypes mdvtools does not map** (`Int64`, `string`, `uint64`, `float16`, `boolean` with
  NA) — the conversion aborts. Sanitise first.
- **`|` or `(` in feature names**, or `/` in a field: virtual gene columns and h5 paths break.
- **Re-running into an existing project folder.** Convert into a new folder every time.
- **`add_layer_data` left at its default.** It fails or duplicates X on current anndata.
- **Unchecked dropped columns.** `add_datasource` returns the columns it could not write. Assert
  that the list is empty.
- **Raw CosMx FOVs placed without the orientation check.** A wrong axis sign scrambles the tissue
  and nothing reports an error.
- **Reordered rows between a SpatialData table and its MDV datasource.** The viewer joins them
  by position.
- **Unlabelled inferences.** A cell type from markers is a putative label. Say so, and show
  the evidence.
- **"It loads" as the acceptance test.** Run the validator, and look at the views.

## References

| File | Read it when |
|---|---|
| `references/mdv-project-contract.md` | You need the exact rules: files, column types and limits, dtype mapping, naming, links, views, state, regions, version differences |
| `references/anndata-route.md` | Every project: sanitise, convert, curate names and colours, add context datasources, README, state — with a complete worked script |
| `references/view-recipes.md` | Building views: chart config helpers, virtual gene columns, the standard view set per modality |
| `references/validation.md` | Before delivery: the validator script and how to read its report |
| `references/spatial-transcriptomics.md` | CosMx (flat files and raw instrument output), Xenium, Visium, MERFISH: readers, slide coordinates, region image, orientation check |
| `references/spatial-proteomics.md` | CODEX/PhenoCycler, IMC, MIBI: markers as features, transforms, morphology |
| `references/scatac-multiome.md` | scATAC-seq and multiome: gene activity, peaks, chromVAR, MuData |
| `references/memory-and-scale.md` | More than ~50,000 cells, or a large panel: estimates, backed reads, chunked loads, subsampling |
