# pertpy API Reference

Perturbation analysis toolkit for single-cell data. Covers cell type
prioritization (Augur), distance-based comparisons (DistanceTest),
compositional analysis (scCODA), and differential abundance (Milo).

## Augur (Cell Type Prioritization)

Ranks cell types by their response to experimental perturbations using a
classification-based approach.

### Basic Usage

```python
import pertpy as pt

# Load example data (or use your own AnnData)
adata = pt.dt.sc_sim_augur()

# Initialize with classifier
ag = pt.tl.Augur(estimator="random_forest_classifier")
# Other options: "logistic_regression"

# Load data (sets condition and treatment labels)
adata = ag.load(adata)

# Predict cell type prioritization
adata, results = ag.predict(adata)

# View prioritization scores per cell type (higher = more responsive)
print(results["summary_metrics"])
# Returns DataFrame with mean_augur_score per cell type
```

### With Custom Conditions

```python
ag = pt.tl.Augur("random_forest_classifier")

# Specify condition label and treatment group
adata_loaded = ag.load(
    adata,
    condition_label="condition",      # Column in obs with condition info
    treatment_label="stimulated",     # Value in condition_label for treatment
)

adata_result, results = ag.predict(
    adata_loaded,
    random_state=42,
    n_threads=4,
)

# Sort cell types by responsiveness
scores = results["summary_metrics"].loc["mean_augur_score"]
print(scores.sort_values(ascending=False))
```

### Differential Prioritization (Comparing Conditions)

```python
ag = pt.tl.Augur("random_forest_classifier")

# Condition 1
adata_c1 = ag.load(adata, condition_label="status", treatment_label="condition_A")
_, results_c1 = ag.predict(adata_c1)
_, perm_c1 = ag.predict(adata_c1, augur_mode="permute", n_subsamples=100)

# Condition 2
adata_c2 = ag.load(adata, condition_label="status", treatment_label="condition_B")
_, results_c2 = ag.predict(adata_c2)
_, perm_c2 = ag.predict(adata_c2, augur_mode="permute", n_subsamples=100)

# Compare conditions
pvals = ag.predict_differential_prioritization(
    augur_results1=results_c1,
    augur_results2=results_c2,
    permuted_results1=perm_c1,
    permuted_results2=perm_c2,
    n_subsamples=50,
    n_permutations=1000,
)
print(pvals)
```

## DistanceTest (Perturbation Distances)

Computes and tests distances between conditions at the single-cell level.

```python
import pertpy as pt

# Initialize
distance = pt.tl.Distance(metric="euclidean")
# Other metrics: "cosine", "wasserstein", "edistance", "mmd"

# Compute pairwise distances between groups
distances = distance.pairwise(
    adata,
    groupby="cell_type",
    use_rep="X_pca",  # Representation to use
)

# Statistical testing
dt = pt.tl.DistanceTest(
    metric="euclidean",
    n_perms=1000,
)

# Test for significant differences
results = dt.test(
    adata,
    groupby="cell_type",
    contrast="condition",     # Column with condition labels
    use_rep="X_pca",
)
# Returns DataFrame with p-values per cell type
```

## scCODA (Compositional Analysis)

Bayesian model for differential cell type composition analysis. Identifies
cell types with significantly altered proportions between conditions.

### Standard Workflow

```python
import pertpy as pt

# Initialize scCODA
sccoda = pt.tl.Sccoda()

# Load data (cell-level AnnData -> sample-level counts)
mdata = sccoda.load(
    adata,
    type="cell_level",
    generate_sample_level=True,
    cell_type_identifier="cell_type",  # Column with cell type labels
    sample_identifier="sample_id",      # Column with sample IDs
    covariate_obs=["condition"],         # Covariates to include
)

# Prepare model
mdata = sccoda.prepare(
    mdata,
    modality_key="coda",
    formula="condition",                # Design formula
    reference_cell_type="automatic",    # Or specify: "B cells"
    automatic_reference_absence_threshold=0.1,
)

# Run MCMC inference
sccoda.run_nuts(
    mdata,
    num_warmup=100,
    num_samples=1000,
    rng_key=42,
)
# Alternative: sccoda.run_hmc(mdata, num_warmup=100, num_samples=1000)

# View results
sccoda.summary(mdata)

# Get credible effects (significant changes)
effects = sccoda.credible_effects(mdata, modality_key="coda")
print(effects)

# Get effect sizes
effect_df = sccoda.get_effect_df(mdata, modality_key="coda")
```

### Visualization

```python
# Stacked barplot of cell type proportions
sccoda.plot_stacked_barplot(mdata, modality_key="coda", feature_name="condition")

# Effect size barplot
sccoda.plot_effects_barplot(mdata, modality_key="coda")

# Boxplots of cell type proportions
sccoda.plot_boxplots(mdata, modality_key="coda", feature_name="condition")
```

### Setting FDR

```python
# Adjust credibility level (default: 0.05)
sccoda.set_fdr(mdata, est_fdr=0.1, modality_key="coda")
sccoda.credible_effects(mdata, modality_key="coda")
```

## Milo (Differential Abundance)

Neighborhood-level differential abundance testing. Detects localized changes
in cell type abundance without requiring discrete cell type labels.

```python
import pertpy as pt
import scanpy as sc

# Initialize Milo
milo = pt.tl.Milo()

# Load data into MuData format
mdata = milo.load(adata)

# Compute neighbors on expression data
sc.pp.neighbors(mdata["rna"], use_rep="X_pca", n_neighbors=150)

# Build neighborhoods
milo.make_nhoods(mdata["rna"], prop=0.1)

# Count cells per neighborhood per sample
mdata = milo.count_nhoods(mdata, sample_col="sample_id")

# Differential abundance test
milo.da_nhoods(mdata, design="~condition")

# With complex design
milo.da_nhoods(mdata, design="~site + condition", model_contrasts="conditionTreated")

# Annotate neighborhoods with cell types
milo.annotate_nhoods(mdata, anno_col="cell_type")

# Visualize
milo.plot_da_beeswarm(mdata)
milo.plot_nhood_graph(mdata, alpha=0.1)
```

## Other Tools

```python
# Available perturbation analysis tools
pt.tl.Mixscape()       # CRISPR perturbation analysis (Mixscape)
pt.tl.Scgen()          # Perturbation response prediction
pt.tl.Dialogue()       # Multi-cellular program identification
pt.tl.Cinemaot()       # Causal perturbation effect estimation
pt.tl.Enrichment()     # Gene set enrichment
pt.tl.PyDESeq2()       # Differential expression (DESeq2)
pt.tl.EdgeR()          # Differential expression (edgeR)
```

## Gotchas

- **Augur data requirements**: Needs at least two conditions in the specified
  `condition_label` column. Cell type column must be categorical with multiple types.
- **Augur interpreation**: Higher augur_score means more responsive to perturbation,
  not necessarily up- or down-regulated. It measures predictability of condition
  from expression within each cell type.
- **scCODA reference cell type**: One cell type serves as the compositional reference.
  Use `"automatic"` to let scCODA choose, or specify a cell type expected to be
  unchanged across conditions.
- **scCODA sample size**: Requires multiple biological replicates per condition.
  Minimum 3 samples per group is recommended for meaningful inference.
- **Milo neighbors**: Use more neighbors (100-150) than typical scanpy defaults (15)
  for Milo neighborhood construction.
- **Milo design formula**: Follows R-style formula syntax. Include covariates that
  may confound the comparison (e.g., `~site + condition`).
- **DistanceTest representation**: Use an appropriate reduced representation
  (`X_pca`, `X_scVI`) rather than full gene expression for distance computations.
- **Memory**: scCODA MCMC can be memory-intensive. For large datasets, subsample
  or use pseudobulk counts.
