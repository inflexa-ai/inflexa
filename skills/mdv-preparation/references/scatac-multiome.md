# scATAC-seq and Multiome → MDV

## The problem with peaks

A peak set has 100,000–500,000 features. As the features of an MDV project, a peak set fails:

- Above 65,536 rows, MDV makes the feature name column `unique`, and it shows a warning about the link.
- A person looks up genes, not genomic intervals.

Thus the features of the project are **genes**, through a gene-activity matrix. If the user asks
for the peaks, add them as one more table of the project (`add_table`).

## scATAC-seq alone

Use the chromatin-regulation pack for the analysis (SnapATAC2 when installed, Signac through R
otherwise). The asset holds:

| Item | Source | In the asset |
|---|---|---|
| cells, QC (fragments, TSS enrichment, FRiP, doublet score) | the ATAC object | `obs`, readable labels |
| UMAP, clusters, labels | the ATAC object (spectral embedding / LSI) | `obsm["UMAP"]`, `obs` |
| gene activity, normalized + log1p, sparse | SnapATAC2 `make_gene_matrix` or Signac `GeneActivity` | X |
| gene symbols (unique, no `|` / `(`) | the gene annotation of the genome build | `var_names` |

MDV labels X "Gene Scores". Write in the README that the Gene Scores of this project are
gene-activity scores, not expression.

## Multiome (RNA + ATAC in the same cells)

One project, one gene table, two expression sets:

```python
shared = rna.var_names.intersection(activity.var_names)          # genes in both
rna_s = rna[:, shared]
act = activity[rna.obs_names, shared]                             # rows in the order of the RNA cells
rna_s.layers["act"] = act.X                                       # sparse, normalised + log1p
asset = build_asset(rna_s, OBS_LABELS, obsm_keys={"X_umap": "UMAP"}, layers={"act": "Gene activity"})
```

MDV shows X as "Gene Scores" (RNA) and the layer as "Gene activity". The layer key (`act`) is a
field, so it obeys the field rule of the asset contract. Before you write the asset, make sure
that the cells of the two modalities are the same (`act.obs_names` equals `rna.obs_names`). Also
make sure that the two matrices are sparse and log-normalized. Write in the README how many genes
each modality loses to the intersection.

Motif deviations (chromVAR) and peaks do not fit the gene table. Add them as tables of the project
(`add_table`): one row for each motif or peak, with a summary for each cluster.

## Peaks (an optional table)

The `peaks` table: chromosome, start, end, width, the nearest gene, and the accessibility of each
cluster. MDV stores the positions as float32 numbers, which rounds values above 16,777,216. Thus
keep the positions as text in a `Location` column (`chr1:1234567-1235067`) as well.

## Anti-patterns

- Peaks as the features of the project.
- A raw (not normalized) gene-activity matrix.
- The word "expression" for gene activity, in a label or in the README.
- Multiome layers whose rows or genes are not in the order of X.
