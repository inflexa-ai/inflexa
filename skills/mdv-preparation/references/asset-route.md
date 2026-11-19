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
```

Choose the marker lists for the tissue (adult human cortex, PBMC, tumor, …), and keep only the
genes in the panel. Keep the evidence: it becomes the `clusters` table of the project.

## 2. The helper modules

Copy these modules into the scripts of the step and import them. `mdv_asset.py` makes the asset.
`mdv_project.py` makes the project from it.

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
REGION_CHART = "VivMdvRegionReact"
MDVTOOLS_LABELS = {"x": "Image x (px)", "y": "Image y (px)", "spatial_region": "Region",
                   "spatialdata_path": "SpatialData store", "table_name": "SpatialData table", "mdv_cell_id": "Cell name",
                   "spatial_1": "Slide x", "spatial_2": "Slide y"}
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
    mdv.set_datasource_metadata(_rename(mdv, VAR, {"object_source": "SpatialData store", **(labels.get(VAR) or {})}))


def write_project(asset, out_dir):
    """The project of a curated AnnData (build_asset), or of the path of its .h5ad. Replaces out_dir."""
    from mdvtools.conversions import convert_scanpy_to_mdv
    os.makedirs(os.path.dirname(os.path.abspath(out_dir)), exist_ok=True)
    adata = ad.read_h5ad(asset) if isinstance(asset, str) else asset
    labels = copy.deepcopy(dict(adata.uns.get("mdv_labels", {})))
    mdv = convert_scanpy_to_mdv(out_dir, adata, delete_existing=True)
    label_columns(mdv, labels)
    return mdv


def write_spatial_project(sdata_path, out_dir):
    """The project of one SpatialData store (put_table): its table, images, and regions. Replaces out_dir."""
    import spatialdata as sd
    from mdvtools.spatial.conversion import SpatialDataConversionArgs, convert_spatialdata_to_mdv
    os.makedirs(os.path.dirname(os.path.abspath(out_dir)), exist_ok=True)
    tables = sd.read_zarr(sdata_path, selection=("tables",)).tables
    if len(tables) != 1:
        raise ValueError(f"the store has {len(tables)} tables: MDV merges them into one cells table; keep one (put_table)")
    labels = copy.deepcopy(dict(next(iter(tables.values())).uns.get("mdv_labels", {})))
    with tempfile.TemporaryDirectory() as tmp:
        mdv = convert_spatialdata_to_mdv(SpatialDataConversionArgs(
            spatialdata_path=os.path.abspath(sdata_path), output_folder=os.path.abspath(out_dir), temp_folder=tmp,
            output_geojson=True, link=False))
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


def _region(template, cid, title, color_by, gssize, gsposition, radius):
    chart = copy.deepcopy(template)
    chart.update(id=cid, title=title, color_by=color_by, color_legend={"display": True}, radius=radius, opacity=0.8,
                 gssize=gssize, gsposition=gsposition, size=[gssize[0] * 100, gssize[1] * 100])
    chart.pop("position", None)
    return chart


def add_views(mdv, cell_type, embedding, qc, spatial, readme_md):
    """Replace the views of the conversion with "Tissue" (or "Cells"), "QC", and "About this project".

    cell_type: the cell-type column. embedding: the obsm key of the UMAP ("UMAP" gives UMAP_1, UMAP_2).
    qc: {role: column}. "counts" (transcripts or UMIs per cell) is necessary. "sample" (text) groups a violin.
        Each other numeric column gets a histogram. A column is its field or its label.
    readme_md: the README of the project. It is the only text of "About this project".
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
        template = next((c for v in views.values() for c in v.get("initialCharts", {}).get(OBS, [])
                         if c.get("type") == REGION_CHART), None)
        if template is None:
            raise ValueError("the conversion made no tissue chart: the store has no image region for the table")
        radius = _cell_radius(mdv)

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
        qc_charts.append(_region(template, "qc90", f"Tissue by {name(qc['counts'])}", qc["counts"], [8, 6], [0, row], radius))
    if "sample" in qc:
        qc_charts.append(_chart("qc91", "violin_plot", f"{name(qc['counts'])} by {name(qc['sample'])}",
                                [qc["sample"], qc["counts"]], [4, 6], [8 if spatial else 0, row]))

    text = readme_md.strip()
    about = _chart("abo01", "text_box_chart", "About this project", [], [12, 8], [0, 0], text=text)
    grid = {"layout": "gridstack", "panelWidth": 70}
    mdv.views = {
        first: {"initialCharts": {OBS: main, VAR: genes},
                "dataSources": {OBS: grid, VAR: {"layout": "absolute", "panelWidth": 30}}},
        "QC": {"initialCharts": {OBS: qc_charts}, "dataSources": {OBS: dict(grid, panelWidth=100)}},
        "About this project": {"initialCharts": {OBS: [about]}, "dataSources": {OBS: dict(grid, panelWidth=100)}},
    }
    state["all_views"] = [first, "QC", "About this project"]
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
| "Tissue" (spatial) | the cells on the image, colored by the cell type, with a legend. The UMAP in the same colors. A row chart of the cell types. The gene table and the gene finder |
| "Cells" (not spatial) | the UMAP colored by the cell type, with a legend. A row chart of the cell types. The gene table and the gene finder |
| "QC" | a histogram of each numeric QC column. For spatial data, the cells on the image colored by the counts. A violin of the counts for each sample |
| "About this project" | the README |

A click on a cell type in the row chart filters the other charts of the view. The user can change
and save the views in MDV.

## 5. Context tables

Small tables that answer "can I trust this?" go into the project as more datasources, with
`add_table`:

| Table | One row is | Columns |
|---|---|---|
| `clusters` | a cluster | label, cells, top DE genes, marker evidence |
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
