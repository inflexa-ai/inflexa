# Design

## Context

`mdvtools` writes an MDV project from an AnnData, a MuData, a SpatialData store, or a DataFrame. The PyPI release is 1.3.0. Its API has no `rename_column`, no `soft_delete_column`, no `set_display_name`, and no `create_default_views`. The repository head has them, but the head is not released.

## Decisions

### One agent and one pack

The work is one task with one deliverable, for each modality. A pack that each modality agent declares spreads one workflow over four prompts. Thus one plannable agent owns the task, and its capability phrases make the routing predictable. The agent also declares the modality packs. It reads them for the QC, the normalization, and the clustering of raw input.

### The AnnData route is the default, also for spatial data

The SpatialData route of `mdvtools` needs an image in the coordinate system of each table. It never converts points, it joins the rows to the table by position, and its chart type changes between versions. The AnnData route with a region and a background image works with the released version. Thus the pack makes the AnnData route the default, and it keeps the SpatialData route for a request that asks for it.

### The pack builds the views, and it sets the state

The converter writes one empty view. Thus the pack gives view builders and a standard view set for each modality. It also sets `permission: "edit"`, the initial view, and the name of the project.

### The pack ships code, and a test extracts it

A reference file holds each helper module in a fenced block that starts with `# file: <name>.py`. The agent copies the module into its step. A person can extract the blocks and run them. The modules ran against a CosMx 6K run of 193,673 cells before this change. The extracted reader gave the same matrix and the same metadata as the prototype reader.

### The validator is part of the pack

MDV has no validator, and the browser only logs a bad configuration. The pack validator checks the files, the metadata, the HDF5 layout, the views, a decode of each datasource, and a request for each column through the WSGI app of `mdvtools`, in the process. It uses `werkzeug.test.Client`, because `app.test_client()` fails with Flask 2.2 and Werkzeug 3, which the store holds.

### The orientation of a raw CosMx run is measured

The run files do not give the sign between the FOV axes and the stage axes. The reader scores the four sign hypotheses by the continuity of neighbor FOV images across their seams. It refuses a result that does not win by a clear margin.

## Open decision: mdvtools in the package store

`mdvtools` 1.3.0 pins `anndata==0.12.2`, `pandas==2.3.2`, `scanpy==1.11.4`, `numpy<2.3`, `spatialdata<0.8`, `spatialdata-io<0.7`, and `flask==3.0.3`. The store locks anndata 0.13.2, scanpy 1.12.4, numpy 2.5.2, spatialdata 0.8.0, spatialdata-io 0.7.1, flask 2.2.5, and pandas 2.3.3 (amd64) or 3.0.5 (arm64). A manifest entry resolves the closure of the package. Thus an entry downgrades the catalog for each agent, or it fails to resolve.

A test environment with the exact amd64 pins of the store and `mdvtools` installed with no dependencies ran the full route: the conversion, the regions, the images, the validator, and the server. It also needs `fasteners`, and on arm64 `polars` and `pytz`, which the store does not hold. pandas 3.0.5 was not tested.

The manifest has no entry form that installs a package with no dependencies. This change does not change the manifest. Three options remain:

1. Add an entry option to the provisioner that installs one package with no dependencies, and add `mdvtools`, `fasteners`, and `polars` (arm64).
2. Ask the MDV project to relax its pins, and then add a plain entry.
3. Let the catalog move to the pins of `mdvtools`, for each agent.

## Risks

- The marker lists for cell types are a choice for each tissue. The pack gives the method and an example for adult human cortex, and it marks each label as putative.
- The browser of MDV holds each loaded column in memory. The pack gives the limits that it knows, and it tells the agent to keep the first view light for large data.
