# clusterProfiler via rpy2 API Reference

R clusterProfiler called from Python via rpy2. Universal interface for GO, KEGG, and custom gene set enrichment (ORA and GSEA). Includes multi-group comparison via compareCluster and rich visualization functions.

**The KEGG entry points do not work here.** `enrichKEGG()`, `gseKEGG()`, and
`compareCluster(fun = "enrichKEGG")` fetch pathway data from the KEGG REST API at
run time, and there is no network egress — every one of them fails outright.
KEGG gene sets are not staged either, because their license forbids
redistribution. The KEGG sections below are kept so you can recognise the calls
and avoid them; use `enrichGO()`/`gseGO()`, or Reactome/WikiPathways gene sets,
for canonical pathway coverage instead.

## rpy2 Setup Boilerplate

```python
import numpy as np
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.conversion import localconverter
from rpy2.robjects.packages import importr

pandas2ri.activate()

clusterprofiler = importr("clusterProfiler")
org_db = importr("org.Hs.eg.db")  # human; use org.Mm.eg.db for mouse
enrichplot = importr("enrichplot")
dose = importr("DOSE")
base = importr("base")
stats = importr("stats")
grdevices = importr("grDevices")
ggplot2 = importr("ggplot2")
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

## enrichGO() — GO Over-Representation Analysis

```python
# gene_list: list of gene IDs (Entrez IDs or symbols)
gene_ids = ro.StrVector(["BRCA1", "TP53", "EGFR", "MYC", "KRAS", "PTEN", "RB1"])

ego = clusterprofiler.enrichGO(
    gene=gene_ids,
    OrgDb="org.Hs.eg.db",
    keyType="SYMBOL",          # "ENTREZID"|"SYMBOL"|"ENSEMBL"|"UNIPROT"
    ont="BP",                  # "BP"|"MF"|"CC"|"ALL"
    pvalueCutoff=0.05,
    pAdjustMethod="BH",       # "BH"|"bonferroni"|"holm"|"BY"|"none"
    qvalueCutoff=0.2,
    minGSSize=10,
    maxGSSize=500,
    readable=True,             # convert gene IDs to symbols in output
)

# Extract results
ego_df = r_to_pd(base.as_data_frame(ego))
# Columns: ID, Description, GeneRatio, BgRatio, pvalue, p.adjust, qvalue, geneID, Count
```

### enrichGO() Key Parameters

```python
clusterprofiler.enrichGO(
    gene=gene_ids,             # character vector — gene IDs
    OrgDb="org.Hs.eg.db",     # OrgDb object or string — annotation database
    keyType="ENTREZID",        # character — ID type of input genes
    ont="BP",                  # character — GO ontology: "BP", "MF", "CC", or "ALL"
    pvalueCutoff=0.05,         # numeric — p-value cutoff for enrichment
    pAdjustMethod="BH",        # character — p-value adjustment method
    universe=None,             # character vector | NULL — background gene universe
    qvalueCutoff=0.2,          # numeric — q-value cutoff
    minGSSize=10,              # int — minimum gene set size
    maxGSSize=500,             # int — maximum gene set size
    readable=False,            # logical — map gene IDs to symbols in output
    pool=False,                # logical — pool all GO categories (when ont="ALL")
)
```

## enrichKEGG() — KEGG Over-Representation Analysis (requires network — WILL FAIL here)

```python
# KEGG requires Entrez IDs (numeric gene IDs)
entrez_ids = ro.StrVector(["672", "7157", "1956", "4609", "3845", "5728"])

ekegg = clusterprofiler.enrichKEGG(
    gene=entrez_ids,
    organism="hsa",            # KEGG organism code: "hsa" (human), "mmu" (mouse)
    keyType="kegg",            # "kegg" (Entrez) | "ncbi-geneid" | "ncbi-proteinid" | "uniprot"
    pvalueCutoff=0.05,
    pAdjustMethod="BH",
    minGSSize=10,
    maxGSSize=500,
)

ekegg_df = r_to_pd(base.as_data_frame(ekegg))
```

### ID Conversion (Symbols to Entrez)

```python
# Convert gene symbols to Entrez IDs for KEGG
ro.r('''
library(org.Hs.eg.db)
symbols <- c("BRCA1", "TP53", "EGFR", "MYC")
entrez <- mapIds(org.Hs.eg.db, keys=symbols, keytype="SYMBOL", column="ENTREZID")
entrez <- entrez[!is.na(entrez)]
''')
entrez_ids = ro.r("entrez")
```

## gseGO() — GO Gene Set Enrichment Analysis

Requires a ranked gene list (named numeric vector, sorted descending).

```python
# From DESeq2 results
stats_series = deseq_results["stat"].dropna().sort_values(ascending=False)
gene_names = ro.StrVector(stats_series.index.tolist())
gene_list_r = ro.FloatVector(stats_series.values.tolist())
gene_list_r.names = gene_names

gsego = clusterprofiler.gseGO(
    geneList=gene_list_r,
    OrgDb="org.Hs.eg.db",
    keyType="SYMBOL",
    ont="BP",
    minGSSize=10,
    maxGSSize=500,
    pvalueCutoff=0.05,
    pAdjustMethod="BH",
    verbose=True,
    eps=0,                     # p-value resolution (0 = max precision)
)

gsego_df = r_to_pd(base.as_data_frame(gsego))
# Columns: ID, Description, setSize, enrichmentScore, NES, pvalue, p.adjust, qvalue,
#          rank, leading_edge, core_enrichment
```

## gseKEGG() — KEGG GSEA (requires network — WILL FAIL here)

```python
# Requires Entrez IDs as names in the ranked vector
# First convert symbols to Entrez IDs
ro.r.assign("stats_vec", gene_list_r)
ro.r('''
library(org.Hs.eg.db)
gene_names <- names(stats_vec)
entrez <- mapIds(org.Hs.eg.db, keys=gene_names, keytype="SYMBOL", column="ENTREZID")
mapped <- !is.na(entrez)
stats_entrez <- stats_vec[mapped]
names(stats_entrez) <- entrez[mapped]
stats_entrez <- sort(stats_entrez, decreasing=TRUE)
''')

ro.r('''
gse_kegg <- gseKEGG(
    geneList = stats_entrez,
    organism = "hsa",
    keyType = "kegg",
    minGSSize = 10,
    maxGSSize = 500,
    pvalueCutoff = 0.05,
    pAdjustMethod = "BH",
    verbose = TRUE,
    by = "fgsea"
)
''')
gsekegg_df = r_to_pd(ro.r('as.data.frame(gse_kegg)'))
```

## compareCluster() — Multi-Group Comparison

Compare enrichment across multiple gene clusters (e.g., up vs. down, or per-cluster markers).

```python
# Prepare gene clusters as an R named list
gene_clusters = {
    "Upregulated": ["BRCA1", "TP53", "EGFR", "MYC"],
    "Downregulated": ["PTEN", "RB1", "APC", "VHL"],
}
clusters_r = ro.ListVector({
    k: ro.StrVector(v) for k, v in gene_clusters.items()
})

ro.r.assign("clusters", clusters_r)
ro.r('''
cmp <- compareCluster(
    geneClusters = clusters,
    fun = "enrichGO",
    OrgDb = "org.Hs.eg.db",
    keyType = "SYMBOL",
    ont = "BP",
    pvalueCutoff = 0.05,
    pAdjustMethod = "BH",
    readable = TRUE
)
''')
cmp_df = r_to_pd(ro.r('as.data.frame(cmp)'))
# Columns: Cluster, ID, Description, GeneRatio, BgRatio, pvalue, p.adjust, qvalue, geneID, Count

# compareCluster with KEGG (requires Entrez IDs)
ro.r('''
cmp_kegg <- compareCluster(
    geneClusters = clusters,
    fun = "enrichKEGG",
    organism = "hsa",
    pvalueCutoff = 0.05
)
''')
```

## Visualization

All visualization functions save to file via `ggsave()`.

### dotplot()

```python
ro.r.assign("ego", ego)
ro.r('''
p <- dotplot(ego, showCategory=20) + ggtitle("GO Biological Process")
ggsave("go_dotplot.png", p, width=10, height=8, dpi=150)
''')

# For compareCluster results
ro.r.assign("cmp", ro.r("cmp"))
ro.r('''
p <- dotplot(cmp, showCategory=10) + theme(axis.text.x = element_text(angle=45, hjust=1))
ggsave("compare_dotplot.png", p, width=12, height=8, dpi=150)
''')
```

### cnetplot() — Gene-Concept Network

```python
ro.r('''
p <- cnetplot(ego, showCategory=5, categorySize="pvalue")
ggsave("cnetplot.png", p, width=12, height=10, dpi=150)

# With gene fold changes
# Requires a named numeric vector of fold changes
p <- cnetplot(ego, showCategory=5, foldChange=gene_fc)
ggsave("cnetplot_fc.png", p, width=12, height=10, dpi=150)
''')
```

### heatplot()

```python
ro.r('''
p <- heatplot(ego, showCategory=20)
ggsave("heatplot.png", p, width=14, height=8, dpi=150)
''')
```

### emapplot() — Enrichment Map

```python
ro.r('''
ego_pt <- pairwise_termsim(ego)  # required before emapplot
p <- emapplot(ego_pt, showCategory=30)
ggsave("emapplot.png", p, width=12, height=10, dpi=150)
''')
```

### GSEA Running Plot

```python
ro.r.assign("gsego", gsego)
ro.r('''
p <- gseaplot2(gsego, geneSetID=1:3, pvalue_table=TRUE)
ggsave("gsea_running.png", p, width=10, height=8, dpi=150)
''')
```

## Gotchas

- `enrichKEGG()` and `gseKEGG()` require Entrez gene IDs (numeric), not symbols. Convert first with `mapIds()` from the OrgDb package.
- `geneList` for GSEA functions (`gseGO`, `gseKEGG`) must be a NAMED numeric vector, SORTED in decreasing order. Unsorted input gives wrong results.
- `OrgDb` for human is `"org.Hs.eg.db"`, mouse is `"org.Mm.eg.db"`, rat is `"org.Rn.eg.db"`. The package must be installed.
- `keyType` must match the ID type in your gene list. Common options: `"ENTREZID"`, `"SYMBOL"`, `"ENSEMBL"`. Check with `columns(org.Hs.eg.db)`.
- `enrichKEGG()` and `gseKEGG()` query the KEGG REST API online and fail here — egress is blocked. `use_internal_data=TRUE` is not a way around it: that path needs the `KEGG.db` annotation package, which is not staged either. There is no working KEGG route in this environment; use GO or a resolved Reactome/WikiPathways GMT.
- `emapplot()` requires `pairwise_termsim()` to be called first on the enrichment result. Without it, you get an error about missing similarity data.
- `readable=TRUE` in `enrichGO()` converts Entrez IDs to symbols in the `geneID` column. It only works for `enrichGO`, not `enrichKEGG`.
- `compareCluster()` `fun` parameter accepts a function name as a string (`"enrichGO"`) or the function itself (`enrichGO`). Additional parameters for the enrichment function are passed as `...` arguments.
- `universe` (background gene set) must use the same ID type as the input genes. If not provided, the full OrgDb is used as background.
- KEGG organism codes: human = `"hsa"`, mouse = `"mmu"`, rat = `"rno"`. Full list at https://www.genome.jp/kegg/catalog/org_list.html.
