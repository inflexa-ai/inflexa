# Spatial Transcriptomics → MDV

Build one SpatialData store for each slide, with the images and one curated table. Then
`write_spatial_project` makes the project, and the view "Tissue" draws the cells on the image.
Process the cells like single-cell data, and make the asset with `asset-route.md`.

The project holds a copy of the store. Thus write the work store outside the deliverable.

## Platform decision tree

```
Platform?
├── Xenium → spatialdata_io.xenium(path): table "table", cells as the labels "cell_labels",
│            image "morphology_focus" (mdvtools selects it first)
├── Visium → spatialdata_io.visium(path): spots as circles, the hires and lowres images
├── Visium HD → spatialdata_io.visium_hd(path): one table for each bin size (square_016um, …)
│            and "cell_segmentations"; one project for each table
├── CosMx
│   ├── AtoMx flat-file export: *exprMat_file.csv, *metadata_file.csv, *fov_positions_file.csv
│   │   → spatialdata_io.cosmx(path)
│   └── Raw instrument output: RunSummary/, CellStatsDir/FOVnnn/, a decoded run directory with
│       FOVnnn/*complete_code_cell_target_call_coord.csv
│       → cosmx_raw.py below; run the orientation check before you trust the layout
└── MERSCOPE / MERFISH → spatialdata_io.merscope(path);
             "Blank-*" barcodes are negative controls, not genes
```

After the reader, make sure that the store has an image, and that the table has
`obsm["spatial"]` or annotates shapes.

Negative-control probes and false codes are QC columns, never genes. Some panels merge paralogs
into one target with `/` in the name (`HBA1/2`). That is permitted as a gene name, but not as a
column field.

## Put the asset into the store

```python
# file: mdv_spatial.py
"""Put the curated table into a SpatialData store, so that the MDV project draws the cells on the image."""
import anndata as ad
import numpy as np
import pandas as pd


def _centers(sdata, table, region, region_key, instance_key):
    """Cell centers from the annotated shapes, in the coordinates of the shapes."""
    xy = np.full((table.n_obs, 2), np.nan)
    labels = table.obs[region_key].astype(str).to_numpy()
    for r in ([region] if isinstance(region, str) else list(region)):
        if r not in sdata.shapes:
            raise ValueError(f"the table has no obsm['spatial'] and its region {r!r} is not shapes: give the cell centers")
        centroid = sdata.shapes[r].geometry.centroid
        mask = labels == r
        pos = centroid.index.get_indexer(pd.Index(table.obs[instance_key].to_numpy()[mask]).astype(centroid.index.dtype))
        if (pos < 0).any():
            raise ValueError(f"{int((pos < 0).sum())} cells have no shape in {r!r}")
        xy[mask] = np.column_stack([centroid.x.to_numpy()[pos], centroid.y.to_numpy()[pos]])
    return xy


def put_table(sdata, curated, table_name="table"):
    """Make the curated AnnData the only table of sdata, in place of sdata.tables[table_name].

    Every curated cell must be a cell of the old table. The SpatialData attributes, the region column, the
    instance column, and obsm["spatial"] come from the old table under their own names. The labels of
    build_asset (uns["mdv_labels"]) go with the table. The old table must have
    obsm["spatial"], or annotate shapes (the centers of the shapes are used). MDV merges every table of a store
    into one cells table, so the other tables are removed.
    """
    from spatialdata.models import TableModel, get_table_keys
    old = sdata.tables[table_name]
    region, region_key, instance_key = get_table_keys(old)
    absent = ~curated.obs_names.isin(old.obs_names)
    if absent.any():
        raise ValueError(f"{int(absent.sum())} curated cells are not in table {table_name!r}: {list(curated.obs_names[absent][:3])}")
    rows = old.obs_names.get_indexer(curated.obs_names)
    layers = {k: v for k, v in curated.layers.items() if k is not None}   # anndata 0.13 also lists X under None
    table = ad.AnnData(X=curated.X, obs=curated.obs.copy(), var=curated.var, obsm=dict(curated.obsm), layers=layers)
    keys = {region_key: pd.Categorical(old.obs[region_key].astype(str).to_numpy()[rows]),
            instance_key: old.obs[instance_key].to_numpy()[rows]}
    for key, values in keys.items():
        if key in table.obs.columns and not (table.obs[key].astype(str).to_numpy() == np.asarray(values).astype(str)).all():
            raise ValueError(f"curated column {key!r} has the name of a SpatialData key and other values: rename it")
        table.obs[key] = values
    labels = {k: dict(v) for k, v in dict(curated.uns.get("mdv_labels", {})).items()}
    labels.setdefault("cells", {}).setdefault(region_key, "SpatialData region")
    labels["cells"].setdefault(instance_key, "Cell ID")
    table.uns["mdv_labels"] = labels
    if "spatial" in old.obsm:
        table.obsm["spatial"] = np.asarray(old.obsm["spatial"])[rows]
    else:
        table.obsm["spatial"] = _centers(sdata, table, region, region_key, instance_key)
    for name in list(sdata.tables):
        del sdata.tables[name]
    sdata.tables[table_name] = TableModel.parse(table, region=region, region_key=region_key, instance_key=instance_key)


def drop_unused(sdata, keep_points=()):
    """Remove the points elements that are not in keep_points, and keep the shapes and the labels.

    The transcripts are the gene tiles of MDV: the tissue chart of a newer MDV draws the transcripts of the genes
    that the user selects (write_spatial_project Morton-sorts them). Keep them (keep_points=["transcripts"]) when
    the mdvtools can sort points and the size budget allows ("The size of the project", memory-and-scale.md).
    Remove them for MDV 1.3.0: its tissue chart does not draw points. Returns the names of the removed elements.
    A Xenium store needs its shapes: mdvtools places the cells on the image with the transform of cell_circles,
    cell_boundaries, or nucleus_boundaries.
    """
    removed = [name for name in sdata.points if name not in set(keep_points)]
    for name in removed:
        del sdata.points[name]
    return removed


POINTS_BUDGET = 40_000_000     # points that the tissue chart of MDV reads reliably (about 340 MB of parquet)


def points_feature_counts(sdata, points_key, feature_key=None):
    """Transcripts per gene of a points element (a pandas Series). One pass over the feature column (dask)."""
    pts = sdata.points[points_key]
    feature_key = feature_key or pts.attrs["spatialdata_attrs"]["feature_key"]
    return pts[feature_key].astype(str).value_counts().compute()


def tile_genes(counts, must=(), prefer=(), budget=POINTS_BUDGET):
    """The genes whose transcripts stay as gene tiles, within `budget` points.

    The tissue chart reads the points of one element; in some paths it reads the whole file into one browser
    buffer, and a file of several GB does not load (measured: 323 M points, 2.9 GB, "Array buffer allocation
    failed"). Thus keep every gene of `must` (the markers of the cell types), then the genes of `prefer` (for
    example the HVGs), the rarest first, while the total stays within the budget. The expression of every gene
    stays in the cells ("Gene Scores"). Returns the list of genes.
    """
    counts = counts.astype("int64")
    picked = [g for g in dict.fromkeys(must) if g in counts.index]
    total = int(counts[picked].sum())
    if total > budget:
        raise ValueError(f"the markers alone have {total:,} points, above the budget of {budget:,}: give fewer")
    for g in counts.reindex([g for g in prefer if g in counts.index and g not in set(picked)]).sort_values().index:
        if total + int(counts[g]) > budget:
            break
        picked.append(g)
        total += int(counts[g])
    return picked


def keep_genes(sdata, points_key, genes, feature_key=None):
    """Keep only the points of genes (the var_names of the table): negative-control probes, blank and unassigned
    codewords, and false codes are QC, not gene tiles. Lazy (dask): the filter runs when the store is written."""
    from spatialdata.models import PointsModel, get_axes_names
    from spatialdata.transformations import get_transformation
    pts = sdata.points[points_key]
    feature_key = feature_key or pts.attrs["spatialdata_attrs"]["feature_key"]
    genes = list(genes)
    kept = pts[pts[feature_key].astype(str).isin(genes)]
    kept[feature_key] = kept[feature_key].astype(str).astype(pd.CategoricalDtype(genes))
    kept.attrs.pop("transform", None)              # PointsModel.parse sets the transformations again
    coords = {a: a for a in get_axes_names(pts)}
    extra = {"instance_key": pts.attrs["spatialdata_attrs"]["instance_key"]} if "instance_key" in pts.attrs["spatialdata_attrs"] else {}
    sdata.points[points_key] = PointsModel.parse(kept, coordinates=coords, feature_key=feature_key,
                                                 transformations=get_transformation(pts, get_all=True), **extra)
```

```python
import spatialdata_io
from mdv_asset import preflight, build_asset, write_asset
from mdv_spatial import put_table, drop_unused
from mdv_project import write_spatial_project, add_views, zip_project

sdata = spatialdata_io.xenium(XENIUM_OUTS)                  # the reader of the platform
adata = sdata.tables["table"].copy()
# QC, normalization, embedding, clusters, and labels ("Processing for spatial cell data")
preflight(adata, grouping=["cell_type", "cluster"])
asset = build_asset(adata, CELLS, obsm_keys={"X_umap": "UMAP"})
write_asset(asset, f"{OUT}/{NAME}.mdv.h5ad")                 # run the table validator on it
put_table(sdata, asset)
drop_unused(sdata)
sdata.write(f"{WORK}/{NAME}.zarr", overwrite=True)
mdv = write_spatial_project(f"{WORK}/{NAME}.zarr", f"{OUT}/{NAME}")
add_views(mdv, "Cell type (putative)", "UMAP",
          {"counts": "Transcripts per cell", "genes": "Genes detected", "area": "Cell area (µm²)"},
          spatial=True, readme_md=README_TEXT)
zip_project(f"{OUT}/{NAME}")                                 # run the project check on it
```

`put_table` refuses a curated cell that is not in the old table. Thus filter the cells, but do
not rename them.

## CosMx raw instrument output

The run has no cell × gene matrix. Build it from the decoded transcript calls:

| File | Content |
|---|---|
| `RunSummary/*ExptConfig.txt` | `ImPixel_nm` (pixel size), `Image Rows/Cols`, run identity |
| `RunSummary/latest.fovs.csv` | no header: slide, X_mm, Y_mm, Z_mm, ZOffset_mm, ROI, FOV, order |
| `CellStatsDir/FOVnnn/*_Cell_Stats_Fnnn.csv` | for each cell: Area (px), AspectRatio, CenterX/Y (FOV px), Width, Height, Mean-/Max-<stain> |
| `CellStatsDir/FOVnnn/CellLabels_Fnnn.tif` | segmentation labels. The label value is the CellId |
| `CellStatsDir/RnD/*_Summary_Fnnn.csv` | the first line names the morphology kit |
| `CellStatsDir/CellComposite/CellComposite_Fnnn.jpg` | the false-color composite of each FOV, at the FOV pixel size |
| `<run>/FOVnnn/*__complete_code_cell_target_call_coord.csv` | one row for each transcript: CellId (0 = not in a cell), codeclass (Endogenous / Negative / SystemControl), target, x, y (FOV px) |

These facts come from a 6K-panel run:

- `CellId 1` in Cell_Stats is a whole-FOV placeholder with `Area 0`. Drop the rows with
  `Area == 0`.
- Transcript `(x, y)` and `CellLabels[y, x]` agree (about 99 %). Cell_Stats `Area` is equal to the
  label pixel count. All three are in the same FOV pixel frame.
- `CellComp` in the transcript file can be empty. Do not use the compartments.
- The morphology kit file (`*.mkit`, `Morphology_ChannelID_Dictionary.txt`) can be old. The
  `Mean-<stain>` column names of Cell_Stats are the stains of the run. A channel named only by a
  letter has no target. Say so in its label.

### The orientation check (mandatory)

The run files do not give the sign between the FOV image axes and the stage axes. The sign is
different between instruments and software versions, and a wrong sign scrambles the tissue with
no error. On the measured run, **image right = stage −X and image down = stage +Y** (a 180°
turn, no mirror). Do not copy that: measure it.

`check_orientation` scores the four sign hypotheses by the continuity of the composite images
across the seams of neighbor FOVs. It refuses when the best hypothesis does not clearly win. Then
stitch a thumbnail and look at it.

```python
# file: cosmx_raw.py
"""Raw CosMx SMI run -> cell x gene AnnData, FOV orientation check, thumbnail to look at, mosaic for the project."""
import glob
import json
import os
import re

import anndata as ad
import numpy as np
import pandas as pd
import pyarrow.csv as pc
import scipy.sparse as sp
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def read_config(run_root):
    cfg = {}
    path = glob.glob(os.path.join(run_root, "RunSummary", "*ExptConfig.txt"))
    if path:
        for line in open(path[0], encoding="utf-8", errors="replace"):
            if ":" in line:
                k, v = line.split(":", 1)
                cfg[k.strip()] = v.strip()
    kit = None
    rnd = sorted(glob.glob(os.path.join(run_root, "CellStatsDir", "RnD", "*_Summary_F*.csv")))
    if rnd:
        m = re.match(r"Morphology Kit:\s*(.+)", open(rnd[0], encoding="utf-8", errors="replace").readline())
        kit = m.group(1).strip() if m else None
    return cfg, kit


def fov_positions(run_root, sign_x, sign_y, px_um):
    """FOV offsets in slide pixels for one orientation hypothesis; zero origin."""
    pos = pd.read_csv(os.path.join(run_root, "RunSummary", "latest.fovs.csv"), header=None, skipinitialspace=True,
                      names=["slide", "X_mm", "Y_mm", "Z_mm", "ZOffset_mm", "ROI", "fov", "order"])
    pos["slide"] = pos.slide.astype(int)
    pos["x_offset_px"] = sign_x * pos.X_mm * 1000.0 / px_um
    pos["y_offset_px"] = sign_y * pos.Y_mm * 1000.0 / px_um
    pos["x_offset_px"] -= pos.x_offset_px.min()
    pos["y_offset_px"] -= pos.y_offset_px.min()
    return pos.set_index("fov")


def _composite(run_root, f, size=1064):
    p = os.path.join(run_root, "CellStatsDir", "CellComposite", f"CellComposite_F{int(f):03d}.jpg")
    im = Image.open(p)
    im.draft("L", (size, size))
    return np.asarray(im.convert("L").resize((size, size)), dtype=float)


def check_orientation(run_root, n_pairs=30, seed=0, min_margin=0.03):
    """Score image-axis signs by seam continuity of neighbouring FOV composites.

    Returns {"sign_x": +-1, "sign_y": +-1, "scores": {...}}, where slide_px = fov_px + offset and
    offset = (sign_x * X_mm, sign_y * Y_mm) * 1000 / pixel_size_um. Raises when no hypothesis
    clearly wins: then stitch a thumbnail for each hypothesis and decide by eye.
    """
    cfg, _ = read_config(run_root)
    px_um = float(cfg["ImPixel_nm"]) / 1000.0
    tile_mm = int(cfg.get("Image Cols", 4256)) * px_um / 1000.0
    pos = fov_positions(run_root, 1, 1, px_um).reset_index()
    pairs_x, pairs_y = [], []
    for _, r in pos.iterrows():
        nx = pos[(abs(pos.Y_mm - r.Y_mm) < 1e-3) & (abs(pos.X_mm - r.X_mm - tile_mm) < 5e-3)]
        ny = pos[(abs(pos.X_mm - r.X_mm) < 1e-3) & (abs(pos.Y_mm - r.Y_mm - tile_mm) < 5e-3)]
        if len(nx):
            pairs_x.append((r.fov, nx.fov.iloc[0]))
        if len(ny):
            pairs_y.append((r.fov, ny.fov.iloc[0]))
    rng = np.random.default_rng(seed)
    pick = lambda pairs: [pairs[i] for i in rng.choice(len(pairs), min(n_pairs, len(pairs)), replace=False)]
    pairs_x, pairs_y = pick(pairs_x), pick(pairs_y)

    def corr(a, b):
        a = a - a.mean(); b = b - b.mean(); d = np.sqrt((a * a).sum() * (b * b).sum())
        return float((a * b).sum() / d) if d else 0.0

    sx = {+1: [], -1: []}   # b sits at stage +X of a
    sy = {+1: [], -1: []}   # b sits at stage +Y of a
    for a, b in pairs_x:
        A, B = _composite(run_root, a), _composite(run_root, b)
        sx[+1].append(corr(A[:, -1], B[:, 0]))      # +X is image right: a's right edge meets b's left edge
        sx[-1].append(corr(A[:, 0], B[:, -1]))      # +X is image left
    for a, b in pairs_y:
        A, B = _composite(run_root, a), _composite(run_root, b)
        sy[+1].append(corr(A[-1], B[0]))            # +Y is image down
        sy[-1].append(corr(A[0], B[-1]))            # +Y is image up
    mx = {k: float(np.mean(v)) for k, v in sx.items()}
    my = {k: float(np.mean(v)) for k, v in sy.items()}
    res = {"sign_x": max(mx, key=mx.get), "sign_y": max(my, key=my.get), "scores": {"x": mx, "y": my},
           "pairs": {"x": len(pairs_x), "y": len(pairs_y)}}
    if abs(mx[1] - mx[-1]) < min_margin or abs(my[1] - my[-1]) < min_margin:
        raise ValueError(f"orientation is ambiguous, decide from stitched thumbnails: {res}")
    return res


def stitch(run_root, out_stem, sign_x, sign_y, tile_px=256):
    """Mosaic of the CellComposite JPEGs on the slide; writes <out_stem>.jpg and .json (extent in µm).

    Look at it to confirm the orientation: one continuous tissue, no seam that cuts a structure.
    Use tile_px=64 for a quick look."""
    cfg, _ = read_config(run_root)
    px_um = float(cfg["ImPixel_nm"]) / 1000.0
    fov_px = int(cfg.get("Image Cols", 4256))
    pos = fov_positions(run_root, sign_x, sign_y, px_um)
    scale = tile_px / fov_px
    W = int(round((pos.x_offset_px.max() + fov_px) * scale))
    H = int(round((pos.y_offset_px.max() + fov_px) * scale))
    canvas = Image.new("RGB", (W, H))
    for f, r in pos.iterrows():
        p = os.path.join(run_root, "CellStatsDir", "CellComposite", f"CellComposite_F{int(f):03d}.jpg")
        if os.path.exists(p):
            im = Image.open(p); im.draft("RGB", (fov_px // 8, fov_px // 8))
            canvas.paste(im.convert("RGB").resize((tile_px, tile_px), Image.LANCZOS),
                         (int(round(r.x_offset_px * scale)), int(round(r.y_offset_px * scale))))
    canvas.save(out_stem + ".jpg", quality=85)
    extent = {"width_um": (pos.x_offset_px.max() + fov_px) * px_um, "height_um": (pos.y_offset_px.max() + fov_px) * px_um,
              "width_px": W, "height_px": H, "um_per_px": px_um / scale}
    json.dump(extent, open(out_stem + ".json", "w"), indent=2)
    return extent


def build_anndata(run_root, sign_x, sign_y, fovs=None):
    """Cell x gene counts (float32 CSR) from the decoded transcript calls, with per-cell and per-FOV QC."""
    cfg, kit = read_config(run_root)
    px_um = float(cfg.get("ImPixel_nm", "120.280945")) / 1000.0
    fov_px = int(cfg.get("Image Cols", 4256))
    pos = fov_positions(run_root, sign_x, sign_y, px_um)
    tx_dirs = [d for d in glob.glob(os.path.join(run_root, "*"))
               if glob.glob(os.path.join(d, "FOV*", "*__complete_code_cell_target_call_coord.csv"))]
    if len(tx_dirs) != 1:
        raise ValueError(f"expected one decoded run directory with transcript calls, found {tx_dirs}")
    gene_index, target_class, blocks, obs_parts, fov_rows = {}, {}, [], [], []
    for f in (fovs or list(pos.index)):
        cs_path = glob.glob(os.path.join(run_root, "CellStatsDir", f"FOV{f:03d}", f"*_Cell_Stats_F{f:03d}.csv"))
        tx_path = glob.glob(os.path.join(tx_dirs[0], f"FOV{f:03d}", "*__complete_code_cell_target_call_coord.csv"))
        if not cs_path or not tx_path:
            continue
        cs = pd.read_csv(cs_path[0])
        cs = cs[cs.Area > 0].reset_index(drop=True)            # CellId 1: whole-FOV placeholder
        tx = pc.read_csv(tx_path[0], convert_options=pc.ConvertOptions(include_columns=["CellId", "codeclass", "target"])).to_pandas()
        for t, c in tx[["target", "codeclass"]].drop_duplicates().itertuples(index=False):
            if t not in target_class:
                target_class[t] = c
                if c == "Endogenous":
                    gene_index[t] = len(gene_index)
        assigned = tx[tx.CellId > 0]
        endo = assigned[assigned.codeclass == "Endogenous"]
        g = endo.groupby(["CellId", "target"]).size()
        rows = pd.Series(np.arange(len(cs)), index=cs.CellId.values).reindex(g.index.get_level_values(0)).to_numpy()
        ok = ~np.isnan(rows)
        r = rows[ok].astype(np.int64)
        c = np.fromiter((gene_index[t] for t in g.index.get_level_values(1)), dtype=np.int64, count=len(g))[ok].astype(np.int32)
        d = g.to_numpy()[ok].astype(np.float32)
        order = np.lexsort((c, r))
        blocks.append((d[order], c[order], np.bincount(r, minlength=len(cs))))
        neg = assigned[assigned.codeclass == "Negative"].groupby("CellId").size()
        fc = assigned[assigned.codeclass == "SystemControl"].groupby("CellId").size()
        p = pos.loc[f]
        o = pd.DataFrame({
            "cell_id": [f"c_{p.slide}_{f}_{i}" for i in cs.CellId],
            "fov": f, "cell_id_in_fov": cs.CellId.values,
            "area_um2": cs.Area.values * px_um ** 2, "aspect_ratio": cs.AspectRatio.values,
            "width_um": cs.Width.values * px_um, "height_um": cs.Height.values * px_um,
            "x_fov_px": cs.CenterX.values, "y_fov_px": cs.CenterY.values,
            "x_slide_px": cs.CenterX.values + p.x_offset_px, "y_slide_px": cs.CenterY.values + p.y_offset_px,
            "neg_probe_counts": neg.reindex(cs.CellId).fillna(0).to_numpy(),
            "false_code_counts": fc.reindex(cs.CellId).fillna(0).to_numpy(),
        })
        for col in cs.columns:
            m = re.match(r"(Mean|Max)-(.+)", col)
            if m:
                o[f"{m.group(1).lower()}_intensity_{m.group(2)}"] = cs[col].values
        obs_parts.append(o)
        n_endo = int((tx.codeclass == "Endogenous").sum())
        fov_rows.append({"fov": f, "x_mm": p.X_mm, "y_mm": p.Y_mm,
                         "x_slide_px": p.x_offset_px + fov_px / 2, "y_slide_px": p.y_offset_px + fov_px / 2,
                         "n_cells": len(cs), "n_transcripts": n_endo, "fraction_assigned": len(endo) / max(n_endo, 1),
                         "neg_probe_transcripts": int((tx.codeclass == "Negative").sum()),
                         "false_code_transcripts": int((tx.codeclass == "SystemControl").sum())})
    indptr = np.concatenate([[0], np.cumsum(np.concatenate([b[2] for b in blocks]))]).astype(np.int64)
    X = sp.csr_matrix((np.concatenate([b[0] for b in blocks]), np.concatenate([b[1] for b in blocks]), indptr),
                      shape=(len(indptr) - 1, len(gene_index)))
    del blocks
    obs = pd.concat(obs_parts, ignore_index=True).set_index("cell_id")
    obs.index.name = None
    obs["total_counts"] = np.asarray(X.sum(axis=1)).ravel()
    obs["n_genes_detected"] = np.diff(X.indptr)
    var = pd.DataFrame(index=pd.Index(sorted(gene_index, key=gene_index.get)))
    adata = ad.AnnData(X=X, obs=obs, var=var)
    adata.obsm["spatial"] = (obs[["x_slide_px", "y_slide_px"]].to_numpy() * px_um).astype(np.float32)  # µm, y down
    fq = pd.DataFrame(fov_rows)
    adata.uns["fov_qc"] = {c: fq[c].to_numpy() for c in fq.columns}
    adata.uns["run"] = {"platform": "NanoString/Bruker CosMx SMI", "run_number": cfg.get("Run Number"),
                        "instrument": cfg.get("Instrument"), "experiment_name": cfg.get("Expt Name"),
                        "slot_id": cfg.get("Slot ID"), "morphology_kit": kit, "pixel_size_um": px_um, "fov_size_px": fov_px,
                        "n_negative_probes": sum(v == "Negative" for v in target_class.values()),
                        "n_false_codes": sum(v == "SystemControl" for v in target_class.values()),
                        "orientation": {"sign_x": sign_x, "sign_y": sign_y}}
    return adata


def stitch_image(run_root, sign_x, sign_y, work_dir, downsample=1, chunk=1024):
    """The mosaic of the CellComposite images on the slide, as a multiscale image in µm.

    downsample=1 keeps the full resolution; 2 halves each axis (a quarter of the bytes). The mosaic is
    written tile by tile into <work_dir>/mosaic.zarr, so the peak memory is about one FOV image. Keep
    work_dir until the SpatialData store is written: the image reads from it.
    """
    import dask.array as da
    import zarr
    from spatialdata.models import Image2DModel
    from spatialdata.transformations import Scale
    cfg, _ = read_config(run_root)
    px_um = float(cfg["ImPixel_nm"]) / 1000.0
    fov_px = int(cfg.get("Image Cols", 4256))
    pos = fov_positions(run_root, sign_x, sign_y, px_um)
    tile_px = int(round(fov_px / downsample))
    H = int(np.ceil(pos.y_offset_px.max() / downsample)) + tile_px
    W = int(np.ceil(pos.x_offset_px.max() / downsample)) + tile_px
    os.makedirs(work_dir, exist_ok=True)
    mosaic = zarr.open_array(os.path.join(work_dir, "mosaic.zarr"), mode="w", shape=(3, H, W),
                             chunks=(3, chunk, chunk), dtype="uint8", fill_value=0)
    for f, r in pos.iterrows():
        p = os.path.join(run_root, "CellStatsDir", "CellComposite", f"CellComposite_F{int(f):03d}.jpg")
        if not os.path.exists(p):
            continue
        im = Image.open(p).convert("RGB")
        if downsample != 1:
            im = im.resize((tile_px, tile_px), Image.LANCZOS)
        tile = np.asarray(im, dtype=np.uint8).transpose(2, 0, 1)
        y0, x0 = int(round(r.y_offset_px / downsample)), int(round(r.x_offset_px / downsample))
        mosaic[:, y0:y0 + tile.shape[1], x0:x0 + tile.shape[2]] = tile
    um_per_px = px_um * downsample
    return Image2DModel.parse(da.from_zarr(mosaic), dims=("c", "y", "x"), c_coords=["r", "g", "b"],
                              scale_factors=[2, 2, 2, 2],
                              transformations={"global": Scale([um_per_px, um_per_px], axes=("y", "x"))})


def _transcript_files(run_root):
    tx_dirs = [d for d in glob.glob(os.path.join(run_root, "*"))
               if glob.glob(os.path.join(d, "FOV*", "*__complete_code_cell_target_call_coord.csv"))]
    if len(tx_dirs) != 1:
        raise ValueError(f"expected one decoded run directory with transcript calls, found {tx_dirs}")
    return {int(re.search(r"FOV(\d+)", p).group(1)): p
            for p in glob.glob(os.path.join(tx_dirs[0], "FOV*", "*__complete_code_cell_target_call_coord.csv"))}


def _fov_points(job):
    import pyarrow as pa
    import pyarrow.parquet as pq
    path, out, f, x_off, y_off, px_um, genes = job
    tx = pc.read_csv(path, convert_options=pc.ConvertOptions(include_columns=["CellId", "codeclass", "target", "x", "y"])).to_pandas()
    tx = tx[tx.codeclass == "Endogenous"]
    code = pd.Categorical(tx.target, categories=genes).codes
    if (code < 0).any():
        raise ValueError(f"FOV {f}: {int((code < 0).sum())} Endogenous transcripts of a gene that is not in `genes`")
    table = pa.table({
        "x": ((tx.x.to_numpy() + x_off) * px_um).astype(np.float32),
        "y": ((tx.y.to_numpy() + y_off) * px_um).astype(np.float32),
        "feature_name": pa.DictionaryArray.from_arrays(pa.array(code.astype(np.int16)), pa.array(list(genes))),
        "fov": np.full(len(tx), f, dtype=np.int16),
        "cell_id_in_fov": tx.CellId.to_numpy().astype(np.int32),
    })
    pq.write_table(table, os.path.join(out, f"part.{f:04d}.parquet"), compression="zstd", row_group_size=500_000)
    return len(tx)


def build_points(run_root, sign_x, sign_y, out_dir, genes, processes=4):
    """The Endogenous transcripts of each FOV as parquet parts in out_dir, in slide µm (the frame of obsm["spatial"]).

    genes: the var_names of build_anndata. Columns: x, y (µm, y down), feature_name (one dictionary for each part),
    fov, cell_id_in_fov (0 = not in a cell). Negative probes and false codes are QC columns of the cells, not genes.
    Returns the number of points. Make the points element with points_element(out_dir).
    """
    from multiprocessing import Pool
    cfg, _ = read_config(run_root)
    px_um = float(cfg["ImPixel_nm"]) / 1000.0
    pos = fov_positions(run_root, sign_x, sign_y, px_um)
    files = _transcript_files(run_root)
    os.makedirs(out_dir, exist_ok=True)
    jobs = [(files[f], out_dir, f, r.x_offset_px, r.y_offset_px, px_um, list(genes)) for f, r in pos.iterrows() if f in files]
    json.dump(list(genes), open(os.path.join(out_dir, "genes.json"), "w"))
    with Pool(processes) as pool:
        return int(sum(pool.imap_unordered(_fov_points, jobs)))


def points_element(parts_dir):
    """The SpatialData points of build_points (lazy: dask reads the parts when the store is written)."""
    import dask.dataframe as dd
    from spatialdata.models import PointsModel
    from spatialdata.transformations import Identity
    genes = pd.CategoricalDtype(json.load(open(os.path.join(parts_dir, "genes.json"))))
    ddf = dd.read_parquet(os.path.join(parts_dir, "part.*.parquet"))
    ddf["feature_name"] = ddf["feature_name"].astype(genes)      # one dictionary for each part: no scan
    return PointsModel.parse(ddf, coordinates={"x": "x", "y": "y"}, feature_key="feature_name",
                             transformations={"global": Identity()})


def _fov_polygons(job):
    import tifffile
    from shapely.geometry import Polygon
    from skimage.measure import find_contours, regionprops
    path, f, x_off, y_off, px_um, ids, tolerance_um = job
    labels = tifffile.imread(path)
    want, out = set(int(i) for i in ids), {}
    for rp in regionprops(labels):
        if rp.label not in want:
            continue
        r0, c0, _, _ = rp.bbox
        contours = find_contours(np.pad(rp.image, 1).astype(np.uint8), 0.5)
        if not contours:
            continue
        c = max(contours, key=len)            # (row, col) of pixel centers in the padded crop
        xy = np.column_stack([c[:, 1] + c0 - 0.5 + x_off, c[:, 0] + r0 - 0.5 + y_off]) * px_um
        poly = Polygon(xy).simplify(tolerance_um, preserve_topology=True)
        out[rp.label] = poly if poly.is_valid else poly.buffer(0)
    return f, out


def cell_polygons(run_root, sign_x, sign_y, obs, tolerance_um=0.25, processes=4):
    """The segmented outline of each cell of obs (columns fov, cell_id_in_fov), from CellLabels_Fnnn.tif.

    Returns a list of shapely polygons in slide µm, in the order of obs. A cell with no outline gets a circle of
    its area (column area_um2) at its center (obsm["spatial"] is not needed: the circle uses x_slide_px, y_slide_px).
    """
    from multiprocessing import Pool
    from shapely.geometry import Point
    cfg, _ = read_config(run_root)
    px_um = float(cfg["ImPixel_nm"]) / 1000.0
    pos = fov_positions(run_root, sign_x, sign_y, px_um)
    jobs = []
    for f, ids in obs.groupby("fov")["cell_id_in_fov"]:
        path = os.path.join(run_root, "CellStatsDir", f"FOV{int(f):03d}", f"CellLabels_F{int(f):03d}.tif")
        jobs.append((path, int(f), pos.loc[f].x_offset_px, pos.loc[f].y_offset_px, px_um, ids.to_numpy(), tolerance_um))
    found = {}
    with Pool(processes) as pool:
        for f, polys in pool.imap_unordered(_fov_polygons, jobs):
            found.update({(f, k): v for k, v in polys.items()})
    out, missing = [], 0
    for f, i, x, y, a in obs[["fov", "cell_id_in_fov", "x_slide_px", "y_slide_px", "area_um2"]].itertuples(index=False):
        poly = found.get((int(f), int(i)))
        if poly is None or poly.is_empty:
            missing += 1
            poly = Point(x * px_um, y * px_um).buffer(np.sqrt(a / np.pi))
        out.append(poly)
    if missing:
        print(f"cell_polygons: {missing} cells have no outline in CellLabels; they get a circle")
    return out


def _morphology_fov(run_root, f, stack):
    """The 2D morphology image of one FOV (channels, y, x), uint16: the Morphology2D file, or the max projection
    over z of the Morphology3D stack (on the measured run, the 2D file is exactly that projection)."""
    import tifffile
    two_d = glob.glob(os.path.join(run_root, "CellStatsDir", "Morphology2D", f"*_F{f:03d}.TIF"))
    if two_d:
        return tifffile.imread(two_d[0])
    planes = sorted(glob.glob(os.path.join(run_root, "CellStatsDir", "Morphology3D", f"FOV{f:03d}", f"*_{stack}_F{f:03d}_Z*.TIF")))
    if not planes:
        return None
    img = tifffile.imread(planes[0])
    for p in planes[1:]:
        np.maximum(img, tifffile.imread(p), out=img)
    return img


def morphology_channels(run_root, f=None):
    """The 3D stack to project and the stain of each channel of the morphology TIFs.

    The channel dictionary of the run can be old. Thus the stain of a channel is measured: the mean of the channel
    in each cell (CellLabels) is compared with the Mean-<stain> columns of Cell_Stats. Returns
    {"stack": token of the 3D stack with as many channels as the stains, "names": [stain of channel 0, 1, …],
    "correlation": [...]}. Raises when a channel does not match one stain clearly (r < 0.9).
    """
    import tifffile
    from scipy.optimize import linear_sum_assignment
    root = os.path.join(run_root, "CellStatsDir")
    f = f or int(re.search(r"FOV(\d+)", sorted(glob.glob(os.path.join(root, "FOV[0-9]*")))[0]).group(1))
    cs = pd.read_csv(glob.glob(os.path.join(root, f"FOV{f:03d}", f"*_Cell_Stats_F{f:03d}.csv"))[0])
    cs = cs[cs.Area > 0]
    stains = [c[5:] for c in cs.columns if c.startswith("Mean-")]
    stacks = {}
    for p in glob.glob(os.path.join(root, "Morphology3D", f"FOV{f:03d}", f"*_F{f:03d}_Z001.TIF")):
        token = re.search(r"_([^_]+)_F\d+_Z001\.TIF$", p).group(1)
        stacks[token] = tifffile.TiffFile(p).series[0].shape[0]
    stack = next((t for t, n in sorted(stacks.items()) if n == len(stains)), None)
    if stack is None and not glob.glob(os.path.join(root, "Morphology2D", "*.TIF")):
        raise ValueError(f"no morphology stack has {len(stains)} channels: {stacks}")
    img = _morphology_fov(run_root, f, stack).astype(np.float64)
    labels = tifffile.imread(os.path.join(root, f"FOV{f:03d}", f"CellLabels_F{f:03d}.tif")).ravel()
    n = np.bincount(labels, minlength=labels.max() + 1)
    ids = cs.CellId.to_numpy()
    means = [np.bincount(labels, weights=ch.ravel(), minlength=len(n))[ids] / np.maximum(n[ids], 1) for ch in img]
    corr = np.array([[np.corrcoef(m, cs[f"Mean-{s}"])[0, 1] for s in stains] for m in means])
    rows, cols = linear_sum_assignment(-np.nan_to_num(corr))
    names = [None] * len(means)
    for r, c in zip(rows, cols):
        names[r] = stains[c]
    best = [float(corr[r, c]) for r, c in zip(rows, cols)]
    if len(rows) != len(means) or min(best) < 0.9:
        raise ValueError(f"the channels do not match the stains clearly: {dict(zip(stains, np.round(corr, 3).tolist()))}")
    return {"stack": stack, "names": names, "correlation": best}


def _morphology_tile(job):
    run_root, f, stack, ds = job
    img = _morphology_fov(run_root, f, stack)
    if img is None:
        return f, None
    c, h, w = img.shape
    h, w = h - h % ds, w - w % ds
    tile = img[:, :h, :w].reshape(c, h // ds, ds, w // ds, ds).mean(axis=(2, 4)).astype(np.uint16)
    return f, tile


def stitch_morphology(run_root, sign_x, sign_y, work_dir, channels, downsample=4, processes=4, chunk=1024):
    """The morphology channels of every FOV on the slide, as one multiscale image (uint16, one channel per stain).

    channels: the result of morphology_channels. Each FOV is averaged over downsample × downsample pixels. The
    workers read and project the FOVs; this process writes them, so no two writers share a zarr chunk.
    """
    import dask.array as da
    import zarr
    from multiprocessing import Pool
    from spatialdata.models import Image2DModel
    from spatialdata.transformations import Scale
    cfg, _ = read_config(run_root)
    px_um = float(cfg["ImPixel_nm"]) / 1000.0
    fov_px = int(cfg.get("Image Cols", 4256))
    pos = fov_positions(run_root, sign_x, sign_y, px_um)
    tile_px = fov_px // downsample
    H = int(np.ceil(pos.y_offset_px.max() / downsample)) + tile_px
    W = int(np.ceil(pos.x_offset_px.max() / downsample)) + tile_px
    os.makedirs(work_dir, exist_ok=True)
    names = channels["names"]
    mosaic = zarr.open_array(os.path.join(work_dir, "morphology.zarr"), mode="w", shape=(len(names), H, W),
                             chunks=(1, chunk, chunk), dtype="uint16", fill_value=0)
    jobs = [(run_root, int(f), channels["stack"], downsample) for f in pos.index]
    with Pool(processes) as pool:
        for f, tile in pool.imap_unordered(_morphology_tile, jobs):
            if tile is None:
                continue
            r = pos.loc[f]
            y0, x0 = int(round(r.y_offset_px / downsample)), int(round(r.x_offset_px / downsample))
            mosaic[:, y0:y0 + tile.shape[1], x0:x0 + tile.shape[2]] = tile
    um_per_px = px_um * downsample
    return Image2DModel.parse(da.from_zarr(mosaic), dims=("c", "y", "x"), c_coords=names, scale_factors=[2, 2, 2, 2],
                              transformations={"global": Scale([um_per_px, um_per_px], axes=("y", "x"))})


def to_spatialdata(adata, images, polygons=None, points=None):
    """SpatialData of a raw run: the images, one shape per cell, the transcripts, and the cell table.

    images: {name: image}. The conversion of mdvtools puts the image named first alphabetically under the cells.
    polygons: the outlines of cell_polygons in the order of adata, or None for one circle of the cell area.
    points: points_element(...) for the gene tiles, or None.
    """
    import geopandas as gpd
    import spatialdata as sd
    from spatialdata.models import ShapesModel, TableModel
    from spatialdata.transformations import Identity
    ids = np.arange(adata.n_obs)
    if polygons is None:
        radius = np.sqrt(adata.obs["area_um2"].to_numpy() / np.pi)
        cells = ShapesModel.parse(np.asarray(adata.obsm["spatial"], dtype=float), geometry=0, radius=radius,
                                  index=pd.Index(ids, name="cell"), transformations={"global": Identity()})
    else:
        cells = ShapesModel.parse(gpd.GeoDataFrame(geometry=list(polygons), index=pd.Index(ids, name="cell")),
                                  transformations={"global": Identity()})
    table = ad.AnnData(X=adata.X, obs=adata.obs.copy(), var=adata.var, obsm=dict(adata.obsm))   # no copy of X
    table.obs["region"] = pd.Categorical(["cells"] * adata.n_obs)
    table.obs["instance_id"] = ids
    table = TableModel.parse(table, region="cells", region_key="region", instance_key="instance_id")
    return sd.SpatialData(images=dict(images), shapes={"cells": cells}, points={"transcripts": points} if points is not None else {},
                          tables={"table": table})
```

Use it in this order:

```python
from cosmx_raw import (check_orientation, stitch, build_anndata, stitch_image, morphology_channels,
                       stitch_morphology, cell_polygons, build_points, points_element, to_spatialdata)
o = check_orientation(RUN)                       # raises when ambiguous
sx, sy = o["sign_x"], o["sign_y"]
extent = stitch(RUN, f"{WORK}/slide_composite", sx, sy)
# look at slide_composite.jpg: one continuous tissue, no seams that cut structures
adata = build_anndata(RUN, sx, sy)
# QC, processing, two-level labels, spatial domains ("Processing for spatial cell data"); keep the QC'd cells
channels = morphology_channels(RUN)              # the stain of each morphology channel, measured
images = {"composite": stitch_image(RUN, sx, sy, f"{WORK}/mosaic", downsample=2),
          "morphology": stitch_morphology(RUN, sx, sy, f"{WORK}/morphology", channels, downsample=4)}
polygons = cell_polygons(RUN, sx, sy, adata.obs)  # the outlines of the kept cells, in their order
build_points(RUN, sx, sy, f"{WORK}/points", adata.var_names)
sdata = to_spatialdata(adata, images, polygons=polygons, points=points_element(f"{WORK}/points"))
tiles = tile_genes(points_feature_counts(sdata, "transcripts"), must=MARKERS, prefer=HVGS)   # within POINTS_BUDGET
keep_genes(sdata, "transcripts", tiles)          # mark them in the asset too: var column "gene_tiles" (Yes/No)
put_table(sdata, asset)
drop_unused(sdata, keep_points=["transcripts"])  # the gene tiles; [] for MDV 1.3.0
sdata.write(f"{WORK}/{NAME}.zarr")
mdv = write_spatial_project(f"{WORK}/{NAME}.zarr", f"{OUT}/{NAME}")   # Morton-sorts the transcripts
add_views(mdv, "Cell type (putative)", "UMAP", QC, spatial=True, readme_md=README,
          gene_tiles=TILES, markers=MARKERS, domain="Spatial domain")
```

Each transcript file is read in full, so the count build is I/O bound (pyarrow reads about
300 MB/s). A 400-FOV 6K run takes about 5 minutes on eight cores, and its peak is near one copy
of the final matrix. These times come from a 392-FOV 6K run on eight cores and 30 GB:

| Step | Time | Output |
|---|---|---|
| `build_points` (6 processes) | 5 min | 323 M transcripts, 3.4 GB of parquet; `tile_genes` keeps 40 M of them (1,194 genes) |
| `cell_polygons` (6 processes) | 1 min | 183,000 polygons, 23 vertices each (median) |
| `stitch_morphology` from `Morphology3D` (6 processes) | 51 min (it reads about 300 GB of z-planes) | 5 channels at 4× downsampling, 3.0 GB compressed |
| the Morton sort of `write_spatial_project` | see the README of the project | out of core, 4 GB of memory |

The morphology of a FOV is the maximum projection over z of its 3D stack. On the measured run,
the `Morphology2D` image of a FOV is exactly that projection, but the run has a `Morphology2D`
image for only 15 of 392 FOVs. A FOV can have two 3D stacks (`N99` and `N100` in the file
names) with different channel counts. `morphology_channels` selects the stack that has one
channel for each stain of Cell_Stats.

Select each `downsample` before the stitch. The pyramid of a mosaic is about channels ×
bytes per value × (slide px / downsample)² × 4/3 before compression, and the slide is larger than
the FOVs when the FOVs do not fill a rectangle. The image budget of the project is 8 GB for the
images together, plus the points ("The size of the project", `memory-and-scale.md`). On the
measured run: the RGB composite at `downsample=2` is 7.8 GB before compression, and the five
uint16 channels at `downsample=4` are 6.5 GB before compression. Both compress well, because the
slide outside the tissue is zero. Write the values in the README.

The stitch functions write the mosaic one FOV at a time, so their peak memory is about one FOV
image for each process. Keep `WORK` until the store is written, because the images read from it.

## Processing for spatial cell data

Process the cells as single-cell data (single-cell pack), with these differences:

- QC thresholds change with the panel. Keep the cells with at least max(20, 5th percentile)
  counts, at least 10 genes, a negative-probe fraction ≤ 0.1, and an area below
  median + 5 × IQR. An oversized segment is a group of merged cells.
- Select the HVGs (`seurat_v3` on counts) on a subsample of up to 50,000 cells.
- Do not regress out the FOV. FOV effects are a real QC signal, and the QC view shows them.
- Label the clusters with tissue markers (`asset-route.md`, `annotate_clusters`). Then split the
  classes that the panel can split (`refine_labels`), and mark the low-quality clusters
  (`flag_low_quality`, with the FOV column). A cluster of low counts in a few FOVs shows damaged
  or out-of-focus tissue.
- Add the spatial domains of the finest labels (`spatial_domains`).

## The FOV table

Add the `fovs` table of `asset-route.md`, "Context tables", with `add_table`. A low fraction of
transcripts in cells shows where the segmentation failed.
