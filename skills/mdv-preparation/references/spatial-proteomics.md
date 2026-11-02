# Spatial Proteomics → MDV (CODEX/PhenoCycler, IMC, MIBI)

The rows are segmented cells, the features are markers (antibodies or metal tags), and the
values are per-cell intensities. The project has the same shape as a spatial transcriptomics
project: a `cells` datasource with slide coordinates and a region image, linked to a `markers`
datasource. These platforms come as segmentation tables plus multichannel images; there is no
mdvtools reader for any of them.

## Inputs

| Platform | Cell table | Image |
|---|---|---|
| CODEX / PhenoCycler | per-cell CSV/FCS from the segmentation tool (cell id, x, y, area, one column per marker) | QPTIFF / OME-TIFF, many channels |
| IMC (Hyperion) | per-cell mean intensities from the segmentation pipeline (for example steinbock: `intensities/*.csv` + `regionprops/*.csv`) | one MCD / TIFF stack per ROI |
| MIBI | per-cell table from the segmentation tool | one TIFF per channel per FOV |

Identify the marker columns explicitly. Separate them from morphology columns (area,
eccentricity, perimeter), position columns, and background or empty channels (`Xe131`,
`DNA1`/`DNA2` are not cell-type markers, keep them as QC).

## Build the AnnData

```python
import anndata as ad, numpy as np, pandas as pd, scipy.sparse as sp

markers = [...]                                 # the antibody columns, by name
raw = cells[markers].to_numpy(dtype=np.float32)
adata = ad.AnnData(X=sp.csr_matrix(np.arcsinh(raw / COFACTOR)), obs=cells.drop(columns=markers),
                   var=pd.DataFrame(index=[clean_marker_name(m) for m in markers]))
adata.layers["mean_intensity"] = sp.csr_matrix(raw)       # small: tens of markers
adata.obsm["spatial"] = cells[["x_um", "y_um"]].to_numpy()
```

- **Transform.** `arcsinh(x / cofactor)`; cofactor 5 for CyTOF-like IMC counts, about 150 for
  fluorescence (CODEX). State it in the README. Optionally clip each marker at its 99.9th
  percentile before you scale it to 0–1 for clustering, but export the arcsinh values as X.
- **Marker names.** Make them readable and unique: `CD3e`, not `Er170Di_CD3e`; never `|` or `(`
  (`Ki-67` is fine, `Ki67 (clone X)` is not). Keep the metal/channel tag as a `var` column.
- **Coordinates.** Convert pixels to µm with the pixel size of the platform (IMC: 1 µm/px).
  Several ROIs or FOVs: one region per ROI, each with its own extent and its own image;
  `region` is the ROI name, ≤ 256 regions.
- **Clustering.** Use the markers that define lineages (not the functional or DNA channels).
  Leiden on a kNN graph of the scaled lineage markers; label clusters with lineage markers
  (`annotate_clusters` with marker lists of the tissue). There is no need for HVG selection.

## Write the project

The AnnData route, with these changes:

- Name the feature datasource `markers` (`var_datasource_name="markers"`). Convert with
  `add_layer_data=False`, set the label of the `gs` subgroup to "arcsinh intensity", and add the
  raw values explicitly:
  `mdv.add_rows_as_columns_subgroup("cells", "markers", "raw", sp.csc_matrix(raw), label="Mean intensity")`.
- The linked feature set is small (tens of rows), so its name column stays `text`.
- Region images: one RGB composite per ROI (for example DNA in blue plus two lineage markers),
  at most 8,192 px on the long side, with the same y flip as the cells.
- The dot plot uses all lineage markers; the views otherwise follow the spatial view set.
- QC view: cell area, total intensity per cell, DNA intensity, cells per ROI.

## Anti-patterns

- Exporting raw intensities as X: the dynamic range hides most markers in every colour scale.
- Treating DNA, background, or empty channels as markers in clustering.
- One region for several ROIs whose coordinates overlap: the cells draw on top of each other.
