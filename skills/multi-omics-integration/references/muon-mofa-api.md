# MOFA+ via muon / mofapy2 API Reference

Multi-Omics Factor Analysis for unsupervised integration of multi-modal data. Learns shared and modality-specific latent factors.

## Via muon (Recommended Wrapper)

```python
import muon as mu
import scanpy as sc
from muon import MuData
from anndata import AnnData

# Create MuData from separate AnnData objects
mdata = MuData({
    'rna': adata_rna,               # AnnData: cells x genes
    'atac': adata_atac              # AnnData: cells x peaks
})

# Ensure common observations across modalities
mu.pp.intersect_obs(mdata)

# Run MOFA
mu.tl.mofa(
    mdata,
    n_factors=15,                   # number of latent factors to learn
    use_var='highly_variable',      # only use HVGs/HVPs (column in .var)
    use_obs='intersection',         # use cells present in all modalities
    n_iterations=1000,
    convergence_mode='fast',        # 'fast' or 'slow' (more accurate)
    seed=42,
    save_data=True,
    outfile='mofa_model.hdf5'       # save trained model to file
)
```

## Accessing MOFA Results

```python
# Cell embeddings (factor scores)
factors = mdata.obsm['X_mofa']               # ndarray: (n_cells, n_factors)

# Feature loadings (weights)
loadings = mdata.varm['LFs']                  # ndarray: (n_features, n_factors)

# Variance explained per factor per modality
variance_info = mdata.uns['mofa']['variance']
# variance_info['r2_per_factor']  - DataFrame: factor, view, value

# Per-modality loadings
rna_loadings = mdata['rna'].varm['LFs']       # (n_genes, n_factors)
atac_loadings = mdata['atac'].varm['LFs']     # (n_peaks, n_factors)
```

## Downstream Analysis with Factors

```python
import scanpy as sc

# Use MOFA factors for UMAP/neighbors
sc.pp.neighbors(mdata, use_rep='X_mofa', n_neighbors=15)
sc.tl.umap(mdata)
sc.tl.leiden(mdata, resolution=0.5, key_added='leiden')

# Visualize
mu.pl.umap(mdata, color=['leiden'])
mu.pl.mofa(mdata, color='leiden')             # MOFA factor scatter

# Correlate factors with metadata
import pandas as pd
import numpy as np
factor_df = pd.DataFrame(
    mdata.obsm['X_mofa'],
    columns=[f'Factor{i+1}' for i in range(mdata.obsm['X_mofa'].shape[1])],
    index=mdata.obs_names
)
factor_df = pd.concat([factor_df, mdata.obs], axis=1)
```

## Variance Explained Analysis

```python
import pandas as pd
import matplotlib.pyplot as plt

# Extract variance explained
var_df = pd.DataFrame(mdata.uns['mofa']['variance']['r2_per_factor'])
# Columns: group, factor, value, view

# Plot variance per factor per modality
pivot = var_df.pivot_table(index='factor', columns='view', values='value')
pivot.plot(kind='bar', figsize=(10, 5))
plt.ylabel('Variance Explained (R2)')
plt.title('MOFA Variance Explained per Factor')
plt.tight_layout()
plt.savefig('mofa_variance.png', dpi=150)
plt.close()
```

## Top Feature Weights per Factor

```python
import numpy as np
import pandas as pd

def get_top_weights(mdata, modality, factor_idx, n_top=20):
    """Get top features by absolute loading for a given factor."""
    loadings = mdata[modality].varm['LFs'][:, factor_idx]
    feature_names = mdata[modality].var_names
    weight_df = pd.DataFrame({
        'feature': feature_names,
        'weight': loadings,
        'abs_weight': np.abs(loadings)
    }).sort_values('abs_weight', ascending=False).head(n_top)
    return weight_df

# Top genes driving Factor 1
top_genes = get_top_weights(mdata, 'rna', factor_idx=0, n_top=20)
print(top_genes)
```

## Direct mofapy2 Usage (Without muon)

```python
from mofapy2.run.entry_point import entry_point
import pandas as pd
import numpy as np

# Initialize entry point
ent = entry_point()

# Prepare data as list of DataFrames (long format)
# Columns: sample, feature, value, view, group
data_list = []
for view_name, df in [('rna', rna_df), ('protein', prot_df)]:
    melted = df.reset_index().melt(id_vars='index', var_name='feature', value_name='value')
    melted.rename(columns={'index': 'sample'}, inplace=True)
    melted['view'] = view_name
    melted['group'] = 'group1'
    data_list.append(melted)

data_long = pd.concat(data_list)
ent.set_data_df(data_long)

# Set model options
ent.set_model_options(factors=10, spikeslab_weights=True, ard_weights=True)

# Set training options
ent.set_train_options(
    iter=1000,
    convergence_mode='fast',
    seed=42,
    gpu_mode=False,
    verbose=False
)

# Build and run
ent.build()
ent.run()

# Save
ent.save('mofa_model.hdf5')

# Access results
factors = ent.model.getExpectations()['Z']['group1']   # (n_samples, n_factors)
weights = ent.model.getExpectations()['W']              # dict: view -> (n_features, n_factors)
```

## Loading a Saved MOFA Model

```python
from mofapy2.run.entry_point import entry_point

# Load and inspect
ent = entry_point()
ent.load('mofa_model.hdf5')

# Or via muon
import muon as mu
mdata = mu.read('processed_data.h5mu')
# MOFA results already stored in mdata.obsm['X_mofa'], mdata.varm['LFs'], mdata.uns['mofa']
```

## Complete Workflow Example

```python
import muon as mu
import scanpy as sc
import matplotlib.pyplot as plt
import pandas as pd

# 1. Load multimodal data
mdata = mu.read_10x_h5('filtered_feature_bc_matrix.h5')

# 2. Preprocess each modality
rna = mdata.mod['rna']
sc.pp.normalize_total(rna, target_sum=1e4)
sc.pp.log1p(rna)
sc.pp.highly_variable_genes(rna, n_top_genes=3000)

# 3. Intersect observations
mu.pp.intersect_obs(mdata)

# 4. Run MOFA
mu.tl.mofa(mdata, n_factors=15, use_var='highly_variable', outfile='mofa.hdf5')

# 5. Downstream clustering
sc.pp.neighbors(mdata, use_rep='X_mofa', n_neighbors=15)
sc.tl.umap(mdata)
sc.tl.leiden(mdata, resolution=0.5)

# 6. Visualize
fig, axes = plt.subplots(1, 2, figsize=(14, 5))
sc.pl.umap(mdata, color='leiden', ax=axes[0], show=False)
axes[0].set_title('MOFA UMAP - Leiden Clusters')

# Variance explained
var_df = pd.DataFrame(mdata.uns['mofa']['variance']['r2_per_factor'])
pivot = var_df.pivot_table(index='factor', columns='view', values='value')
pivot.plot(kind='bar', ax=axes[1])
axes[1].set_title('Variance Explained per Factor')
plt.tight_layout()
plt.savefig('mofa_results.png', dpi=150)
plt.close()

mdata.write('processed_multiome.h5mu')
```

## Gotchas

- `mu.tl.mofa()` requires `mofapy2` installed as a dependency. Install with `pip install mofapy2`.
- `use_var='highly_variable'` requires a boolean column named `highly_variable` in each modality's `.var`. Run `sc.pp.highly_variable_genes()` first.
- `use_obs='intersection'` uses only cells present in all modalities. With `'union'`, missing modality values are imputed as NaN.
- `outfile` is required to save the MOFA model for later inspection. Without it, the model object is discarded after factor extraction.
- MOFA factors are not ordered by variance explained by default -- sort by total R2 when reporting.
- Data should be scaled/normalized per modality before running MOFA. Log-transformed counts for RNA, TF-IDF for ATAC.
- For direct mofapy2 usage, data must be in long-format DataFrame with columns: `sample`, `feature`, `value`, `view`, `group`.
- GPU mode (`gpu_mode=True`) requires CuPy and compatible CUDA setup.
- Large datasets: subsample cells or use highly variable features to keep runtime manageable.
