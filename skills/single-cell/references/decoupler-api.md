# decoupler API Reference

Enrichment analysis framework for inferring biological activities from omics
data using prior knowledge networks. Works directly on AnnData objects. Key
applications: transcription factor activity, pathway activity, and functional
gene set scoring.

## Prior Knowledge Resources

Never call `dc.op.collectri()`, `dc.op.progeny()`, `dc.op.msigdb()`, or any other
`dc.op.*()` loader: they fetch from the OmniPath web API, and there is no network
egress. Load every network from a file already available to you.

**Resolve the file before you write the script.** Ask for the *dataset* by what it
is, not by a path — reference data is provisioned per-environment, so the
directory, the filename, and the format all vary and none of them are yours to
assume:

| You need | Ask for | Standard sources |
|-|-|-|
| TF activity | A TF-target regulon network for your organism | CollecTRI; or DoRothEA filtered to confidence A-C |
| Pathway activity | Pathway responsive-gene weights for your organism | PROGENy (14 pathways) |
| Gene set scoring | A gene-set collection for your organism | MSigDB hallmark; Reactome; WikiPathways — these are published as GMT |

Then read it with the reader its format actually calls for — these circulate as
CSV, TSV, GMT, and R `.rda` depending on the source, and a wrong-format read fails
immediately. Match the organism too: a human regulon set over mouse counts runs
happily and returns meaningless activities.

Pathway-weight and regulon files are frequently distributed as R `.rda` (this is
how PROGENy and DoRothEA are published), which pandas cannot open — those need
rpy2. Check the format the inventory reports and pick the reader from it:

```python
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri


def read_rda_frame(path: str) -> pd.DataFrame:
    """Load the data frame an R .rda holds (PROGENy, DoRothEA) into pandas."""
    names = list(ro.r["load"](path))  # load() returns the names it created
    with (ro.default_converter + pandas2ri.converter).context():
        return ro.conversion.get_conversion().rpy2py(ro.r[names[0]])
```

### CollecTRI (Transcription Factors)

```python
import pandas as pd

# `regulon_path` is a path you resolved from the reference inventory, not a literal.
# CollecTRI is CSV; if you resolved DoRothEA instead, it is .rda — use read_rda_frame.
collectri = pd.read_csv(regulon_path)
# Long format: source (TF), target (gene symbol), weight (+1 activation / -1 repression)
#     source  target  weight
# 0   STAT1   IRF1    1.0
# 1   STAT1   GBP1    1.0
```

### PROGENy (Pathway Activity)

```python
# `pathway_path` resolved from the reference inventory.
# PROGENy is published as .rda — read_csv on it fails outright.
progeny = read_rda_frame(pathway_path)
# Columns as shipped: gene, weight, p.value, pathway. Rename to the long format
# every method consumes — source (pathway), target (gene symbol), weight (signed float).
# 14 pathways: Androgen, EGFR, Estrogen, Hypoxia, JAK-STAT, MAPK,
# NFkB, p53, PI3K, TGFb, TNFa, Trail, VEGF, WNT
```

### MSigDB Gene Sets

```python
# `geneset_path` resolved from the reference inventory — ask for the collection
# by name, not by filename. Gene-set collections ship as GMT, whose lines are
# ragged (a set per line, members to the end), so pandas cannot read one: parse
# it, or hand the path straight to a tool that takes GMT (gseapy, fgsea).
def read_gmt(path: str) -> pd.DataFrame:
    """Flatten a GMT into decoupler's long source/target format."""
    rows = []
    with open(path) as handle:
        for line in handle:
            name, _description, *genes = line.rstrip("\n").split("\t")
            rows.extend({"source": name, "target": gene} for gene in genes if gene)
    return pd.DataFrame(rows)


msigdb_hallmark = read_gmt(geneset_path)
# Unweighted: gsea/ora/aucell need only source + target, no weight column.
```

### Normalising Column Names

Column names vary by source — DoRothEA ships `tf`/`target`/`mor`, and some releases
carry extra provenance columns. Every method below consumes `source`/`target`/`weight`,
so inspect the frame after loading and rename before passing it on:

```python
collectri = collectri.rename(columns={"tf": "source", "mor": "weight"})
collectri = collectri[["source", "target", "weight"]]
```

Target gene symbols are HGNC for human and MGI for mouse; they must match
`adata.var_names` exactly.

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

# 2. Load prior knowledge network (NOT dc.op.collectri — no network)
collectri = pd.read_csv(regulon_path)  # resolved + normalised per Prior Knowledge Resources

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

# 1. Load PROGENy pathways (NOT dc.op.progeny — no network)
progeny = read_rda_frame(pathway_path)  # PROGENy is .rda; see Prior Knowledge Resources

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
