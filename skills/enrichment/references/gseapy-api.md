# GSEApy API Reference

Python library for gene set enrichment analysis. Provides ORA (over-representation analysis), GSEA, preranked GSEA, and single-sample GSEA. Supports GMT files, Python dicts, and Enrichr web services as gene set sources.

## Resource Loading

Never pass an Enrichr library name string (e.g., `"MSigDB_Hallmark_2020"`,
`"KEGG_2021_Human"`, `"GO_Biological_Process_2023"`) to `gene_sets=`: every one
of them triggers an HTTP request to the Enrichr API, and there is no network
egress — the call **will fail**. This holds for `gp.enrich()`, `gp.gsea()`,
`gp.prerank()`, and `gp.ssgsea()` alike. Pass a gene set file already available
to you instead.

**Resolve the file before you write the script.** Ask for the *dataset* by what
it is, not by a path — reference data is provisioned per-environment, so the
directory, the filename, and the format all vary and none of them are yours to
assume:

| You need | Ask for | Notes |
|-|-|-|
| Broad first-pass gene sets | The MSigDB hallmark collection for your organism | 50 low-redundancy sets; the reliable default |
| Curated pathways | Reactome pathway gene sets; WikiPathways for your organism | Per-species files |
| GO sets | The MSigDB GO collection for your organism, naming the branch (BP, CC or MF) | Nested hierarchy — parent and child sets hit together; collapse before counting |
| Oncogenic / immunologic sets | The MSigDB oncogenic or immunologic collection for your organism | Sets come in directional `_UP`/`_DN` pairs; a hit means "resembles that contrast", so name the contrast |

Gene set files circulate as GMT, and gseapy's `gene_sets=` accepts a GMT path or
a plain `{set_name: [genes]}` dict — read anything else into a dict yourself.
Match the organism: a human gene set file scored against mouse symbols runs
happily and returns near-empty overlaps. The identifier space must match too —
these files carry HGNC symbols for human and MGI symbols for mouse, so convert
Ensembl or Entrez IDs to symbols before enrichment.

```python
# `hallmark_gmt_path` is a path you resolved, not a literal to copy.
res = gp.prerank(
    rnk=rnk,
    gene_sets=hallmark_gmt_path,
    min_size=15, max_size=500, outdir=None, seed=42,
)

res = gp.enrich(
    gene_list=de_genes,
    gene_sets=wikipathways_gmt_path,  # resolved, per-species
    background=background_genes,
    outdir=None,
)
```

**KEGG is not available.** Its license forbids redistribution, so KEGG gene sets
are not staged, and every route to them (`"KEGG_2021_Human"` via Enrichr,
`clusterProfiler::enrichKEGG()`, KEGGREST) needs network access it will not get.
Use Reactome or WikiPathways for canonical pathway coverage instead.

### GMT File Contract

A GMT is one gene set per line, tab-separated: set name, a description or source
URL, then the member gene symbols. Whatever file you resolve must match your
data on both axes — organism and identifier type — before the enrichment result
means anything.

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

# Basic ORA against a resolved GMT
# `hallmark_gmt_path` was resolved from the reference inventory.
# gp.enrich() takes no `organism` argument — that belongs to the web-only
# gp.enrichr(). Passing it here raises TypeError. Match the organism by
# resolving a gene set file for that organism instead.
enr = gp.enrich(
    gene_list=gene_list,
    gene_sets=hallmark_gmt_path,
    outdir=None,            # None = do not write files to disk
    cutoff=0.05,            # adjusted p-value cutoff for output filtering
)

# Multiple gene set files — pass a list of resolved paths
enr = gp.enrich(
    gene_list=gene_list,
    gene_sets=[hallmark_gmt_path, reactome_gmt_path, wikipathways_gmt_path],
    outdir=None,
)

# With custom background (required for a defensible ORA)
enr = gp.enrich(
    gene_list=gene_list,
    gene_sets=reactome_gmt_path,
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
| `Combined Score` | Enrichr combined score: `log(p) * z`, where p is the Fisher p-value and z the z-score of deviation from expected rank. log(p) is negative and z is negative, so the product is positive and larger = stronger. Do not negate log(p) — that flips the sign and inverts the ranking. |
| `Genes` | Semicolon-separated gene symbols in the overlap |

## gp.gsea() — Standard GSEA

Requires an expression matrix and class labels. Computes gene-level ranking internally.

```python
# expr_df: genes as rows, samples as columns
# cls: class label vector matching column order (or a .cls file path)

gsea_res = gp.gsea(
    data=expr_df,                       # DataFrame (genes x samples) or file path
    gene_sets=hallmark_gmt_path,        # resolved GMT path or dict (never a library name)
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
    gene_sets=hallmark_gmt_path,        # resolved GMT path or dict
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
    gene_sets=hallmark_gmt_path,        # resolved GMT path or dict
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

### Resolved gene set files (the only option here)

Pass a path you resolved from the reference inventory, or an in-memory dict.
These are the only sources that work without network access:

```python
# `hallmark_gmt_path` was resolved from the reference inventory.
res = gp.prerank(
    rnk=rnk,
    gene_sets=hallmark_gmt_path,
    outdir=None,
)

# A dict works too, and is the escape hatch for any non-GMT source you parse yourself
res = gp.prerank(rnk=rnk, gene_sets={"PathA": ["GENE1", "GENE2"]}, outdir=None)
```

### Enrichr library names (requires network — WILL FAIL here)

Every string below is an Enrichr library name. Passing one to `gene_sets=`
issues an HTTP request to the Enrichr API and fails without egress — there is no
cached fallback. `gp.get_library_name()` fails for the same reason. They are
listed only so you can recognise and avoid them:

| Library Name | Nearest available substitute |
|-|-|
| `"MSigDB_Hallmark_2020"` | The MSigDB hallmark collection, resolved as a GMT |
| `"Reactome_2022"` | Reactome pathway gene sets, resolved as a GMT |
| `"WikiPathway_2023_Human"` | WikiPathways for your organism, resolved as a GMT |
| `"GO_Biological_Process_2023"` | An MSigDB GO collection *if* your environment has one |
| `"GO_Molecular_Function_2023"` | An MSigDB GO collection *if* your environment has one |
| `"GO_Cellular_Component_2023"` | An MSigDB GO collection *if* your environment has one |
| `"KEGG_2021_Human"` | None — KEGG cannot be redistributed and is not staged |
| `"Transcription_Factor_PPIs"` | A TF-target regulon network via decoupler |
| `"ENCODE_and_ChEA_Consensus_TFs_from_ChIP-X"` | A TF-target regulon network via decoupler |

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
- Any Enrichr library name string fails without network access, and so does `gp.get_library_name()`. There is no offline library cache — resolve a gene set file instead.
- `organism=` exists only on `gp.enrichr()`, the Enrichr **web API** call, which cannot run here. `gp.enrich()` — the offline route — has no such parameter and raises TypeError if you pass one. It does **not** convert identifiers either way, so resolve a gene set file matching your organism rather than reaching for this parameter.
- `background` in `gp.enrich()` sets the gene universe for the Fisher test. Provide it: without it GSEApy falls back to the union of genes across the gene sets, which inflates significance.
- Column names in results vary slightly between methods. `enrich()` uses `"Adjusted P-value"` while `prerank()` uses `"FDR q-val"`.
- `prerank()` expects a pre-sorted ranking. If you pass an unsorted Series, results may differ from expected.
- For custom gene sets as dicts, values must be lists of strings (gene symbols), not sets or tuples.
- `ssgsea()` `res2d` has one row per (term, sample) pair. Pivot to get a gene_sets x samples matrix.
- Large gene set libraries (>5000 sets) with high `permutation_num` can be very slow. Start with `permutation_num=100` for exploration.
