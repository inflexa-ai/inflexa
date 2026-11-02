# MDV Asset Contract

What MDV does with an uploaded AnnData, and the rules an asset must obey so that the result is
correct and readable. "MUST" items abort the conversion or silently show wrong data. "SHOULD" items
separate a loadable asset from a useful one. The facts come from the mdvtools source (1.3.0) and
the MDV documentation.

## How MDV loads files

| File | MDV route | Result |
|---|---|---|
| `.h5ad` | upload: `scanpy.read(file)`, then `convert_scanpy_to_mdv(project_dir, adata)` with every default | a `cells` table and a `genes` table; expression linked to cells |
| `.csv`, `.tsv`, `.txt` | upload | one table per file |
| project `.zip` | import | a full project (built with mdvtools; not this route) |

- MDV's documentation lists `.h5ad` upload for its local development deployment, and CSV, TSV,
  and TXT for production. Say so in the README.
- An AnnData above 5 GB must come in as a project. Keep the asset below 5 GB.
- The upload holds the whole AnnData in memory and makes one more copy of X: about
  2 × (8 bytes × non-zeros) on the MDV server.
- One AnnData per project: a second upload into a project that has a `cells` table fails.
- The new project opens on one view with a table for each table. The user adds charts in MDV.

## What the conversion does with each slot

| AnnData slot | In MDV |
|---|---|
| `obs` columns | columns of `cells`; the **column label is the name people see** |
| `obs_names` | column `mdv_cell_id` (`unique`) |
| `obsm[k]` (2-D) | columns `k_1`, `k_2`, `k_3` (first 3 only) |
| `var` columns, `var_names` | columns of `genes`; a column `name` from `var_names` (it overwrites a `name` column) |
| `varm[k]` | columns `k_1…k_3` of `genes` |
| `X` | the expression set "Gene Scores", sparse when X is sparse |
| `layers[k]` | one more expression set per layer, labelled `k`, as large as X |
| `uns`, `raw`, `obsp`, `varp` | ignored (colours in `uns` are lost) |

## MUST

1. **Unique `obs_names` and `var_names`.** The conversion joins embeddings on the index;
   duplicates multiply rows with no error.
2. **Only mapped dtypes.** As MDV's reader sees them (anndata 0.12, pandas 2.3):

   | Stored as | MDV datatype |
   |---|---|
   | int8, int16, int64, uint8, uint16, uint32 | `integer` (float32; exact to 2^24) |
   | int32, float32, float64 | `double` |
   | categorical text, object text, bool | `text` (auto-promoted to `text16` above 256 values, `unique` above 65,536) |
   | uint64, float16, nullable Int/Float/boolean, pandas `string`, complex | **KeyError: the conversion aborts** |

   With pandas ≥ 3, anndata writes `obs_names`, `var_names`, and any text column it does not make
   categorical (all-unique values) as a nullable string array. MDV's reader turns that into the
   `string` dtype, and the conversion aborts (`KeyError: 'string'`). Write the names as plain `str`
   (object) and every text column as categorical. `build_asset` does both.
3. **Column labels:** non-empty strings, unique, without `|` (MDV splits virtual column ids on
   it) and without `/` (an HDF5 path separator; anndata refuses it).
4. **Gene names without `|` or `(`**: they name the virtual gene columns.
5. **Reserved labels:** no `obs` column `mdv_cell_id`, no `var` column `name`.
6. **Sparse X and layers.** A dense matrix is stored in full: 4 bytes × cells × genes.

## SHOULD

1. **Readable labels as column names**: words and units (`Cell area (µm²)`, `Transcripts per
   cell`). MDV has no separate display name and no column description field.
2. **Readable categories**: no bare cluster ids, no float ids (`"1.0"`), booleans as words.
   Inferred labels carry "putative" in the column label; keep their evidence in a context table.
3. **Grouping columns at ≤ 256 categories**, so they stay `text`. Stacked row, violin, box, heat
   map, pie, and Sankey charts accept only `text`.
4. **X log-normalised**: MDV shows "Gene Scores" as stored.
5. **Only useful embeddings in `obsm`**: `UMAP`, not `X_pca` (three meaningless columns). Name
   the key for people: MDV makes `UMAP_1`, `UMAP_2` from the key `UMAP`.
6. **Spatial positions as two readable `obs` columns** in micrometres, with y pointing up
   (`image height − y`): MDV scatter plots draw y upwards.
7. **No layers by default**: each one doubles the expression data in the project.
8. **No `varm`, `obsp`, `raw`**: noise or dead weight.
9. **A README next to the asset** with the column glossary and the processing record.
10. **Context tables as TSV**: per cluster, per sample, per FOV.

## Limits that stay

- Category colours: MDV uses its default palette (it ignores `uns["*_colors"]`); the user sets
  colours in MDV.
- Views: the user builds them. The README names the charts to make first.
- No tissue image under the cells: images need a project.
- More than 65,536 features (peaks) make the gene name column `unique`, and MDV warns about the
  link. Keep the feature set to genes.

## Compatibility checked

An asset written with anndata 0.13.2 and pandas 2.3.3 (the sandbox) was read and converted by
mdvtools 1.3.0 with anndata 0.12.2, pandas 2.3.2, and scanpy 1.11.4 (MDV's pins): every column
mapped as listed above, and the project opened in a browser.
