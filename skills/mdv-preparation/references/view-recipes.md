# View Recipes

A project opens on its `initial_view`. The converters write no useful view, so build them.
Every view starts with an "About this view" text box that says what the view shows and how to
use it. Use the gridstack layout: a 12-column grid, `gsposition = [x, y]`, `gssize = [w, h]`.

## Chart types and their parameters

| `type` | `param` | Notes |
|---|---|---|
| `wgl_scatter_plot` | `[x, y]` numbers | `color_by`: a field, a virtual gene id, or a RowsAsColsQuery |
| `image_scatter_plot` (Centroid Plot) | `[x, y, color]` | needs `regions`; draws the region image under the cells |
| `row_chart` | `[category]` | `text`, `text16`, `multitext` |
| `stacked_row_chart` | `[category, category]` | `text` only |
| `bar_chart` (histogram) | `[number]` | `bin_number`, `display_min`, `display_max` |
| `dot_plot` | `[category, gene, gene, …]` | `text`/`text16` category + virtual gene ids |
| `violin_plot`, `box_plot` | `[category, number]` | `text` only |
| `heat_map` | `[category, gene, …]` | `text` only |
| `table_chart` | `[fields…]` | `include_index: false` |
| `selection_dialog` | `[fields…]` | the genes panel uses it to pick genes |
| `text_box_chart` | `[]` | markdown in `text` |

A virtual gene id is `f"gs|{gene}(gs)|{j}"`, where `j` is the row of the gene in the genes
datasource (the column of the matrix in `var` order). Do not take `j` from the `values` of the
name column: they are in frequency order, not row order.

## The helper module

```python
# file: mdv_views.py
"""Chart and view builders for MDV gridstack views."""
import random
import string


def _id():
    return "".join(random.choices(string.ascii_letters, k=6))


def chart(kind, title, param, pos, size, **extra):
    d = {"type": kind, "title": title, "param": param, "size": [400, 300], "position": [0, 0],
         "gsposition": list(pos), "gssize": list(size), "id": _id()}
    d.update(extra)
    return d


AXIS = {"label": "", "textSize": 13, "tickfont": 10}


def scatter(title, x, y, color_by, pos, size, legend=True, **extra):
    opts = {"radius": 2, "opacity": 0.8, "brush": "poly", "default_color": "#377eb8", "color_by": color_by,
            "color_legend": {"display": legend, "pos": [12, 12]},
            "axis": {"x": {"size": 30, "textsize": 13, **AXIS}, "y": {"size": 45, "textsize": 13, **AXIS}}}
    opts.update(extra)
    return chart("wgl_scatter_plot", title, [x, y], pos, size, **opts)


def tissue(title, x, y, color, pos, size, region=None, roi=None, image=None, **extra):
    """Cells on the tissue image (Centroid Plot) when a region image exists, else a plain scatter."""
    if region and image:
        opts = {"color_by": color, "region": region, "roi": roi, "background_image": image, "image_opacity": 0.6,
                "background_filter": extra.pop("background_filter"), "radius": 1.5, "opacity": 0.9,
                "color_legend": {"display": True, "pos": [12, 12]}}
        opts.update(extra)
        return chart("image_scatter_plot", title, [x, y, color], pos, size, **opts)
    return scatter(title, x, y, color, pos, size, radius=1.5, **{k: v for k, v in extra.items() if k != "background_filter"})


def row(title, field, pos, size):
    return chart("row_chart", title, [field], pos, size, axis={"x": dict(AXIS)})


def histogram(title, field, lo, hi, pos, size, unit):
    return chart("bar_chart", title, [field], pos, size, bin_number=50, display_min=lo, display_max=hi,
                 x_axis={"size": 30, "label": unit, "textSize": 13, "tickfont": 10},
                 y_axis={"size": 45, "label": "count", "textSize": 13, "tickfont": 10, "rotate_labels": False})


def dot(title, category, genes, pos, size):
    return chart("dot_plot", title, [category] + list(genes), pos, size, axis={"x": dict(AXIS), "y": dict(AXIS)},
                 color_scale={"log": False}, color_legend={"display": True, "pos": [40, 10]},
                 fraction_legend={"display": True, "pos": [0, 0]})


def violin(title, category, value, pos, size):
    return chart("violin_plot", title, [category, value], pos, size, box_visible=True, meanline_visible=True)


def table(title, fields, pos, size):
    return chart("table_chart", title, list(fields), pos, size, include_index=False)


def selection(title, fields, pos, size):
    return chart("selection_dialog", title, list(fields), pos, size)


def textbox(title, text, pos, size):
    return chart("text_box_chart", title, [], pos, size, text=text)


def selected_gene(genes_ds="genes"):
    """Follows the genes the user selects in the genes panel."""
    return {"linkedDsName": genes_ds, "maxItems": 1, "type": "RowsAsColsQuery"}


def gene_ids(var_names, genes, stub="gs"):
    """Virtual column ids for the genes present, in the order given."""
    row_of = {g: j for j, g in enumerate(var_names)}
    return [f"{stub}|{g}({stub})|{row_of[g]}" for g in genes if g in row_of]


def panels(**widths):
    return {ds: {"layout": "gridstack", "panelWidth": w} for ds, w in widths.items()}


def standard_views(*, about, var_names, markers, label="cell_type", cluster="cluster", qc=(), spatial=None,
                   context=None, cells="cells", genes="genes"):
    """The standard view set.

    about: markdown for the first view. markers: canonical genes for the dot plot.
    qc: [(field, title, lo, hi, unit)] histograms. spatial: None, or a dict with x, y and
    optionally region, roi, image, background_filter (see tissue()). context: optional
    {"datasource": name, "table": [fields], "map": (x, y, color) or None, "about": markdown}
    for the QC view, and {"clusters": [fields]} for the atlas evidence table.
    """
    context = context or {}
    sel = selected_gene(genes)
    views = {}
    first = [textbox("About this view", about, [8, 0], [4, 4])]
    if spatial:
        first += [tissue("Cells on the tissue, coloured by cell type", spatial["x"], spatial["y"], label, [0, 0], [8, 10],
                         region=spatial.get("region"), roi=spatial.get("roi"), image=spatial.get("image"),
                         background_filter=spatial.get("background_filter"))]
    else:
        first += [scatter("UMAP, coloured by cell type", "X_umap_1", "X_umap_2", label, [0, 0], [8, 10])]
    first += [row("Cells per cell type", label, [8, 4], [4, 6])]
    first += [scatter("UMAP, coloured by cell type", "X_umap_1", "X_umap_2", label, [0, 10], [6, 8], legend=False)
              if spatial else row("Cells per cluster", cluster, [0, 10], [6, 8])]
    first += [row("Cells per cluster", cluster, [6, 10], [6, 8])] if spatial else []
    views["Tissue map" if spatial else "Overview"] = {"dataSources": panels(**{cells: 100}), "initialCharts": {cells: first}}

    atlas = {cells: [scatter("UMAP, coloured by cluster", "X_umap_1", "X_umap_2", cluster, [0, 0], [12, 9]),
                     dot("Canonical markers by cell type", label, gene_ids(var_names, markers), [0, 9], [12, 8])]}
    widths = {cells: 100}
    if context.get("clusters"):
        atlas["clusters"] = [textbox("About this view", "Each cluster label comes from the overlap of the cluster's top "
                                     "differentially expressed genes with curated marker lists. The table lists the evidence. "
                                     "Labels are putative: check them against the dot plot.", [0, 0], [12, 3]),
                             table("Cluster annotation evidence", context["clusters"], [0, 3], [12, 14])]
        widths = {cells: 65, "clusters": 35}
    views["Cell atlas"] = {"dataSources": panels(**widths), "initialCharts": atlas}

    explore = [scatter("Selected gene on the UMAP", "X_umap_1", "X_umap_2", sel, [0, 10] if spatial else [0, 0],
                       [6, 8] if spatial else [12, 10]),
               violin("Selected gene by cell type", label, sel, [6, 10] if spatial else [0, 10], [6, 8] if spatial else [12, 8])]
    if spatial:
        explore.insert(0, scatter("Selected gene on the tissue", spatial["x"], spatial["y"], sel, [0, 0], [12, 10], radius=1.5))
    views["Gene explorer"] = {"dataSources": panels(**{cells: 70, genes: 30}), "initialCharts": {
        cells: explore,
        genes: [selection("Find a gene", ["name"], [0, 0], [12, 3]),
                table("Genes", ["name"] + list(context.get("gene_table", [])), [0, 3], [12, 15])]}}

    if qc:
        charts = [textbox("About this view", context.get("qc_about", "Quality metrics of the cells in this project."), [0, 0], [12, 2])]
        for i, (f, t, lo, hi, unit) in enumerate(qc):
            charts.append(histogram(t, f, lo, hi, [6 * (i % 2), 2 + 6 * (i // 2)], [6, 6], unit))
        if spatial:
            charts.append(scatter(f"{qc[0][1]} on the tissue", spatial["x"], spatial["y"], qc[0][0],
                                  [6 * (len(qc) % 2), 2 + 6 * (len(qc) // 2)], [6, 6], radius=1.5))
        qc_view = {"dataSources": panels(**{cells: 100}), "initialCharts": {cells: charts}}
        ctx = context.get("datasource")
        if ctx:
            ctx_charts = []
            if context.get("map"):
                x, y, color = context["map"]
                ctx_charts.append(scatter(context.get("map_title", f"{ctx} map"), x, y, color, [0, 0], [12, 8], radius=8))
            ctx_charts.append(table(context.get("table_title", ctx), context["table"], [0, 8 if ctx_charts else 0], [12, 10]))
            qc_view = {"dataSources": panels(**{cells: 60, ctx: 40}), "initialCharts": {cells: charts, ctx: ctx_charts}}
        views["Quality control"] = qc_view
    return views
```

## The standard view sets

| View | single-cell / scATAC | spatial (transcriptomics, proteomics) |
|---|---|---|
| first view | **Overview**: UMAP by cell type, cells per cell type, cells per cluster | **Tissue map**: cells on the tissue image by cell type, cells per cell type, UMAP |
| Cell atlas | UMAP by cluster, dot plot of canonical markers by cell type, cluster evidence table | same |
| Gene explorer | genes panel (search + table); selected gene on the UMAP and as a violin by cell type | + selected gene on the tissue |
| Quality control | histograms of the QC metrics | + one metric on the tissue, the FOV / sample table and map |

For multi-sample data add a stacked row chart of cell type by sample, and use the sample column
as `background_filter` / region so each sample has its own tissue panel.

## Checks before you save views

- Every `param` and `color_by` exists in the panel's datasource (the validator checks this).
- Hide columns before any view references them.
- Category charts get `text` columns only (≤ 256 values).
- The dot plot gets 5–15 canonical markers of the tissue that are present in the panel.
- The first view has no chart that loads every gene.
