# scATAC-seq and Multiome → MDV

## The problem with peaks

A peak set has 100,000–500,000 features. As the linked feature datasource of the cells this
breaks down in MDV:

- above 65,536 rows the feature name column becomes `unique` and the link UI warns about
  unexpected behaviour;
- people look up genes, not genomic intervals.

So the cells link to **genes**, through a gene-activity matrix. Peaks, if the user needs them,
go in their own datasource, not as the gene link.

## Build the AnnData

Use the chromatin-regulation pack for the analysis (SnapATAC2 when installed, Signac through R
otherwise). For MDV you need:

| Item | Source |
|---|---|
| cells, QC (`n_fragment`, `tsse`, `frip`, doublet score) | the ATAC object |
| `X_umap`, clusters, labels | the ATAC object (spectral embedding / LSI) |
| X = gene activity, log-normalised, sparse | SnapATAC2 `make_gene_matrix` or Signac `GeneActivity`, then normalise + log1p |
| var = gene symbols (unique, no `|` / `(`) | the gene annotation of the genome build |

Name the subgroup for what it is: "Gene activity", not "Gene Scores". Rename the link and the
subgroup label after the conversion:

```python
md = mdv.get_datasource_metadata("cells")
md["links"]["genes"]["rows_as_columns"]["subgroups"]["gs"]["label"] = "Gene activity"
md["links"]["genes"]["rows_as_columns"]["name"] = "Gene activity"
mdv.set_datasource_metadata(md)
```

Motif deviations (chromVAR) are a second feature set: a `motifs` datasource with its own link
(`add_rows_as_columns_link` + `add_rows_as_columns_subgroup`), rows in the same order as the
deviation matrix columns.

## Peaks (optional)

A `peaks` datasource from a DataFrame: `chr` (text), `start` and `end` as `int32` (positions
exceed the exact range of float32), peak width, the nearest gene, and per-cluster accessibility
summaries. Do not link it to the cells by rows-as-columns.

## Multiome (RNA + ATAC in the same cells)

Two routes. Use the first.

1. **AnnData route plus a link** (default): convert the RNA AnnData with `add_layer_data=False`,
   then add the gene activity as a second feature datasource and link it:

   ```python
   mdv.add_datasource("activity_genes", sanitise_frame(act_var.reset_index(names="name")), add_to_view=None)
   mdv.add_rows_as_columns_link("cells", "activity_genes", "name", "Gene activity")
   mdv.add_rows_as_columns_subgroup("cells", "activity_genes", "ga", to_csc(act_X), label="Gene activity")
   ```

   `act_X` rows MUST be in the order of the `cells` datasource (the RNA `obs_names`), and its
   columns in the order of `activity_genes`. Check `act_obs_names == rna_obs_names` first.
2. **MuData route**: `convert_mudata_to_mdv(folder, mdata)` writes `cells` from the global `obs`
   and one datasource plus link per modality (`rna`, `atac`, …). It has no `add_layer_data`
   switch, and with anndata ≥ 0.13 it writes each matrix twice: `<mod>_expr` and `<mod>_None`
   (the X that anndata lists under `layers[None]`). Before you convert: make the ATAC modality a
   gene-activity modality (not peaks), keep modality keys short, and make every modality's
   `obs_names` a subset of the global ones. After you convert, remove the `<mod>_None` subgroups
   from the link metadata; the duplicate data stays in the file, so prefer route 1.

Then curate and build views as in the AnnData route. Add a view that compares RNA expression
and gene activity of the selected gene on the UMAP side by side.

## Anti-patterns

- Peaks as the linked feature set of the cells.
- Genomic positions as `integer` or `double` (float32 rounds them).
- A raw (not normalised) gene-activity matrix as X.
- Calling gene activity "expression" in names, labels, or the README.
