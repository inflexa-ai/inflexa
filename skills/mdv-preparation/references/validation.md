# Validation

MDV has no project validator, and the browser only logs schema problems: a project with a wrong
category code or a missing column still opens and shows wrong data. Run this validator on every
project before delivery. Zero errors is the bar. Then look at the warnings: they are the
difference between loadable and useful.

## Layers

| Layer | Checks |
|---|---|
| L0 files | the three JSON files exist and are strict JSON (no NaN / Infinity) |
| L1 metadata | unique datasource names; positive `size`; per column: unique `field` without `|` or `/`, a known `datatype`, `values` within the category limit, one `#rrggbb` colour per value, finite `minMax`, `stringLength` where needed |
| L2 HDF5 | a dataset per column with the right dtype and length; category codes inside `values`; link `name_column` exists; sparse subgroups have consistent `p`/`i`/`x` |
| L3 views | `all_views` and `initial_view` are consistent; every `param` / `color_by` resolves (fields, virtual gene ids, RowsAsColsQuery links); background images exist; region fields exist; `permission` is `edit`; every datasource has a chart |
| L4 round trip | `MDVProject.get_datasource_as_dataframe` decodes every datasource with the right row count |
| L5 serve | the app page, the frontend bundle, and the JSON files serve; every column returns exactly `size × bytes` through `/get_data` |
| U usefulness (warnings) | display names set, a `text` grouping column, fixed colours, a README |

L5 runs the real `mdvtools.serverlite` WSGI app in process (no port, no browser). It uses
`werkzeug.test.Client` because `app.test_client()` fails with Flask 2.2 on Werkzeug 3.

## Run it

```
python validate_mdv_project.py <project>                 # all layers
python validate_mdv_project.py <project> --no-serve      # skip L5
python validate_mdv_project.py <project> --no-roundtrip  # skip L4 (large projects: it decodes every column)
```

It prints a JSON report and exits 1 on any error. Save the report next to the project. On an
error, fix the step that made the problem (usually the curation or the views) and write the
project again from the curated AnnData; do not patch the JSON files.

## The script

```python
# file: validate_mdv_project.py
"""Validate an MDV project directory without a browser.

Layers: L0 files, L1 metadata, L2 HDF5 consistency, L3 views/state/regions, L4 decode round trip,
L5 headless serve through mdvtools.serverlite. Usefulness checks give warnings, not errors.
Prints a JSON report; exit status 1 if any error.
"""
import json, math, os, re, sys

import h5py
import numpy as np

DATATYPES = {"text", "text16", "multitext", "integer", "double", "int32", "unique"}
CATEGORY_LIMIT = {"text": 256, "text16": 65536, "multitext": 65535}
H5_DTYPE = {"text": np.uint8, "text16": np.uint16, "multitext": np.uint16, "integer": np.float32, "double": np.float32, "int32": np.int32}
BYTES = {"text": 1, "text16": 2, "double": 4, "integer": 4, "int32": 4}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
VIRTUAL = re.compile(r"^([^|]+)\|([^|]*)\|(\d+)$")


def strict_json(path):
    def bad(c):
        raise ValueError(f"non-finite constant {c}")
    with open(path) as f:
        return json.load(f, parse_constant=bad)


def main(project, serve=True, roundtrip=True):
    errors, warnings = [], []
    err, warn = errors.append, warnings.append

    # L0 files
    for name in ("datasources.json", "views.json", "state.json"):
        if not os.path.isfile(os.path.join(project, name)):
            err(f"L0 missing {name}")
    if errors:
        return report(errors, warnings)
    try:
        dss = strict_json(os.path.join(project, "datasources.json"))
        views = strict_json(os.path.join(project, "views.json"))
        state = strict_json(os.path.join(project, "state.json"))
    except ValueError as e:
        err(f"L0 JSON is not strict: {e}")
        return report(errors, warnings)
    if not isinstance(dss, list) or not isinstance(views, dict) or not isinstance(state, dict):
        err("L0 datasources.json must be a list, views.json and state.json objects")
        return report(errors, warnings)

    # L1 metadata
    by_name = {}
    for d in dss:
        n = d.get("name")
        if not isinstance(n, str) or not re.fullmatch(r"[A-Za-z0-9_]+", n or ""):
            warn(f"L1 datasource name {n!r} is not [A-Za-z0-9_]+")
        if n in by_name:
            err(f"L1 duplicate datasource {n}")
        by_name[n] = d
        if not isinstance(d.get("size"), int) or d["size"] <= 0:
            err(f"L1 {n}: size must be a positive int")
        fields, names = set(), set()
        for c in d.get("columns", []):
            f, dt = c.get("field"), c.get("datatype")
            if not isinstance(f, str) or not f:
                err(f"L1 {n}: column without a field"); continue
            if f in fields:
                err(f"L1 {n}.{f}: duplicate field")
            fields.add(f)
            if "|" in f or "/" in f:
                err(f"L1 {n}.{f}: '|' or '/' in a field")
            if dt not in DATATYPES:
                err(f"L1 {n}.{f}: datatype {dt!r}")
            nm = c.get("name", f)
            if nm.lower() in names:
                warn(f"L1 {n}.{f}: display name {nm!r} repeats")
            names.add(nm.lower())
            if dt in CATEGORY_LIMIT:
                vals = c.get("values")
                if not isinstance(vals, list):
                    err(f"L1 {n}.{f}: {dt} without values")
                elif len(vals) > CATEGORY_LIMIT[dt]:
                    err(f"L1 {n}.{f}: {len(vals)} values > {CATEGORY_LIMIT[dt]}")
                if "colors" in c and (len(c["colors"]) != len(vals or []) or not all(HEX.match(x or "") for x in c["colors"])):
                    err(f"L1 {n}.{f}: colors must be one #rrggbb per value")
            if dt in ("integer", "double", "int32"):
                mm = c.get("minMax")
                if not (isinstance(mm, list) and len(mm) == 2 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in mm)):
                    err(f"L1 {n}.{f}: minMax missing or not finite")
            if dt in ("unique", "multitext") and not c.get("stringLength"):
                err(f"L1 {n}.{f}: stringLength missing")
        d["_fields"] = fields

    # L2 h5
    h5path = os.path.join(project, "datafile.h5")
    if not os.path.isfile(h5path):
        err("L2 datafile.h5 missing")
        return report(errors, warnings)
    with h5py.File(h5path, "r") as h5:
        for d in dss:
            n, size = d["name"], d.get("size", 0)
            if n not in h5:
                err(f"L2 group {n} missing"); continue
            g = h5[n]
            for c in d.get("columns", []):
                f, dt = c.get("field"), c.get("datatype")
                if f not in g:
                    err(f"L2 {n}/{f} missing"); continue
                ds = g[f]
                length = size * (c.get("stringLength") or 1) if dt == "multitext" else size
                if ds.shape[0] != length:
                    err(f"L2 {n}/{f}: length {ds.shape[0]} != {length}")
                if dt in H5_DTYPE and ds.dtype != H5_DTYPE[dt]:
                    err(f"L2 {n}/{f}: dtype {ds.dtype} != {np.dtype(H5_DTYPE[dt])}")
                if dt in ("text", "text16"):
                    codes = ds[:]
                    if len(codes) and int(codes.max()) >= len(c.get("values", [])):
                        err(f"L2 {n}/{f}: category code beyond values")
            for target, link in (d.get("links") or {}).items():
                rac = link.get("rows_as_columns")
                if not rac:
                    continue
                t = by_name.get(target)
                if t is None:
                    err(f"L2 {n}: link to unknown datasource {target}"); continue
                if rac.get("name_column") not in t["_fields"]:
                    err(f"L2 {n}->{target}: name_column {rac.get('name_column')!r} is not a field of {target}")
                for stub, sgi in (rac.get("subgroups") or {}).items():
                    sg = g.get(sgi.get("name", stub))
                    if sg is None:
                        err(f"L2 {n}: subgroup {stub} missing"); continue
                    if sgi.get("type") == "sparse":
                        p = sg["p"]
                        if p.shape[0] != t["size"] + 1:
                            err(f"L2 {n}/{stub}: len(p) {p.shape[0]} != {t['size'] + 1}")
                        if int(p[-1]) != sg["x"].shape[0] or sg["x"].shape[0] != sg["i"].shape[0]:
                            err(f"L2 {n}/{stub}: p[-1], len(x), len(i) disagree")
                        if sg["i"].shape[0] and int(sg["i"][:].max()) >= size:
                            err(f"L2 {n}/{stub}: row index beyond size")
                    elif sg["x"].shape[0] != size * t["size"]:
                        err(f"L2 {n}/{stub}: dense length mismatch")

    # L3 views, state, regions
    all_views = state.get("all_views", [])
    for v in all_views:
        if v not in views:
            err(f"L3 state.all_views has {v!r}, which views.json lacks")
    if state.get("initial_view") not in all_views:
        err("L3 state.initial_view is not in all_views")
    if state.get("permission") != "edit":
        warn("L3 state.permission is not 'edit': the project opens view-only")
    seen = set()

    def check_ref(ds, ref, where):
        if isinstance(ref, dict):
            if ref.get("type") == "RowsAsColsQuery":
                if ref.get("linkedDsName") not in (ds.get("links") or {}):
                    err(f"L3 {where}: RowsAsColsQuery to {ref.get('linkedDsName')!r}, which {ds['name']} does not link")
            return
        if not isinstance(ref, str):
            return
        m = VIRTUAL.match(ref)
        if m:
            stub, idx = m.group(1), int(m.group(3))
            for target, link in (ds.get("links") or {}).items():
                rac = link.get("rows_as_columns") or {}
                if stub in (rac.get("subgroups") or {}):
                    if idx >= by_name[target]["size"]:
                        err(f"L3 {where}: {ref} index beyond {target}")
                    return
            err(f"L3 {where}: {ref} has an unknown subgroup")
        elif ref not in ds["_fields"]:
            err(f"L3 {where}: {ref!r} is not a column of {ds['name']}")

    for vn, view in views.items():
        for dsn, charts in (view.get("initialCharts") or {}).items():
            ds = by_name.get(dsn)
            if ds is None:
                err(f"L3 view {vn!r}: unknown datasource {dsn}"); continue
            if charts:
                seen.add(dsn)
            for ch in charts:
                where = f"view {vn!r} / {ch.get('title', ch.get('type'))}"
                for p in ch.get("param") or []:
                    check_ref(ds, p, where)
                if ch.get("color_by") is not None:
                    check_ref(ds, ch["color_by"], where)
                bi = ch.get("background_image")
                if bi and bi.get("file"):
                    base = (ds.get("regions") or {}).get("base_url", "")
                    if not os.path.isfile(os.path.join(project, base, bi["file"])):
                        err(f"L3 {where}: background image {bi['file']} not found")
    for d in dss:
        if d["name"] not in seen:
            warn(f"L3 datasource {d['name']} has no chart in any view")
        r = d.get("regions")
        if r:
            for f in [r.get("region_field"), r.get("default_color")] + list(r.get("position_fields") or []):
                if f not in d["_fields"]:
                    err(f"L3 {d['name']}.regions names {f!r}, which is not a column")

    # usefulness
    for d in dss:
        cols = d.get("columns", [])
        if sum(c.get("name", c["field"]) == c["field"] and "_" in c["field"] for c in cols) > len(cols) / 2:
            warn(f"U {d['name']}: most columns show their raw field id; set display names")
    cells = next((d for d in dss if (d.get("links") or {})), None)
    if cells:
        if not any(c["datatype"] == "text" for c in cells["columns"]):
            warn(f"U {cells['name']}: no 'text' grouping column (cell type, cluster); most category charts need one")
        if not any(c.get("colors") for c in cells["columns"]):
            warn(f"U {cells['name']}: no column has fixed colours")
    if not os.path.isfile(os.path.join(project, "README.md")):
        warn("U README.md missing: MDV has no column description field, so the README is the glossary")

    # L4 round trip and L5 serve
    if roundtrip or serve:
        from mdvtools.mdvproject import MDVProject
        p = MDVProject(project)
        if roundtrip:
            for d in dss:
                try:
                    df = p.get_datasource_as_dataframe(d["name"])
                    if len(df) != d["size"]:
                        err(f"L4 {d['name']}: decoded {len(df)} rows != size {d['size']}")
                except Exception as e:
                    err(f"L4 {d['name']}: decode failed: {type(e).__name__}: {e}")
        if serve:
            from mdvtools.serverlite import create_app
            from werkzeug.test import Client  # not app.test_client(): Flask 2.2 + Werkzeug 3 breaks it
            client = Client(create_app(p))
            r = client.get("/")
            if r.status_code != 200:
                err(f"L5 GET / -> {r.status_code}")
            if r.headers.get("Cross-Origin-Embedder-Policy") != "require-corp":
                warn("L5 COEP header missing on /")
            for f in ("datasources", "views", "state"):
                if client.get(f"/{f}.json").status_code != 200:
                    err(f"L5 GET /{f}.json failed")
            for d in dss:
                for c in d["columns"]:
                    dt = c["datatype"]
                    exp = d["size"] * BYTES[dt] if dt in BYTES else d["size"] * c["stringLength"] * (2 if dt == "multitext" else 1)
                    r = client.post("/get_data", json={"columns": [c], "data_source": d["name"]})
                    if r.status_code != 200 or len(r.get_data()) != exp:  # serverlite returns raw column bytes
                        err(f"L5 /get_data {d['name']}.{c['field']}: status {r.status_code}, {len(r.get_data())} bytes, expected {exp}")
    return report(errors, warnings)


def report(errors, warnings):
    out = {"ok": not errors, "errors": errors, "warnings": warnings}
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0 if not errors else 1


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sys.exit(main(args[0], serve="--no-serve" not in sys.argv, roundtrip="--no-roundtrip" not in sys.argv))
```

## A visual check

If a browser is available, open the project with `mdvtools serve <folder>` (or
`python -m mdvtools.serverlite <folder> --no-browser --port 5050`) and look at every view.
Check that the tissue is upright and that the cells sit on the tissue image, that colours match
between views, and that the dot plot shows the expected markers per cell type.
