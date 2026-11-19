# MDV Asset Contract

What `inflexa-mdvtools` does with the asset, and the rules that the asset must obey so that the
project is correct and readable. A "MUST" item stops the conversion or shows wrong data with no
error. A "SHOULD" item makes the difference between a project that opens and a project that is
useful. The facts come from the source of mdvtools 1.3.0, the source of MDV 1.3.0, and the MDV
documentation.

## The project

| Path | Content |
|---|---|
| `datafile.h5` | the data of each column of each datasource, and the expression sets |
| `datasources.json` | each datasource (`cells`, `genes`, the context tables) with its columns. A column has a `field` (its ID in `datafile.h5` and in the views) and a `name` (the label that MDV shows) |
| `views.json` | the charts of each view |
| `state.json` | the list of views, and the view that opens first |
| `README.md` | the README, also in the view "About this project" |
| `spatial/<store>.zarr` | a copy of the SpatialData store, with the images (spatial projects only) |
| `images/<region>.geo.json` | the shapes of the cells of each region (spatial projects only) |

## The conversions

| Input | Function | Result |
|---|---|---|
| the asset (`.mdv.h5ad`) | `convert_scanpy_to_mdv` (`write_project`) | a `cells` datasource and a `genes` datasource, with the expression linked to the cells |
| a SpatialData store with one table | `convert_spatialdata_to_mdv` (`write_spatial_project`) | the same datasources, plus one region for each annotated element, with its image |

The spatial conversion also does these things:

- It merges every table of the store into one `cells` datasource. Thus the store must hold one table.
- It adds the columns `x` and `y` (the position on the image, in pixels), `spatial_region`,
  `spatialdata_path`, and `table_name`.
- It selects the image `morphology_focus` first, if the store has it.
- A table without `obsm["spatial"]` has no position. Its cells get the region "ND" and no image.
- It adds the column `object_source` to `genes`.

## The way into MDV

A deployment of MDV adds the project in one of two ways:

- **"Import an existing project".** The user imports `<name>.mdv.zip` from the catalog. MDV 1.3.0
  shows this tile only in a development build. In the upstream code after 1.3.0, a production
  build shows it only when the build sets `VITE_SHOW_PROJECT_CREATION=true`.
- **The projects directory.** The operator of the server unzips the zip into a new folder of the
  projects directory (`/app/mdv` in the MDV image). Then "Rescan Projects" in the catalog, or a
  restart of the server, adds the project. With authentication, only an administrator can rescan.
  The name of the folder becomes the name of the project.

The import of MDV 1.3.0 has these rules:

- It refuses a zip above 20,000 MiB.
- It refuses an entry with `..` or an absolute path.
- It finds `views.json`, `state.json`, and `datasources.json` at the root of the zip, or under one
  folder.
- The server reads the full zip into memory.

The projects directory does not go through the import, so the import limit does not apply to it.

## What the conversion does with each slot

| AnnData slot | In MDV |
|---|---|
| `obs` columns | columns of `cells`. The label in `uns["mdv_labels"]` is the name that MDV shows |
| `obs_names` | the column `mdv_cell_id` (`unique`) |
| `obsm[k]` (2-D) | the columns `k_1`, `k_2`, `k_3` (the first 3 only). In a spatial table, `obsm["spatial"]` gives `spatial_1` and `spatial_2` |
| `var` columns, `var_names` | columns of `genes`. `var_names` gives the column `name`, which replaces a `name` column |
| `varm[k]` | the columns `k_1…k_3` of `genes` |
| `X` | the expression set "Gene Scores", sparse when X is sparse |
| `layers[k]` | one more expression set for each layer, as large as X, with the label of `uns["mdv_labels"]` |
| `uns`, `raw`, `obsp`, `varp` | not used (MDV does not keep the colors in `uns`) |

## MUST

1. **Unique `obs_names` and `var_names`.** The conversion joins the embeddings on the index.
   A duplicate multiplies rows with no error.
2. **Only mapped dtypes:**

   | Stored as | MDV datatype |
   |---|---|
   | int8, int16, int64, uint8, uint16, uint32 | `integer` (float32, exact to 2^24) |
   | int32, float32, float64 | `double` |
   | categorical text, object text, bool | `text` (`text16` above 256 values, `unique` above 65,536) |
   | uint64, float16, nullable Int/Float/boolean, pandas `string`, complex | **KeyError: the conversion stops** |

   With pandas ≥ 3, anndata writes `obs_names`, `var_names`, and a text column that is not
   categorical as a nullable string array. The reader gives the `string` dtype, and the
   conversion stops (`KeyError: 'string'`). Write the names as plain `str` (object) and each text
   column as categorical. `build_asset` does both.
3. **Safe fields.** A column name and a key of `obsm` or `layers` use only letters, digits, `_`,
   `.`, and `-`. A name does not start with `__`. The names of one slot are unique without regard
   to case. SpatialData refuses a table that breaks these rules, so the AnnData route obeys them
   too.
4. **Labels:** non-empty strings without `|`, because MDV divides the IDs of virtual columns at
   `|`.
5. **Gene names without `|` or `(`**, because they name the virtual gene columns.
6. **Reserved fields.** mdvtools writes these columns itself:
   - `obs`: `mdv_cell_id`, `x`, `y`, `spatial_region`, `spatialdata_path`, `table_name`
   - `var`: `name`
7. **Sparse X and layers.** mdvtools stores a dense matrix in full: 4 bytes × cells × genes.
8. **One table in a spatial store**, with `obsm["spatial"]` or with shapes that it annotates. The
   region column and the instance column keep their SpatialData names. `put_table` does this.

## SHOULD

1. **Readable labels**: words and units (`Cell area (µm²)`, `Transcripts per cell`), in
   `uns["mdv_labels"]` (`build_asset`). MDV has no column description field. Thus the README is the
   glossary.
2. **Readable categories**: no bare cluster IDs, no float IDs (`"1.0"`), and booleans as words.
   An inferred label has "putative" in its column label. Keep its evidence in a context table.
3. **Grouping columns with ≤ 256 categories**, so that they stay `text`. The stacked row, violin,
   box, heat map, pie, and Sankey charts accept only `text`.
4. **X log-normalized**, because MDV shows "Gene Scores" as stored.
5. **Only useful embeddings in `obsm`**: `UMAP`, not `X_pca` (three meaningless columns). Name
   the key for a person: MDV makes `UMAP_1` and `UMAP_2` from the key `UMAP`.
6. **The positions of the store as they are.** The tissue chart draws the cells on the image in
   the coordinates of the image. Do not flip y.
7. **No layers by default.** Each layer adds one more expression set as large as X.
8. **No `varm`, `obsp`, or `raw`**: they are noise or dead weight.
9. **A README** in the project and next to the zip, with the column glossary and the record of
   the processing.
10. **Context tables as datasources** of the project (`add_table`): one for the clusters, one for
    the samples, and one for the FOVs.

## Limits that stay

- Category colors: MDV uses its default palette, and it ignores `uns["*_colors"]`. The user sets
  the colors in MDV.
- More than 65,536 features (peaks) make the gene name column `unique`, and MDV shows a warning
  about the link. Keep the features to genes.
- The views of `add_views` are the first views. The user can change and save them in MDV.

## Compatibility

`inflexa-mdvtools` 1.3.0.post1 ran on the versions of the package store: anndata 0.13.2,
pandas 2.3.3, scanpy 1.12.4, numpy 2.5.2, spatialdata 0.8.0, spatialdata-io 0.7.1, and zarr
3.3.0. The project check gave zero errors for these projects:

- Xenium (`Xenium_V1_human_Breast_2fov`), with the image `morphology_focus`
- Visium HD (`Visium_HD_Tiny_3prime_Dataset`), the 16 µm bins and the segmented cells
- Visium CytAssist (`CytAssist_FFPE_Protein_Expression_Human_Breast_Cancer`)
- a synthetic raw CosMx run, with the stitched image
- a synthetic AnnData with no positions

The Xenium project and the synthetic AnnData project opened in the MDV 1.3.0 frontend that
mdvtools serves. On the tissue image, the Xenium cells sat on the nuclei. The import of a zip into
an MDV server was not part of these runs.
