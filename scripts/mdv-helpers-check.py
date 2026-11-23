#!/usr/bin/env python3
"""The end-to-end check of the helper modules of the mdv-preparation skill.

The program takes the helper modules from the code blocks of the skill (the
blocks that start with `# file: <name>.py`). Then it makes three MDV projects
from synthetic data. The data has no relation to one platform:

A: an image, labels, and points. The table annotates the labels and has obsm["spatial"] (as Xenium).
B: an image and circles. The table annotates the circles and has no obsm["spatial"] (as Visium).
C: an AnnData with no image (single cell).

Each project must give zero errors and zero warnings in the table validator
and in the project check. Run the program in an environment that has
inflexa-mdvtools (or mdvtools from the MDV repository) and spatialdata:

    python scripts/mdv-helpers-check.py [output directory]
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

import anndata as ad
import numpy as np
import pandas as pd
import scipy.sparse as sp

SKILL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "mdv-preparation")
HERE = tempfile.mkdtemp(prefix="mdv-helpers-")
for md in sorted(glob.glob(os.path.join(SKILL, "**", "*.md"), recursive=True)):
    for block in re.findall(r"```python\n(.*?)```", open(md, encoding="utf-8").read(), re.S):
        m = re.match(r"# file: (\S+\.py)\n", block)
        if m:
            open(os.path.join(HERE, m.group(1)), "w", encoding="utf-8").write(block[m.end():])
sys.path.insert(0, HERE)

from mdv_asset import build_asset, preflight, write_asset  # noqa: E402
from mdv_project import add_views, write_project, write_spatial_project, zip_project  # noqa: E402
from mdv_spatial import drop_unused, put_table  # noqa: E402

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="mdv-check-")
rng = np.random.default_rng(0)
CELLS = {"cell_type": "Cell type (putative)", "cluster": "Cluster", "total_counts": "Counts per cell",
         "n_genes": "Genes detected"}


def curate(n, genes=40):
    counts = sp.random(n, genes, density=0.3, format="csr", random_state=0, dtype=np.float32)
    counts.data = np.ceil(counts.data * 10)
    X = counts.copy()
    lib = np.asarray(X.sum(1)).ravel()
    X = sp.diags(1e4 / np.maximum(lib, 1)) @ X
    X.data = np.log1p(X.data)
    a = ad.AnnData(X=sp.csr_matrix(X, dtype=np.float32), var=pd.DataFrame(index=[f"GENE{i}" for i in range(genes)]))
    k = rng.integers(0, 3, n)
    a.obs["cell_type"] = pd.Categorical(np.array(["Type A", "Type B", "Type C"])[k])
    a.obs["cluster"] = pd.Categorical([f"C{i + 1:02d} {t}" for i, t in zip(k, a.obs.cell_type)])
    a.obs["total_counts"] = lib.astype(np.int32)
    a.obs["n_genes"] = np.diff(counts.indptr).astype(np.int32)
    a.obsm["X_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
    return a


def finish(name, mdv, spatial):
    add_views(mdv, "Cell type (putative)", "UMAP", {"counts": "Counts per cell", "genes": "Genes detected"},
              spatial=spatial, readme_md=f"# {name}\n\nTest project.")
    zip_project(f"{OUT}/{name}")
    r = subprocess.run([sys.executable, f"{HERE}/check_mdv_project.py", f"{OUT}/{name}"], capture_output=True, text=True)
    rep = json.loads(r.stdout)
    print(name, "check:", "ok" if rep["ok"] else "FAIL", rep["errors"], rep["warnings"], rep["summary"].get("views"))
    return rep["ok"] and not rep["warnings"]


def validate(asset, name):
    path = f"{OUT}/{name}.mdv.h5ad"
    write_asset(asset, path)
    r = subprocess.run([sys.executable, f"{HERE}/validate_mdv_asset.py", path], capture_output=True, text=True)
    rep = json.loads(r.stdout)
    print(name, "validator:", "ok" if rep["ok"] else "FAIL", rep["errors"], rep["warnings"])
    return ad.read_h5ad(path), rep["ok"] and not rep["warnings"]


def spatial_case(name, kind):
    import spatialdata as sd
    from spatialdata.datasets import blobs
    from spatialdata.models import ShapesModel, TableModel
    from spatialdata.transformations import Identity
    b = blobs()
    old = b.tables["table"]
    if kind == "labels":                       # Xenium-like: table annotates labels and carries obsm["spatial"]
        region, inst = "blobs_labels", old.obs["instance_id"].to_numpy()
        table = ad.AnnData(obs=pd.DataFrame({"region": pd.Categorical([region] * old.n_obs), "instance_id": inst},
                                            index=[f"cell{i}" for i in range(old.n_obs)]))
        table.obsm["spatial"] = rng.uniform(10, 500, size=(old.n_obs, 2))
        sdata = sd.SpatialData(images={"img": b.images["blobs_image"]}, labels={region: b.labels[region]},
                               points={"transcripts": b.points["blobs_points"]})
    else:                                      # Visium-like: table annotates circles, no obsm["spatial"]
        region, n = "spots", 60
        xy = rng.uniform(10, 500, size=(n, 2))
        spots = ShapesModel.parse(xy, geometry=0, radius=np.full(n, 5.0), index=pd.Index(np.arange(n)),
                                  transformations={"global": Identity()})
        table = ad.AnnData(obs=pd.DataFrame({"region": pd.Categorical([region] * n), "instance_id": np.arange(n)},
                                            index=[f"spot{i}" for i in range(n)]))
        sdata = sd.SpatialData(images={"img": b.images["blobs_image"]}, shapes={region: spots})
    sdata.tables["table"] = TableModel.parse(table, region=region, region_key="region", instance_key="instance_id")
    cur = curate(table.n_obs)
    cur.obs_names = table.obs_names
    preflight(cur, grouping=["cell_type", "cluster"])
    asset, ok = validate(build_asset(cur, CELLS, obsm_keys={"X_umap": "UMAP"}), name)
    put_table(sdata, asset)
    print(name, "dropped points:", drop_unused(sdata))
    store = f"{OUT}/work/{name}.zarr"
    sdata.write(store, overwrite=True)
    mdv = write_spatial_project(store, f"{OUT}/{name}")
    return ok and finish(name, mdv, spatial=True)


def single_cell_case(name):
    cur = curate(300)
    cur.obs_names = [f"bc{i}" for i in range(cur.n_obs)]
    preflight(cur, grouping=["cell_type", "cluster"])
    asset, ok = validate(build_asset(cur, CELLS, obsm_keys={"X_umap": "UMAP"}), name)
    mdv = write_project(f"{OUT}/{name}.mdv.h5ad", f"{OUT}/{name}")
    return ok and finish(name, mdv, spatial=False)


os.makedirs(f"{OUT}/work", exist_ok=True)
import mdvtools  # noqa: E402
print("mdvtools at", os.path.dirname(mdvtools.__file__))
results = {}
for name, fn in (("A_labels", lambda: spatial_case("A_labels", "labels")),
                 ("B_circles", lambda: spatial_case("B_circles", "circles")),
                 ("C_single_cell", lambda: single_cell_case("C_single_cell"))):
    try:
        results[name] = fn()
    except Exception as e:
        import traceback
        traceback.print_exc()
        results[name] = f"{type(e).__name__}: {e}"
print("RESULTS", json.dumps(results))
sys.exit(0 if all(v is True for v in results.values()) else 1)
