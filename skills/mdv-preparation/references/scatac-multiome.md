# scATAC-seq and Multiome → MDV

## The problem with peaks

A peak set has 100,000–500,000 features. As the features of an MDV asset this breaks down:

- above 65,536 rows MDV makes the feature name column `unique` and warns about the link;
- people look up genes, not genomic intervals.

So the features of the asset are **genes**, through a gene-activity matrix. Peaks, if the user
needs them, go in a separate TSV.

## scATAC-seq alone

Use the chromatin-regulation pack for the analysis (SnapATAC2 when installed, Signac through R
otherwise). The asset holds:

| Item | Source | In the asset |
|---|---|---|
| cells, QC (fragments, TSS enrichment, FRiP, doublet score) | the ATAC object | `obs`, readable labels |
| UMAP, clusters, labels | the ATAC object (spectral embedding / LSI) | `obsm["UMAP"]`, `obs` |
| gene activity, normalised + log1p, sparse | SnapATAC2 `make_gene_matrix` or Signac `GeneActivity` | X |
| gene symbols (unique, no `|` / `(`) | the gene annotation of the genome build | `var_names` |

MDV labels X "Gene Scores". Say in the README that the Gene Scores of this asset are gene-activity
scores, not expression.

## Multiome (RNA + ATAC in the same cells)

One asset, one gene table, two expression sets:

```python
shared = rna.var_names.intersection(activity.var_names)          # genes in both
rna_s = rna[:, shared]
act = activity[rna.obs_names, shared]                             # rows in the order of the RNA cells
rna_s.layers["act"] = act.X                                       # sparse, normalised + log1p
asset = build_asset(rna_s, OBS_LABELS, obsm_keys={"X_umap": "UMAP"}, layers={"act": "Gene activity"})
```

MDV shows X as "Gene Scores" (RNA) and the layer as "Gene activity". Check before you write:
the cells of both modalities are the same (`act.obs_names` equals `rna.obs_names`), and both
matrices are sparse and log-normalised. Report in the README how many genes each modality loses
to the intersection.

Motif deviations (chromVAR) and peaks do not fit the gene table. Write them as TSV files: one row
per motif or peak, with per-cluster summaries.

## Peaks (optional TSV)

`peaks.tsv`: chromosome, start, end, width, the nearest gene, and per-cluster accessibility. MDV
reads positions as numbers stored as float32, which rounds values above 16,777,216; keep the
positions as text in a `Location` column (`chr1:1234567-1235067`) as well.

## Anti-patterns

- Peaks as the features of the asset.
- A raw (not normalised) gene-activity matrix.
- Calling gene activity "expression" in labels or the README.
- Multiome layers whose rows or genes are not in the order of X.
