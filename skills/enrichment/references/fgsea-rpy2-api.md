# fgsea via rpy2 API Reference

R fgsea (Fast Gene Set Enrichment Analysis) called from Python via rpy2. Provides fast, accurate GSEA with multilevel splitting for precise p-value estimation. Preferred when working in an R ecosystem or when fgseaMultilevel precision is needed.

## rpy2 Setup Boilerplate

```python
import numpy as np
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

pandas2ri.activate()

fgsea = importr("fgsea")
base = importr("base")
stats = importr("stats")
```

## pandas to R Conversion Helpers

```python
def pd_to_r(df):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.py2rpy(df)

def r_to_pd(r_obj):
    with localconverter(ro.default_converter + pandas2ri.converter):
        return ro.conversion.rpy2py(r_obj)
```

## Preparing Input

fgsea requires two inputs: (1) a named numeric vector of gene-level statistics and (2) a named list of character vectors (gene sets).

### Gene-Level Statistics (Named Numeric Vector)

```python
# From DESeq2 results: use stat column or log2FoldChange
# stats_series: pd.Series with gene symbols as index, ranking metric as values
stats_series = deseq_results["stat"].dropna()
# Or: stats_series = deseq_results["log2FoldChange"].dropna()

# Convert to R named numeric vector
gene_names = ro.StrVector(stats_series.index.tolist())
gene_stats = ro.FloatVector(stats_series.values.tolist())
gene_stats.names = gene_names
```

### Gene Sets (Named List of Character Vectors)

```python
# From a GMT file you resolved from the reference inventory (see Loading Gene Sets below).
# `gmt_path` is a Python variable holding the resolved path — never a literal.
ro.r.assign("gmt_path", gmt_path)
ro.r('pathways <- gmtPathways(gmt_path)')
pathways = ro.r("pathways")

# From a Python dict
gene_sets = {
    "HALLMARK_APOPTOSIS": ["CASP3", "CASP9", "BAX", "BCL2", "TP53"],
    "HALLMARK_HYPOXIA": ["VEGFA", "HIF1A", "LDHA", "PGK1", "SLC2A1"],
    "HALLMARK_P53_PATHWAY": ["TP53", "MDM2", "CDKN1A", "BAX", "GADD45A"],
}

# Build R named list of character vectors
pathway_list = ro.ListVector({
    name: ro.StrVector(genes) for name, genes in gene_sets.items()
})
```

## fgseaMultilevel() — Recommended

Multilevel splitting algorithm for accurate p-value estimation. Preferred over the legacy `fgsea()`.

```python
ro.r.assign("stats_vec", gene_stats)
ro.r.assign("pathways", pathway_list)

ro.r('''
result <- fgseaMultilevel(
    pathways = pathways,
    stats = stats_vec,
    minSize = 15,
    maxSize = 500,
    eps = 0,
    nPermSimple = 10000
)
''')
result = ro.r("result")
```

### fgseaMultilevel() Parameters

```python
ro.r('''
result <- fgseaMultilevel(
    pathways = pathways,       # named list of character vectors
    stats = stats_vec,         # named numeric vector (gene-level statistics)
    sampleSize = 101,          # int — sample size for initial estimation
    minSize = 15,              # int — minimum gene set size (after filtering)
    maxSize = 500,             # int — maximum gene set size
    eps = 0,                   # numeric — boundary for p-value precision (0 = max precision)
    nPermSimple = 10000,       # int — number of permutations for simple estimation
    absEps = NULL,             # numeric | NULL — absolute eps for p-value
    nproc = 1,                 # int — number of parallel processes
    BPPARAM = NULL             # BiocParallel param object
)
''')
```

## Legacy fgsea()

Simpler permutation-based approach. Faster but less accurate p-values.

```python
ro.r('''
result <- fgsea(
    pathways = pathways,
    stats = stats_vec,
    minSize = 15,
    maxSize = 500,
    nperm = 10000
)
''')
```

## Result Extraction to pandas

```python
# Convert fgsea results (data.table) to pandas DataFrame
ro.r.assign("result", result)

# fgsea returns a data.table; convert via as.data.frame
ro.r('result_df <- as.data.frame(result)')
res_df = r_to_pd(ro.r('result_df'))

# Columns:
#   pathway       — gene set name
#   pval          — nominal p-value
#   padj          — BH-adjusted p-value
#   log2err       — log2 fold enrichment error bound
#   ES            — enrichment score
#   NES           — normalized enrichment score
#   size          — gene set size (after intersection with stats)
#   leadingEdge   — list of leading edge genes (R list column)

# leadingEdge is an R list column — extract separately
leading_edge = {}
for i in range(len(ro.r('result$pathway'))):
    pathway_name = str(ro.r('result$pathway')[i])
    le_genes = list(ro.r(f'result$leadingEdge[[{i+1}]]'))
    leading_edge[pathway_name] = le_genes

# Add leading edge as semicolon-separated string
res_df["leadingEdge"] = res_df["pathway"].map(
    lambda p: ";".join(leading_edge.get(p, []))
)

# Filter significant pathways
sig = res_df[res_df["padj"] < 0.05].sort_values("padj")
sig_up = sig[sig["NES"] > 0]    # positively enriched
sig_down = sig[sig["NES"] < 0]  # negatively enriched
```

## Collapsed Pathways (Redundancy Reduction)

Reduce redundant gene sets by collapsing those with high overlap.

```python
ro.r.assign("result", result)
ro.r.assign("pathways", pathway_list)
ro.r.assign("stats_vec", gene_stats)

ro.r('''
collapsed <- collapsePathways(
    fgseaRes = result,
    pathways = pathways,
    stats = stats_vec,
    pval.threshold = 0.05,
    nperm = 10000
)
# collapsed$mainPathways — character vector of non-redundant pathways
# collapsed$parentPathways — named vector mapping children to parents
''')

# Filter results to main (non-redundant) pathways
main_pathways = list(ro.r('collapsed$mainPathways'))
res_collapsed = res_df[res_df["pathway"].isin(main_pathways)]
```

## Loading Gene Sets

### Resolved GMT files (the only option without network)

**Resolve the file before you write the script.** Ask for the *dataset* by what
it is, not by a path — reference data is provisioned per-environment, so the
directory, the filename, and the format all vary and none of them are yours to
assume:

| You need | Ask for | Notes |
|-|-|-|
| Broad first-pass gene sets | The MSigDB hallmark collection for your organism | 50 low-redundancy sets; the reliable default |
| Curated pathways | Reactome pathway gene sets; WikiPathways for your organism | Per-species files |
| GO / oncogenic / immunologic sets | The MSigDB collection you need, *if available* | Do not assume; only hallmark is dependably present |

`gmtPathways()` reads GMT and nothing else: one gene set per line,
tab-separated, with the set name first, then a description or source URL, then
the member gene symbols. If the inventory reports a different format for what
you resolved, parse it in Python and build the R named list yourself (see
"Gene Sets" above). Match the organism and the identifier space — these files
carry HGNC symbols for human and MGI symbols for mouse, and they must agree with
the names in your `stats` vector or every pathway drops out at `minSize`.

```python
# `gmt_path` was resolved from the reference inventory; do not hardcode it.
ro.r.assign("gmt_path", gmt_path)
ro.r('pathways <- gmtPathways(gmt_path)')
pathways = ro.r("pathways")

# Sanity check once stats_vec is assigned: expect a healthy overlap, not a handful
ro.r('cat(length(pathways), "sets;",
          length(intersect(unlist(pathways), names(stats_vec))), "genes matched\n")')
```

### msigdbr R package (requires network — WILL FAIL here)

```python
# msigdbr queries an online database. Without egress this errors out; there is
# no offline mode. Use a resolved GMT instead.
msigdbr = importr("msigdbr")

ro.r('''
msigdb_df <- msigdbr(species = "Homo sapiens", category = "H")
pathways <- split(msigdb_df$gene_symbol, msigdb_df$gs_name)
''')
pathways = ro.r("pathways")
```

### KEGG

KEGG gene sets cannot be redistributed under their license, so they are not
staged. `KEGGREST`, `clusterProfiler::gseKEGG()`, and Enrichr's KEGG libraries
all reach for the network and fail. Use Reactome or WikiPathways for canonical
pathway coverage instead.

## Complete Workflow Example

```python
# Prepare ranking from DESeq2
stats_series = deseq_results["stat"].dropna().sort_values(ascending=False)
gene_names = ro.StrVector(stats_series.index.tolist())
gene_stats = ro.FloatVector(stats_series.values.tolist())
gene_stats.names = gene_names

# Load hallmark gene sets from a GMT resolved per Loading Gene Sets
ro.r.assign("gmt_path", gmt_path)
ro.r('pathways <- gmtPathways(gmt_path)')

# Run fgsea
ro.r.assign("stats_vec", gene_stats)
ro.r('''
result <- fgseaMultilevel(
    pathways = pathways,
    stats = stats_vec,
    minSize = 15,
    maxSize = 500,
    eps = 0
)
result_df <- as.data.frame(result)
''')
res_df = r_to_pd(ro.r('result_df'))

# Filter and sort
sig = res_df[res_df["padj"] < 0.05].sort_values("NES", ascending=False)
```

## Gotchas

- `stats` vector must be NAMED. Unnamed numeric vectors silently produce empty results.
- Gene names in `stats` must match gene names in `pathways`. Use the same ID type (e.g., HGNC symbols) for both.
- `fgseaMultilevel()` with `eps=0` gives maximum precision but is slower. For exploratory analysis, `eps=1e-10` is usually sufficient.
- The `leadingEdge` column in fgsea results is an R list column, not a character vector. Direct pandas conversion creates nested objects. Extract it separately using R indexing.
- `collapsePathways()` requires the original `result`, `pathways`, and `stats` objects. It re-runs fgsea internally for the collapsing procedure.
- `minSize` and `maxSize` filter gene sets by the number of genes that overlap with the `stats` vector, not by the total gene set size.
- fgsea uses the absolute ranking of genes (their position in the sorted vector), not the numeric values directly. The direction of enrichment depends on gene order.
- Duplicate gene names in the stats vector are not allowed. Remove duplicates before creating the R vector, keeping the entry with the highest absolute value.
- Memory: fgsea with many large gene sets (>10k sets) can be memory-intensive. Call `ro.r("gc()")` after extracting results.
- `fgseaMultilevel()` supersedes `fgsea()` and `fgseaSimple()`. Use it by default for publication-quality results.
