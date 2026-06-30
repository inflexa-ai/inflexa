# LIANA+ API Reference

Cell-cell communication analysis framework. Aggregates multiple methods and
resources for ligand-receptor interaction inference from single-cell data.
Supports multi-condition analysis and tensor decomposition.

## Basic Ligand-Receptor Analysis

### Rank Aggregate (Core Function)

```python
import liana as li

# Run LIANA rank aggregate on AnnData with cell type labels
li.mt.rank_aggregate(
    adata,
    groupby="cell_type",       # Column in obs with cell identity labels
    resource_name="consensus",  # Ligand-receptor resource (see below)
    expr_prop=0.1,             # Min proportion of cells expressing the gene
    min_cells=5,               # Min cells per group to consider
    use_raw=True,              # Use adata.raw for expression
    verbose=True,
)

# Results stored in adata.uns["liana_res"] as a DataFrame
liana_results = adata.uns["liana_res"]
print(liana_results.head())
# Columns: source, target, ligand_complex, receptor_complex, ...
# Plus scores from each method and aggregate ranks
```

### Choosing Methods

```python
# Specify which methods to aggregate
li.mt.rank_aggregate(
    adata,
    groupby="cell_type",
    methods=["cellphonedb", "natmi", "connectome", "logfc", "sca"],
    resource_name="consensus",
)

# Run a single method directly
li.mt.cellphonedb(adata, groupby="cell_type", resource_name="CellPhoneDB")
li.mt.natmi(adata, groupby="cell_type")
li.mt.connectome(adata, groupby="cell_type")
li.mt.singlecellsignalr(adata, groupby="cell_type")
li.mt.geometric_mean(adata, groupby="cell_type")
```

### Available Resources

```python
# List available resources
li.resource.show_resources()

# Key resources:
# "consensus"    - LIANA's curated consensus resource (default, recommended)
# "CellPhoneDB"  - CellPhoneDB ligand-receptor pairs
# "CellChatDB"   - CellChat database
# "ICELLNET"     - ICELLNET resource
# "Baccin2019"   - Bone marrow niche interactions
# "Ramilowski2015" - Literature-curated interactions
# "MouseConsensus" - Mouse-specific consensus

# Select a specific resource
li.mt.rank_aggregate(
    adata,
    groupby="cell_type",
    resource_name="CellPhoneDB",
)

# Use a custom resource (DataFrame with source, target, ligand, receptor columns)
custom_resource = li.resource.select_resource("CellPhoneDB")
# Filter or modify as needed
li.mt.rank_aggregate(
    adata,
    groupby="cell_type",
    resource=custom_resource,
)
```

## Result Interpretation

```python
liana_results = adata.uns["liana_res"]

# Key columns in the result DataFrame:
# - source: sender cell type
# - target: receiver cell type
# - ligand_complex: ligand gene(s)
# - receptor_complex: receptor gene(s)
# - magnitude_rank: aggregate rank by interaction magnitude (lower = stronger)
# - specificity_rank: aggregate rank by interaction specificity (lower = more specific)
# - [method]_score: individual method scores

# Filter top interactions
top_interactions = liana_results[liana_results["magnitude_rank"] <= 0.01]

# Filter by specific cell types
t_to_b = liana_results[
    (liana_results["source"] == "T cells") &
    (liana_results["target"] == "B cells")
].sort_values("magnitude_rank")
```

## Visualization

```python
# Dotplot of top interactions
li.pl.dotplot(
    adata=adata,
    colour="magnitude_rank",
    size="specificity_rank",
    inverse_colour=True,   # Lower rank = darker color
    inverse_size=True,     # Lower rank = larger dot
    source_labels=["T cells", "NK cells"],
    target_labels=["B cells", "Monocytes"],
    top_n=20,
)

# Chord diagram
li.pl.connectivity(
    adata,
    score_key="magnitude_rank",
)
```

## Multi-Condition Analysis (LIANA+)

### Multi-Sample, Multi-Condition

```python
# Requires sample and condition columns in obs
li.mt.rank_aggregate(
    adata,
    groupby="cell_type",
    resource_name="consensus",
    sample_key="sample_id",    # Per-sample analysis
)
```

### Tensor Decomposition (Multi-Context)

```python
# Tensor decomposition for multi-condition ligand-receptor analysis
# Decomposes interactions across conditions/samples into factors

# Step 1: Build tensor from per-sample LIANA results
tensor = li.multi.to_tensor_c2c(
    adata,
    groupby="cell_type",
    sample_key="sample_id",
    score_key="magnitude_rank",
    how="outer",  # Handle missing values
)

# Step 2: Decompose
tensor_res = li.multi.decompose_tensor(
    tensor,
    rank=5,         # Number of factors to extract
    random_state=42,
)

# Step 3: Visualize factors
li.pl.tensor_factor(
    tensor_res,
    factor_idx=0,
    top_n=10,
)
```

## Standard Workflow

```python
import scanpy as sc
import liana as li

# 1. Load and preprocess
adata = sc.read_h5ad("annotated_data.h5ad")
# Ensure adata has: cell type labels, normalized expression, raw counts in .raw

# 2. Run LIANA rank aggregate
li.mt.rank_aggregate(
    adata,
    groupby="cell_type",
    resource_name="consensus",
    expr_prop=0.1,
    use_raw=True,
    verbose=True,
)

# 3. Examine results
results = adata.uns["liana_res"]
top = results.sort_values("magnitude_rank").head(50)
print(top[["source", "target", "ligand_complex", "receptor_complex", "magnitude_rank"]])

# 4. Visualize
li.pl.dotplot(
    adata=adata,
    colour="magnitude_rank",
    size="specificity_rank",
    inverse_colour=True,
    inverse_size=True,
    top_n=30,
)
```

## Gotchas

- **Cell type labels required**: `groupby` must point to a categorical column with
  cell type annotations. Fine-grained annotations yield more specific interactions.
- **Raw counts**: Set `use_raw=True` (default) to use `adata.raw` for expression.
  Some methods need normalized data; LIANA handles this internally.
- **expr_prop filtering**: The `expr_prop` parameter filters interactions where fewer
  than this fraction of cells express the gene. Too strict filtering (>0.2) can
  miss real but sparse interactions.
- **Resource choice**: `"consensus"` is recommended as it merges curated interactions
  from multiple databases. Use specific resources (CellPhoneDB, CellChatDB) for
  comparisons with published results.
- **Aggregate ranks**: `magnitude_rank` and `specificity_rank` range from 0 to 1.
  Lower is stronger/more specific. These are more robust than individual method scores.
- **Multi-condition**: For tensor decomposition, you need multiple samples per
  condition. Single-sample designs cannot leverage this feature.
- **Complex ligand-receptor pairs**: Some interactions involve multi-subunit
  complexes (e.g., "COL1A1_COL1A2"). LIANA handles these using minimum or
  geometric mean of subunit expression.
