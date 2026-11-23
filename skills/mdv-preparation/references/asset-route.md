# Project Route: from an analysis-ready AnnData to an MDV project

Every route ends in an MDV project. `inflexa-mdvtools` converts a curated AnnData (the asset) into
the `cells` and `genes` tables of the project. For spatial data, it converts a SpatialData store
that holds the asset and the images (`spatial-transcriptomics.md`). Then the helper module of this
file sets the labels, the views that open first, and the zip.

## The deliverable

| File | What it is |
|---|---|
| `<name>/` | the project folder: `datafile.h5`, `datasources.json`, `views.json`, `state.json`, `README.md`. A spatial project also has `spatial/` (the SpatialData store with the images) and `images/` (the shapes of each region) |
| `<name>.mdv.zip` | the project files at the root of the zip, for an import or for the projects directory of the server ("The way into MDV") |
| `README.md` | the README of the project, also next to the zip |
| `<name>.mdv.h5ad` | the asset that the table validator reads |
| `<name>.mdv.validation.json` | the report of the table validator, with zero errors |
| `<name>.mdv.check.json` | the report of the project check, with zero errors |

Keep the full analysis AnnData (standard keys, raw counts) as a separate output. The asset is for
MDV only: readable labels, and nothing that MDV shows as noise.

## 1. Readable labels

Number the clusters by size, the largest first, and add the label:

```python
sizes = adata.obs["leiden"].value_counts()
rank = {c: i + 1 for i, c in enumerate(sizes.index)}          # C01 is the largest cluster
adata.obs["cluster"] = adata.obs["leiden"].map(lambda c: f"C{rank[c]:02d} {label_of[c]}").astype("category")
```

When labels come from markers, use the cluster's own differentially expressed genes, not an
absolute marker score. A gene that is high everywhere (myelin transcripts in white matter,
hemoglobin in blood-rich tissue) spills into neighboring segments and wins an absolute score in
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


def refine_labels(adata, label_key, parent, markers, resolution=0.6, n_top_genes=1000, n_pcs=30, seed=0,
                  counts_layer="counts", min_score=0.5, **annotate_kw):
    """Subcluster the cells of one label and annotate the subclusters with finer markers (subtypes, layers).

    The HVGs and the PCA come from the parent cells only: the HVGs of all cells separate the main types, not the
    subtypes. counts_layer holds the raw counts (seurat_v3). Returns (labels, calls): labels is a Series of the
    subtype of each parent cell; calls is annotate_clusters of the subclusters. A subcluster with no subtype
    evidence keeps the parent label. min_score is lower than for the main types: a targeted panel holds few
    markers of each subtype. Write subtype names without "/" ("L2-3 IT", not "L2/3 IT").
    """
    import pandas as pd
    mask = (adata.obs[label_key] == parent).to_numpy()
    sub = adata[mask].copy()
    sc.pp.highly_variable_genes(sub, flavor="seurat_v3", layer=counts_layer, n_top_genes=min(n_top_genes, sub.n_vars - 1))
    sc.pp.pca(sub, n_comps=n_pcs, mask_var="highly_variable", random_state=seed)
    sc.pp.neighbors(sub, random_state=seed)
    sc.tl.leiden(sub, resolution=resolution, flavor="igraph", n_iterations=2, random_state=seed, key_added="sub")
    calls = annotate_clusters(sub, "sub", markers, seed=seed, min_score=min_score, **annotate_kw)
    keep = lambda lab: parent if lab == "Unresolved" else lab
    labels = pd.Series([keep(calls[c][0]) for c in sub.obs["sub"]], index=sub.obs_names)
    return labels, calls


def top_markers(adata, groupby, n=2, max_cells_per_group=1000, seed=0, exclude=(), prefer=None):
    """{group: [n marker genes]}, for the dot plot of the Markers view and for the gene tiles.

    prefer: {group or a word of the group name: [known markers]}. The known markers that are up in the group (DE
    score > 0) come first, in DE order, then the top DE genes. Known markers keep the plot readable: the top DE
    genes of a segmented cell can be genes that spill in from its neighbors. Groups in `exclude` (for example
    "Low-quality cells") are left out of the result but stay in the comparison."""
    rng = np.random.default_rng(seed)
    groups = adata.obs[groupby].astype("category")
    keep = np.concatenate([rng.choice(np.flatnonzero(groups.values == c), min(max_cells_per_group, int((groups == c).sum())),
                                      replace=False) for c in groups.cat.categories])
    sub = adata[np.sort(keep)].copy()
    sub.obs[groupby] = sub.obs[groupby].astype("category")
    sc.tl.rank_genes_groups(sub, groupby, method="t-test_overestim_var", n_genes=sub.n_vars)
    rg = sub.uns["rank_genes_groups"]
    out, used = {}, set()
    for c in sub.obs[groupby].cat.categories:
        if c in exclude:
            continue
        score = dict(zip(rg["names"][c], rg["scores"][c]))
        exact = [g for key, gs in (prefer or {}).items() if key == c for g in gs]          # the markers of the group
        broad = [g for key, gs in (prefer or {}).items() if key != c and key in str(c).split() for g in gs]   # its class
        up = lambda gs: sorted({g for g in gs if score.get(g, 0) > 0}, key=lambda g: -score[g])
        known = up(exact) + up(broad)
        picks = [g for g in known + list(rg["names"][c]) if g not in used]
        picks = list(dict.fromkeys(picks))[:n]                    # a gene once, at its first group
        used.update(picks)
        out[c] = picks
    return out


def flag_low_quality(adata, cluster_key, label_key, counts_key, fov_key=None, ratio=0.5, fov_share=0.25):
    """The clusters that are low-quality cells, not a cell type: no marker label ("Unresolved") and a median count
    below ratio × the median of all cells. Returns {cluster: evidence}. With fov_key, the evidence also gives the
    FOVs where the cluster is more than fov_share of the cells: damaged or out-of-focus tissue looks like this.
    """
    import numpy as np
    out = {}
    med_all = float(np.median(adata.obs[counts_key]))
    for c, obs in adata.obs.groupby(cluster_key, observed=True):
        med = float(np.median(obs[counts_key]))
        if (obs[label_key] == "Unresolved").all() and med < ratio * med_all:
            ev = f"median {med:.0f} transcripts against {med_all:.0f} for all cells; no marker in the top DE genes"
            if fov_key:
                share = (adata.obs[cluster_key] == c).groupby(adata.obs[fov_key]).mean()
                hot = share[share > fov_share].sort_values(ascending=False)
                if len(hot):
                    ev += f"; more than {fov_share:.0%} of the cells in FOVs {', '.join(str(i) for i in hot.index[:8])}"
            out[c] = ev
    return out


def spatial_domains(adata, label_key, n_domains=8, k=30, sample_key=None, min_fraction=0.05, seed=0, names=None):
    """Spatial domains (niches): k-means of the cell-type composition of the k nearest neighbors of each cell.

    The neighbors come from obsm["spatial"], inside one sample (sample_key) only. A domain gets the name of the
    cell types that it enriches most (fraction in the domain / fraction in all cells, types above min_fraction of
    the domain): "Excitatory L2-3 IT, Astrocytes". names: an optional function of the composition of a domain (a
    Series of fractions) that returns a name from evidence, or None: for example "White matter" for 60 % or more
    oligodendrocytes. Domains with the same name are one domain: k-means can split one tissue region by density
    alone. Returns (labels, composition): labels is a categorical of "D01 <name>" (D01 is the largest); composition
    is the mean neighborhood composition of each domain.
    """
    import numpy as np
    import pandas as pd
    from sklearn.cluster import MiniBatchKMeans
    from sklearn.neighbors import NearestNeighbors
    types = adata.obs[label_key].astype("category")
    onehot = np.eye(len(types.cat.categories), dtype=np.float32)[types.cat.codes.to_numpy()]
    comp = np.zeros_like(onehot)
    groups = adata.obs[sample_key].to_numpy() if sample_key else np.zeros(adata.n_obs)
    xy = np.asarray(adata.obsm["spatial"], dtype=float)
    for g in np.unique(groups):
        idx = np.flatnonzero(groups == g)
        nn = NearestNeighbors(n_neighbors=min(k, len(idx))).fit(xy[idx])
        neigh = nn.kneighbors(xy[idx], return_distance=False)
        comp[idx] = onehot[idx][neigh].mean(axis=1)
    km = MiniBatchKMeans(n_clusters=n_domains, random_state=seed, n_init=5, batch_size=8192).fit(comp)
    frame = pd.DataFrame(comp, columns=types.cat.categories)
    overall = onehot.mean(axis=0)
    base = {}
    for d, frac in frame.groupby(km.labels_).mean().iterrows():
        given = names(frac) if names else None
        enrich = (frac / np.maximum(overall, 1e-9))[frac >= min_fraction].sort_values(ascending=False)
        base[d] = given or ", ".join(enrich.index[:2])                # labels can hold "+" (Mixed A + B)
    merged = pd.Series([base[d] for d in km.labels_])
    rank = {n: f"D{i:02d} {n}" for i, n in enumerate(merged.value_counts().index, 1)}
    labels = pd.Categorical(merged.map(rank).to_numpy())
    composition = frame.groupby(labels, observed=True).mean()
    return labels, composition.sort_index()
```

Annotate in two levels. First the main types (`annotate_clusters`). Then subtypes for each
type that the panel can split (`refine_labels`): for brain, the layers of the excitatory neurons and
the classes of the inhibitory neurons. Choose the subtype markers from the cluster's DE genes and
the tissue literature, restricted to the panel, and write them in the README. A cluster that
`flag_low_quality` returns gets the label "Low-quality cells": keep it in the project and give the
evidence, because it shows where the tissue or the segmentation failed. For spatial data, add the
`spatial_domains` of the finest labels as a column.

Choose the marker lists for the tissue (adult human cortex, PBMC, tumor, …), and keep only the
genes in the panel. Keep the evidence: it becomes the `clusters` table of the project.

## 2. The helper modules

Copy these modules into the scripts of the step and import them. `mdv_asset.py` makes the asset.
`mdv_project.py` makes the project from it.

`mdv_project.py` works with `inflexa-mdvtools` 1.3.0 and with newer builds of mdvtools from the MDV
repository. If the caller does not give `table_handling="merge"`, the newer builds name the
datasources of a spatial table after its region. The newer builds also give the tissue chart another
type, and write more bookkeeping columns. The helper passes the option when the version has it, finds the tissue chart by its region,
and labels the extra columns.

```python
# file: mdv_asset.py
"""Build and write the curated AnnData that mdvtools converts into the cells and genes of the MDV project."""
import os

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp

RESERVED_OBS = {"mdv_cell_id", "x", "y", "spatial_region", "spatialdata_path", "table_name"}   # mdvtools writes them
RESERVED_VAR = {"name"}                                                                    # mdvtools writes var_names


def safe_field(name):
    """True for a column name that SpatialData and MDV accept as a field."""
    return (isinstance(name, str) and name not in ("", ".", "..") and not name.startswith("__")
            and all(c.isalnum() or c in "_-." for c in name))


def _safe_label(label):
    return isinstance(label, str) and label.strip() != "" and "|" not in label


def preflight(adata, grouping=()):
    """Raise on the conditions that corrupt or stop the conversion of mdvtools."""
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
    which the reader of mdvtools turns into a pandas 'string' dtype that its conversion does not map.
    Booleans become Yes/No. Nullable numbers become float64 (NaN for missing).
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
    """A new AnnData that holds only what MDV must show. The labels go to uns["mdv_labels"].

    obs_labels: {obs column: readable label}, in display order (others are dropped). The column keeps its name
                as the MDV field. The label becomes the name that MDV shows.
    var_labels: {var column: readable label} (others dropped; the index stays the gene name).
    obsm_keys:  {obsm key: MDV key}; 2-D only; MDV makes "<key>_1", "<key>_2" (max 3 columns).
    layers:     {layer: readable label}; each becomes one more expression set in MDV. Sparse only.
    uns:        small dict of provenance strings.
    """
    frames = (("obs", obs_labels, RESERVED_OBS), ("var", var_labels or {}, RESERVED_VAR),
              ("obsm", {v: v for v in (obsm_keys or {}).values()}, set()), ("layers", layers or {}, set()))
    for slot, labels, reserved in frames:
        for field, label in labels.items():
            if not safe_field(field):
                raise ValueError(f"{slot} name {field!r} must use only letters, digits, '_', '.', '-': rename it")
            if field in reserved:
                raise ValueError(f"{slot} name {field!r} is reserved by mdvtools: rename it")
            if not _safe_label(label):
                raise ValueError(f"label {label!r} must be a non-empty string without '|'")
        lower = [f.lower() for f in labels]
        if len(set(lower)) != len(lower):
            raise ValueError(f"{slot} names must be unique without regard to case: {list(labels)}")
    obs = sanitise_frame(adata.obs[list(obs_labels)])
    var = sanitise_frame(adata.var[list(var_labels or {})])
    var.index = pd.Index([str(g) for g in adata.var_names], dtype=object)
    obs.index = pd.Index([str(c) for c in adata.obs_names], dtype=object)   # pandas 3 would write a nullable string array
    X = adata.X if sp.isspmatrix_csr(adata.X) else sp.csr_matrix(adata.X)
    asset = ad.AnnData(X=X.astype(np.float32, copy=False), obs=obs, var=var)   # no second copy of a large X
    for key, label in (obsm_keys or {}).items():
        m = np.asarray(adata.obsm[key], dtype=np.float32)
        if m.ndim != 2:
            raise ValueError(f"obsm[{key!r}] is not 2-D")
        asset.obsm[label] = m[:, :3]
    for key in (layers or {}):
        layer = adata.layers[key]
        if not sp.issparse(layer):
            raise ValueError(f"layer {key!r} is dense: MDV would store it in full")
        asset.layers[key] = sp.csr_matrix(layer, dtype=np.float32)
    asset.uns["mdv_labels"] = {"cells": dict(obs_labels), "genes": dict(var_labels or {}), "layers": dict(layers or {})}
    if uns:
        asset.uns["mdv_asset"] = {k: str(v) for k, v in uns.items()}
    return asset


def write_asset(asset, path):
    """Write the curated AnnData for the table validator; returns the size in GB."""
    asset.write_h5ad(path, compression="gzip")
    return os.path.getsize(path) / 1e9
```

```python
# file: mdv_project.py
"""Build the MDV project with inflexa-mdvtools: the conversion, the labels, the views that open first, the zip."""
import copy
import os
import tempfile
import zipfile

import anndata as ad
import numpy as np

OBS, VAR = "cells", "genes"
MDVTOOLS_LABELS = {"x": "Image x (px)", "y": "Image y (px)", "spatial_region": "Region",
                   "spatialdata_path": "SpatialData store", "table_name": "SpatialData table", "mdv_cell_id": "Cell name",
                   "spatial_1": "Slide x", "spatial_2": "Slide y",
                   # newer mdvtools versions also write these; a label for an absent field is ignored
                   "spatialdata_name": "SpatialData name", "spatialdata_table_id": "SpatialData table ID",
                   "spatialdata_region": "SpatialData region name", "spatialdata_region_key": "SpatialData region key",
                   "spatialdata_instance_key": "SpatialData instance key"}
MDVTOOLS_GENE_LABELS = {"object_source": "SpatialData store", "table_source": "SpatialData table"}
GENE_CHARTS = [
    {"type": "selection_dialog", "title": "Find genes", "legend": "", "param": ["name"], "filters": {"name": None},
     "order": {}, "noClearFilters": False, "size": [375, 293], "position": [5, 5]},
    {"type": "table_chart_react", "title": "Genes", "legend": "", "param": ["name"], "column_widths": {},
     "size": [375, 293], "position": [5, 303]},
]


def _rename(mdv, ds, wanted):
    meta = mdv.get_datasource_metadata(ds)
    for column in meta["columns"]:
        if column["field"] in wanted:
            column["name"] = str(wanted[column["field"]])
    return meta


def label_columns(mdv, labels):
    """Set the names that MDV shows. labels: {"cells": {field: label}, "genes": {...}, "layers": {layer: label}}."""
    meta = _rename(mdv, OBS, {**MDVTOOLS_LABELS, **(labels.get(OBS) or {})})
    groups = meta.get("links", {}).get(VAR, {}).get("rows_as_columns", {}).get("subgroups", {})
    for stub, label in (labels.get("layers") or {}).items():
        if stub in groups:
            groups[stub]["label"] = str(label)
    mdv.set_datasource_metadata(meta)
    mdv.set_datasource_metadata(_rename(mdv, VAR, {**MDVTOOLS_GENE_LABELS, **(labels.get(VAR) or {})}))


def write_project(asset, out_dir):
    """The project of a curated AnnData (build_asset), or of the path of its .h5ad. Replaces out_dir."""
    from mdvtools.conversions import convert_scanpy_to_mdv
    os.makedirs(os.path.dirname(os.path.abspath(out_dir)), exist_ok=True)
    adata = ad.read_h5ad(asset) if isinstance(asset, str) else asset
    labels = copy.deepcopy(dict(adata.uns.get("mdv_labels", {})))
    mdv = convert_scanpy_to_mdv(out_dir, adata, delete_existing=True)
    label_columns(mdv, labels)
    return mdv


def write_spatial_project(sdata_path, out_dir, index_points=True):
    """The project of one SpatialData store (put_table): its table, images, shapes, points, and regions.

    Replaces out_dir. With index_points, the copy of the store in the project gets Morton-sorted points: then the
    tissue chart reads the transcripts of a gene in the view (the gene tiles). A version of mdvtools without the
    browser-store options cannot sort them. Then the function warns, and the points stay as they are: remove them
    with drop_unused, or use mdvtools from the MDV repository.
    """
    import dataclasses
    import warnings
    import spatialdata as sd
    from mdvtools.spatial.conversion import SpatialDataConversionArgs, convert_spatialdata_to_mdv
    os.makedirs(os.path.dirname(os.path.abspath(out_dir)), exist_ok=True)
    tables = sd.read_zarr(sdata_path, selection=("tables",)).tables
    if len(tables) != 1:
        raise ValueError(f"the store has {len(tables)} tables: MDV merges them into one cells table; keep one (put_table)")
    labels = copy.deepcopy(dict(next(iter(tables.values())).uns.get("mdv_labels", {})))
    options = {}
    fields = {f.name for f in dataclasses.fields(SpatialDataConversionArgs)}
    if "table_handling" in fields:
        options["table_handling"] = "merge"    # newer mdvtools: one table keeps the names cells and genes
    points_dir = os.path.join(sdata_path, "points")
    if index_points and os.path.isdir(points_dir) and [d for d in os.listdir(points_dir) if not d.startswith(".")]:
        if "browser_store" in fields:
            from mdvtools.spatial.browser_store import BrowserStoreOptions
            options["browser_store"] = BrowserStoreOptions(morton_points=True)
        else:
            warnings.warn("this mdvtools cannot Morton-sort points: MDV shows no gene tiles. Remove the points "
                          "(drop_unused) or use mdvtools from the MDV repository")
    with tempfile.TemporaryDirectory() as tmp:
        mdv = convert_spatialdata_to_mdv(SpatialDataConversionArgs(
            spatialdata_path=os.path.abspath(sdata_path), output_folder=os.path.abspath(out_dir), temp_folder=tmp,
            output_geojson=True, link=False, **options))
    names = {d["name"] for d in mdv.datasources}
    if not {OBS, VAR} <= names:
        raise ValueError(f"the conversion wrote the datasources {sorted(names)}, not {OBS!r} and {VAR!r}")
    label_columns(mdv, labels)
    return mdv


def add_table(mdv, name, df, labels=None):
    """One more datasource of the project, for a context table (clusters, samples, FOVs). labels: {column: label}."""
    from mdv_asset import sanitise_frame
    mdv.add_datasource(name, sanitise_frame(df.reset_index(drop=True)))
    mdv.set_datasource_metadata(_rename(mdv, name, labels or {}))


def _field(columns, key):
    """The field of a column given by its field or by the name that MDV shows."""
    if key in columns:
        return key
    named = [f for f, c in columns.items() if c.get("name") == key]
    if len(named) != 1:
        raise ValueError(f"no single column {key!r} in {OBS}: give the field or the label as the project has it")
    return named[0]


def _chart(cid, kind, title, param, gssize, gsposition, **extra):
    return {"id": cid, "type": kind, "title": title, "legend": "", "param": param,
            "size": [gssize[0] * 100, gssize[1] * 100], "gssize": gssize, "gsposition": gsposition, **extra}


def _scatter(cid, title, x, y, color_by, legend, gssize, gsposition):
    return _chart(cid, "wgl_scatter_plot", title, [x, y], gssize, gsposition, color_by=color_by,
                  color_legend={"display": legend, "pos": [5, 5]}, radius=2, opacity=0.8, brush="poly",
                  on_filter="hide", tooltip={"show": False}, default_color="#377eb8")


def _cell_radius(mdv, sample=50000, seed=0):
    """Half the median distance from a cell to its nearest neighbor, in image pixels: the dot size on the image."""
    from scipy.spatial import cKDTree
    xy = np.column_stack([np.asarray(mdv.get_column(OBS, c), dtype=float) for c in ("x", "y")])
    xy = xy[np.isfinite(xy).all(axis=1)]
    if len(xy) < 2:
        raise ValueError("fewer than 2 cells have a position on the image")
    query = xy[np.random.default_rng(seed).choice(len(xy), min(sample, len(xy)), replace=False)]
    dist = cKDTree(xy).query(query, k=2)[0][:, 1]
    return float(np.median(dist[dist > 0]) / 2)


def _deck_radius(mdv, radius_px, fraction=0.7):
    """The radius setting of a tissue chart with layers for dots of fraction × radius_px image pixels.

    That chart reads radius × course_radius as 1/10000 of the larger range of x and y, not as pixels (MDV 1.3.0
    reads pixels). A dot smaller than the cell leaves the outlines and the image visible."""
    xy = [np.asarray(mdv.get_column(OBS, c), dtype=float) for c in ("x", "y")]
    span = max(float(np.nanmax(v) - np.nanmin(v)) for v in xy)
    total = fraction * radius_px * 10000 / span
    return {"radius": round(total, 2), "course_radius": 1} if total <= 20 else {"radius": round(total / 10, 2), "course_radius": 10}


def _label_axis(columns, field):
    """A y axis wide enough for the longest category of a text column (the default of 40 px cuts the labels)."""
    longest = max((len(str(v)) for v in columns[field].get("values", [])), default=8)
    return {"y": {"size": min(280, 16 + 6 * longest), "tickfont": 10, "label": ""}, "x": {"size": 40, "tickfont": 10}}


def _region(template, cid, title, color_by, gssize, gsposition, radius):
    chart = copy.deepcopy(template)
    sizes = radius if isinstance(radius, dict) else {"radius": radius}
    chart.update(id=cid, title=title, color_by=color_by, color_legend={"display": True}, opacity=0.8,
                 gssize=gssize, gsposition=gsposition, size=[gssize[0] * 100, gssize[1] * 100], **sizes)
    chart.pop("position", None)
    return chart


LAYERED_CHARTS = ("SpatialDataMdvRegionReact",)   # tissue charts with a layer stack (SpatialData.js viewer)


def _store_elements(mdv, region):
    """{"images"|"shapes"|"points"|"labels": [element names]} of the copy of the store of a region."""
    store = os.path.join(mdv.dir, "spatial", (region.get("spatial") or {}).get("file", ""))
    found = {}
    for kind in ("images", "shapes", "points", "labels"):
        d = os.path.join(store, kind)
        found[kind] = sorted(e for e in os.listdir(d) if not e.startswith(".") and os.path.isdir(os.path.join(d, e))) \
            if os.path.isdir(d) else []
    return found


STAIN_COLORS = {"dapi": [0, 0, 255], "hoechst": [0, 0, 255], "dna": [0, 0, 255], "nuclear": [0, 0, 255],
                "histone": [255, 255, 255], "gfap": [0, 255, 0], "rrna": [255, 0, 255], "membrane": [255, 255, 0],
                "cd45": [255, 0, 0], "panck": [0, 255, 0], "cd68": [255, 0, 255]}
NUCLEAR = {"dapi", "hoechst", "dna", "nuclear"}
STRUCTURAL = {"histone", "rrna", "membrane", "cd298_b2m", "b2m"}


def _shown_channels(names, n=3):
    """The channels that the image layer shows first: the nuclear stain, then the cell-type stains, then the
    structural stains, and a channel with only a letter as its name last (it has no target)."""
    rank = lambda i: (0 if names[i].lower() in NUCLEAR else 2 if names[i].lower() in STRUCTURAL
                      else 3 if len(names[i]) <= 1 else 1, i)
    return sorted(range(len(names)), key=rank)[:n]
OTHER_COLORS = [[255, 0, 0], [0, 255, 0], [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 128, 0]]


def _image_info(mdv, region, name):
    """(µm per pixel in the coordinate system of the region, the channel config of the image layer).

    An RGB image (channels r, g, b) shows in its own colors. A fluorescence image shows its first three channels,
    each in the color of its stain, with contrast limits from the 0.5 and 99.8 percentiles of its coarsest level."""
    import spatialdata as sd
    from spatialdata.transformations import get_transformation
    store = os.path.join(mdv.dir, "spatial", (region.get("spatial") or {}).get("file", ""))
    image = sd.read_zarr(store, selection=("images",)).images[name]
    system = (region.get("spatial") or {}).get("coordinate_system", "global")
    level0 = image["scale0"].image if hasattr(image, "children") else image
    matrix = get_transformation(level0, system).to_affine_matrix(input_axes=("x", "y"), output_axes=("x", "y"))
    um_per_px = float(abs(matrix[0, 0]))
    coarsest = image[sorted(image.children)[-1]].image if hasattr(image, "children") else image
    names = [str(c) for c in coarsest.coords["c"].values]
    if [n.lower() for n in names] == ["r", "g", "b"]:
        top = 255 if coarsest.dtype == np.uint8 else float(np.iinfo(coarsest.dtype).max) if coarsest.dtype.kind in "ui" else 1.0
        return um_per_px, {"colors": [[255, 0, 0], [0, 255, 0], [0, 0, 255]], "contrastLimits": [[0, top]] * 3,
                           "channelsVisible": [True] * 3, "selections": [{"c": i} for i in range(3)]}
    data = np.asarray(coarsest.values, dtype=float)
    shown = _shown_channels(names)
    others = iter(OTHER_COLORS)
    colors, limits = [], []
    for i in shown:
        values = data[i][data[i] > 0]
        lo, hi = (np.percentile(values, [0.5, 99.8]) if values.size else (0.0, 1.0))
        limits.append([float(lo), float(max(hi, lo + 1))])
        colors.append(STAIN_COLORS.get(names[i].lower()) or next(others))
    return um_per_px, {"colors": colors, "contrastLimits": limits, "channelsVisible": [True] * len(shown),
                       "selections": [{"c": i} for i in shown]}


def _render_stack(elements, main_image, gene_tiles, channels=None, show_tiles=True):
    """The layers of the tissue chart: the main image (the other images hidden), the cell outlines, and the
    transcripts of gene_tiles. MDV adds its own overlays (the cells, colored by the chart) when it loads the stack."""
    entries, n = [], 0
    def entry(kind, key, visible, props):
        nonlocal n
        n += 1
        entries.append({"kind": "spatial", "id": f"spatialdata-{kind}-{key}-#mdv{n:02d}", "visible": visible,
                        "source": {"elementType": kind, "elementKey": key}, "props": props})
    images = elements["images"]
    for img in ([main_image] if main_image in images else []) + [i for i in images if i != main_image]:
        props = {"channels": (channels or {})[img]} if (channels or {}).get(img) else {}
        entry("image", img, img == main_image or main_image not in images and img == images[0], props)
    for key in elements["shapes"]:
        # a faint fill and a 1-pixel edge: the edge alone does not draw in every renderer (measured), the fill does
        entry("shapes", key, True, {"fillColor": [255, 255, 255, 30], "strokeColor": [255, 255, 255, 200],
                                    "strokeWidth": 1, "strokeWidthUnits": "pixels", "strokeWidthMinPixels": 1,
                                    "strokeWidthMaxPixels": 2})
    for key in elements["points"]:
        entry("points", key, bool(gene_tiles) and show_tiles, {"pointSize": 2, "featureNames": list(gene_tiles)})
    return {"schemaVersion": 2, "entries": entries}


def gene_field(mdv, gene):
    """The field of the expression of one gene in the cells (the first expression set, "Gene Scores")."""
    link = mdv.get_datasource_metadata(OBS).get("links", {}).get(VAR, {}).get("rows_as_columns", {})
    sg = next(iter(link.get("subgroups", {})), None)
    if sg is None:
        raise ValueError("the cells have no expression link to the genes")
    names = [str(g) for g in mdv.get_column(VAR, link.get("name_column", "name"))]
    if gene not in names:
        raise ValueError(f"gene {gene!r} is not in the genes of the project")
    return f"{sg}|{gene}({sg})|{names.index(gene)}"


def add_views(mdv, cell_type, embedding, qc, spatial, readme_md, gene_tiles=(), markers=(), domain=None):
    """Replace the views of the conversion with "Tissue" (or "Cells"), "Markers", "Domains", "QC", and "About this
    project".

    cell_type: the cell-type column. embedding: the obsm key of the UMAP ("UMAP" gives UMAP_1, UMAP_2).
    qc: {role: column}. "counts" (transcripts or UMIs per cell) is necessary. "sample" (text) groups a violin.
        Each other numeric column gets a histogram. A column is its field or its label.
    readme_md: the README of the project. It is the only text of "About this project".
    gene_tiles: up to 8 genes whose transcripts the Tissue view shows, from the points of the store (a tissue
        chart with a layer stack only). The user selects other genes in the layer panel.
    markers: genes for a "Markers" view: a dot plot of the cell types by the genes. Give the top markers of each type.
    domain: a column of spatial domains (spatial_domains) for a "Domains" view.
    """
    columns = {c["field"]: c for c in mdv.get_datasource_metadata(OBS)["columns"]}
    if "counts" not in qc:
        raise ValueError("qc needs a 'counts' column")
    cell_type = _field(columns, cell_type)
    qc = {role: _field(columns, key) for role, key in qc.items()}
    x, y = _field(columns, f"{embedding}_1"), _field(columns, f"{embedding}_2")
    name = lambda f: columns[f].get("name", f)
    views, state = mdv.views, mdv.state
    template = None
    if spatial:
        regions = (mdv.get_datasource_metadata(OBS).get("regions") or {}).get("all_regions", {})
        template = next((c for v in views.values() for c in v.get("initialCharts", {}).get(OBS, [])
                         if c.get("region") in regions), None)    # the tissue chart; its type differs between versions
        if template is None:
            raise ValueError("the conversion made no tissue chart: the store has no image region for the table")
        radius = _cell_radius(mdv)
        if template.get("type") in LAYERED_CHARTS:
            region = regions[template["region"]]
            main_image = os.path.basename((region.get("viv_image") or {}).get("file", ""))
            elements = _store_elements(mdv, region)
            info = {img: _image_info(mdv, region, img) for img in elements["images"]}
            # The cells' x and y are pixels of the main image, but this chart draws in the coordinate system of the
            # store: regions.scale (µm per pixel of the main image) puts the cells on the image.
            if main_image in info:
                meta = mdv.get_datasource_metadata(OBS)
                meta["regions"]["scale"] = info[main_image][0]
                mdv.set_datasource_metadata(meta)
            radius = _deck_radius(mdv, radius)
            channels = {img: c for img, (_, c) in info.items()}
            # At the zoom of the slide, millions of transcripts cover the cells: the Tissue view selects the genes
            # but hides the layer, and the "Gene tiles" view shows it over faded cells.
            tiles = list(gene_tiles)[:8]
            tiles_chart = dict(copy.deepcopy(template), renderStack=_render_stack(elements, main_image, tiles, channels))
            template = dict(copy.deepcopy(template),
                            renderStack=_render_stack(elements, main_image, tiles, channels, show_tiles=False))
            plain = dict(copy.deepcopy(template), renderStack=_render_stack(elements, main_image, [], channels))
        else:
            if gene_tiles:
                print("add_views: this tissue chart has no layer stack: the gene tiles are not shown")
            plain = template
            tiles_chart = None

    first = "Tissue" if spatial else "Cells"
    if spatial:
        main = [_region(template, "tis01", "Tissue", cell_type, [8, 6], [0, 0], radius),
                _scatter("tis02", "UMAP", x, y, cell_type, False, [4, 3], [8, 0]),
                _chart("tis03", "row_chart", name(cell_type), [cell_type], [4, 3], [8, 3])]
    else:
        main = [_scatter("cel01", "UMAP", x, y, cell_type, True, [8, 6], [0, 0]),
                _chart("cel02", "row_chart", name(cell_type), [cell_type], [4, 6], [8, 0])]
    genes = [dict(copy.deepcopy(c), id=f"gen{i:02d}") for i, c in enumerate(GENE_CHARTS, 1)]

    qc_charts, n = [], 0
    for role, field in qc.items():
        meta = columns[field]
        if role == "sample" or meta.get("datatype") not in ("double", "integer", "int32"):
            continue
        lo, hi = (meta.get("minMax") or [0, 1])[:2]
        qc_charts.append(_chart(f"qc{n + 1:02d}", "bar_chart", name(field), [field], [4, 3], [4 * (n % 3), 3 * (n // 3)],
                                bin_number=50, display_min=lo, display_max=hi))
        n += 1
    row = 3 * ((n + 2) // 3)
    if spatial:
        qc_charts.append(_region(plain, "qc90", f"Tissue by {name(qc['counts'])}", qc["counts"], [8, 6], [0, row], radius))
    if "sample" in qc:
        qc_charts.append(_chart("qc91", "violin_plot", f"{name(qc['counts'])} by {name(qc['sample'])}",
                                [qc["sample"], qc["counts"]], [4, 6], [8 if spatial else 0, row]))

    text = readme_md.strip()
    about = _chart("abo01", "text_box_chart", "About this project", [], [12, 8], [0, 0], text=text)
    grid = {"layout": "gridstack", "panelWidth": 70}
    full = dict(grid, panelWidth=100)
    views = {first: {"initialCharts": {OBS: main, VAR: genes},
                     "dataSources": {OBS: grid, VAR: {"layout": "absolute", "panelWidth": 30}}}}
    if spatial and gene_tiles and tiles_chart is not None:
        gt = _region(tiles_chart, "gtl01", f"Gene tiles: {', '.join(list(gene_tiles)[:8])}", cell_type, [12, 9], [0, 0], radius)
        gt["opacity"] = 0.25          # the cells stay as faded context under the transcripts
        views["Gene tiles"] = {"initialCharts": {OBS: [gt], VAR: [dict(copy.deepcopy(c), id=f"gtg{i:02d}") for i, c in enumerate(GENE_CHARTS, 1)]},
                               "dataSources": {OBS: grid, VAR: {"layout": "absolute", "panelWidth": 30}}}
    if markers:
        fields = [gene_field(mdv, g) for g in dict.fromkeys(markers)]
        width = 7 if spatial else 12
        mk = [_chart("mrk01", "dot_plot", f"Markers by {name(cell_type)}", [cell_type, *fields], [width, 7], [0, 0],
                     axis=_label_axis(columns, cell_type))]
        if spatial:
            mk.append(_region(plain, "mrk02", f"Tissue by {markers[0]}", fields[0], [5, 7], [7, 0], radius))
        views["Markers"] = {"initialCharts": {OBS: mk}, "dataSources": {OBS: full}}
    if domain:
        domain = _field(columns, domain)
        dm = [_chart("dom02", "stacked_row_chart", f"{name(cell_type)} by {name(domain)}", [domain, cell_type], [4, 6], [8, 0],
                     axis=_label_axis(columns, domain), color_legend={"display": True}),
              _chart("dom03", "row_chart", name(domain), [domain], [4, 4], [8, 6])]
        if spatial:
            dm.insert(0, _region(plain, "dom01", name(domain), domain, [8, 8], [0, 0], radius))
        views["Domains"] = {"initialCharts": {OBS: dm}, "dataSources": {OBS: full}}
    views["QC"] = {"initialCharts": {OBS: qc_charts}, "dataSources": {OBS: full}}
    views["About this project"] = {"initialCharts": {OBS: [about]}, "dataSources": {OBS: full}}
    mdv.views = views
    state["all_views"] = list(views)
    state["initial_view"] = first
    mdv.state = state
    with open(os.path.join(mdv.dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(text + "\n")


def zip_project(out_dir):
    """<out_dir>.mdv.zip with the project files at its root, the layout that the import of MDV reads."""
    out_dir = os.path.abspath(out_dir)
    path = out_dir + ".mdv.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
        for root, _, files in os.walk(out_dir):
            for name in sorted(files):
                full = os.path.join(root, name)
                z.write(full, os.path.relpath(full, out_dir))
    return path
```

## 3. Build the project

```python
import anndata as ad
from mdv_asset import preflight, build_asset, round_columns, write_asset
from mdv_project import write_project, add_table, add_views, zip_project

adata = ad.read_h5ad(PROCESSED_H5AD)        # large files: read X with read_csr_rows (memory-and-scale.md)
preflight(adata, grouping=["cell_type", "cluster", "sample"])
CELLS = {                                   # field -> label that people read, in display order
    "cell_type": "Cell type (putative)",
    "cluster": "Cluster",
    "sample": "Sample",
    "total_counts": "UMIs per cell",
    "n_genes_by_counts": "Genes detected",
    "pct_counts_mt": "Mitochondrial reads (%)",
}
round_columns(adata.obs, {"pct_counts_mt": 2})
asset = build_asset(adata, CELLS,
                    var_labels={"highly_variable": "Highly variable"},
                    obsm_keys={"X_umap": "UMAP"},           # MDV columns UMAP_1, UMAP_2
                    uns={"title": TITLE, "expression": "normalize_total (median) + log1p"})
write_asset(asset, f"{OUT}/{NAME}.mdv.h5ad")                 # run the table validator on it (validation.md)
mdv = write_project(f"{OUT}/{NAME}.mdv.h5ad", f"{OUT}/{NAME}")
add_table(mdv, "clusters", cluster_table, {"cluster": "Cluster", "top_genes": "Top DE genes"})
add_views(mdv, "Cell type (putative)", "UMAP",
          {"counts": "UMIs per cell", "genes": "Genes detected", "mito": "Mitochondrial reads (%)", "sample": "Sample"},
          spatial=False, readme_md=README_TEXT)
zip_project(f"{OUT}/{NAME}")                                 # run the project check on it (validation.md)
```

Convert the file that the validator read, not the AnnData in memory. Then the validator and the
conversion see the same encodings. For spatial data, put the asset into the SpatialData store and
use `write_spatial_project` in place of `write_project` (`spatial-transcriptomics.md`).

## 4. The views

`add_views` replaces the views of the conversion. The project opens on the first view:

| View | Charts |
|---|---|
| "Tissue" (spatial) | the cells on the image, colored by the cell type, with a legend. The UMAP in the same colors. A row chart of the cell types. The gene table and the gene finder. On a tissue chart with layers (newer MDV): the main image, the other images hidden, the cell outlines, and the gene tiles of `gene_tiles` |
| "Gene tiles" (spatial, with `gene_tiles`, newer MDV) | the tissue with the transcripts of the `gene_tiles` genes over faded cells. The Tissue view selects the same genes but hides the layer: at the zoom of the slide, millions of transcripts cover the cells |
| "Markers" | a dot plot of the cell types by the `markers` genes. For spatial data, the tissue colored by the first marker |
| "Domains" (spatial, with `domain`) | the tissue colored by the domain. A stacked row chart of the cell types in each domain. A row chart of the domains |
| "Cells" (not spatial) | the UMAP colored by the cell type, with a legend. A row chart of the cell types. The gene table and the gene finder |
| "QC" | a histogram of each numeric QC column. For spatial data, the cells on the image colored by the counts. A violin of the counts for each sample |
| "About this project" | the README |

A click on a cell type in the row chart filters the other charts of the view. The user can change
and save the views in MDV.

Give `gene_tiles` one marker of each main cell class, a maximum of 8 (`top_markers` of the classes
with `prefer` set to the known markers). The user selects other genes in the layer panel of the
tissue chart. MDV loads the transcripts of a selected gene on demand.

## 5. Context tables

Small tables that answer "can I trust this?" go into the project as more datasources, with
`add_table`:

| Table | One row is | Columns |
|---|---|---|
| `clusters` | a cluster | label, cells, top DE genes, marker evidence |
| `cell_types` | a cell type | class, cells, the marker genes of the dot plot |
| `subclusters` | a subcluster of `refine_labels` | the subtype call, top DE genes, marker evidence |
| `domains` | a spatial domain | cells, the main cell types of its neighborhoods |
| `samples` | a sample, a slide, or a donor | design factors, cells before and after QC, median counts |
| `fovs` (CosMx and other FOV platforms) | a field of view | the FOV center in slide µm, cells, cells after QC, median transcripts per cell, fraction of transcripts in cells, negative-probe transcripts |

## 6. The README

Give the README text to `add_views`, and write the same text next to the zip. Use these sections:

1. **Contents** — the views, each table of the project, its rows, and what one row is.
2. **Opening in MDV** — both ways of "The way into MDV".
3. **Processing** — the steps with their parameters, thresholds, seeds, and package versions. The
   QC counts: the cells in, the cells kept, and the reasons.
4. **Column glossary** — each column of each table, with units.
5. **Caveats** — what is putative, what was dropped, what is not in the project (raw counts).

## The way into MDV

A deployment of MDV adds the project in one of two ways:

- **"Import an existing project".** The user imports `<name>.mdv.zip` from the catalog. MDV 1.3.0
  shows this tile only in a development build.
- **The projects directory.** The operator of the server unzips the zip into a new folder of the
  projects directory (`/app/mdv` in the MDV image). Then "Rescan Projects" in the catalog, or a
  restart of the server, adds the project. With authentication, only an administrator can rescan.
  The name of the folder becomes the name of the project.

The import of MDV 1.3.0 has these rules:

- It refuses a zip above 20,000 MiB.
- It refuses an entry with `..` or an absolute path.
- It finds `views.json`, `state.json`, and `datasources.json` at the root of the zip, or under one
  folder.
- The server reads the full zip into memory.

The projects directory does not go through the import, so the import limit does not apply to it.

## What the conversion does with each slot

The conventions of `SKILL.md` give the rules, and `build_asset`, `put_table`, and the table
validator enforce them. These are the facts behind the rules.

| AnnData slot | In MDV |
|---|---|
| `obs` columns | columns of `cells`. The label in `uns["mdv_labels"]` is the name that MDV shows |
| `obs_names` | the column `mdv_cell_id` (`unique`) |
| `obsm[k]` (2-D) | the columns `k_1`, `k_2`, `k_3` (the first 3 only). In a spatial table, `obsm["spatial"]` gives `spatial_1` and `spatial_2` |
| `var` columns, `var_names` | columns of `genes`. `var_names` gives the column `name`, which replaces a `name` column |
| `varm[k]` | the columns `k_1…k_3` of `genes` |
| `X` | the expression set "Gene Scores", sparse when X is sparse |
| `layers[k]` | one more expression set for each layer, as large as X, with the label of `uns["mdv_labels"]` |
| `uns`, `raw`, `obsp`, `varp` | not used. MDV ignores the colors in `uns["*_colors"]` and uses its default palette, so the user sets the colors in MDV |

## The dtypes

| Stored as | MDV datatype |
|---|---|
| int8, int16, int64, uint8, uint16, uint32 | `integer` (float32, exact to 2^24) |
| int32, float32, float64 | `double` |
| categorical text, object text, bool | `text` (`text16` above 256 values, `unique` above 65,536) |
| uint64, float16, nullable Int/Float/boolean, pandas `string`, complex | **KeyError: the conversion stops** |
