# scirpy API Reference

Single-cell immune receptor (TCR/BCR) repertoire analysis. Built on the
scverse ecosystem, integrates with scanpy and MuData for combined
transcriptome + repertoire analysis.

## Data Import (ir.io)

### 10x Genomics VDJ

```python
import scirpy as ir
import scanpy as sc
from mudata import MuData

# Read 10x CellRanger VDJ output (CSV or JSON)
adata_tcr = ir.io.read_10x_vdj("filtered_contig_annotations.csv")
# Also works with: all_contig_annotations.csv, contig_annotations.json

# Combine with gene expression into MuData
adata_gex = sc.read_10x_h5("filtered_feature_bc_matrix.h5")
adata_gex.var_names_make_unique()
mdata = MuData({"gex": adata_gex, "airr": adata_tcr})
# Convention: gene expression in "gex", immune receptors in "airr"
```

### AIRR-Compliant Format

```python
# Read AIRR rearrangement TSV files
adata_ir = ir.io.read_airr([
    "immunesim_tra.tsv",
    "immunesim_trb.tsv",
])

# Read multiple samples
adata_ir = ir.io.read_airr(
    ["sample1_airr.tsv", "sample2_airr.tsv"],
)
```

### Other Formats

```python
# BD Rhapsody
adata_ir = ir.io.read_bd_rhapsody("bd_vdj_output.csv")

# TraCeR (T cell)
adata_ir = ir.io.read_tracer("tracer_output_dir/")

# BraCeR (B cell)
adata_ir = ir.io.read_bracer("bracer_output_dir/")
```

## Preprocessing (ir.pp)

### Index Chains

Required first step after data import. Selects primary/secondary VJ/VDJ
chains per cell based on expression levels.

```python
# Index chains (required before most analyses)
ir.pp.index_chains(mdata)
# Adds adata.obsm["chain_indices"]: primary/secondary chain selection

# With custom filtering (default: productive + require junction_aa)
ir.pp.index_chains(
    mdata,
    filter=("productive", "require_junction_aa"),
)
```

### Compute Sequence Distances

```python
# Pairwise CDR3 sequence distances (for clonotype clustering)
ir.pp.ir_dist(mdata)  # Default: nucleotide identity

# Amino acid sequence distances
ir.pp.ir_dist(mdata, sequence="aa")

# Custom metric
ir.pp.ir_dist(mdata, metric="hamming", sequence="nt")
# Stores in mdata.uns["ir_dist_{sequence}_{metric}"]
```

## Quality Control (ir.tl)

### Chain QC

```python
# Assess receptor chain quality
ir.tl.chain_qc(mdata)

# Adds to obs:
# - receptor_type: "TCR", "BCR", "ambiguous", "no IR"
# - receptor_subtype: "TRA+TRB", "TRG+TRD", "IGH+IGL", "IGH+IGK", etc.
# - chain_pairing: "single pair", "extra VJ", "extra VDJ",
#   "two full chains", "multichain", "orphan VJ", "orphan VDJ", "ambiguous", "no IR"

print(mdata.obs["airr:chain_pairing"].value_counts())
print(mdata.obs["airr:receptor_type"].value_counts())

# Filter problematic cells
# Remove multichain (likely doublets) and ambiguous
mdata = mdata[
    ~mdata.obs["airr:chain_pairing"].isin(["multichain", "ambiguous"])
].copy()
```

## Clonotype Definition (ir.tl)

### Define Clonotypes

```python
# Strict: CDR3 nucleotide sequence identity
ir.pp.ir_dist(mdata)
ir.tl.define_clonotypes(mdata, receptor_arms="all", dual_ir="primary_only")
# Adds: mdata.obs["clone_id"], mdata.obs["clone_id_size"]

# Parameters:
# receptor_arms: "VJ", "VDJ", "all" (both chains must match), "any" (either chain)
# dual_ir: "primary_only", "any", "all"
# same_v_gene: True to also require V-gene match
# within_group: "receptor_type" (default) to only cluster within TCR/BCR

# Relaxed: amino acid sequence similarity clustering
ir.pp.ir_dist(mdata, sequence="aa", metric="alignment")
ir.tl.define_clonotype_clusters(
    mdata,
    sequence="aa",
    metric="alignment",
    receptor_arms="all",
    dual_ir="primary_only",
    key_added="clone_id_aa",
)
```

## Clonal Expansion Analysis

### Categorize Expansion

```python
# Categorize cells by clonotype size
ir.tl.clonal_expansion(
    mdata,
    target_col="clone_id",
    breakpoints=(1, 2, 5),  # Categories: "<= 1", "<= 2", "<= 5", "> 5"
)
# Adds: mdata.obs["airr:clonal_expansion"]

print(mdata.obs["airr:clonal_expansion"].value_counts())
# <= 1     1850
# <= 2      234
# <= 5      156
# > 5       108

# Calculate proportion of expanded cells
expanded = (mdata.obs["airr:clonal_expansion"] != "<= 1").mean()
print(f"{expanded:.1%} of cells are clonally expanded")
```

### Visualize Expansion

```python
# Bar plot: expansion per cluster (normalized)
ir.pl.clonal_expansion(
    mdata,
    groupby="gex:cell_type",
    target_col="clone_id",
    breakpoints=(1, 2, 5),
    normalize=True,
)

# Absolute counts
ir.pl.clonal_expansion(mdata, groupby="gex:cell_type", normalize=False)
```

## Diversity Metrics

### Alpha Diversity

```python
# Shannon entropy per group (normalized to 0-1)
diversity = ir.tl.alpha_diversity(
    mdata,
    groupby="gex:cell_type",
    target_col="clone_id",
    metric="normalized_shannon_entropy",
    inplace=False,
)
print(diversity)

# Other metrics: "D50", "DXX"
# D50: minimum number of clonotypes accounting for 50% of cells
ir.tl.alpha_diversity(mdata, groupby="gex:sample", metric="D50")
```

### Repertoire Overlap

```python
# Pairwise repertoire overlap between groups
ir.tl.repertoire_overlap(
    mdata,
    groupby="gex:sample",
    target_col="clone_id",
    overlap_measure="jaccard",  # scipy.spatial.distance metrics
)
# Stores: mdata.uns["repertoire_overlap"] with distance matrix and linkage

# Visualize overlap heatmap
ir.pl.repertoire_overlap(
    mdata,
    groupby="gex:sample",
    heatmap_cats=["gex:condition"],
)

# Scatter plot comparing two samples
ir.pl.repertoire_overlap(
    mdata,
    groupby="gex:sample",
    pair_to_plot=["sample_A", "sample_B"],
)
```

## Additional Analyses

```python
# Clonotype imbalance between groups
ir.tl.clonotype_imbalance(mdata, replicate_col="sample", groupby="condition")

# Clonotype modularity (transcriptional relatedness within clonotypes)
ir.tl.clonotype_modularity(mdata, target_col="clone_id")

# V(D)J gene usage
ir.tl.group_abundance(mdata, groupby="gex:cell_type", target_col="airr:v_call")
ir.pl.group_abundance(mdata, groupby="gex:cell_type", target_col="airr:v_call")

# Spectratype (CDR3 length distribution)
ir.pl.spectratype(mdata, groupby="gex:cell_type", target_col="clone_id")
```

## Standard Workflow

```python
import scirpy as ir
import scanpy as sc
from mudata import MuData

# 1. Load data
adata_tcr = ir.io.read_10x_vdj("filtered_contig_annotations.csv")
adata_gex = sc.read_10x_h5("filtered_feature_bc_matrix.h5")
adata_gex.var_names_make_unique()
mdata = MuData({"gex": adata_gex, "airr": adata_tcr})

# 2. Preprocess GEX
sc.pp.normalize_total(mdata["gex"], target_sum=1e4)
sc.pp.log1p(mdata["gex"])
sc.pp.pca(mdata["gex"])
sc.pp.neighbors(mdata["gex"])
sc.tl.umap(mdata["gex"])

# 3. Index chains and QC
ir.pp.index_chains(mdata)
ir.tl.chain_qc(mdata)
mdata = mdata[~mdata.obs["airr:chain_pairing"].isin(["multichain", "ambiguous"])].copy()

# 4. Define clonotypes
ir.pp.ir_dist(mdata)
ir.tl.define_clonotypes(mdata, receptor_arms="all", dual_ir="primary_only")

# 5. Analyze expansion and diversity
ir.tl.clonal_expansion(mdata, breakpoints=(1, 2, 5))
ir.tl.alpha_diversity(mdata, groupby="gex:cell_type", metric="normalized_shannon_entropy")
ir.tl.repertoire_overlap(mdata, groupby="gex:sample")

# 6. Visualize
ir.pl.clonal_expansion(mdata, groupby="gex:cell_type", normalize=True)
ir.pl.repertoire_overlap(mdata, groupby="gex:sample")
```

## Gotchas

- **MuData convention**: Gene expression goes in `"gex"` modality, immune receptors
  in `"airr"`. Access cross-modality columns with prefix: `"gex:cell_type"`,
  `"airr:receptor_type"`.
- **index_chains first**: Must call `ir.pp.index_chains()` before any analysis.
  It selects primary/secondary chains and filters non-productive chains.
- **ir_dist before clonotypes**: `ir.pp.ir_dist()` must be called before
  `ir.tl.define_clonotypes()` or `ir.tl.define_clonotype_clusters()`.
- **Multichain cells**: Cells with >2 VJ or >2 VDJ chains are likely doublets.
  Filter them after `chain_qc()`.
- **Orphan chains**: Cells with only VJ or only VDJ chain can still be included
  in clonotype analysis using `receptor_arms="any"`.
- **Clonotype stringency**: `define_clonotypes` (nucleotide identity) is stricter
  than `define_clonotype_clusters` (sequence similarity). Use the latter for
  grouping functionally similar receptors.
- **Memory with ir_dist**: Pairwise distance computation can be memory-intensive
  for large datasets. Use `n_jobs=-1` for parallelization.
