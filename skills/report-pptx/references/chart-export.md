# Chart Export

Patterns for generating static chart images from analysis data for embedding into PowerPoint slides. The sandbox environment provides matplotlib, seaborn, and numpy.

## General Setup

```python
import matplotlib
matplotlib.use("Agg")  # Non-interactive backend for headless rendering
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import seaborn as sns
import numpy as np

# Inflexa color palette (matches slide branding)
NAVY = "#1e293b"
DARK_GRAY = "#334155"
INDIGO = "#4f46e5"
LIGHT_INDIGO = "#818cf8"
CORAL = "#ef4444"
TEAL = "#14b8a6"
AMBER = "#f59e0b"
LIGHT_BG = "#f8fafc"

# Default style
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Calibri", "DejaVu Sans", "Arial"],
    "font.size": 12,
    "axes.titlesize": 16,
    "axes.labelsize": 14,
    "axes.facecolor": "white",
    "figure.facecolor": "white",
    "axes.edgecolor": DARK_GRAY,
    "axes.labelcolor": DARK_GRAY,
    "xtick.color": DARK_GRAY,
    "ytick.color": DARK_GRAY,
})
```

## Save Convention

All chart images are saved as PNG at 300 DPI with a tight bounding box. Use white background for slide embedding (transparent can cause issues in PowerPoint).

```python
def save_chart(fig, path: str, dpi: int = 300):
    """Save figure for slide embedding."""
    fig.savefig(path, dpi=dpi, bbox_inches="tight", facecolor="white", pad_inches=0.3)
    plt.close(fig)
```

## Volcano Plot

Standard differential expression visualization with log2 fold-change on x-axis and -log10(p-value) on y-axis. Threshold lines indicate significance cutoffs.

```python
def create_volcano_plot(
    log2fc: np.ndarray,
    neg_log10p: np.ndarray,
    labels: np.ndarray | None = None,
    fc_threshold: float = 1.0,
    p_threshold: float = 1.3,  # -log10(0.05)
    output_path: str = "volcano.png",
):
    fig, ax = plt.subplots(figsize=(10, 8))

    # Classify points
    up = (log2fc > fc_threshold) & (neg_log10p > p_threshold)
    down = (log2fc < -fc_threshold) & (neg_log10p > p_threshold)
    ns = ~up & ~down

    ax.scatter(log2fc[ns], neg_log10p[ns], c="#94a3b8", s=8, alpha=0.5, label="NS")
    ax.scatter(log2fc[up], neg_log10p[up], c=CORAL, s=12, alpha=0.7, label="Up")
    ax.scatter(log2fc[down], neg_log10p[down], c=INDIGO, s=12, alpha=0.7, label="Down")

    # Threshold lines
    ax.axhline(y=p_threshold, color=DARK_GRAY, linestyle="--", linewidth=0.8, alpha=0.5)
    ax.axvline(x=fc_threshold, color=DARK_GRAY, linestyle="--", linewidth=0.8, alpha=0.5)
    ax.axvline(x=-fc_threshold, color=DARK_GRAY, linestyle="--", linewidth=0.8, alpha=0.5)

    # Optional: label top genes
    if labels is not None:
        sig = up | down
        top_idx = np.argsort(neg_log10p[sig])[-10:]  # Top 10 by significance
        sig_indices = np.where(sig)[0]
        for idx in top_idx:
            i = sig_indices[idx]
            ax.annotate(
                labels[i],
                (log2fc[i], neg_log10p[i]),
                fontsize=8, color=NAVY,
                xytext=(5, 5), textcoords="offset points",
            )

    ax.set_xlabel("log$_2$ Fold Change")
    ax.set_ylabel("-log$_{10}$ Adjusted P-value")
    ax.set_title("Differential Expression")
    ax.legend(loc="upper right", framealpha=0.9)
    sns.despine(ax=ax)

    save_chart(fig, output_path)
    return output_path
```

## Heatmap

Clustered heatmap for expression data or correlation matrices. Uses seaborn clustermap for hierarchical clustering or matplotlib imshow for pre-ordered matrices.

```python
def create_heatmap(
    data: np.ndarray,
    row_labels: list[str] | None = None,
    col_labels: list[str] | None = None,
    title: str = "Expression Heatmap",
    cluster: bool = True,
    output_path: str = "heatmap.png",
):
    if cluster:
        g = sns.clustermap(
            data,
            cmap="RdBu_r",
            center=0,
            figsize=(12, 10),
            xticklabels=col_labels if col_labels else False,
            yticklabels=row_labels if row_labels else False,
            linewidths=0.1,
            linecolor=LIGHT_BG,
            dendrogram_ratio=(0.1, 0.12),
            cbar_kws={"label": "Z-score"},
        )
        g.fig.suptitle(title, y=1.02, fontsize=16, color=NAVY)
        save_chart(g.fig, output_path)
    else:
        fig, ax = plt.subplots(figsize=(12, 10))
        im = ax.imshow(data, cmap="RdBu_r", aspect="auto")
        ax.set_title(title, color=NAVY)

        if col_labels:
            ax.set_xticks(range(len(col_labels)))
            ax.set_xticklabels(col_labels, rotation=45, ha="right", fontsize=8)
        if row_labels:
            ax.set_yticks(range(len(row_labels)))
            ax.set_yticklabels(row_labels, fontsize=8)

        plt.colorbar(im, ax=ax, label="Z-score", shrink=0.8)
        save_chart(fig, output_path)

    return output_path
```

## Bar Chart

Horizontal bar chart for ranked data such as enrichment results, top DE genes, or pathway scores.

```python
def create_bar_chart(
    labels: list[str],
    values: list[float],
    title: str = "Top Results",
    xlabel: str = "Score",
    color: str = INDIGO,
    highlight_top: int = 3,
    output_path: str = "barchart.png",
):
    fig, ax = plt.subplots(figsize=(10, max(4, len(labels) * 0.4)))

    # Reverse so highest value appears at top
    labels = labels[::-1]
    values = values[::-1]

    colors = [INDIGO if i >= len(labels) - highlight_top else LIGHT_INDIGO
              for i in range(len(labels))]

    bars = ax.barh(labels, values, color=colors, edgecolor="white", height=0.6)

    ax.set_xlabel(xlabel)
    ax.set_title(title, color=NAVY, fontweight="bold")
    ax.xaxis.set_major_locator(ticker.MaxNLocator(integer=False, nbins=6))
    sns.despine(ax=ax, left=True)
    ax.tick_params(left=False)

    # Value labels on bars
    for bar, val in zip(bars, values):
        ax.text(
            bar.get_width() + max(values) * 0.01,
            bar.get_y() + bar.get_height() / 2,
            f"{val:.2f}",
            va="center", fontsize=10, color=DARK_GRAY,
        )

    save_chart(fig, output_path)
    return output_path
```

## PCA / Dimensionality Reduction Plot

Scatter plot for PCA, t-SNE, or UMAP projections with group coloring.

```python
def create_scatter_plot(
    x: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray | None = None,
    title: str = "PCA",
    xlabel: str = "PC1",
    ylabel: str = "PC2",
    output_path: str = "scatter.png",
):
    fig, ax = plt.subplots(figsize=(10, 8))

    palette = [INDIGO, CORAL, TEAL, AMBER, "#8b5cf6", "#06b6d4", "#ec4899"]

    if groups is not None:
        unique_groups = np.unique(groups)
        for i, grp in enumerate(unique_groups):
            mask = groups == grp
            ax.scatter(
                x[mask], y[mask],
                c=palette[i % len(palette)],
                s=30, alpha=0.7, label=str(grp),
                edgecolors="white", linewidth=0.3,
            )
        ax.legend(title="Group", loc="best", framealpha=0.9)
    else:
        ax.scatter(x, y, c=INDIGO, s=30, alpha=0.7, edgecolors="white", linewidth=0.3)

    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_title(title, color=NAVY, fontweight="bold")
    sns.despine(ax=ax)

    save_chart(fig, output_path)
    return output_path
```

## Embedding Charts into Slides

After generating a chart image, embed it into a slide using the figure slide layout from `slide-layouts.md`:

```python
from pptx.util import Inches

# Generate the chart
chart_path = create_volcano_plot(log2fc, pvals, labels, output_path="volcano.png")

# Embed into slide
add_figure_slide(
    prs,
    image_path=chart_path,
    caption="Volcano plot showing differentially expressed genes (|log2FC| > 1, FDR < 0.05)",
    heading="Differential Expression Results",
)
```

## ECharts Config Conversion

When the Document JSON contains figures that reference ECharts configurations (from the frontend), convert them to matplotlib equivalents:

- **ECharts scatter** -> `create_scatter_plot()` or `create_volcano_plot()`
- **ECharts heatmap** -> `create_heatmap()`
- **ECharts bar** -> `create_bar_chart()`
- **ECharts line** -> standard `plt.plot()` with Inflexa styling

Extract the data arrays from the ECharts `series[].data` and axis labels from `xAxis.data` / `yAxis.data`, then pass to the corresponding matplotlib function.
