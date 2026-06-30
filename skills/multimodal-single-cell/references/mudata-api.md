# MuData API Reference

Multimodal data container where each modality is an AnnData object. Core data structure for muon and the scverse multimodal ecosystem.

## Import Convention

```python
import mudata as md
from mudata import MuData
from anndata import AnnData
```

## Construction

### From Dictionary of AnnData Objects

```python
import numpy as np
import pandas as pd

n_obs = 1000
obs_names = [f"cell_{i}" for i in range(n_obs)]

rna = AnnData(
    X=np.random.randn(n_obs, 2000).astype(np.float32),
    obs=pd.DataFrame(index=obs_names),
    var=pd.DataFrame(index=[f"gene_{i}" for i in range(2000)])
)

atac = AnnData(
    X=np.random.randn(n_obs, 5000).astype(np.float32),
    obs=pd.DataFrame(index=obs_names),
    var=pd.DataFrame(index=[f"peak_{i}" for i in range(5000)])
)

mdata = MuData({"rna": rna, "atac": atac})
print(mdata)
# MuData object with n_obs x n_vars = 1000 x 7000
#   2 modalities
#     rna:  1000 x 2000
#     atac: 1000 x 5000
```

### Three-Modality (e.g., TEA-seq / DOGMA-seq)

```python
mdata = MuData({
    "rna": rna_adata,
    "adt": adt_adata,
    "atac": atac_adata
})
```

## Modality Access

```python
# Two equivalent ways to access a modality
rna = mdata.mod['rna']   # via .mod dict
rna = mdata['rna']        # shorthand

# List modalities
print(mdata.mod.keys())   # dict_keys(['rna', 'atac'])
print(mdata.mod_names)    # ['rna', 'atac']
print(mdata.n_mod)        # 2
```

## .obs and .var Alignment

MuData maintains a global `.obs` (cells) and `.var` (features) alongside per-modality annotations.

```python
# Global obs: union of all cells across modalities
mdata.obs          # DataFrame indexed by cell barcodes
mdata.obs_names    # Index of all cell names

# Per-modality obs
mdata['rna'].obs   # RNA-specific cell annotations

# Global var: concatenated feature space with modality prefix
mdata.var          # index like 'rna:gene_0', 'atac:peak_0'
mdata.var_names

# Per-modality var (no prefix)
mdata['rna'].var   # genes only
mdata['atac'].var  # peaks only
```

### Updating After Modality Changes

When you modify a modality (e.g., filter cells), call `update()` to synchronize the global annotations.

```python
# After filtering cells in a modality
import scanpy as sc
sc.pp.filter_cells(mdata['rna'], min_genes=200)

# Synchronize global obs/var with modality-level changes
mdata.update()
```

### obs Column Prefixing

Columns added per-modality get prefixed in the global `.obs`:

```python
mdata['rna'].obs['n_genes'] = (mdata['rna'].X > 0).sum(axis=1)
mdata.update()
# Now accessible as mdata.obs['rna:n_genes']
```

## Read / Write (.h5mu)

### Write

```python
# Write entire MuData to .h5mu
mdata.write("dataset.h5mu")

# Equivalent
md.write("dataset.h5mu", mdata)
```

### Read

```python
# Read full MuData
mdata = md.read("dataset.h5mu")

# Read a single modality from .h5mu (returns AnnData)
rna_only = md.read("dataset.h5mu/rna")

# Write a single modality back into existing .h5mu
md.write("dataset.h5mu/rna", rna_only)
```

### Zarr Format

```python
md.write_zarr("dataset.zarr", mdata)
mdata = md.read_zarr("dataset.zarr")
```

### Generic Read (Auto-detects Format)

```python
mdata = md.read("dataset.h5mu")     # -> MuData
adata = md.read("dataset.h5ad")     # -> AnnData
```

## Backed Mode

For large datasets, backed mode keeps data on disk and loads on demand.

```python
mdata = md.read("dataset.h5mu", backed=True)
# or
mdata = md.read_h5mu("dataset.h5mu", backed="r")

print(mdata.isbacked)  # True

# Access data lazily
rna_subset = mdata['rna'][0:100, :]  # reads only this slice from disk
```

### Backed Mode Gotchas

- Backed MuData is read-only by default. Use `backed="r+"` for read-write.
- Not all operations work in backed mode (e.g., concatenation, some scanpy functions).
- Close the file handle when done or use context managers.

## Subsetting

```python
# Subset cells
mdata_subset = mdata[mdata.obs['cell_type'] == 'T_cell']

# Subset features in a modality
mdata['rna'] = mdata['rna'][:, mdata['rna'].var['highly_variable']]
mdata.update()
```

## obsm, varm, uns, obsp

MuData supports the same slot types as AnnData at the global level:

```python
mdata.obsm['X_umap']       # Global UMAP embedding
mdata.obs['leiden']         # Global cluster labels
mdata.uns['mofa']           # MOFA results

# Per-modality slots work as in AnnData
mdata['rna'].obsm['X_pca']
mdata['atac'].obsm['X_lsi']
```

## Concatenation

```python
# Concatenate MuData objects (e.g., multiple samples)
mdata_merged = md.concat([mdata1, mdata2], axis=0, join='outer')
# axis=0: concatenate cells (obs)
# join='outer': keep all features, fill missing with 0/NaN
```

## Complete Example: Build MuData from Scratch

```python
import mudata as md
from mudata import MuData
from anndata import AnnData
import numpy as np
import pandas as pd

cells = [f"AACG_{i}" for i in range(500)]

rna = AnnData(
    X=np.random.poisson(2, (500, 1000)).astype(np.float32),
    obs=pd.DataFrame({"batch": np.random.choice(["A", "B"], 500)}, index=cells),
    var=pd.DataFrame(index=[f"Gene_{i}" for i in range(1000)])
)

adt = AnnData(
    X=np.random.poisson(50, (500, 200)).astype(np.float32),
    obs=pd.DataFrame(index=cells),
    var=pd.DataFrame(index=[f"ADT_{i}" for i in range(200)])
)

mdata = MuData({"rna": rna, "adt": adt})
print(mdata.n_obs, mdata.n_vars)  # 500 1200

mdata.write("cite_seq_raw.h5mu")
mdata_reload = md.read("cite_seq_raw.h5mu")
```

## Gotchas

- Call `mdata.update()` after modifying modalities in-place (filtering, adding columns). Forgetting this causes stale global `.obs`/`.var`.
- Feature names in global `.var` are prefixed with `modality_name:` (e.g., `rna:CD3E`). Per-modality `.var` uses bare names.
- MuData supports non-overlapping cells across modalities (mosaic data). Use `muon.pp.intersect_obs(mdata)` to restrict to shared cells.
- Backed mode requires h5py. The `backed="r+"` mode enables writes but can corrupt files if the process crashes.
- When concatenating, `join='inner'` keeps only shared features; `join='outer'` keeps all but introduces missing values.
