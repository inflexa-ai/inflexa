# SpatialData API Reference

Universal framework for spatial omics data. Provides a FAIR container for images, labels, shapes, points, and annotation tables with coordinate system transformations. Integrates with squidpy for spatial analysis.

## Import Convention

```python
import spatialdata as sd
from spatialdata.models import (
    Image2DModel, Image3DModel,
    Labels2DModel, Labels3DModel,
    ShapesModel, PointsModel, TableModel
)
from spatialdata.transformations import Identity, Scale, Translation, Affine
```

## SpatialData Object Model

Five element types, each stored as standard Python data structures:

| Element | Backend Type | Purpose |
|---------|-------------|---------|
| `images` | `xarray.DataArray` / `DataTree` (multiscale) | Microscopy, H&E, fluorescence |
| `labels` | `xarray.DataArray` / `DataTree` (multiscale) | Segmentation masks (integer-valued) |
| `shapes` | `geopandas.GeoDataFrame` | Cell boundaries, ROIs, circles |
| `points` | `dask.DataFrame` | Transcript/molecule coordinates |
| `tables` | `anndata.AnnData` | Gene expression, cell annotations |

## Creating a SpatialData Object

```python
import numpy as np
import pandas as pd
from anndata import AnnData

# Image: shape (channels, y, x)
image_data = np.random.rand(3, 512, 512).astype(np.float32)
image = Image2DModel.parse(
    image_data,
    dims=["c", "y", "x"],
    c_coords=["DAPI", "GFP", "mCherry"],
    transformations={"global": Identity()}
)

# Labels: segmentation mask, shape (y, x)
labels_data = np.random.randint(0, 100, (512, 512)).astype(np.int32)
labels = Labels2DModel.parse(labels_data, dims=["y", "x"])

# Shapes: circles with centroids and radii
coords = np.array([[100, 150], [200, 250], [300, 350]])
circles = ShapesModel.parse(
    coords,
    geometry=0,           # 0 = circles
    radius=np.array([10, 15, 20])
)

# Points: transcript locations
points_df = pd.DataFrame({
    "x": np.random.rand(1000) * 512,
    "y": np.random.rand(1000) * 512,
    "gene": np.random.choice(["GeneA", "GeneB", "GeneC"], 1000),
    "cell_id": np.random.randint(0, 100, 1000)
})
points = PointsModel.parse(
    points_df,
    coordinates={"x": "x", "y": "y"},
    feature_key="gene",
    instance_key="cell_id"
)

# Table: cell-level annotations linked to labels
table = AnnData(
    X=np.random.rand(100, 50),
    obs=pd.DataFrame({
        "region": pd.Categorical(["my_labels"] * 100),
        "instance_id": np.arange(100)
    })
)
table = TableModel.parse(
    table,
    region="my_labels",
    region_key="region",
    instance_key="instance_id"
)

# Assemble
sdata = sd.SpatialData(
    images={"my_image": image},
    labels={"my_labels": labels},
    shapes={"my_circles": circles},
    points={"my_points": points},
    tables={"my_table": table}
)
```

## Element Access

```python
# Access by type
sdata.images                 # dict-like: {"name": DataArray, ...}
sdata.labels
sdata.shapes
sdata.points
sdata.tables

# Access specific element
img = sdata.images["my_image"]
tbl = sdata.tables["my_table"]

# List all elements
print(sdata.images.keys())
print(sdata.labels.keys())
```

## Coordinate Systems and Transformations

Every spatial element (images, labels, shapes, points) lives in one or more coordinate systems. Transformations map between them.

```python
from spatialdata.transformations import (
    Identity, Scale, Translation, Affine,
    get_transformation, set_transformation
)

# Get current transformation for an element
t = get_transformation(sdata.images["my_image"], to_coordinate_system="global")

# Set a new transformation
set_transformation(
    sdata.images["my_image"],
    transformation=Scale([0.5, 0.5], axes=("x", "y")),
    to_coordinate_system="global"
)

# Affine transformation (rotation, scaling, translation)
import numpy as np
affine_matrix = np.array([
    [0.5, 0.0, 100],
    [0.0, 0.5, 200],
    [0.0, 0.0, 1.0]
])
set_transformation(
    sdata.images["he_image"],
    transformation=Affine(affine_matrix, input_axes=("x", "y"), output_axes=("x", "y")),
    to_coordinate_system="global"
)
```

## I/O: Zarr Format

SpatialData uses Zarr as its on-disk format (OME-NGFF compatible).

```python
# Write to Zarr
sdata.write("dataset.zarr")
sdata.write("dataset.zarr", overwrite=True)

# Read from Zarr
sdata = sd.read_zarr("dataset.zarr")

# Read specific element types only
sdata = sd.read_zarr("dataset.zarr", selection=("images", "tables"))

# Read from remote storage
sdata = sd.read_zarr("s3://bucket/dataset.zarr")

# Write individual elements
sdata.write_element("my_image")

# Write with consolidated metadata (required for cloud storage)
sdata.write("dataset.zarr", consolidate_metadata=True)
```

## spatialdata-io: Technology-Specific Readers

```python
from spatialdata_io import xenium, visium_hd
```

### 10x Visium HD

```python
sdata = visium_hd(
    path="path/to/visium_hd_output/",
    dataset_id="sample_1",
    filtered_counts_file=True,
    bin_size=8,                    # 8um or 16um bin size
    bins_as_squares=True
)
```

### 10x Xenium

```python
from spatialdata_io import xenium

sdata = xenium(
    "path/to/xenium_output/",
    cells_boundaries=True,
    nucleus_boundaries=True,
    cells_as_circles=False,       # polygons preferred
    cells_labels=True,
    nucleus_labels=True,
    transcripts=True,
    morphology_mip=True,
    morphology_focus=True,
    aligned_images=True,
    cells_table=True
)
```

### Other Supported Technologies

```python
from spatialdata_io import merscope, cosmx, stereoseq

# MERFISH (Vizgen MERSCOPE) — the reader is `merscope`; there is no `merfish` reader
sdata = merscope("path/to/merscope_output/")

# CosMx (Nanostring)
sdata = cosmx("path/to/cosmx_output/")

# Stereo-seq
sdata = stereoseq("path/to/stereoseq_output/")
```

## Spatial Queries

```python
# Bounding box query
queried = sdata.query.bounding_box(
    axes=("x", "y"),
    min_coordinate=np.array([100, 100]),
    max_coordinate=np.array([300, 300]),
    target_coordinate_system="global"
)

# The result is a new SpatialData with only elements within the bounding box
```

## Integration with Squidpy

SpatialData tables are AnnData objects, directly usable with squidpy.

```python
import squidpy as sq

# Extract the AnnData table
adata = sdata.tables["table"]

# Ensure spatial coordinates are in .obsm
# (may need to extract from shapes/points)
adata.obsm["spatial"] = np.column_stack([
    adata.obs["x"].values,
    adata.obs["y"].values
])

# Standard squidpy workflow
sq.gr.spatial_neighbors(adata, coord_type="generic", n_neighs=10)
sq.gr.nhood_enrichment(adata, cluster_key="cell_type")
sq.gr.spatial_autocorr(adata, mode="moran")
```

## Table-Element Linking

Tables annotate spatial elements (labels or shapes) via region/instance keys.

```python
# Link a table to a labels element
sdata.set_table_annotates_spatialelement(
    table_name="my_table",
    region="my_labels",           # name of the labels/shapes element
    region_key="region",          # column in table.obs pointing to the element name
    instance_key="instance_id"    # column in table.obs with cell/segment IDs
)
```

## Complete Workflow: Xenium to Analysis

```python
from spatialdata_io import xenium
import spatialdata as sd
import squidpy as sq
import scanpy as sc

# Load
sdata = xenium("path/to/xenium_output/")
sdata.write("xenium.zarr")

# Get expression table
adata = sdata.tables["table"].copy()

# Standard preprocessing
sc.pp.filter_cells(adata, min_genes=10)
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.pca(adata)
sc.pp.neighbors(adata)
sc.tl.leiden(adata, resolution=0.5, key_added="clusters")

# Spatial analysis with squidpy
sq.gr.spatial_neighbors(adata, coord_type="generic", n_neighs=10)
sq.gr.nhood_enrichment(adata, cluster_key="clusters")
sq.gr.spatial_autocorr(adata, mode="moran", n_jobs=4)
```

## Gotchas

- Images use `(c, y, x)` axis order (channels first), not `(y, x, c)`. Always specify `dims=["c", "y", "x"]`.
- Labels must be integer-typed (`int32` or `int64`). Float masks will fail validation.
- `TableModel.parse()` requires `region`, `region_key`, and `instance_key` to link tables to spatial elements. Missing these breaks the annotation chain.
- `sdata.write()` defaults to `overwrite=False`. Writing to an existing path without `overwrite=True` raises an error.
- SpatialData uses lazy loading (Dask for points, Zarr chunks for images). Call `.compute()` to materialize Dask arrays if needed.
- Coordinate systems are strings (e.g., `"global"`, `"microscope"`). Elements in different coordinate systems are not directly comparable without transformation.
- `spatialdata-io` readers are in a separate package: `pip install spatialdata-io`.
