# MDV Project Contract

The rules an MDV project must obey, distilled from the mdvtools source (1.3.0) and the MDV
frontend. "MUST" items break the build, break the load, or silently show wrong data. "SHOULD"
items separate a loadable project from a useful one.

## Files

```
<project>/
  datasources.json   JSON array, one object per datasource
  views.json         JSON object {view name: view}
  state.json         JSON object {all_views, initial_view, permission, name}
  datafile.h5        one HDF5 group per datasource; one dataset per column
  images/regions/    background images of spatial regions (add_region_images copies them here)
  README.md          project description; shown in the full MDV app
  tracks/, lock      created by mdvtools
```

- All JSON MUST be strict: no `NaN`, no `Infinity` (mdvtools writes with `allow_nan=False` and
  raises). Clean every number you put into metadata.
- `MDVProject(folder)` creates the folder with `os.mkdir`: the parent MUST exist.
- The browser only runs from `localhost` or HTTPS, with the cross-origin isolation headers
  (COOP `same-origin`, COEP `require-corp`). `mdvtools serve` and `serverlite` send them.

## Datasources

```json
{"name": "cells", "size": 183350, "columns": [ ... ], "links": { ... },
 "columnGroups": [{"name": "QC", "columns": ["total_counts", "n_genes_detected"]}],
 "regions": { ... }}
```

- `name`: use `[A-Za-z0-9_]+`. It is the h5 group, a JSON key, and a URL segment.
- `size` MUST equal the length of every column dataset.
- The DataFrame index is NOT stored. `reset_index()` first if the index carries ids.

## Columns

```json
{"field": "area_um2", "name": "Cell area (µm²)", "datatype": "double", "minMax": [3.1, 520.8]}
```

| datatype | Use for | Stored as | Limit | Missing |
|---|---|---|---|---|
| `text` | grouping categories | uint8 codes into `values` | 256 values | `"ND"` category |
| `text16` | many categories | uint16 codes | 65,536 values | `"ND"` |
| `multitext` | several categories per row | uint16 × `stringLength` | 65,535 | empty |
| `unique` | ids, free text | fixed-length bytes | none | `""` |
| `integer`, `double` | numbers | float32 | exact integers only to 2^24 | NaN |
| `int32` | large integers (genomic positions) | int32 | — | none: NaN becomes INT_MIN |

- `field` MUST be unique per datasource, a non-empty `str`, without `|` (the frontend splits
  virtual column ids on `|` and hides such columns) and without `/` (h5py makes a nested group).
- `name` is the display label. Keep it unique (case-insensitive) within the datasource.
- Category `values` are written in **descending frequency** order, not category order. If you
  pass `values` yourself, they MUST cover every value in the data, or unlisted values are coded
  as the first category with no error.
- `colors`: one `#rrggbb` per entry of `values`, same order. Hex only (`"red"` fails).
- There is no description field for a column. Use the README glossary and chart `legend`.

### pandas dtype → MDV datatype (pandas path)

| pandas dtype | MDV datatype |
|---|---|
| `int8`, `int16`, `int64`, `uint8`, `uint16`, `uint32` | `integer` (float32) |
| `int32`, `float32`, `float64` | `double` |
| `object`, `category`, `bool` | `text` → auto-promoted to `text16` above 256 values, `unique` above 65,536 |
| `datetime64` | `double` with `is_date` (repo HEAD only) |
| `uint64`, `float16`, `Int*`/`UInt*`/`Float*` (nullable), `string`, `complex` | **KeyError — the whole conversion aborts** |

Silent drops (warning only; returned by `add_datasource`): integer column labels, duplicate
labels (both dropped), empty labels, non-ASCII text in a `unique` column, a numeric datatype on
strings. A float column turned into text gives `"0.0"`, `"1.0"` — cast ids to `str(int)` first.
A bool column becomes `"True"`/`"False"`; map it to words first.

## AnnData → MDV (`convert_scanpy_to_mdv`)

| AnnData slot | Becomes |
|---|---|
| `obs` (every column) | the `cells` datasource (name configurable) |
| `obs_names` | column `mdv_cell_id`, datatype `unique` |
| `obsm[k]` (2-D array) | columns `{k}_1 … {k}_{max_dims}`, for example `X_umap_1`, `X_umap_2` |
| `var` + `var_names` | the `genes` datasource; column `name` from `var_names` (overwrites a `name` column) |
| `varm[k]` | columns `{k}_1 …` on genes |
| `X` | subgroup `gs`, h5 group `gene_scores`, label "Gene Scores" |
| `layers[k]` | one subgroup per layer when `add_layer_data=True` (the default). **With anndata ≥ 0.13 the layers include X under the key `None` and the conversion fails: always pass `add_layer_data=False`** |
| `uns`, `raw`, `obsp`, `varp` | **ignored** (colours in `uns` are lost) |

- Duplicate `obs_names` or `var_names` MUST be fixed first: they multiply rows silently.
- `adata.obs` and `adata.var` are mutated in place (`mdv_cell_id`, `name` are added).
- `delete_existing=True` deletes the folder, writes one empty `default` view, and sets
  `permission: "edit"`. `delete_existing=False` into an existing project raises
  `FileExistsError` for an existing datasource and never saves its view updates.
- Sparse matrices are stored as CSC (`x` float32, `i` uint32, `p` pointers): about 8 bytes per
  non-zero. Dense matrices are stored in full, column-major.

## Links: cells ↔ genes

```json
"links": {"genes": {"rows_as_columns": {"name_column": "name", "name": "Gene Expr",
          "subgroups": {"gs": {"name": "gene_scores", "label": "Gene Scores", "type": "sparse"}}}}}
```

- A gene column is virtual. Its id is `"{stub}|{gene name}({stub})|{row index in genes}"`,
  for example `"gs|GFAP(gs)|1234"`. The index is the row of the gene in the genes datasource,
  which is the column of the matrix. Feature names MUST NOT contain `|` or `(`.
- The `name_column` should be `text`/`text16`. Above 65,536 features it becomes `unique` and the
  link UI warns. Keep the linked feature set below that (genes, not peaks).
- `{"type": "RowsAsColsQuery", "linkedDsName": "genes", "maxItems": 1}` as a `param` or
  `color_by` follows the genes the user selects in the genes panel.

## Views and state

```json
{"Tissue map": {"dataSources": {"cells": {"layout": "gridstack", "panelWidth": 100}},
                "initialCharts": {"cells": [ {chart}, ... ]}}}
```

- Every chart has `id`, `type`, `title`, `param` (column fields, virtual ids, or a
  RowsAsColsQuery), `size`, `position`, and for gridstack `gsposition` / `gssize` on a 12-column
  grid. `legend` is a description shown in the chart info.
- Every `param` and `color_by` field MUST exist in the datasource of the panel.
- `state.json`: `all_views` (menu order), `initial_view` (MUST be in `all_views`),
  `permission: "edit"` (anything else is view-only), `name` (project display name).
- Hide a column (`deleted: true`) before any view references it.

## Regions (spatial background images, classic route)

```json
"regions": {"position_fields": ["x_um", "y_um"], "region_field": "region", "default_color": "cell_type",
            "scale_unit": "µm", "scale": 1.0, "base_url": "images/regions/",
            "all_regions": {"slide": {"roi": {"min_x": 0, "min_y": 0, "max_x": 12798, "max_y": 11774},
                                      "images": {"Morphology composite": {"file": "abc123.jpg", "position": [0, 0],
                                                 "width": 12798, "height": 11774, "name": "Morphology composite"}},
                                      "default_image": "Morphology composite"}}}
```

- Write it with `set_region_data` then `add_region_images`. Both raise if a named column is missing.
- `region_field` must be a `text` column with one value per region (one region per sample or slide).
- Keep each image at most 8,192 px on its long side: it becomes one WebGL texture.

## Version differences (PyPI 1.3.0 vs repository HEAD)

| Feature | PyPI 1.3.0 | HEAD |
|---|---|---|
| `rename_column`, `soft_delete_column` | absent — set `name` / `deleted` in the metadata | present |
| `set_display_name` | absent — set `state["name"]` | present |
| `create_default_views` | absent — build views yourself | present |
| date columns (`is_date`) | absent | present |
| SpatialData chart type | `VivMdvRegionReact` | `SpatialDataMdvRegionReact` |
| core pins | `anndata==0.12.2`, `pandas==2.3.2`, `scanpy==1.11.4`, `numpy<2.3`, `spatialdata<0.8`, `flask==3.0.3` | similar |

mdvtools 1.3.0 also runs on newer anndata (0.13), scanpy (1.12), numpy (2.5), and spatialdata
(0.8) for the AnnData route, with two exceptions:

- anndata 0.13 lists X in `adata.layers` under the key `None`. `convert_scanpy_to_mdv` with the
  default `add_layer_data=True` fails (`TypeError: Argument 'path' must not be None`), and
  `convert_mudata_to_mdv` writes each matrix twice (`rna_expr` and `rna_None`). Pass
  `add_layer_data=False`, and avoid the MuData route or remove the `_None` subgroups.
- With Flask 2.2 and Werkzeug 3, `app.test_client()` fails; use `werkzeug.test.Client(app)`.
