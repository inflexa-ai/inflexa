# Spatial Transcriptomics → MDV

Build one cell-level (or spot-level) AnnData with slide coordinates in micrometres, process it
like single-cell data, then write it through the AnnData route with a region image so the
cells sit on the tissue.

## What the project needs from a spatial dataset

| Item | Where it goes |
|---|---|
| cell × gene counts → log-normalised sparse X | "Gene Scores" |
| slide coordinates (µm), y flipped upwards | `obs["x_um"]`, `obs["y_um"]` (position fields of the region) |
| one region per slide/sample | `obs["region"]` (`text`) + `set_region_data` |
| a downsampled tissue image of each region (≤ 8,192 px) | `add_region_images` |
| per-cell QC: counts, genes, negative-control probes, area | `obs` |
| per-FOV or per-sample QC | a `fovs` / `samples` context datasource |
| morphology stain intensities, if the platform gives them | `obs`, grouped as "Morphology markers" |

Flip y once, for every coordinate in the project, with the same image height:
`y_up = image_height_um − y_image_um`. Cells and FOV centres then match the image.

## Platform decision tree

```
Platform?
├── CosMx (NanoString/Bruker SMI)
│   ├── AtoMx flat-file export: *exprMat_file.csv, *metadata_file.csv, *fov_positions_file.csv (+ tx_file, polygons)
│   │   → spatialdata_io.cosmx(path) or pandas; global coordinates are already in the metadata
│   │     (CenterX_global_px / CenterY_global_px, or x_slide_mm / y_slide_mm)
│   └── Raw instrument output: RunSummary/, CellStatsDir/FOVnnn/, a decoded run directory with
│       FOVnnn/*complete_code_cell_target_call_coord.csv
│       → cosmx_raw.py below; run the orientation check before you trust the layout
├── Xenium → spatialdata_io.xenium(path): table "table" (cells), obsm["spatial"] in µm,
│            image "morphology_focus"; use cell_id as the cell id
├── Visium / Visium HD → spots/bins are rows; coordinates in full-resolution pixels
│            (scalefactors give µm via the 55 µm spot diameter); hires image as the region image;
│            one project per bin size for HD
└── MERSCOPE / MERFISH → cell_by_gene.csv + cell_metadata.csv (center_x, center_y in µm);
             "Blank-*" barcodes are negative controls, not genes
```

Always: negative-control probes and false codes are QC columns, never genes. Panels merge some
paralogues into one target with `/` in the name (`HBA1/2`); that is fine as a gene name, but
never as a column field or an h5 key.

## CosMx raw instrument output

The run has no cell × gene matrix. Build it from the decoded transcript calls:

| File | Content |
|---|---|
| `RunSummary/*ExptConfig.txt` | `ImPixel_nm` (pixel size), `Image Rows/Cols`, run identity |
| `RunSummary/latest.fovs.csv` | no header: slide, X_mm, Y_mm, Z_mm, ZOffset_mm, ROI, FOV, order |
| `CellStatsDir/FOVnnn/*_Cell_Stats_Fnnn.csv` | per cell: Area (px), AspectRatio, CenterX/Y (FOV px), Width, Height, Mean-/Max-<stain> |
| `CellStatsDir/FOVnnn/CellLabels_Fnnn.tif` | segmentation labels; label value = CellId |
| `CellStatsDir/RnD/*_Summary_Fnnn.csv` | first line names the morphology kit |
| `CellStatsDir/CellComposite/CellComposite_Fnnn.jpg` | per-FOV false-colour composite (FOV pixel size) |
| `<run>/FOVnnn/*__complete_code_cell_target_call_coord.csv` | one row per transcript: CellId (0 = not in a cell), codeclass (Endogenous / Negative / SystemControl), target, x, y (FOV px) |

Facts to rely on, checked on a 6K-panel run:

- `CellId 1` in Cell_Stats is a whole-FOV placeholder with `Area 0`. Drop rows with `Area == 0`.
- Transcript `(x, y)` and `CellLabels[y, x]` agree (about 99 %); Cell_Stats `Area` equals the
  label pixel count. All three are in the same FOV pixel frame.
- `CellComp` in the transcript file can be empty; do not rely on compartments.
- The morphology kit file (`*.mkit`, `Morphology_ChannelID_Dictionary.txt`) can be stale. The
  `Mean-<stain>` column names of Cell_Stats are the stains of the run. A channel named only by a
  letter has no target: say so in its display name.

### The orientation check (mandatory)

The sign between FOV image axes and stage axes is not documented in the run files and differs
between instruments and software versions. A wrong sign scrambles the tissue with no error. On
the checked run, **image right = stage −X and image down = stage +Y** (a 180° rotation, no
mirror). Do not copy that: measure it. `check_orientation` scores the four sign hypotheses by
the continuity of the composite images across the seams of neighbouring FOVs, and refuses when
the best hypothesis does not clearly win. Then stitch a thumbnail and look at it.

```python
# file: cosmx_raw.py
"""Raw CosMx SMI run -> cell x gene AnnData, FOV orientation check, stitched slide image."""
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
    """Mosaic of the CellComposite JPEGs on the slide; writes <out_stem>.jpg and .json (extent in µm)."""
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
```

Use it in this order:

```python
from cosmx_raw import check_orientation, stitch, build_anndata
o = check_orientation(RUN)                       # raises when ambiguous
extent = stitch(RUN, f"{OUT}/slide_composite", o["sign_x"], o["sign_y"])
# look at slide_composite.jpg: one continuous tissue, no seams cutting structures
adata = build_anndata(RUN, o["sign_x"], o["sign_y"])
adata.write_h5ad(f"{OUT}/raw_counts.h5ad", compression="gzip")
```

Reading every transcript file is I/O bound (pyarrow reads about 300 MB/s); a 400-FOV 6K run
takes about 10 minutes on two cores and peaks near one copy of the final matrix.

## Processing for spatial cell data

Same as single-cell (single-cell pack), with these differences:

- QC thresholds scale with the panel. Keep cells with at least max(20, 5th percentile) counts,
  at least 10 genes, a negative-probe fraction ≤ 0.1, and an area below
  median + 5 × IQR (oversized segments are merged cells).
- HVG selection (`seurat_v3` on counts) on a subsample of up to 50,000 cells.
- Do not regress out FOV: FOV effects are real QC signal; show them in the QC view.
- Label clusters with tissue markers (`anndata-route.md`, `annotate_clusters`).

## Writing the project

Follow `anndata-route.md`, plus:

```python
H = extent["height_um"]                                   # one height for every y in the project
obs["x_um"] = adata.obsm["spatial"][:, 0]
obs["y_um"] = H - adata.obsm["spatial"][:, 1]             # MDV draws y upwards
obs["region"] = pd.Categorical(["slide"] * adata.n_obs)  # one region per slide / sample
# ... convert_scanpy_to_mdv with obsm={"X_umap": ...} only (no "spatial": x_um / y_um replace it)
mdv.set_region_data("cells", {"slide": {"width": extent["width_um"], "height": H}}, region_field="region",
                    default_color="cell_type", position_fields=["x_um", "y_um"], scale_unit="µm", scale=1.0)
mdv.add_region_images("cells", {"slide": {"name": "Morphology composite", "path": f"{OUT}/slide_composite.jpg"}})
image = mdv.get_datasource_metadata("cells")["regions"]["all_regions"]["slide"]["images"]["Morphology composite"]
spatial = {"x": "x_um", "y": "y_um", "region": "slide", "image": image,
           "roi": {"min_x": 0, "min_y": 0, "max_x": extent["width_um"], "max_y": H},
           "background_filter": {"column": "region", "category": "slide"}}
views = standard_views(..., spatial=spatial, context={"datasource": "fovs", ...})   # view-recipes.md
```

The FOV table becomes the `fovs` datasource: FOV centre (`x_um`, `y_um` flipped the same way),
cells, cells after QC, median transcripts per cell, fraction of transcripts in cells, negative
probes. Show it in the QC view as a map coloured by the fraction of transcripts in cells.

## The SpatialData route (only when asked)

`mdvtools convert-spatial <output> <store>` (output folder first) needs, per table: an N×2
`obsm["spatial"]`, `uns["spatialdata_attrs"]` with region / region_key / instance_key, and an
image in the coordinate system of the annotated element; a store without such an image does not
convert. It never converts points (transcripts), it joins MDV rows to the zarr table **by
position** (never filter or reorder rows after you write the store), and its spatial chart type
differs between mdvtools versions. Pass `--no-output_geojson` for large data. Build the same views
and README afterwards.
