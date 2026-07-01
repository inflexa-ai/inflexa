# DEP (Differential Enrichment analysis of Proteomics data) via rpy2

R package for integrated differential proteomics analysis. Accepts tabular output from MaxQuant, IsobarQuant, or similar quantitative proteomics pipelines.

## rpy2 Setup

```python
import pandas as pd
import numpy as np
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri
from rpy2.robjects.packages import importr
from rpy2.robjects.conversion import localconverter

dep = importr("DEP")
se_pkg = importr("SummarizedExperiment")
base = importr("base")

converter = ro.default_converter + pandas2ri.converter
```

## make_se / make_se_parse -- Create SummarizedExperiment

`make_se(proteins_unique, columns, expdesign)` builds a SummarizedExperiment from a data.frame of unique proteins, integer column indices pointing to intensity columns, and an experimental design data.frame.

`make_se_parse(proteins_unique, columns)` infers the experimental design by parsing column names (expects `{condition}_{replicate}` pattern).

```python
with localconverter(converter):
    proteins_df = ro.conversion.get_conversion().py2rpy(proteins_pd)

# Identify LFQ intensity columns (1-indexed in R)
columns = base.grep("LFQ.intensity.", base.colnames(proteins_df))

# Experimental design: must have columns 'label', 'condition', 'replicate'
# 'label' values must exactly match the intensity column names
exp_design_pd = pd.DataFrame({
    "label":     ["LFQ.intensity.S1", "LFQ.intensity.S2", "LFQ.intensity.S3",
                  "LFQ.intensity.S4", "LFQ.intensity.S5", "LFQ.intensity.S6"],
    "condition": ["Control", "Control", "Control", "Treated", "Treated", "Treated"],
    "replicate": [1, 2, 3, 1, 2, 3],
})

with localconverter(converter):
    exp_design = ro.conversion.get_conversion().py2rpy(exp_design_pd)
    se = dep.make_se(proteins_df, columns, exp_design)

# Alternative: parse condition/replicate from column names
# Column names must follow pattern: {condition}_{replicate}
# se = dep.make_se_parse(proteins_df, columns)
```

**Gotcha**: `make_se` requires gene names to be unique. Run `make_unique(proteins, "Gene.names", "Protein.IDs")` first. Missing gene names are filled from protein IDs.

```python
proteins_unique = dep.make_unique(proteins_df, ro.StrVector(["Gene.names"]),
                                  ro.StrVector(["Protein.IDs"]), delim=";")
```

## filter_missval -- Missing Value Filtering

`filter_missval(se, thr=0)` removes proteins with more than `thr` missing values in any condition.

```python
# Keep proteins with at most 1 missing value per condition
filt = dep.filter_missval(se, thr=1)

# Stricter: require complete cases (no missing values)
filt_strict = dep.filter_missval(se, thr=0)
```

**Gotcha**: Filter *before* normalization and imputation. Filtering after imputation defeats the purpose.

## normalize_vsn -- Variance Stabilizing Normalization

`normalize_vsn(se)` applies variance stabilizing transformation via the vsn package. Returns a SummarizedExperiment with vsn-normalized log2 values.

```python
norm = dep.normalize_vsn(filt)

# Verify normalization with meanSdPlot
dep.plot_normalization(filt, norm)  # before/after comparison
```

## impute -- Missing Value Imputation

`impute(se, fun)` imputes remaining missing values. Methods:

| Method | Type | Best for |
|--------|------|----------|
| `"MinProb"` | Left-censored | MNAR (low-abundance missingness) |
| `"knn"` | Local similarity | MCAR (random dropout) |
| `"MLE"` | Global structure | MCAR with sufficient data |
| `"QRILC"` | Left-censored | MNAR, small sample sizes |
| `"man"` | Manual | Custom shift/scale |
| `"mixed"` | Hybrid | Mixed MNAR + MCAR |
| `"zero"` | Constant | Replace with zero |

```python
# MinProb (recommended for MNAR): draws from left-shifted Gaussian
# q=0.01 sets the quantile for centering the distribution
imp = dep.impute(norm, fun="MinProb", q=0.01)

# kNN imputation (for MCAR patterns)
imp = dep.impute(norm, fun="knn", rowmax=0.9)

# MLE via EM algorithm
imp = dep.impute(norm, fun="MLE")

# Mixed: MinProb for MNAR, kNN for MCAR
# randna=TRUE assigns MNAR/MCAR per protein automatically
imp = dep.impute(norm, fun="mixed",
                 randna=True, mar="knn", mnar="MinProb")
```

**Gotcha**: `MinProb` draws random values -- set `base.set_seed(42)` before calling for reproducibility.

## test_diff -- Differential Testing

`test_diff(se, type, control, fdr.type)` performs limma-based differential testing.

```python
# type="control": compare all conditions against a single control
diff = dep.test_diff(imp, type="control", control="Control")

# type="all": all pairwise comparisons
diff = dep.test_diff(imp, type="all")

# type="manual": custom contrast
# contrast_vec must be a valid limma contrast string
diff = dep.test_diff(imp, type="manual",
                     test=ro.StrVector(["Treated_vs_Control"]))

# Apply significance thresholds
dep_result = dep.add_rejections(diff, alpha=0.05, lfc=1.0)
```

**Parameters**: `fdr.type` controls p-value adjustment (`"BH"` default, Benjamini-Hochberg).

## plot_volcano -- Visualization

```python
# Volcano plot for a specific contrast
dep.plot_volcano(dep_result, contrast="Treated_vs_Control",
                 label_size=3, add_names=True)

# Additional useful plots
dep.plot_pca(norm, x=1, y=2, point_size=3)          # PCA
dep.plot_heatmap(dep_result, type="centered",         # heatmap of DE proteins
                 kmeans=True, k=6, col_limit=4)
dep.plot_cond(dep_result)                             # per-condition summary
```

## Extract Results to pandas

```python
with localconverter(converter):
    # Get results table
    results_r = se_pkg.rowData(dep_result)
    results_df = ro.conversion.get_conversion().rpy2py(base.as_data_frame(results_r))

# Key columns in results_df:
# - {contrast}_diff      : log2 fold change
# - {contrast}_p.val     : raw p-value
# - {contrast}_p.adj     : adjusted p-value (BH)
# - {contrast}_significant: TRUE/FALSE at chosen alpha + lfc
```

## Complete Workflow

```python
# 1. Load and deduplicate
proteins_unique = dep.make_unique(proteins_df, "Gene.names", "Protein.IDs", delim=";")

# 2. Create SummarizedExperiment
se = dep.make_se(proteins_unique, columns, exp_design)

# 3. Filter missing values
filt = dep.filter_missval(se, thr=1)

# 4. Normalize
norm = dep.normalize_vsn(filt)

# 5. Impute
base.set_seed(42)
imp = dep.impute(norm, fun="MinProb", q=0.01)

# 6. Differential test
diff = dep.test_diff(imp, type="control", control="Control")
dep_result = dep.add_rejections(diff, alpha=0.05, lfc=1.0)

# 7. Extract and save
with localconverter(converter):
    results = ro.conversion.get_conversion().rpy2py(
        base.as_data_frame(se_pkg.rowData(dep_result))
    )
results.to_csv("output/dep_results.csv", index=False)
```

## Version Notes

- DEP >= 1.24 (Bioconductor 3.20+): current API as documented above.
- `make_se` intensity columns are auto-log2 transformed. Do not pre-transform.
- VSN normalization requires the `vsn` Bioconductor package as a dependency.
