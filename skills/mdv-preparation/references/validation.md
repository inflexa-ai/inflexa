# Validation

MDV checks nothing before it converts an upload: a dtype it cannot map aborts the conversion, a
duplicate name multiplies rows, and a bare cluster id shows as a number. Run this validator on
every asset before delivery. It reads the `.h5ad` as stored, so it checks what MDV's reader will
see, not what the step's pandas shows in memory. Zero errors is the bar. Then read the warnings:
they are the difference between loadable and useful.

## What it checks

| Kind | Checks |
|---|---|
| errors | the file is an AnnData; every HDF5 encoding is one that MDV's reader knows (no nullable arrays); X is sparse, float, and log-scale; obs and var names are unique; gene names have no `|` or `(`; every obs/var column is a plain number type that MDV maps or categorical text; no column uses the reserved labels `mdv_cell_id` (obs) or `name` (var); layers are sparse; anndata can read the file |
| warnings | column labels that are raw ids; categories that are bare numbers; more than 256 categories (text16); plain text not stored as categorical; booleans shown as True/False; integers above 2^24; all-missing columns; obsm entries that are not 2-D, have more than 3 columns, or are PCA; layers (each doubles the expression data); varm, obsp, varp, raw; a file above 5 GB; no README next to the asset |

## Run it

```
python validate_mdv_asset.py <asset>.mdv.h5ad > <asset>.mdv.validation.json
```

It prints a JSON report with a summary (cells, genes, non-zeros, the column labels, size) and
exits 1 on any error. On an error, fix the step that made the problem (usually the curation in
`build_asset`) and write the asset again; do not patch the file.

## The script

```python
# file: validate_mdv_asset.py
"""Validate an MDV-ready AnnData asset on disk, without mdvtools.

MDV loads an .h5ad by reading it (anndata) and converting it with convert_scanpy_to_mdv defaults.
This checks the file as that reader sees it: the HDF5 encodings, the dtypes MDV maps, the names it
reserves or cannot use, and what it would show as noise. Prints a JSON report; exit 1 on any error.
"""
import json, os, re, sys

import h5py
import numpy as np

KNOWN_ENCODINGS = {"anndata", "dataframe", "categorical", "string-array", "array", "csr_matrix", "csc_matrix",
                   "dict", "numeric-scalar", "string"}
NUMERIC_OK = {"int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "float32", "float64"}
RAW_ID = re.compile(r"^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$")     # snake_case ids such as total_counts
BARE_ID = re.compile(r"^-?\d+(\.0)?$")


def enc(node):
    v = node.attrs.get("encoding-type", "")
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
    if summary["size_gb"] > 5:
        warn(f"the file is {summary['size_gb']} GB: MDV asks for an import as a project above 5 GB")
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
        for frame, reserved in (("obs", "mdv_cell_id"), ("var", "name")):
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
            raw_like = [c for c in order if RAW_ID.match(c)]
            if order and len(raw_like) > len(order) / 2:
                warn(f"{frame}: most column labels are raw ids ({raw_like[:4]}…); MDV shows the label as the column name")
            if reserved in order:
                err(f"{frame} column {reserved!r} is reserved: MDV writes its own")
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
    if not os.path.isfile(os.path.join(os.path.dirname(os.path.abspath(path)), "README.md")):
        warn("README.md missing next to the asset: MDV has no column description field, so the README is the glossary")
    return report(errors, warnings, summary)


def report(errors, warnings, summary):
    print(json.dumps({"ok": not errors, "errors": errors, "warnings": warnings, "summary": summary}, indent=2, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
```

## What it cannot check

The validator does not run MDV. Two checks need the user's MDV:

- the upload converts (the validator checks every condition known to abort it, with mdvtools
  1.3.0, anndata 0.12.2, and pandas 2.3.2 on the MDV side);
- the tissue is upright in a scatter plot of the slide coordinates, and the cells look right on
  the UMAP. Say in the README which charts to make first.
