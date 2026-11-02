# AnnData Route: from an analysis-ready AnnData to a curated MDV project

Every modality ends here. The input is one AnnData with log-normalised sparse `X`, the cell
metadata in `obs`, the embeddings in `obsm`, and readable labels. The output is a project that
validates and opens on useful views.

## 1. Pre-flight checks

Stop and fix the AnnData if one of these fails:

| Check | Why |
|---|---|
| `scipy.sparse.issparse(adata.X)` | a dense X is stored in full: 4 bytes × cells × genes |
| `X` is log-normalised (max well below 50, no negative values) | "Gene Scores" are shown as stored; markers and colours assume log scale |
| `adata.obs_names.is_unique` and `adata.var_names.is_unique` | duplicates multiply rows silently |
| no `|` or `(` in `var_names` | virtual gene columns break |
| no `/` or `|` in any column label | h5 paths and column pickers break |
| every grouping column has ≤ 256 categories | `text16` columns are refused by most category charts |
| `obsm` holds only what users need (`X_umap`, not `X_pca`) | each `obsm` key adds `max_dims` columns |

## 2. Readable labels

Never export a bare cluster id. Number the clusters by size and add the label:

```python
sizes = adata.obs["leiden"].value_counts()
rank = {c: i + 1 for i, c in enumerate(sizes.index)}          # C01 is the largest cluster
adata.obs["cluster"] = adata.obs["leiden"].map(lambda c: f"C{rank[c]:02d} {label_of[c]}").astype("category")
```

When the labels come from markers, use the cluster's own differentially expressed genes, not
the absolute marker score. A gene that is high everywhere (myelin transcripts in white matter,
haemoglobin in blood-rich tissue) spills into neighbouring segments and wins an absolute score
in every cluster. DE is relative to the other clusters, so the spill does not decide the call.

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
the genes in the panel. Store the evidence: it becomes the `clusters` datasource below.

## 3. The helper module

Copy this module into the step's scripts and import it.

```python
# file: mdv_prep.py
"""Helpers for writing a curated MDV project with mdvtools (1.3.0 API)."""
import json
import math
import os
import shutil

import numpy as np
import pandas as pd
import scipy.sparse as sp


def preflight(adata, grouping=()):
    """Raise on the conditions that corrupt or abort an MDV conversion."""
    problems = []
    if not sp.issparse(adata.X):
        problems.append("X is dense: export a sparse log-normalised matrix")
    elif adata.X.nnz and (adata.X.data.min() < 0 or adata.X.data.max() > 50):
        problems.append("X does not look log-normalised (negative or very large values)")
    if not adata.obs_names.is_unique:
        problems.append("obs_names are not unique")
    if not adata.var_names.is_unique:
        problems.append("var_names are not unique")
    bad = [g for g in adata.var_names if "|" in g or "(" in g]
    if bad:
        problems.append(f"feature names with '|' or '(': {bad[:5]}")
    for frame, where in ((adata.obs, "obs"), (adata.var, "var")):
        for c in frame.columns:
            if not isinstance(c, str) or not c or "|" in c or "/" in c:
                problems.append(f"{where} column label {c!r} is not a safe field id")
    for c in grouping:
        n = adata.obs[c].nunique()
        if n > 256:
            problems.append(f"grouping column {c} has {n} categories (> 256 makes it text16)")
    if problems:
        raise ValueError("MDV pre-flight failed:\n- " + "\n- ".join(problems))


def sanitise_frame(df, yes_no=True):
    """Cast every column to a dtype that mdvtools maps; booleans become Yes/No."""
    out = pd.DataFrame(index=df.index)
    for c in df.columns:
        s = df[c]
        name = s.dtype.name
        if isinstance(s.dtype, pd.CategoricalDtype):
            s = s.astype(str).astype("category")
        elif name in ("bool", "boolean"):
            s = s.map({True: "Yes", False: "No"}).fillna("ND").astype("category") if yes_no else s.astype(str).astype("category")
        elif name.startswith(("Int", "UInt", "Float")) or name == "uint64":
            s = s.astype("float64")
        elif name == "float16":
            s = s.astype("float32")
        elif name == "string":
            s = s.astype(object)
        out[c] = s
    return out


def finite(x, default=0.0):
    x = float(x)
    return x if math.isfinite(x) else default


def round_columns(df, digits):
    """Round numeric columns to a meaningful precision: {column: digits}. Tables show every float32 digit."""
    for c, d in digits.items():
        if c in df.columns:
            df[c] = df[c].astype("float64").round(d)
    return df


def features_first(var_names, first):
    """Column order for the genes datasource: `first` (canonical markers, present ones only), then A-Z.

    A RowsAsColsQuery ("the selected gene") starts on the first gene row, so the first row should be
    a gene worth seeing. Returns integer positions into var_names.
    """
    pos = {g: i for i, g in enumerate(var_names)}
    head = [g for g in dict.fromkeys(first) if g in pos]
    rest = sorted((g for g in var_names if g not in set(head)), key=str.upper)
    return [pos[g] for g in head + rest]


def to_csc(adata_x, order=None):
    """CSC copy of a sparse X, columns optionally reordered. mdvtools stores CSC: passing CSC
    avoids its own copy. Drop every reference to the CSR before calling, so the peak is two copies."""
    csc = adata_x.tocsc()
    if order is not None:
        csc = csc[:, order]
    return csc


def set_column_names(mdv, datasource, names, groups=None):
    """Set display names {field: name} and column groups {group: [fields]} (1.3.0 has no rename_column)."""
    md = mdv.get_datasource_metadata(datasource)
    fields = {c["field"] for c in md["columns"]}
    missing = [f for f in names if f not in fields]
    if missing:
        raise KeyError(f"{datasource}: no such columns {missing}")
    for col in md["columns"]:
        if col["field"] in names:
            col["name"] = names[col["field"]]
    if groups:
        md["columnGroups"] = [{"name": g, "columns": [f for f in fs if f in fields]} for g, fs in groups.items()]
    mdv.set_datasource_metadata(md)


def hide_columns(mdv, datasource, fields):
    """Tombstone columns before any view references them (1.3.0 has no soft_delete_column)."""
    md = mdv.get_datasource_metadata(datasource)
    for col in md["columns"]:
        if col["field"] in fields:
            col["deleted"] = True
    mdv.set_datasource_metadata(md)


def set_category_colors(mdv, datasource, field, color_of, fallback="#aaaaaa"):
    """Fix one colour per category. color_of: dict or callable(value) -> '#rrggbb'."""
    md = mdv.get_datasource_metadata(datasource)
    for col in md["columns"]:
        if col["field"] == field:
            pick = color_of if callable(color_of) else (lambda v: color_of.get(v, fallback))
            col["colors"] = [pick(v) or fallback for v in col["values"]]  # same order as values
            break
    else:
        raise KeyError(f"{datasource}.{field} not found")
    mdv.set_datasource_metadata(md)


def add_table(mdv, name, df, names=None):
    """Add a context datasource from a DataFrame and fail on any dropped column."""
    dropped = mdv.add_datasource(name, sanitise_frame(df.reset_index(drop=True)), add_to_view=None)
    if dropped:
        raise ValueError(f"{name}: mdvtools dropped columns {dropped}")
    if names:
        set_column_names(mdv, name, names)


def set_state(mdv, title, views_in_order):
    state = mdv.state                       # 1.3.0 has no set_display_name
    state["name"] = title
    state["permission"] = "edit"
    state["all_views"] = list(views_in_order)
    state["initial_view"] = views_in_order[0]
    mdv.state = state


def replace_views(mdv, views):
    """Remove the converter's views and write ours; the first one opens first."""
    for name in list(mdv.views.keys()):
        mdv.set_view(name, None)
    for i, (name, view) in enumerate(views.items()):
        mdv.set_view(name, view, make_default=(i == 0))


def zip_project(project_dir):
    """Zip next to the folder (the folder stays). The full MDV app imports this zip."""
    return shutil.make_archive(project_dir, "zip", root_dir=project_dir)


def write_readme(project_dir, title, sections):
    """sections: [(heading, markdown body)]."""
    text = f"# {title}\n\n" + "\n\n".join(f"## {h}\n\n{b.strip()}" for h, b in sections) + "\n"
    with open(os.path.join(project_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(text)


def glossary(rows):
    """rows: [(display name, meaning)] -> markdown table."""
    return "| Column | Meaning |\n|---|---|\n" + "\n".join(f"| {a} | {b} |" for a, b in rows)
```

## 4. Convert, curate, describe

The order matters: convert into a new folder, add context tables, set names and colours, then
build views (a column referenced by a view can no longer be hidden), then README and state.

```python
import importlib.metadata, json, os, shutil
import anndata as ad, numpy as np, pandas as pd
from mdvtools.conversions import convert_scanpy_to_mdv
from mdv_prep import (preflight, sanitise_frame, round_columns, features_first, to_csc, set_column_names,
                      set_category_colors, add_table, replace_views, set_state, write_readme, glossary, zip_project)

adata = ad.read_h5ad(PROCESSED_H5AD)        # large files: read X with read_csr_rows (memory-and-scale.md)
COLUMNS = {                                   # field -> (display name, group); everything else is dropped
    "cell_type": ("Cell type (putative)", "Annotation"),
    "cluster": ("Cluster", "Annotation"),
    "sample": ("Sample", "Design"),
    "total_counts": ("UMIs per cell", "QC"),
    "n_genes_by_counts": ("Genes detected", "QC"),
    "pct_counts_mt": ("Mitochondrial reads (%)", "QC"),
}
obs = sanitise_frame(adata.obs[[c for c in COLUMNS if c in adata.obs]])
obs = round_columns(obs, {"pct_counts_mt": 2})
order = features_first(list(adata.var_names), MARKERS)    # canonical markers first, then A-Z
var = sanitise_frame(adata.var).iloc[order]
x, umap = adata.X, adata.obsm["X_umap"]
del adata                                     # drop the CSR references before the CSC copy
adata = ad.AnnData(X=to_csc(x, order), obs=obs, var=var, obsm={"X_umap": umap})
del x
preflight(adata, grouping=["cell_type", "cluster"])

if os.path.exists(PROJECT):                   # never convert into an existing project
    shutil.rmtree(PROJECT)
mdv = convert_scanpy_to_mdv(PROJECT, adata, max_dims=2, delete_existing=True, add_layer_data=False)
# add_layer_data=False always: anndata >= 0.13 lists X under layers[None] and the default fails.
# A layer the user needs goes in explicitly, rows in cells order, columns in genes order:
# mdv.add_rows_as_columns_subgroup("cells", "genes", "counts", to_csc(counts, order), label="Raw counts")

add_table(mdv, "clusters", cluster_table, names={"cluster": "Cluster", "top_genes": "Top DE genes",
                                                 "marker_evidence": "Marker evidence", "cells": "Cells"})
names = {f: n for f, (n, _) in COLUMNS.items() if f in obs}
names.update({"mdv_cell_id": "Cell ID", "X_umap_1": "UMAP 1", "X_umap_2": "UMAP 2"})
groups = {}
for f, (_, g) in COLUMNS.items():
    if f in obs:
        groups.setdefault(g, []).append(f)
set_column_names(mdv, "cells", names, groups)
set_column_names(mdv, "genes", {"name": "Gene"})
set_category_colors(mdv, "cells", "cell_type", CELL_TYPE_COLORS)
views = build_views(...)                      # view-recipes.md
replace_views(mdv, views)
set_state(mdv, TITLE, list(views))
write_readme(PROJECT, TITLE, [("Contents", ...), ("Processing", ...), ("Column glossary", glossary([...])), ("Caveats", ...)])
zip_project(PROJECT)
```

## 5. Context datasources

Add small tables that answer "can I trust this?" next to the cells:

| Datasource | One row is | Columns |
|---|---|---|
| `clusters` | a cluster | label, cells, top DE genes, marker evidence |
| `samples` | a sample / slide / donor | design factors, cells before and after QC, median counts |
| `fovs` (CosMx, other FOV-based platforms) | a field of view | slide position, cells, transcripts, fraction of transcripts in cells, negative probes |

Each one needs at least one chart in a view (the validator warns about orphans).

## 6. The README

MDV shows `README.md` as the project description, and it is the only place for column meanings.
Write these sections:

1. **Contents** — one row per datasource: rows, what one row is.
2. **Processing** — the steps with their parameters, thresholds, seeds, and package versions;
   the QC counts (cells in, cells kept, reasons).
3. **Column glossary** — every visible column of every datasource, with units.
4. **Caveats** — what is putative, what was dropped, what the image is for.

## 7. Delivery

- the project folder and its zip (`zip_project`) — the zip imports into the full MDV app,
  the folder opens with `mdvtools serve <folder>` on the user's machine;
- the validator report (`validation.md`), with zero errors;
- the curated `.h5ad` that the project was written from.
