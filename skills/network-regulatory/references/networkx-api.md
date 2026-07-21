# NetworkX API Reference

Python library for creating, manipulating, and analyzing complex networks. Use for gene co-expression networks, PPI networks, regulatory networks, and general graph analysis.

## Core Imports

```python
import networkx as nx
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
```

## Graph Construction

```python
# Undirected graph
G = nx.Graph()

# Directed graph (for regulatory networks)
G = nx.DiGraph()

# Weighted graph
G = nx.Graph()
G.add_edge("BRCA1", "TP53", weight=0.85)

# Add nodes with attributes
G.add_node("EGFR", gene_type="oncogene", chromosome="7")
G.add_nodes_from(["MYC", "KRAS", "PTEN"])
G.add_nodes_from([
    ("CDK1", {"gene_type": "kinase"}),
    ("CDK2", {"gene_type": "kinase"}),
])

# Add edges with attributes
G.add_edge("BRCA1", "TP53", weight=0.95, interaction="physical")
G.add_edges_from([
    ("MYC", "CDK1", {"weight": 0.7}),
    ("MYC", "CDK2", {"weight": 0.6}),
    ("KRAS", "EGFR", {"weight": 0.8}),
])
```

## From pandas Edge List

```python
# edge_df: DataFrame with source, target, and optional weight columns
edge_df = pd.DataFrame({
    "source": ["BRCA1", "TP53", "MYC", "EGFR"],
    "target": ["TP53", "MDM2", "CDK2", "KRAS"],
    "weight": [0.95, 0.88, 0.72, 0.81],
    "interaction": ["physical", "regulatory", "coexpression", "signaling"],
})

G = nx.from_pandas_edgelist(
    edge_df,
    source="source",
    target="target",
    edge_attr=["weight", "interaction"],   # list of columns to include as edge attributes
    create_using=nx.Graph(),               # nx.DiGraph() for directed
)

# Back to pandas
edge_df_out = nx.to_pandas_edgelist(G)
# Columns: source, target, weight, interaction

# Adjacency matrix to pandas
adj_df = nx.to_pandas_adjacency(G, weight="weight")
```

## From Correlation/Adjacency Matrix

```python
# From a correlation matrix (common for gene co-expression)
corr_df = expr_df.T.corr()  # genes x genes

# Threshold to create edges
threshold = 0.8
adj = (corr_df.abs() > threshold).astype(int)
np.fill_diagonal(adj.values, 0)  # remove self-loops

G = nx.from_pandas_adjacency(adj)

# Weighted from correlation
G_weighted = nx.from_pandas_adjacency(corr_df)
# Remove weak edges
edges_to_remove = [(u, v) for u, v, d in G_weighted.edges(data=True) if abs(d["weight"]) < threshold]
G_weighted.remove_edges_from(edges_to_remove)
# Remove self-loops
G_weighted.remove_edges_from(nx.selfloop_edges(G_weighted))
```

## Graph Properties

```python
print(f"Nodes: {G.number_of_nodes()}")
print(f"Edges: {G.number_of_edges()}")
print(f"Density: {nx.density(G):.4f}")
print(f"Connected: {nx.is_connected(G)}")

# Connected components
components = list(nx.connected_components(G))
largest_cc = max(components, key=len)
G_lcc = G.subgraph(largest_cc).copy()

# For directed graphs
if isinstance(G, nx.DiGraph):
    print(f"Weakly connected: {nx.is_weakly_connected(G)}")
    print(f"Strongly connected: {nx.is_strongly_connected(G)}")
```

## Centrality Measures

```python
# Degree centrality (fraction of nodes connected)
degree_cent = nx.degree_centrality(G)
# dict: {node: centrality_value}

# Betweenness centrality (fraction of shortest paths through node)
betweenness = nx.betweenness_centrality(G, weight="weight", normalized=True)

# Closeness centrality (inverse average distance to all nodes)
closeness = nx.closeness_centrality(G)

# Eigenvector centrality (influence based on neighbor connectivity)
eigenvector = nx.eigenvector_centrality(G, max_iter=1000, weight="weight")

# PageRank (directed graphs, e.g., regulatory networks)
pagerank = nx.pagerank(G, alpha=0.85, weight="weight")

# Combine into DataFrame for analysis
centrality_df = pd.DataFrame({
    "degree": degree_cent,
    "betweenness": betweenness,
    "closeness": closeness,
    "eigenvector": eigenvector,
}).sort_values("betweenness", ascending=False)

# Top hub genes
top_hubs = centrality_df.head(20)
```

## Community Detection

```python
# Greedy modularity optimization
from networkx.algorithms.community import greedy_modularity_communities
communities_greedy = list(greedy_modularity_communities(G, weight="weight"))

# Label propagation (fast, non-deterministic)
from networkx.algorithms.community import label_propagation_communities
communities_lp = list(label_propagation_communities(G))

# Louvain — networkx ships this built-in, so it works without the standalone
# python-louvain / community package (which may not be installed; verify, or
# `pip install python-louvain`, if you specifically need community_louvain).
from networkx.algorithms.community import louvain_communities
communities_louvain = louvain_communities(G, weight="weight", resolution=1.0, seed=0)
# communities_louvain: list of sets of nodes (same shape as the other methods)

# Modularity score
modularity = nx.community.modularity(G, communities_greedy)
print(f"Modularity: {modularity:.3f}")

# Assign community to node attribute
for i, comm in enumerate(communities_greedy):
    for node in comm:
        G.nodes[node]["community"] = i
```

## Network Visualization

```python
# Spring layout (force-directed, good default)
pos = nx.spring_layout(G, k=0.5, iterations=50, seed=42)

# Other layouts
pos = nx.kamada_kawai_layout(G)          # stress-minimization
pos = nx.circular_layout(G)              # circular arrangement
pos = nx.spectral_layout(G)             # eigenvector-based

# Basic drawing
fig, ax = plt.subplots(figsize=(12, 10))
nx.draw_networkx(
    G, pos=pos, ax=ax,
    with_labels=True,
    node_size=300,
    node_color="lightblue",
    edge_color="gray",
    font_size=8,
    alpha=0.8,
)
ax.set_title("Gene Network")
plt.axis("off")
fig.savefig("network.png", dpi=150, bbox_inches="tight")
plt.close(fig)

# Colored by community, sized by centrality
node_colors = [partition.get(n, 0) for n in G.nodes()]
node_sizes = [betweenness.get(n, 0) * 5000 + 100 for n in G.nodes()]

fig, ax = plt.subplots(figsize=(14, 12))
nx.draw_networkx(
    G, pos=pos, ax=ax,
    with_labels=True,
    node_color=node_colors,
    node_size=node_sizes,
    cmap=plt.cm.Set3,
    edge_color="gainsboro",
    font_size=7,
    alpha=0.7,
)
plt.axis("off")
fig.savefig("network_communities.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

## Subgraph and Filtering

```python
# Subgraph from a set of nodes
genes_of_interest = ["BRCA1", "TP53", "MYC", "EGFR", "KRAS"]
subG = G.subgraph(genes_of_interest).copy()

# Neighbors of a node (ego network)
neighbors = list(G.neighbors("TP53"))
ego = nx.ego_graph(G, "TP53", radius=1)

# Filter edges by weight
G_filtered = G.copy()
weak_edges = [(u, v) for u, v, d in G_filtered.edges(data=True) if d.get("weight", 0) < 0.5]
G_filtered.remove_edges_from(weak_edges)

# Remove isolated nodes
isolates = list(nx.isolates(G_filtered))
G_filtered.remove_nodes_from(isolates)

# k-core decomposition (dense subgraph)
core_number = nx.core_number(G)
k = 5
k_core = nx.k_core(G, k=k)
```

## Shortest Paths and Distance

```python
# Shortest path between two nodes
path = nx.shortest_path(G, source="BRCA1", target="MYC", weight="weight")

# All shortest path lengths from a node
lengths = dict(nx.single_source_shortest_path_length(G, "TP53"))

# Average shortest path length (connected graphs only)
if nx.is_connected(G):
    avg_path = nx.average_shortest_path_length(G)
```

## Export Formats

```python
# GraphML (preserves all attributes, recommended)
nx.write_graphml(G, "network.graphml")

# GML
nx.write_gml(G, "network.gml")

# Edge list (simple, no attributes)
nx.write_edgelist(G, "network.edgelist")

# Adjacency list
nx.write_adjlist(G, "network.adjlist")

# Read back
G_loaded = nx.read_graphml("network.graphml")
```

## Gotchas

- `nx.from_pandas_edgelist()` creates an undirected graph by default. Pass `create_using=nx.DiGraph()` for directed networks.
- `eigenvector_centrality()` may not converge on disconnected graphs. Either use the largest connected component or increase `max_iter`.
- For Louvain, prefer networkx's built-in `louvain_communities()` (from `networkx.algorithms.community`), which is always available. The standalone `community` package (`community_louvain.best_partition()`, distributed on PyPI as `python-louvain`) may not be present — verify it imports, or `pip install python-louvain`, before relying on it.
- `spring_layout()` is non-deterministic. Set `seed=` for reproducible layouts.
- `nx.draw_networkx()` renders to the current matplotlib axes. Always call `plt.close(fig)` afterward to avoid memory leaks when generating many plots.
- `from_pandas_adjacency()` treats all non-zero entries as edges. For weighted networks, ensure the DataFrame contains the actual weights, not just 0/1.
- `G.subgraph(nodes)` returns a view, not a copy. Modifying the original graph affects the subgraph. Use `.copy()` to get an independent subgraph.
- For large networks (>10k nodes), skip `with_labels=True` in drawing calls. Label rendering dominates performance.
- `betweenness_centrality()` is O(VE) and slow on large graphs. Use the `k` parameter to approximate: `nx.betweenness_centrality(G, k=100)`.
- Self-loops from correlation matrices must be explicitly removed. `from_pandas_adjacency()` does not remove diagonal entries.
