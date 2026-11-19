# Validation

Run two checks before delivery. The table validator reads the asset as stored, before mdvtools
converts it. The project check reads the project folder and its zip, after `zip_project`. Zero
errors in both is the bar. Then read the warnings: they make the difference between a project that
opens and a project that is useful.

mdvtools converts the asset with no check. A dtype that it cannot map stops the conversion, a
duplicate name multiplies rows, and a bare cluster ID shows as a number. MDV opens the views with
no check. A view that names a column that is not in the project opens as an empty chart, with no
error.

## The table validator

| Kind | Checks |
|---|---|
| errors | the file is an AnnData. Each HDF5 encoding is one that the reader knows (no nullable arrays). X is sparse, float, and log-scale. The obs and var names are unique. The gene names have no `\|` or `(`. Each obs and var column is a number type that MDV maps, or categorical text. Each field is safe and unique without regard to case. No column uses a reserved field. The layers are sparse. anndata can read the file |
| warnings | `uns["mdv_labels"]` is missing, or a column has no readable label. Categories that are bare numbers. More than 256 categories (text16). Plain text that is not categorical. Booleans that show as True/False. Integers above 2^24. Columns with no value. obsm entries that are not 2-D, have more than 3 columns, or are PCA. Layers. varm, obsp, varp, raw |

```
python validate_mdv_asset.py <name>.mdv.h5ad > <name>.mdv.validation.json
```

It prints a JSON report with a summary (cells, genes, non-zeros, the columns, the size), and it
exits 1 on an error. On an error, fix the step that made the problem (usually the curation in
`build_asset`), and write the asset again. Do not patch the file.

```python
# file: validate_mdv_asset.py
"""Validate the curated AnnData on disk, before mdvtools converts it into the MDV project.

convert_scanpy_to_mdv reads the AnnData as anndata stores it. This checks the file as that reader sees it:
the HDF5 encodings, the dtypes MDV maps, the names that mdvtools and SpatialData reserve or refuse, the labels
in uns["mdv_labels"], and what MDV would show as noise. Prints a JSON report; exit 1 on any error.
"""
import json, os, re, sys

import h5py
import numpy as np

KNOWN_ENCODINGS = {"anndata", "dataframe", "categorical", "string-array", "array", "csr_matrix", "csc_matrix",
                   "dict", "numeric-scalar", "string"}
NUMERIC_OK = {"int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "float32", "float64"}
RAW_ID = re.compile(r"^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$")     # snake_case ids such as total_counts
FIELD = re.compile(r"^(?!__)[\w.-]+$")                     # the SpatialData rule for a column or a key
RESERVED = {"obs": {"mdv_cell_id", "x", "y", "spatial_region", "spatialdata_path", "table_name"}, "var": {"name"}}
BARE_ID = re.compile(r"^-?\d+(\.0)?$")


def enc(node):
    v = node.attrs.get("encoding-type", "")
    return v.decode() if isinstance(v, bytes) else str(v)


def scalar(node):
    v = node[()]
    return v.decode() if isinstance(v, bytes) else str(v)


def strings(node):
    ds = node["values"] if isinstance(node, h5py.Group) else node      # nullable-string-array keeps its values in a group
    return [x.decode() if isinstance(x, bytes) else str(x) for x in ds[()]]


def main(path):
    errors, warnings, summary = [], [], {}
    err, warn = errors.append, warnings.append
    if not os.path.isfile(path):
        return report([f"no file {path}"], [], {})
    summary["size_gb"] = round(os.path.getsize(path) / 1e9, 3)
    with h5py.File(path, "r") as f:
        if enc(f) != "anndata":
            return report(["the file is not an AnnData h5ad"], [], summary)

        def visit(name, node):
            e = enc(node)
            if e == "nullable-string-array":
                err(f"{name}: nullable string array (pandas 3 strings); MDV's reader makes it the 'string' dtype and the "
                    "conversion aborts with KeyError 'string'. Write names as plain str and text columns as categorical")
            elif e and e not in KNOWN_ENCODINGS:
                err(f"{name}: encoding {e!r} is not one that MDV's reader is known to read (use categorical text, plain numbers)")
        f.visititems(visit)

        # X
        if "X" not in f:
            err("X is missing")
        else:
            e = enc(f["X"])
            if e not in ("csr_matrix", "csc_matrix"):
                err(f"X is {e or 'dense'}: give a sparse log-normalised matrix")
            else:
                data = f["X"]["data"]
                summary["nnz"] = int(data.shape[0])
                sample = data[: min(data.shape[0], 2_000_000)]
                if sample.size and (sample.min() < 0 or sample.max() > 50):
                    err("X does not look log-normalised (negative or very large values)")
                if data.dtype.kind != "f":
                    err(f"X values are {data.dtype}: give normalised float values")

        # obs / var
        labels = {}
        if "uns" in f and "mdv_labels" in f["uns"]:
            for ds, frame in (("cells", "obs"), ("genes", "var")):
                node = f["uns"]["mdv_labels"].get(ds)
                labels[frame] = {k: scalar(v) for k, v in node.items()} if node is not None else {}
        else:
            warn("uns['mdv_labels'] is missing: MDV shows each column by its field; build the table with build_asset")
        for frame in ("obs", "var"):
            reserved = RESERVED[frame]
            if frame not in f:
                err(f"{frame} is missing"); continue
            g = f[frame]
            idx_key = g.attrs.get("_index", "_index")
            idx_key = idx_key.decode() if isinstance(idx_key, bytes) else idx_key
            index = strings(g[idx_key])
            summary["cells" if frame == "obs" else "genes"] = len(index)
            if len(set(index)) != len(index):
                err(f"{frame} names are not unique: MDV multiplies the duplicated rows")
            if frame == "var":
                bad = [x for x in index if "|" in x or "(" in x]
                if bad:
                    err(f"gene names with '|' or '(' break MDV gene columns: {bad[:5]}")
            order = [c.decode() if isinstance(c, bytes) else str(c) for c in g.attrs.get("column-order", [])]
            summary[f"{frame}_columns"] = order
            unsafe = [c for c in order if not FIELD.match(c) or c in (".", "..")]
            if unsafe:
                err(f"{frame} columns {unsafe[:4]}: a field uses only letters, digits, '_', '.', '-'; put the readable "
                    "label in uns['mdv_labels'] (build_asset)")
            if len({c.lower() for c in order}) != len(order):
                err(f"{frame} column names must be unique without regard to case (a SpatialData rule)")
            named = labels.get(frame, {})
            raw_like = [c for c in order if RAW_ID.match(named.get(c, c))]
            if order and named and raw_like:
                warn(f"{frame}: columns with no readable label ({raw_like[:4]}); MDV shows the label as the column name")
            for c in sorted(reserved & set(order)):
                err(f"{frame} column {c!r} is reserved: mdvtools writes its own")
            for c in order:
                node = g[c]
                e = enc(node)
                if e == "categorical":
                    cats = node["categories"]
                    if enc(cats) != "string-array":
                        err(f"{frame}.{c}: categories are {enc(cats) or cats.dtype}; use text categories")
                        continue
                    values = strings(cats)
                    if len(values) > 256:
                        warn(f"{frame}.{c}: {len(values)} categories become text16/unique in MDV; most category charts refuse it")
                    if values and all(BARE_ID.match(v) for v in values):
                        warn(f"{frame}.{c}: categories are bare numbers ({values[:3]}…); give readable labels")
                elif e == "string-array":
                    warn(f"{frame}.{c}: plain text column; write text as categorical")
                elif e == "array":
                    kind = node.dtype.name
                    if kind == "bool":
                        warn(f"{frame}.{c}: boolean shows as True/False; map it to words")
                    elif kind not in NUMERIC_OK:
                        err(f"{frame}.{c}: dtype {kind} aborts MDV's conversion")
                    elif node.dtype.kind in "iu" and node.shape[0] and int(np.max(node[()])) > 2 ** 24:
                        warn(f"{frame}.{c}: integers above 2^24 lose precision in MDV (float32)")
                    elif node.dtype.kind == "f" and node.shape[0] and np.isnan(node[()]).all():
                        warn(f"{frame}.{c}: every value is missing")
                else:
                    err(f"{frame}.{c}: encoding {e!r} is not a plain number or categorical text")

        # obsm, varm, layers, the rest
        for key in (f["obsm"].keys() if "obsm" in f else []):
            node = f["obsm"][key]
            if enc(node) != "array" or len(node.shape) != 2:
                warn(f"obsm[{key!r}] is not a 2-D array: MDV skips it")
                continue
            if node.shape[1] > 3:
                warn(f"obsm[{key!r}] has {node.shape[1]} columns: MDV keeps 3 as {key}_1..3")
            if key.lower() in ("x_pca", "pca"):
                warn(f"obsm[{key!r}]: PCA columns are noise in MDV; leave them out")
        summary["obsm"] = list(f["obsm"].keys()) if "obsm" in f else []
        for key in (f["layers"].keys() if "layers" in f else []):
            if enc(f["layers"][key]) not in ("csr_matrix", "csc_matrix"):
                err(f"layers[{key!r}] is dense: MDV stores it in full")
            else:
                warn(f"layers[{key!r}] becomes one more expression set in MDV (as large as X); keep it only if needed")
        summary["layers"] = list(f["layers"].keys()) if "layers" in f else []
        for slot in ("varm", "obsp", "varp"):
            if slot in f and len(f[slot].keys()):
                warn(f"{slot} is not empty: MDV adds varm as gene columns and ignores obsp/varp; leave them out")
        if "raw" in f:
            warn("raw is present: MDV ignores it; it only adds size")

    # Readable with anndata at all (the sandbox version)
    try:
        import anndata as ad
        a = ad.read_h5ad(path, backed="r")
        _ = a.obs.head(), a.var.head()
        a.file.close()
    except Exception as e:
        err(f"anndata cannot read the file: {type(e).__name__}: {e}")
    return report(errors, warnings, summary)


def report(errors, warnings, summary):
    print(json.dumps({"ok": not errors, "errors": errors, "warnings": warnings, "summary": summary}, indent=2, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

## The project check

| Kind | Checks |
|---|---|
| errors | a project file is missing. A datasource has no group in `datafile.h5`, or a column has no data. A region image is not under `spatial/`, or the shapes file of a region is missing. `state.json` names a view that `views.json` does not have. The first view is not "Tissue" or "Cells", or a project with regions does not open on "Tissue". A chart names a column or a region that the project does not have. The zip is missing, has an entry with `..` or an absolute path, does not hold the project files at its root, or is above the import limit of MDV |
| warnings | columns that MDV shows by their field, with no label. `README.md` is missing in the project |

```
python check_mdv_project.py <name> > <name>.mdv.check.json
```

Give the project folder. The check finds `<name>.mdv.zip` next to it. The summary gives the size
of each datasource, the regions, the images, and the sizes of `datafile.h5`, `spatial/`, and the
zip in MB. Write the sizes in the README. On an error, fix the step that made the problem, and
make the project again.

```python
# file: check_mdv_project.py
"""Check an MDV project folder and its zip before delivery: the files, the views, the regions, the sizes.

Prints a JSON report {ok, errors, warnings, summary}; exit 1 on any error.
"""
import json
import os
import re
import sys
import zipfile

import h5py

REQUIRED = ("datafile.h5", "datasources.json", "views.json", "state.json")
FIRST_VIEWS = ("Tissue", "Cells")
IMPORT_LIMIT_MB = 20000 * 1024 * 1024 / 1e6     # the import dialog of MDV 1.3.0 refuses a larger zip
RAW_ID = re.compile(r"^[a-z0-9]+(_[a-z0-9]+)+$")


def _size_mb(path):
    if os.path.isfile(path):
        return os.path.getsize(path) / 1e6
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs) / 1e6


def _fields(chart):
    """The column fields that a chart names: param, color_by, and the background filter."""
    out = [p for p in chart.get("param", []) if isinstance(p, str)]
    if isinstance(chart.get("color_by"), str):
        out.append(chart["color_by"])
    column = (chart.get("background_filter") or {}).get("column")
    if column:
        out.append(column)
    return out


def main(project_dir):
    errors, warnings, summary = [], [], {}
    err, warn = errors.append, warnings.append
    missing = [f for f in REQUIRED if not os.path.isfile(os.path.join(project_dir, f))]
    if missing:
        return report([f"missing {f}" for f in missing], [], summary)
    load = lambda f: json.load(open(os.path.join(project_dir, f), encoding="utf-8"))
    datasources = {d["name"]: d for d in load("datasources.json")}
    views, state = load("views.json"), load("state.json")
    columns = {ds: {c["field"]: c for c in d.get("columns", [])} for ds, d in datasources.items()}
    summary.update({ds: d.get("size") for ds, d in datasources.items()})

    with h5py.File(os.path.join(project_dir, "datafile.h5"), "r") as h5:
        for ds, cols in columns.items():
            if ds not in h5:
                err(f"datafile.h5 has no group for datasource {ds!r}")
                continue
            absent = [f for f in cols if f not in h5[ds]]
            if absent:
                err(f"{ds}: columns without data in datafile.h5: {absent[:5]}")
    for ds, cols in columns.items():
        unlabelled = [f for f, c in cols.items() if c.get("name", f) == f and RAW_ID.match(f)]
        if unlabelled:
            warn(f"{ds}: columns that MDV shows by their field, with no label: {unlabelled[:6]}")

    regions = (datasources.get("cells", {}).get("regions") or {}).get("all_regions", {})
    summary["regions"] = list(regions)
    images = []
    for name, region in regions.items():
        image = (region.get("viv_image") or {}).get("file")
        if not image:
            warn(f"region {name!r} has no image")
            continue
        images.append(image)
        if not os.path.isdir(os.path.join(project_dir, "spatial", image)):
            err(f"region {name!r}: image {image!r} is not under spatial/")
        if region.get("json") and not os.path.isfile(os.path.join(project_dir, region["json"])):
            err(f"region {name!r}: shapes file {region['json']!r} is missing")
    summary["images"] = images

    first = state.get("initial_view")
    summary["views"] = state.get("all_views", [])
    for name in state.get("all_views", []):
        if name not in views:
            err(f"state.json lists view {name!r}, which views.json does not have")
    if first not in FIRST_VIEWS:
        err(f"the view that opens first is {first!r}, not one of {FIRST_VIEWS}: run add_views")
    elif regions and first != "Tissue":
        err("the project has image regions, but the view that opens first is not 'Tissue'")
    for vname, view in views.items():
        for ds, charts in view.get("initialCharts", {}).items():
            if ds not in columns:
                err(f"view {vname!r}: datasource {ds!r} does not exist")
                continue
            for chart in charts:
                absent = [f for f in _fields(chart) if f not in columns[ds]]
                if absent:
                    err(f"view {vname!r}, chart {chart.get('title') or chart.get('type')!r}: no column {absent} in {ds}")
                if chart.get("region") and chart["region"] not in regions:
                    err(f"view {vname!r}: chart names region {chart['region']!r}, which the project does not have")
    if not os.path.isfile(os.path.join(project_dir, "README.md")):
        warn("README.md is missing in the project")

    summary["datafile_mb"] = round(_size_mb(os.path.join(project_dir, "datafile.h5")), 1)
    summary["spatial_mb"] = round(_size_mb(os.path.join(project_dir, "spatial")), 1) if os.path.isdir(
        os.path.join(project_dir, "spatial")) else 0
    zip_path = os.path.abspath(project_dir) + ".mdv.zip"
    if not os.path.isfile(zip_path):
        err(f"no zip {os.path.basename(zip_path)}: run zip_project")
    else:
        summary["zip_mb"] = round(_size_mb(zip_path), 1)
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
        bad = [n for n in names if n.startswith(("/", "\\")) or ".." in n]
        if bad:
            err(f"the import of MDV refuses zip entries with '..' or an absolute path: {bad[:3]}")
        if not set(REQUIRED) <= set(names):
            err("the zip does not hold the project files at its root")
        if summary["zip_mb"] > IMPORT_LIMIT_MB:
            err(f"the zip is {summary['zip_mb']:.0f} MB: the import of MDV refuses a zip above {IMPORT_LIMIT_MB:.0f} MB")
    return report(errors, warnings, summary)


def report(errors, warnings, summary):
    print(json.dumps({"ok": not errors, "errors": errors, "warnings": warnings, "summary": summary}, indent=2,
                     ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

## What the checks cannot see

The checks do not run MDV. They cannot see these things:

- the tissue under the cells is the correct image, at the correct position and scale
- the clusters look correct on the UMAP and on the tissue
- the colors of the categories are easy to tell apart

Open the project in MDV when the user can. Write in the README which view to look at first.
