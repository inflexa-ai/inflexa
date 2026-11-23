#!/usr/bin/env python3
"""The end-to-end check of the helper modules of the mdv-preparation skill.

The program takes the helper modules from the code blocks of the skill (the
blocks that start with `# file: <name>.py`). Then it makes three MDV projects
from synthetic data. The data has no relation to one platform:

A: an image, labels, and transcripts. The table annotates the labels and has obsm["spatial"] (as Xenium). The
   transcripts stay as gene tiles when the mdvtools can Morton-sort points.
B: an RGB image, a multichannel image, and polygons, in µm (the images have a scale of 0.5 µm per pixel). The
   table annotates the polygons and has no obsm["spatial"] (as Visium or as cell outlines). On a tissue chart with
   layers, regions.scale must be 0.5: else the cells do not sit on the image.
C: an AnnData with no image (single cell).

Each project has the Markers view; A and B also have the Domains view (spatial_domains).

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
from mdv_labels import spatial_domains, top_markers  # noqa: E402
from mdv_project import add_views, write_project, write_spatial_project, zip_project  # noqa: E402
from mdv_spatial import drop_unused, keep_genes, points_feature_counts, put_table, tile_genes  # noqa: E402

OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="mdv-check-")
rng = np.random.default_rng(0)
CELLS = {"cell_type": "Cell type (putative)", "cluster": "Cluster", "total_counts": "Counts per cell",
         "n_genes": "Genes detected"}
SPATIAL_CELLS = {**CELLS, "domain": "Spatial domain"}


def sorts_points():
    import dataclasses
    from mdvtools.spatial.conversion import SpatialDataConversionArgs
    return "browser_store" in {f.name for f in dataclasses.fields(SpatialDataConversionArgs)}


def curate(n, genes=40, names=None):
    counts = sp.random(n, genes, density=0.3, format="csr", random_state=0, dtype=np.float32)
    counts.data = np.ceil(counts.data * 10)
    X = counts.copy()
    lib = np.asarray(X.sum(1)).ravel()
    X = sp.diags(1e4 / np.maximum(lib, 1)) @ X
    X.data = np.log1p(X.data)
    names = list(names or []) + [f"GENE{i}" for i in range(genes - len(names or []))]
    a = ad.AnnData(X=sp.csr_matrix(X, dtype=np.float32), var=pd.DataFrame(index=names))
    k = rng.integers(0, 3, n)
    a.obs["cell_type"] = pd.Categorical(np.array(["Type A", "Type B", "Type C"])[k])
    a.obs["cluster"] = pd.Categorical([f"C{i + 1:02d} {t}" for i, t in zip(k, a.obs.cell_type)])
    a.obs["total_counts"] = lib.astype(np.int32)
    a.obs["n_genes"] = np.diff(counts.indptr).astype(np.int32)
    a.obsm["X_umap"] = rng.normal(size=(n, 2)).astype(np.float32)
    return a


def finish(name, mdv, spatial, cur, gene_tiles=(), um_per_px=None):
    markers = [g for gs in top_markers(cur, "cell_type", n=1).values() for g in gs]
    add_views(mdv, "Cell type (putative)", "UMAP", {"counts": "Counts per cell", "genes": "Genes detected"},
              spatial=spatial, readme_md=f"# {name}\n\nTest project.", gene_tiles=gene_tiles, markers=markers,
              domain="Spatial domain" if spatial else None)
    views = json.load(open(f"{OUT}/{name}/views.json"))
    stacks = [c["renderStack"] for v in views.values() for c in v["initialCharts"].get("cells", []) if "renderStack" in c]
    scale = json.load(open(f"{OUT}/{name}/datasources.json"))[0].get("regions", {}).get("scale")
    scale_ok = not stacks or um_per_px is None or abs(scale - um_per_px) < 1e-6
    print(name, "regions.scale:", scale, "ok" if scale_ok else f"FAIL (expected {um_per_px})")
    print(name, "views:", list(views), "layer stacks:", len(stacks),
          "layers:", [(e["source"]["elementType"], e["source"]["elementKey"], e["visible"]) for e in (stacks[0]["entries"] if stacks else [])])
    zip_project(f"{OUT}/{name}")
    r = subprocess.run([sys.executable, f"{HERE}/check_mdv_project.py", f"{OUT}/{name}"], capture_output=True, text=True)
    rep = json.loads(r.stdout)
    print(name, "check:", "ok" if rep["ok"] else "FAIL", rep["errors"], rep["warnings"], rep["summary"].get("views"),
          "points:", rep["summary"].get("points"))
    return rep["ok"] and not rep["warnings"] and scale_ok


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
    from spatialdata.models import Image2DModel, ShapesModel, TableModel
    from spatialdata.transformations import Identity, Scale
    b = blobs()
    old = b.tables["table"]
    if kind == "labels":                       # Xenium-like: table annotates labels and carries obsm["spatial"]
        region, inst = "blobs_labels", old.obs["instance_id"].to_numpy()
        table = ad.AnnData(obs=pd.DataFrame({"region": pd.Categorical([region] * old.n_obs), "instance_id": inst},
                                            index=[f"cell{i}" for i in range(old.n_obs)]))
        table.obsm["spatial"] = rng.uniform(10, 500, size=(old.n_obs, 2))
        sdata = sd.SpatialData(images={"img": b.images["blobs_image"]}, labels={region: b.labels[region]},
                               points={"transcripts": b.points["blobs_points"]})
        genes = sorted(b.points["blobs_points"]["genes"].compute().astype(str).unique())
    else:                                      # Visium-like: table annotates circles, no obsm["spatial"]
        region, n = "spots", 60
        xy = rng.uniform(5, 250, size=(n, 2))           # µm: the images cover 256 µm
        import geopandas as gpd
        from shapely.geometry import Point
        outlines = gpd.GeoDataFrame(geometry=[Point(x, y).buffer(5.0) for x, y in xy], index=pd.Index(np.arange(n)))
        spots = ShapesModel.parse(outlines, transformations={"global": Identity()})
        half = {"global": Scale([0.5, 0.5], axes=("y", "x"))}
        rgb = Image2DModel.parse(b.images["blobs_image"].data, dims=("c", "y", "x"), c_coords=["r", "g", "b"], transformations=half)
        table = ad.AnnData(obs=pd.DataFrame({"region": pd.Categorical([region] * n), "instance_id": np.arange(n)},
                                            index=[f"spot{i}" for i in range(n)]))
        channels = Image2DModel.parse(rng.integers(0, 4000, size=(4, 512, 512)).astype(np.uint16), dims=("c", "y", "x"),
                                      c_coords=["DAPI", "CD45", "PanCK", "Membrane"], transformations=half)
        sdata = sd.SpatialData(images={"img": rgb, "morphology": channels}, shapes={region: spots})
        genes = []
    sdata.tables["table"] = TableModel.parse(table, region=region, region_key="region", instance_key="instance_id")
    cur = curate(table.n_obs, names=genes)
    cur.obs_names = table.obs_names
    cur.obsm["spatial"] = table.obsm["spatial"] if "spatial" in table.obsm else xy
    cur.obs["domain"] = spatial_domains(cur, "cell_type", n_domains=2, k=5)[0]
    preflight(cur, grouping=["cell_type", "cluster", "domain"])
    asset, ok = validate(build_asset(cur, SPATIAL_CELLS, obsm_keys={"X_umap": "UMAP"}), name)
    put_table(sdata, asset)
    keep = ["transcripts"] if genes and sorts_points() else []
    if keep:
        counts = points_feature_counts(sdata, "transcripts")
        tiles = tile_genes(counts, must=genes[:1], prefer=genes, budget=int(counts.sum()))
        assert tiles[0] == genes[0] and set(tiles) <= set(genes), tiles
        keep_genes(sdata, "transcripts", tiles)
    print(name, "dropped points:", drop_unused(sdata, keep_points=keep))
    store = f"{OUT}/work/{name}.zarr"
    sdata.write(store, overwrite=True)
    mdv = write_spatial_project(store, f"{OUT}/{name}")
    return ok and finish(name, mdv, spatial=True, cur=cur, gene_tiles=genes[:1], um_per_px=None if kind == "labels" else 0.5)


def single_cell_case(name):
    cur = curate(300)
    cur.obs_names = [f"bc{i}" for i in range(cur.n_obs)]
    preflight(cur, grouping=["cell_type", "cluster"])
    asset, ok = validate(build_asset(cur, CELLS, obsm_keys={"X_umap": "UMAP"}), name)
    mdv = write_project(f"{OUT}/{name}.mdv.h5ad", f"{OUT}/{name}")
    return ok and finish(name, mdv, spatial=False, cur=cur)


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
if results.get("B_circles") is True and sorts_points():
    # negative control: with regions.scale 1.0, the project check must report the cells at the wrong scale
    import shutil
    bad = f"{OUT}/B_scale_1"
    shutil.rmtree(bad, ignore_errors=True)
    shutil.copytree(f"{OUT}/B_circles", bad)
    shutil.copy(f"{OUT}/B_circles.mdv.zip", f"{bad}.mdv.zip")
    ds = json.load(open(f"{bad}/datasources.json"))
    ds[0]["regions"]["scale"] = 1.0
    json.dump(ds, open(f"{bad}/datasources.json", "w"))
    r = subprocess.run([sys.executable, f"{HERE}/check_mdv_project.py", bad], capture_output=True, text=True)
    caught = any("regions.scale" in e for e in json.loads(r.stdout)["errors"])
    print("B_scale_1 (negative control):", "the check reports the scale" if caught else "FAIL: the check does not see it")
    results["B_scale_1_detected"] = caught
print("RESULTS", json.dumps(results))
sys.exit(0 if all(v is True for v in results.values()) else 1)
