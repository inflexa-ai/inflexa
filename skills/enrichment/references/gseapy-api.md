# GSEApy API Reference

Python library for gene set enrichment analysis. Provides ORA (over-representation analysis), GSEA, preranked GSEA, and single-sample GSEA. Supports GMT files, Python dicts, and Enrichr web services as gene set sources.

## Sandbox: Use Pre-Staged GMT Files

In sandbox environments there is **no network access**. Do NOT pass Enrichr
library name strings (e.g., `"MSigDB_Hallmark_2020"`) to `gene_sets=` — this
triggers an HTTP request that will fail. Instead, pass a **pre-staged GMT file
path** from `list-available-refs`:

```python
# Get the GMT path from list-available-refs tool output, then:
res = gp.prerank(
    rnk=rnk,
    gene_sets="<path from list-available-refs>/msigdb/processed/Hs/msigdb_hallmark.gmt",
    min_size=15, max_size=500, outdir=None, seed=42,
)

# WikiPathways GMT is also pre-staged:
res = gp.enrich(
    gene_list=de_genes,
    gene_sets="<path from list-available-refs>/wikipathways/processed/wikipathways_Homo_sapiens.gmt",
    background=background_genes,
    outdir=None,
)
```

Available pre-staged MSigDB collections (human + mouse): hallmark,
canonical_pathways, go_biological_process, go_cellular_component,
go_molecular_function, oncogenic_signatures, immunologic_signatures,
cell_type_signatures. WikiPathways GMT files are available per species.

## Core Imports

```python
import gseapy as gp
import pandas as pd
import numpy as np
```

## gp.enrich() — Over-Representation Analysis (ORA)

Tests whether a gene list is enriched for specific gene sets compared to a background.

```python
# gene_list: list of gene symbols (DEGs, cluster markers, etc.)
gene_list = ["BRCA1", "TP53", "EGFR", "MYC", "KRAS", "PTEN"]

# Basic ORA using Enrichr libraries
enr = gp.enrich(
    gene_list=gene_list,
    gene_sets="GO_Biological_Process_2023",
    organism="human",
    outdir=None,            # None = do not write files to disk
    cutoff=0.05,            # adjusted p-value cutoff for output filtering
)

# Multiple gene set libraries
enr = gp.enrich(
    gene_list=gene_list,
    gene_sets=["GO_Biological_Process_2023", "KEGG_2021_Human", "MSigDB_Hallmark_2020"],
    organism="human",
    outdir=None,
)

# With custom background
enr = gp.enrich(
    gene_list=gene_list,
    gene_sets="KEGG_2021_Human",
    background="background_genes.txt",   # file path or list of gene symbols
    outdir=None,
)

# Custom gene sets (dict or GMT file)
custom_gs = {
    "Pathway_A": ["GENE1", "GENE2", "GENE3"],
    "Pathway_B": ["GENE4", "GENE5", "GENE6"],
}
enr = gp.enrich(
    gene_list=gene_list,
    gene_sets=custom_gs,
    outdir=None,
)

# Results
results_df = enr.results
# OR
results_df = enr.res2d
```

### enrich() Results Columns

| Column | Description |
|--------|-------------|
| `Gene_set` | Library name |
| `Term` | Gene set / pathway name |
| `Overlap` | "k/n" format (k genes from list in set of size n) |
| `P-value` | Raw p-value from Fisher's exact test |
| `Adjusted P-value` | BH-adjusted p-value |
| `Odds Ratio` | Odds ratio of enrichment |
| `Combined Score` | Enrichr combined score: -log(p) * z |
| `Genes` | Semicolon-separated gene symbols in the overlap |

## gp.gsea() — Standard GSEA

Requires an expression matrix and class labels. Computes gene-level ranking internally.

```python
# expr_df: genes as rows, samples as columns
# cls: class label vector matching column order (or a .cls file path)

gsea_res = gp.gsea(
    data=expr_df,                       # DataFrame (genes x samples) or file path
    gene_sets="MSigDB_Hallmark_2020",   # library name, GMT path, or dict
    cls=["control"] * 5 + ["treatment"] * 5,  # class labels
    permutation_num=1000,               # number of permutations
    permutation_type="phenotype",       # "phenotype" or "gene_set"
    method="signal_to_noise",           # ranking metric
    min_size=15,                        # min gene set size
    max_size=500,                       # max gene set size
    outdir=None,
    seed=42,
    verbose=True,
)

results_df = gsea_res.res2d
```

### GSEA Ranking Methods

| `method=` | Description |
|-----------|-------------|
| `"signal_to_noise"` | (mean_A - mean_B) / (std_A + std_B). Default. |
| `"t_test"` | t-statistic |
| `"ratio_of_classes"` | mean_A / mean_B |
| `"log2_ratio_of_classes"` | log2(mean_A / mean_B) |
| `"diff_of_classes"` | mean_A - mean_B |

## gp.prerank() — Preranked GSEA

When you already have a ranked gene list (e.g., from DESeq2 log2FC * -log10(pvalue)).

```python
# rnk: pd.Series or pd.DataFrame with gene names and ranking scores
# Or a file path to a .rnk file (two columns: gene, score)

# From DESeq2 results
rnk = deseq_results["log2FoldChange"].dropna()
rnk = rnk.sort_values(ascending=False)

# Or compute a composite ranking metric
rnk = np.sign(deseq_results["log2FoldChange"]) * -np.log10(deseq_results["pvalue"].clip(1e-300))
rnk = rnk.sort_values(ascending=False)

pre_res = gp.prerank(
    rnk=rnk,                            # Series (index=genes, values=scores) or file path
    gene_sets="MSigDB_Hallmark_2020",
    min_size=15,
    max_size=500,
    permutation_num=1000,
    outdir=None,
    seed=42,
    verbose=True,
)

results_df = pre_res.res2d
```

### prerank() Results Columns (res2d)

| Column | Description |
|--------|-------------|
| `Term` | Gene set name |
| `ES` | Enrichment score |
| `NES` | Normalized enrichment score |
| `NOM p-val` | Nominal p-value |
| `FDR q-val` | FDR-adjusted q-value |
| `FWER p-val` | Family-wise error rate p-value |
| `Tag %` | Percentage of gene set before peak (leading edge) |
| `Gene %` | Percentage of ranked list before peak |
| `Lead_genes` | Semicolon-separated leading edge genes |

## gp.ssgsea() — Single-Sample GSEA

Per-sample enrichment scores for each gene set.

```python
# expr_df: genes as rows, samples as columns

ss_res = gp.ssgsea(
    data=expr_df,
    gene_sets="MSigDB_Hallmark_2020",
    outdir=None,
    min_size=15,
    max_size=500,
    sample_norm_method="rank",     # "rank" | "log" | "log_rank" | "custom"
    no_plot=True,
)

# ssGSEA enrichment scores matrix: gene_sets x samples
scores_df = ss_res.res2d.pivot_table(
    index="Term", columns="Name", values="NES"
)
# OR from the result object directly:
scores_df = ss_res.res2d
```

## Gene Set Sources

### Pre-staged GMT files (sandbox — preferred)

Use pre-staged GMT file paths from `list-available-refs`. This is the only
method that works without network access:

```python
res = gp.prerank(
    rnk=rnk,
    gene_sets="<path>/msigdb/processed/Hs/msigdb_hallmark.gmt",
    outdir=None,
)
```

### Enrichr library names (requires network — NOT available in sandbox)

These string names trigger HTTP requests to the Enrichr API:

| Library Name | Description |
|-------------|-------------|
| `"GO_Biological_Process_2023"` | GO biological processes |
| `"GO_Molecular_Function_2023"` | GO molecular functions |
| `"GO_Cellular_Component_2023"` | GO cellular components |
| `"KEGG_2021_Human"` | KEGG pathways (human) |
| `"MSigDB_Hallmark_2020"` | MSigDB hallmark gene sets (50 sets) |
| `"Reactome_2022"` | Reactome pathways |
| `"WikiPathway_2023_Human"` | WikiPathways (human) |
| `"Transcription_Factor_PPIs"` | TF protein-protein interactions |
| `"ENCODE_and_ChEA_Consensus_TFs_from_ChIP-X"` | TF targets |

```python
# List all available Enrichr libraries (requires network)
libs = gp.get_library_name()
```

## Plotting

```python
# GSEA enrichment plot for a specific term (prerank/gsea results)
from gseapy import gseaplot

# Plot top term
term = pre_res.res2d.iloc[0]["Term"]
gseaplot(
    rank_metric=pre_res.ranking,
    term=term,
    ofname="gsea_plot.png",
    **pre_res.results[term],
)

# Dot plot for ORA results
from gseapy import dotplot
ax = dotplot(
    enr.res2d,
    column="Adjusted P-value",
    title="Enrichment",
    cmap="viridis_r",
    size=6,
    figsize=(8, 10),
    cutoff=0.05,
)
ax.figure.savefig("dotplot.png", dpi=150, bbox_inches="tight")
```

## Gotchas

- `outdir=None` suppresses file output. If you set a directory, GSEApy writes TSV and plot files. For programmatic use, always set `outdir=None`.
- Results are in `res2d` (DataFrame), not `results` (which is a dict for GSEA/prerank). Use `res2d` for consistent access across all methods.
- Gene set names in Enrichr are case-sensitive and include the year. Check exact names with `gp.get_library_name()`.
- `organism="human"` is only needed for Enrichr web API calls (`enrich`). For `prerank`/`ssgsea` with local gene sets or GMT files, it is ignored.
- The `background` parameter in `gp.enrich()` overrides `organism`. When `background` is provided, the background gene universe is restricted to those genes.
- Column names in results vary slightly between methods. `enrich()` uses `"Adjusted P-value"` while `prerank()` uses `"FDR q-val"`.
- `prerank()` expects a pre-sorted ranking. If you pass an unsorted Series, results may differ from expected.
- For custom gene sets as dicts, values must be lists of strings (gene symbols), not sets or tuples.
- `ssgsea()` `res2d` has one row per (term, sample) pair. Pivot to get a gene_sets x samples matrix.
- Large gene set libraries (>5000 sets) with high `permutation_num` can be very slow. Start with `permutation_num=100` for exploration.
