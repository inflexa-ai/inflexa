# Asset Route: from an analysis-ready AnnData to an MDV-ready asset

MDV loads an AnnData through its upload: it reads the file with `scanpy.read` and converts it
with `mdvtools.convert_scanpy_to_mdv(project_dir, adata)` and every default. The asset is the
AnnData that this default conversion turns into a correct, readable project. You do not run the
conversion; every rule below follows from what it does (`mdv-asset-contract.md`).

## The deliverable

| File | What the user does with it in MDV |
|---|---|
| `<name>.mdv.h5ad` | uploads it: MDV makes a `cells` table and a `genes` table, with expression linked to cells |
| `<table>.tsv` (context tables, optional) | uploads each as one more table |
| `README.md` | reads it: MDV has no column description field, so the README is the glossary |
| `<name>.mdv.validation.json` | the validator report, with zero errors |

Keep the full analysis AnnData (standard keys, raw counts) as a separate output. The asset is
for MDV only: readable labels instead of snake_case keys, nothing MDV would show as noise.

## 1. Pre-flight

Fix the AnnData before you build the asset if one of these fails (`preflight` checks them):

| Check | Why |
|---|---|
| X is sparse | MDV stores a dense matrix in full: 4 bytes × cells × genes |
| X is log-normalised (no negative values, max well below 50) | MDV shows X as "Gene Scores", as stored |
| `obs_names` and `var_names` are unique | duplicates multiply rows silently |
| no `|` or `(` in `var_names` | gene columns in MDV break |
| grouping columns have ≤ 256 categories | above 256 a column becomes `text16`, which most category charts refuse |

## 2. Readable labels

Never ship a bare cluster id. Number the clusters by size and add the label:

```python
sizes = adata.obs["leiden"].value_counts()
rank = {c: i + 1 for i, c in enumerate(sizes.index)}          # C01 is the largest cluster
adata.obs["cluster"] = adata.obs["leiden"].map(lambda c: f"C{rank[c]:02d} {label_of[c]}").astype("category")
```

When labels come from markers, use the cluster's own differentially expressed genes, not an
absolute marker score. A gene that is high everywhere (myelin transcripts in white matter,
haemoglobin in blood-rich tissue) spills into neighbouring segments and wins an absolute score in
every cluster. DE is relative to the other clusters, so the spill does not decide the call.

```python
# file: mdv_labels.py
"""Cluster-level marker labels from the overlap of each cluster's top DE genes with marker lists."""
import numpy as np
import scanpy as sc


def annotate_clusters(adata, groupby, markers, top_n=50, max_cells_per_group=1000, seed=0,
                      min_score=1.0, mixed_ratio=0.67, generic=None, refine=()):
    """Return {cluster: (label, evidence, top5)}.

    markers: {type name: [genes]} restricted to genes in the panel (choose lists for the tissue).
    generic/refine: an optional generic type (for example "Neurons") refined to the best of `refine`
    when one of them has evidence. A label is "Unresolved" below min_score and
    "Mixed A + B" when the runner-up scores above mixed_ratio of the best.
    """
    rng = np.random.default_rng(seed)
    groups = adata.obs[groupby].astype("category")
    keep = np.concatenate([rng.choice(np.flatnonzero(groups.values == c), min(max_cells_per_group, int((groups == c).sum())),
                                      replace=False) for c in groups.cat.categories])
    sub = adata[np.sort(keep)].copy()                      # DE on a subsample: same ranking, a fraction of the memory
    sub.obs[groupby] = sub.obs[groupby].astype("category")
    sc.tl.rank_genes_groups(sub, groupby, method="t-test_overestim_var", n_genes=top_n)
    names = sub.uns["rank_genes_groups"]["names"]
    calls = {}
    for c in sub.obs[groupby].cat.categories:
        top = list(names[c])
        weight = {g: 1.0 - i / top_n for i, g in enumerate(top)}
        score = {t: sum(weight.get(g, 0.0) for g in gs) for t, gs in markers.items()}
        hits = {t: [g for g in gs if g in weight] for t, gs in markers.items()}
        ranked = sorted(score, key=score.get, reverse=True)
        best = ranked[0]
        if generic and best == generic and refine:
            sub_best = max(refine, key=score.get)
            if score[sub_best] > 0:
                best = sub_best
        second = [t for t in ranked if t not in (best, generic)][0]
        if score[best] < min_score:
            label = "Unresolved"
        elif score[second] > mixed_ratio * score[best]:
            label = f"Mixed {best} + {second}"            # never "/": it is a path separator in HDF5 keys
        else:
            label = best
        evidence = "; ".join(f"{t}: {', '.join(hits[t])}" for t in (best, second) if hits[t]) or "no marker in top DE genes"
        calls[c] = (label, evidence, ", ".join(top[:5]))
    return calls
```

Choose the marker lists for the tissue (adult human cortex, PBMC, tumour, …), and keep only
the genes in the panel. Keep the evidence: it becomes the `clusters` context table.

## 3. The helper module

Copy this module into the step's scripts and import it.

```python
# file: mdv_asset.py
"""Build and write an MDV-ready AnnData: the asset that MDV converts with its default upload."""
import os
import re

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp

RESERVED_OBS = {"mdv_cell_id"}   # MDV adds it from obs_names
RESERVED_VAR = {"name"}          # MDV overwrites it with var_names


def _safe_label(label):
    return isinstance(label, str) and label != "" and "|" not in label and "/" not in label


def preflight(adata, grouping=()):
    """Raise on the conditions that corrupt or abort MDV's conversion of the asset."""
    problems = []
    if not sp.issparse(adata.X):
        problems.append("X is dense: give a sparse log-normalised matrix")
    elif adata.X.nnz and (adata.X.data.min() < 0 or adata.X.data.max() > 50):
        problems.append("X does not look log-normalised (negative or very large values)")
    if not adata.obs_names.is_unique:
        problems.append("obs_names are not unique")
    if not adata.var_names.is_unique:
        problems.append("var_names are not unique")
    bad = [g for g in adata.var_names if "|" in g or "(" in g]
    if bad:
        problems.append(f"gene names with '|' or '(': {bad[:5]}")
    for c in grouping:
        n = adata.obs[c].nunique()
        if n > 256:
            problems.append(f"grouping column {c!r} has {n} categories (> 256 makes it text16)")
    if problems:
        raise ValueError("MDV pre-flight failed:\n- " + "\n- ".join(problems))


def sanitise_frame(df):
    """Every column becomes numeric (int8-64, uint8-32, float32/64) or a categorical of plain str.

    Text is always categorical: a plain string column can be written as a nullable string array,
    which MDV's reader turns into a pandas 'string' dtype that its conversion does not map.
    Booleans become Yes/No; nullable numbers become float64 (NaN for missing).
    """
    out = pd.DataFrame(index=df.index)
    for c in df.columns:
        s = df[c]
        name = s.dtype.name
        if name in ("bool", "boolean"):
            vals = np.array(["ND" if pd.isna(v) else ("Yes" if v else "No") for v in s.astype(object)], dtype=object)
            s = pd.Series(pd.Categorical(vals, categories=pd.Index(sorted(set(vals)), dtype=object)), index=df.index)
        elif name.startswith(("Int", "UInt", "Float")) or name == "uint64":
            s = s.astype("float64")
        elif name == "float16":
            s = s.astype("float32")
        elif pd.api.types.is_numeric_dtype(s) and not isinstance(s.dtype, pd.CategoricalDtype):
            pass
        else:
            vals = np.array(["ND" if pd.isna(v) else str(v) for v in s.astype(object)], dtype=object)
            s = pd.Series(pd.Categorical(vals, categories=pd.Index(sorted(set(vals)), dtype=object)), index=df.index)
        out[c] = s
    return out


def round_columns(df, digits):
    """Round numeric columns to a meaningful precision: {column: digits}."""
    for c, d in digits.items():
        if c in df.columns:
            df[c] = df[c].astype("float64").round(d)
    return df


def build_asset(adata, obs_labels, var_labels=None, obsm_keys=None, layers=None, uns=None):
    """A new AnnData holding only what MDV should show, under readable labels.

    obs_labels: {obs column: readable label}, in display order (others are dropped).
    var_labels: {var column: readable label} (others dropped; the index stays the gene name).
    obsm_keys:  {obsm key: readable key}; 2-D only; MDV makes "<key>_1", "<key>_2" (max 3 columns).
    layers:     {layer: readable label}; each becomes one more expression set in MDV. Sparse only.
    uns:        small dict of provenance strings (MDV ignores uns; people and tools read it).
    """
    for label in list(obs_labels.values()) + list((var_labels or {}).values()) + list((obsm_keys or {}).values()) \
            + list((layers or {}).values()):
        if not _safe_label(label):
            raise ValueError(f"label {label!r} must be a non-empty string without '|' or '/'")
    if RESERVED_OBS & set(obs_labels.values()) or RESERVED_VAR & set((var_labels or {}).values()):
        raise ValueError("labels 'mdv_cell_id' (obs) and 'name' (var) are reserved by MDV")
    obs = sanitise_frame(adata.obs[list(obs_labels)]).rename(columns=obs_labels)
    var = sanitise_frame(adata.var[list(var_labels or {})]).rename(columns=var_labels or {})
    var.index = pd.Index([str(g) for g in adata.var_names], dtype=object)
    obs.index = pd.Index([str(c) for c in adata.obs_names], dtype=object)   # pandas 3 would write a nullable string array
    X = adata.X if sp.isspmatrix_csr(adata.X) else sp.csr_matrix(adata.X)
    asset = ad.AnnData(X=X.astype(np.float32, copy=False), obs=obs, var=var)   # no second copy of a large X
    for key, label in (obsm_keys or {}).items():
        m = np.asarray(adata.obsm[key], dtype=np.float32)
        if m.ndim != 2:
            raise ValueError(f"obsm[{key!r}] is not 2-D")
        asset.obsm[label] = m[:, :3]
    for key, label in (layers or {}).items():
        layer = adata.layers[key]
        if not sp.issparse(layer):
            raise ValueError(f"layer {key!r} is dense: MDV would store it in full")
        asset.layers[label] = sp.csr_matrix(layer, dtype=np.float32)
    if uns:
        asset.uns["mdv_asset"] = {k: str(v) for k, v in uns.items()}
    return asset


def write_asset(asset, path):
    """Write the asset; returns the size in GB. MDV asks for an upload below 5 GB."""
    asset.write_h5ad(path, compression="gzip")
    return os.path.getsize(path) / 1e9


def write_table(df, path, labels=None):
    """A context table as TSV with readable headers, ready for MDV's upload."""
    t = sanitise_frame(df.reset_index(drop=True)).rename(columns=labels or {})
    for c in t.columns:
        if not _safe_label(c):
            raise ValueError(f"column {c!r} must be a non-empty string without '|' or '/'")
    t.to_csv(path, sep="\t", index=False)


def write_readme(path, title, sections):
    """sections: [(heading, markdown body)]."""
    text = f"# {title}\n\n" + "\n\n".join(f"## {h}\n\n{b.strip()}" for h, b in sections) + "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def glossary(rows):
    """rows: [(column label, meaning)] -> markdown table."""
    return "| Column | Meaning |\n|---|---|\n" + "\n".join(f"| {a} | {b} |" for a, b in rows)
```

## 4. Build and write

```python
import anndata as ad, numpy as np
from mdv_asset import preflight, build_asset, round_columns, write_asset, write_table, write_readme, glossary

adata = ad.read_h5ad(PROCESSED_H5AD)        # large files: read X with read_csr_rows (memory-and-scale.md)
preflight(adata, grouping=["cell_type", "cluster", "sample"])
OBS = {                                     # source column -> label people read, in display order
    "cell_type": "Cell type (putative)",
    "cluster": "Cluster",
    "sample": "Sample",
    "total_counts": "UMIs per cell",
    "n_genes_by_counts": "Genes detected",
    "pct_counts_mt": "Mitochondrial reads (%)",
}
round_columns(adata.obs, {"pct_counts_mt": 2})
asset = build_asset(adata, OBS,
                    var_labels={"highly_variable": "Highly variable"},
                    obsm_keys={"X_umap": "UMAP"},           # MDV columns UMAP_1, UMAP_2
                    uns={"title": TITLE, "expression": "normalize_total (median) + log1p"})
size_gb = write_asset(asset, f"{OUT}/{NAME}.mdv.h5ad")
write_table(cluster_table, f"{OUT}/clusters.tsv", labels={"cluster": "Cluster", "top_genes": "Top DE genes"})
```

Decide each slot on purpose:

| Slot | Rule |
|---|---|
| `obs` | only the columns a person needs; labels with words and units; ids and codes as words |
| `obsm` | the embeddings to plot (UMAP); spatial positions as two readable `obs` columns instead (`spatial-transcriptomics.md`); never `X_pca` (three meaningless columns) |
| `var` | readable labels; no column named `name` |
| `varm`, `obsp`, `raw` | leave out |
| `layers` | none by default (each layer doubles the expression data in MDV); add one only when the user needs it, sparse, with a readable label such as "Raw counts" |
| `uns` | small provenance strings only |

## 5. Context tables

Small tables that answer "can I trust this?" go next to the asset as TSV. MDV's upload accepts
CSV and TSV, and each file becomes one table:

| Table | One row is | Columns |
|---|---|---|
| `clusters.tsv` | a cluster | label, cells, top DE genes, marker evidence |
| `samples.tsv` | a sample / slide / donor | design factors, cells before and after QC, median counts |
| `fovs.tsv` (CosMx and other FOV platforms) | a field of view | slide position, cells, transcripts, fraction of transcripts in cells, negative probes |

## 6. The README

Write `README.md` next to the asset with these sections:

1. **Contents** — each file, its rows, and what one row is.
2. **Loading into MDV** — upload the `.h5ad` (MDV makes the `cells` and `genes` tables); upload
   each TSV as one more table. MDV lists `.h5ad` upload for its local development deployment;
   files above 5 GB must be imported as a project instead.
3. **Processing** — the steps with their parameters, thresholds, seeds, and package versions; the
   QC counts (cells in, cells kept, reasons).
4. **Column glossary** — every column of every file, with units.
5. **Caveats** — what is putative, what was dropped, what is not in the asset (raw counts).
