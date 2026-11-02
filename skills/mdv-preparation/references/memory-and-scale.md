# Memory and Scale

Estimate before you load. A sparse float32 CSR matrix costs about **8 bytes per non-zero**
(4 data + 4 index). A 6K-panel CosMx run of 194,000 cells has about 105 million non-zeros:
0.84 GB per copy. Several common steps hold two or three copies at once, and the step is killed
without a Python error when the sandbox runs out of memory.

## Estimate

```python
import h5py
with h5py.File(path, "r") as f:
    nnz = f["X"]["data"].shape[0]          # CSR / CSC stored X
    n_obs, n_vars = f["X"].attrs["shape"]
gb_per_copy = nnz * 8 / 1e9
```

Plan for 3 × `gb_per_copy` + 1 GB. Ask for that much memory when you acquire the sandbox. If the
grant is smaller, use the patterns below; they keep the peak near one copy.

## Where the copies come from

| Step | Hidden copies | Pattern |
|---|---|---|
| `adata[mask].copy()` after QC | old + new X | read only the kept rows (`read_csr_rows`) |
| backed `adata[mask].to_memory()` on a compressed h5ad | decompresses and copies X more than once | `read_csr_rows` |
| `sc.pp.highly_variable_genes(flavor="seurat_v3")` | a boolean-indexed copy + a float64 copy of X | rank HVGs on a subsample of ≤ 50,000 cells, copy the flags back |
| `sc.pp.pca(mask_var=...)` | X[:, hvg] copy; freed memory is not returned to the OS | park X on disk while the graph, UMAP and Leiden run |
| `sc.tl.rank_genes_groups` on all cells | per-group copies | ≤ 1,000 cells per group (`annotate_clusters`) |
| `build_asset` + `write_h5ad` | none when X is CSR float32 (`astype(copy=False)`) | build the asset from a fresh AnnData that holds only what it needs |
| MDV's upload (on the MDV server) | the whole file + a CSC copy of X | keep the asset below 5 GB; say the size in the README |
| `sc.pp.normalize_total`, `sc.pp.log1p` | none on sparse X (in place) | — |

## Helpers

```python
# file: mdv_memory.py
"""Memory-lean loading for large AnnData files."""
import ctypes
import gc

import h5py
import numpy as np
import scipy.sparse as sp


def read_csr_rows(h5ad_path, keep, block=20000):
    """Load only the rows of a CSR X where `keep` is True, straight from the h5ad.

    Peak memory: one copy of the kept matrix (float32 data, int32 indices) plus one block,
    because the output arrays are allocated once from the row lengths in indptr.
    """
    with h5py.File(h5ad_path, "r") as f:
        g = f["X"]
        if g.attrs.get("encoding-type", "") != "csr_matrix":
            raise ValueError("expected a CSR X")
        n_cols = int(g.attrs["shape"][1])
        indptr = g["indptr"][:].astype(np.int64)
        lengths = np.diff(indptr)
        kept = np.flatnonzero(keep)
        out_ptr = np.zeros(len(kept) + 1, dtype=np.int64)
        np.cumsum(lengths[kept], out=out_ptr[1:])
        data = np.empty(out_ptr[-1], dtype=np.float32)
        indices = np.empty(out_ptr[-1], dtype=np.int32)
        pos = 0
        for start in range(0, len(lengths), block):
            stop = min(start + block, len(lengths))
            rows = kept[(kept >= start) & (kept < stop)]
            if len(rows) == 0:
                continue
            lo, hi = indptr[start], indptr[stop]
            d = g["data"][lo:hi]
            ix = g["indices"][lo:hi]
            for r in rows:
                a, b = indptr[r] - lo, indptr[r + 1] - lo
                data[pos:pos + b - a] = d[a:b]
                indices[pos:pos + b - a] = ix[a:b]
                pos += b - a
    return sp.csr_matrix((data, indices, out_ptr), shape=(len(kept), n_cols))


def release():
    """Return freed heap to the OS (glibc); scanpy leaves large freed blocks behind."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass


def park_x(adata, path):
    """Write X to disk and replace it with an empty matrix; returns a function that restores it."""
    sp.save_npz(path, adata.X, compressed=False)
    adata.X = sp.csr_matrix(adata.shape, dtype=np.float32)
    release()

    def restore():
        import os
        adata.X = sp.load_npz(path).tocsr()
        os.remove(path)
    return restore
```

## The lean processing order

```python
backed = ad.read_h5ad(RAW, backed="r")
obs = backed.obs.copy()                     # QC on metadata only
keep = qc_mask(obs)
var, uns, spatial = backed.var.copy(), dict(backed.uns), backed.obsm["spatial"][:][keep]
backed.file.close()
adata = ad.AnnData(X=read_csr_rows(RAW, keep), obs=obs[keep], var=var, uns=uns)
adata.obsm["spatial"] = spatial

idx = np.sort(np.random.default_rng(0).choice(adata.n_obs, min(adata.n_obs, 50000), replace=False))
sub = adata[idx].copy()
sc.pp.highly_variable_genes(sub, n_top_genes=2000, flavor="seurat_v3")
adata.var["highly_variable"] = sub.var["highly_variable"]; del sub

sc.pp.normalize_total(adata); sc.pp.log1p(adata)       # in place
sc.pp.pca(adata, n_comps=50, mask_var="highly_variable", random_state=0)
restore = park_x(adata, f"{OUT}/X.npz")
sc.pp.neighbors(adata, random_state=0); sc.tl.umap(adata, random_state=0)
sc.tl.leiden(adata, flavor="igraph", n_iterations=2, random_state=0)
del adata.obsp["distances"], adata.obsp["connectivities"]
release(); restore()
```

On two cores, 183,000 cells: PCA about 1.5 min, UMAP about 4 min, Leiden under 30 s; peak 2.9 GB.

## Browser limits

The browser holds every loaded column as a typed array of N values, and each gene a user looks
at as one more. A few hundred thousand cells are fine. Above about 2 million cells, keep the
charts light (no all-gene charts) and consider one asset per sample.
