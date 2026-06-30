# decoupler API Reference

Enrichment analysis framework for inferring biological activities from omics
data using prior knowledge networks. Works directly on AnnData objects. Key
applications: transcription factor activity, pathway activity, and functional
gene set scoring.

## Prior Knowledge Resources

### CollecTRI (Transcription Factors)

```python
import pandas as pd

# Load pre-staged CollecTRI regulons from the reference store.
# Call list-available-refs to get the exact path.
# NEVER call dc.op.collectri() — it requires network access (unavailable in sandbox).
collectri = pd.read_parquet("<path from list-available-refs>/omnipath/processed/organism_9606/interactions_by_dataset/interactions__dataset_collectri.parquet")
# Returns DataFrame: source (TF), target (gene), weight (activation/repression)
#     source  target  weight
# 0   STAT1   IRF1    1.0
# 1   STAT1   GBP1    1.0
```

### PROGENy (Pathway Activity)

```python
# Load pre-staged PROGENy pathway gene weights from the reference store.
# NEVER call dc.op.progeny() — it requires network access.
progeny = pd.read_parquet("<path from list-available-refs>/progeny/processed/progeny_human.parquet")
# Returns DataFrame: source (pathway), target (gene), weight, p_value
# 14 pathways: Androgen, EGFR, Estrogen, Hypoxia, JAK-STAT, MAPK,
# NFkB, p53, PI3K, TGFb, TNFa, Trail, VEGF, WNT
```

### MSigDB Gene Sets

```python
# Load pre-staged MSigDB gene sets from the reference store.
# NEVER call dc.op.msigdb() — it requires network access (unavailable in sandbox).
# Available collections: hallmark, canonical_pathways, go_biological_process,
# go_cellular_component, go_molecular_function, oncogenic_signatures,
# immunologic_signatures, cell_type_signatures.
msigdb_hallmark = pd.read_parquet("<path from list-available-refs>/msigdb/processed/Hs/msigdb_hallmark.parquet")
# Returns DataFrame: gene_set, description, gene_symbol (long format)
# GMT format also available for gseapy/fgsea:
#   "<path from list-available-refs>/msigdb/processed/Hs/msigdb_hallmark.gmt"
```

## Running Methods on AnnData

All methods follow the pattern: `dc.mt.<method>(data=adata, net=network)`.
Results are stored in `adata.obsm`.

### ULM (Univariate Linear Model) - Recommended

```python
# TF activity inference on single-cell AnnData
dc.mt.ulm(data=adata, net=collectri)
# Stores: adata.obsm["score_ulm"]  (activity scores)
#         adata.obsm["padj_ulm"]   (adjusted p-values)

# Pathway activity
dc.mt.ulm(data=adata, net=progeny)

# Extract scores as AnnData
tf_scores = dc.pp.get_obsm(adata=adata, key="score_ulm")
print(tf_scores)  # AnnData where X = activity scores, var = TFs or pathways
```

### MLM (Multivariate Linear Model)

```python
# Multivariate model - accounts for co-regulation
dc.mt.mlm(data=adata, net=collectri)
# Stores: adata.obsm["score_mlm"], adata.obsm["padj_mlm"]
```

### WSUM (Weighted Sum)

```python
# Weighted sum of target gene expression
dc.mt.wsum(data=adata, net=collectri)
# Stores: adata.obsm["score_wsum"], adata.obsm["padj_wsum"]
#         adata.obsm["norm_wsum"]  (normalized scores)
```

### Other Methods

```python
# GSEA (Gene Set Enrichment Analysis)
dc.mt.gsea(data=adata, net=msigdb)

# Over-representation analysis (ORA)
dc.mt.ora(data=adata, net=msigdb)

# AUCell
dc.mt.aucell(data=adata, net=msigdb)

# Consensus (run multiple methods and aggregate)
dc.mt.consensus(data=adata, net=collectri)
```

## Bulk / Pseudobulk Analysis

```python
import pandas as pd

# Works on DataFrames too (samples x genes)
data = pd.DataFrame(...)  # Your expression matrix

# Run ULM on bulk data
tf_acts, tf_padj = dc.mt.ulm(data=data, net=collectri)
# Returns tuple of DataFrames when input is DataFrame

# Filter significant TFs
msk = (tf_padj.T < 0.05).iloc[:, 0]
tf_acts_sig = tf_acts.loc[:, msk]
```

## Extracting and Visualizing Results

```python
# Extract activity scores from AnnData
acts = dc.pp.get_obsm(adata, key="score_ulm")

# Visualize TF activities on UMAP
import scanpy as sc
sc.pl.umap(acts, color=["STAT1", "MYC", "TP53"], cmap="RdBu_r", vcenter=0)

# Network visualization of TF and target genes
dc.pl.network(
    net=collectri,
    data=data,          # Expression data (DataFrame)
    score=tf_acts,      # Activity scores
    sources=["ATF3", "MYC", "GATA1"],  # TFs to show
    targets=5,          # Top N targets per TF
    figsize=(5, 5),
    vcenter=True,
)

# Barplot of top activities
dc.pl.barplot(
    acts,
    "score_ulm",
    groupby="cell_type",
    top_n=10,
)
```

## Standard Workflow (Single-Cell TF Activity)

```python
import scanpy as sc
import decoupler as dc

# 1. Load preprocessed, annotated AnnData
adata = sc.read_h5ad("annotated.h5ad")

# 2. Load prior knowledge network from ref store (NOT dc.op.collectri — no network)
collectri = pd.read_parquet("<path from list-available-refs>/omnipath/processed/organism_9606/interactions_by_dataset/interactions__dataset_collectri.parquet")

# 3. Infer TF activities
dc.mt.ulm(data=adata, net=collectri)

# 4. Extract activity scores
acts = dc.pp.get_obsm(adata, key="score_ulm")

# 5. Visualize
sc.pl.umap(acts, color=["STAT1", "MYC", "NF-kB"], cmap="RdBu_r", vcenter=0)
sc.pl.matrixplot(acts, var_names=["STAT1", "MYC", "GATA1"], groupby="cell_type")
```

## Standard Workflow (Pathway Activity)

```python
import decoupler as dc

# 1. Load PROGENy pathways from ref store (NOT dc.op.progeny — no network)
progeny = pd.read_parquet("<path from list-available-refs>/progeny/processed/progeny_human.parquet")

# 2. Score pathways
dc.mt.ulm(data=adata, net=progeny)

# 3. Extract and visualize
pw_scores = dc.pp.get_obsm(adata, key="score_ulm")
sc.pl.umap(pw_scores, color=["JAK-STAT", "NFkB", "MAPK"], cmap="RdBu_r", vcenter=0)
sc.pl.matrixplot(pw_scores, var_names=pw_scores.var_names.tolist(), groupby="cell_type")
```

## Gotchas

- **Normalized input**: decoupler expects log-normalized expression in `adata.X`.
  Do not pass raw counts unless the method explicitly requires them.
- **AnnData storage**: When passing an AnnData object, results go into `adata.obsm`
  (keyed by `score_<method>` and `padj_<method>`). When passing a DataFrame,
  results are returned as a tuple of DataFrames.
- **Gene name matching**: Gene names in `adata.var_names` must match the network's
  `target` column. Ensure consistent gene symbol format (e.g., uppercase for human).
- **CollecTRI vs PROGENy**: CollecTRI is for TF activity inference (TF-target
  interactions). PROGENy is for pathway activity (pathway-responsive genes with
  weights). Do not mix them.
- **Method choice**: ULM is fast and robust for most cases. MLM accounts for
  co-regulation but is slower. WSUM is the simplest. Consensus runs multiple
  methods but takes longer.
- **Sparse data**: Methods handle sparse matrices natively. No need to densify.
- **Pseudobulk**: For differential activity analysis between conditions, consider
  pseudobulking first, then running decoupler on the pseudobulk DataFrame.
