# mixOmics via rpy2 API Reference

R-based multi-omics integration package accessed from Python via rpy2. Specializes in supervised and unsupervised multivariate projection methods for omics data.

## rpy2 Setup

```python
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri, numpy2ri
from rpy2.robjects.packages import importr

pandas2ri.activate()
numpy2ri.activate()

mixomics = importr('mixOmics')
base = importr('base')
grdevices = importr('grDevices')
```

## Data Preparation

```python
import numpy as np
import pandas as pd
from rpy2.robjects import r, FloatVector, StrVector
from rpy2.robjects import pandas2ri

# Convert pandas DataFrames to R matrices
def df_to_r_matrix(df):
    """Convert pandas DataFrame to R matrix with row/col names."""
    r_mat = pandas2ri.py2rpy(df)
    return r_mat

# Prepare data blocks (each omics as a matrix: samples x features)
rna_r = df_to_r_matrix(rna_df)      # samples x genes
prot_r = df_to_r_matrix(prot_df)    # samples x proteins
metab_r = df_to_r_matrix(metab_df)  # samples x metabolites

# Create named list of data blocks for DIABLO
data_blocks = ro.ListVector({
    'mRNA': rna_r,
    'proteomics': prot_r,
    'metabolomics': metab_r
})

# Response vector (factor for classification)
y_r = ro.FactorVector(y_labels)
```

## sPLS-DA (Single-Omics Supervised)

```python
# Sparse PLS-DA for single-omics classification
splsda_result = mixomics.splsda(
    X=rna_r,
    Y=y_r,
    ncomp=3,                        # number of components
    keepX=ro.IntVector([50, 30, 20]) # features to select per component
)

# Tune number of features per component
tune_splsda = mixomics.tune_splsda(
    X=rna_r,
    Y=y_r,
    ncomp=3,
    validation='Mfold',
    folds=5,
    nrepeat=10,
    test_keepX=ro.IntVector([10, 20, 30, 50, 100]),
    measure='BER'                   # balanced error rate
)

# Extract optimal keepX.
# `tune_splsda` here is a Python-side R object; ro.r() evaluates in R's global
# environment, which has never heard of it. Push it across first, or index the
# result directly with .rx2 — do not name it inside an ro.r() string.
optimal_keepX = tune_splsda.rx2('choice.keepX')
```

## DIABLO (block.splsda - Multi-Omics Supervised)

```python
# Design matrix: controls correlation between blocks (0 = no link, 1 = full link)
design = ro.r('''
  design <- matrix(0.1, ncol=3, nrow=3)
  diag(design) <- 0
  colnames(design) <- c("mRNA", "proteomics", "metabolomics")
  rownames(design) <- c("mRNA", "proteomics", "metabolomics")
  design
''')

# Fit DIABLO model
diablo_result = mixomics.block_splsda(
    X=data_blocks,
    Y=y_r,
    ncomp=2,
    keepX=ro.ListVector({
        'mRNA': ro.IntVector([50, 30]),
        'proteomics': ro.IntVector([30, 20]),
        'metabolomics': ro.IntVector([20, 15])
    }),
    design=design
)
```

## Tuning DIABLO

```python
# Tune number of features per block per component
tune_diablo = mixomics.tune_block_splsda(
    X=data_blocks,
    Y=y_r,
    ncomp=2,
    design=design,
    validation='Mfold',
    folds=5,
    nrepeat=10,
    test_keepX=ro.ListVector({
        'mRNA': ro.IntVector([10, 30, 50]),
        'proteomics': ro.IntVector([10, 20, 30]),
        'metabolomics': ro.IntVector([5, 10, 20])
    }),
    measure='BER'
)
```

## MINT.sPLS-DA (Multi-Study Integration)

```python
# Combine multiple studies/batches
mint_result = mixomics.mint_splsda(
    X=combined_expression_r,        # all studies concatenated (samples x features)
    Y=y_all_r,                      # combined labels
    study=ro.FactorVector(study_labels),  # study/batch membership
    ncomp=3,
    keepX=ro.IntVector([50, 30, 20])
)
```

## Visualization

```python
# All plots save to file via grDevices
grdevices = importr('grDevices')

# Sample plot (scores)
grdevices.png('diablo_indiv.png', width=800, height=600, res=150)
mixomics.plotIndiv(
    diablo_result,
    ind_names=False,
    legend=True,
    title=ro.StrVector(['DIABLO Sample Plot'])
)
grdevices.dev_off()

# Loading plot (feature weights per component)
grdevices.png('diablo_loadings.png', width=800, height=800, res=150)
mixomics.plotLoadings(
    diablo_result,
    comp=1,                         # component number
    contrib='max',                  # color by class with max mean value
    method='median'
)
grdevices.dev_off()

# DIABLO diagnostic plot (per-block explained variance)
grdevices.png('diablo_plot.png', width=800, height=600, res=150)
mixomics.plotDiablo(diablo_result, ncomp=1)
grdevices.dev_off()

# Circos plot (cross-block correlations)
grdevices.png('diablo_circos.png', width=800, height=800, res=150)
mixomics.circosPlot(
    diablo_result,
    cutoff=0.7,                     # correlation threshold
    line=True,
    size_labels=0.7
)
grdevices.dev_off()
```

## Extracting Results

```python
# Selected variables per block per component
selected_vars = {}
for block_name in ['mRNA', 'proteomics', 'metabolomics']:
    for comp in [1, 2]:
        vars_r = mixomics.selectVar(diablo_result, block=block_name, comp=comp)
        names = list(ro.r('rownames')(vars_r.rx2('value')))
        loadings = list(vars_r.rx2('value').rx(True, 1))
        selected_vars[f'{block_name}_comp{comp}'] = dict(zip(names, loadings))

# Performance evaluation
perf = mixomics.perf(
    diablo_result,
    validation='Mfold',
    folds=5,
    nrepeat=10
)
# Access error rates — same rule: `perf` is a Python-side object, so index it
# directly rather than naming it in an ro.r() string.
error_rate = perf.rx2('WeightedVote.error.rate')
```

## Complete Workflow Example

```python
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri, numpy2ri
from rpy2.robjects.packages import importr

pandas2ri.activate()
numpy2ri.activate()

mixomics = importr('mixOmics')
grdevices = importr('grDevices')

# 1. Prepare data blocks and response
data_blocks = ro.ListVector({'mRNA': rna_r, 'protein': prot_r})
y_r = ro.FactorVector(labels)

# 2. Design matrix. Build it in one R block and end on the object itself —
#    `diag(.) <- 0` is not valid R (`.` is undefined), and a trailing
#    assignment returns the assigned value invisibly, not the matrix.
design = ro.r('''
  design <- matrix(0.1, ncol=2, nrow=2)
  diag(design) <- 0
  design
''')

# 3. Tune
tune = mixomics.tune_block_splsda(
    X=data_blocks, Y=y_r, ncomp=2, design=design,
    validation='Mfold', folds=5, nrepeat=5,
    test_keepX=ro.ListVector({
        'mRNA': ro.IntVector([20, 50, 100]),
        'protein': ro.IntVector([10, 20, 30])
    })
)

# 4. Fit with tuned parameters
result = mixomics.block_splsda(
    X=data_blocks, Y=y_r, ncomp=2, design=design,
    keepX=tune.rx2('choice.keepX')
)

# 5. Visualize
grdevices.png('sample_plot.png', width=800, height=600, res=150)
mixomics.plotIndiv(result, ind_names=False, legend=True)
grdevices.dev_off()
```

## Gotchas

- All matrices must have matching sample names (rownames) across blocks.
- The `Y` vector must be an R factor (`ro.FactorVector`), not a plain string/integer vector.
- `design` matrix diagonal must be 0; off-diagonal values (0-1) control how strongly blocks are linked.
- rpy2 type conversion: always `activate()` both `pandas2ri` and `numpy2ri` before passing data.
- `tune.block.splsda` is computationally expensive -- reduce `nrepeat` and `test.keepX` grid during development.
- Plot functions write to the active graphics device. Always wrap with `grdevices.png()` / `grdevices.dev_off()`.
- `keepX` must be a `ListVector` of `IntVector` when multiple blocks are used. Length of each `IntVector` must equal `ncomp`.
- For MINT, all studies must have the same feature space (same column names).
