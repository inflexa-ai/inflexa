# python-igraph API Reference

Fast C-based graph library with Python bindings. Preferred over NetworkX for large networks (>10k nodes) due to significantly better performance. Supports community detection, centrality, layout, and interop with NetworkX and pandas.

## Core Imports

```python
import igraph as ig
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
```

## Graph Construction

```python
# Empty undirected graph
g = ig.Graph()

# Empty directed graph
g = ig.Graph(directed=True)

# From edge list (integer vertex indices)
g = ig.Graph(n=5, edges=[(0, 1), (1, 2), (2, 3), (3, 4), (0, 4)])

# With vertex and edge attributes
g = ig.Graph(n=4, edges=[(0, 1), (1, 2), (2, 3)], directed=False)
g.vs["name"] = ["BRCA1", "TP53", "MYC", "EGFR"]
g.vs["gene_type"] = ["tumor_suppressor", "tumor_suppressor", "oncogene", "oncogene"]
g.es["weight"] = [0.95, 0.72, 0.81]
g.es["interaction"] = ["physical", "coexpression", "signaling"]
```

## From pandas DataFrame

```python
# Edge list DataFrame
edge_df = pd.DataFrame({
    "source": ["BRCA1", "TP53", "MYC", "EGFR", "KRAS"],
    "target": ["TP53", "MDM2", "CDK2", "KRAS", "RAF1"],
    "weight": [0.95, 0.88, 0.72, 0.81, 0.67],
})

# Graph.DataFrame() — auto-creates vertices from edge list
g = ig.Graph.DataFrame(edge_df, directed=False)
# Vertex names are automatically assigned from source/target columns
# g.vs["name"] gives the vertex names

# With separate vertex DataFrame
vertex_df = pd.DataFrame({
    "name": ["BRCA1", "TP53", "MYC", "EGFR", "KRAS", "MDM2", "CDK2", "RAF1"],
    "gene_type": ["ts", "ts", "onc", "onc", "onc", "onc", "kinase", "kinase"],
})
g = ig.Graph.DataFrame(edge_df, directed=False, vertices=vertex_df)

# Back to pandas
edge_df_out = g.get_edge_dataframe()
# Columns: source (int index), target (int index), plus edge attributes
vertex_df_out = g.get_vertex_dataframe()
# Columns: name, plus vertex attributes
```

## From Adjacency Matrix

```python
# From numpy adjacency matrix
adj_matrix = np.array([
    [0, 1, 0, 1],
    [1, 0, 1, 0],
    [0, 1, 0, 1],
    [1, 0, 1, 0],
])
g = ig.Graph.Adjacency(adj_matrix.tolist(), mode="undirected")
g.vs["name"] = ["A", "B", "C", "D"]

# Weighted adjacency
weight_matrix = np.array([
    [0.0, 0.8, 0.0, 0.5],
    [0.8, 0.0, 0.6, 0.0],
    [0.0, 0.6, 0.0, 0.9],
    [0.5, 0.0, 0.9, 0.0],
])
g = ig.Graph.Weighted_Adjacency(weight_matrix.tolist(), mode="undirected")
g.vs["name"] = ["BRCA1", "TP53", "MYC", "EGFR"]
```

## Famous Graphs (for Testing)

```python
g = ig.Graph.Famous("Zachary")         # Zachary's karate club (34 nodes)
g = ig.Graph.Famous("Petersen")        # Petersen graph (10 nodes)
g = ig.Graph.Erdos_Renyi(100, 0.05)   # Random graph: 100 nodes, 5% edge probability
g = ig.Graph.Barabasi(100, 3)         # Scale-free: 100 nodes, 3 edges per new node
```

## Community Detection

```python
# Leiden algorithm (recommended — improved Louvain)
communities = g.community_leiden(
    objective_function="modularity",   # "modularity" | "CPM"
    weights="weight",                  # edge attribute name or None
    resolution=1.0,                    # higher = more communities
    n_iterations=2,                    # number of iterations (-1 for convergence)
)

# Louvain (Multilevel)
communities = g.community_multilevel(weights="weight", resolution=1.0)

# Infomap (information-theoretic)
communities = g.community_infomap(edge_weights="weight", trials=10)

# Label propagation (very fast, non-deterministic)
communities = g.community_label_propagation(weights="weight")

# Fast greedy (hierarchical agglomerative)
dendrogram = g.community_fastgreedy(weights="weight")
communities = dendrogram.as_clustering()

# Edge betweenness (Girvan-Newman style)
dendrogram = g.community_edge_betweenness(weights="weight")
communities = dendrogram.as_clustering()

# Walktrap (random walks)
dendrogram = g.community_walktrap(weights="weight", steps=4)
communities = dendrogram.as_clustering()
```

### Community Object Access

```python
# Number of communities
print(f"Communities: {len(communities)}")

# Modularity
print(f"Modularity: {communities.modularity:.3f}")

# Community sizes
print(f"Sizes: {communities.sizes()}")

# Membership vector (community ID per vertex)
membership = communities.membership
# List of ints, one per vertex

# Iterate communities
for i, comm in enumerate(communities):
    gene_names = [g.vs[v]["name"] for v in comm]
    print(f"Community {i}: {len(gene_names)} genes")

# Assign to vertex attribute
g.vs["community"] = communities.membership

# Community as DataFrame
comm_df = pd.DataFrame({
    "gene": g.vs["name"],
    "community": communities.membership,
})
```

## Centrality Measures

```python
# Degree
degrees = g.degree()

# Weighted degree (strength)
strengths = g.strength(weights="weight")

# Betweenness centrality
betweenness = g.betweenness(weights="weight")

# Closeness centrality
closeness = g.closeness(weights="weight")

# Eigenvector centrality
eigenvector = g.eigenvector_centrality(weights="weight")

# PageRank
pagerank = g.pagerank(weights="weight", damping=0.85)

# Hub and authority scores (directed graphs)
hub_scores = g.hub_score(weights="weight")
authority_scores = g.authority_score(weights="weight")

# Combine into DataFrame
centrality_df = pd.DataFrame({
    "gene": g.vs["name"],
    "degree": degrees,
    "strength": strengths,
    "betweenness": betweenness,
    "closeness": closeness,
    "eigenvector": eigenvector,
    "pagerank": pagerank,
}).set_index("gene").sort_values("betweenness", ascending=False)
```

## Layout Algorithms

```python
# Force-directed layouts
layout_fr = g.layout("fruchterman_reingold")       # Fruchterman-Reingold (spring)
layout_kk = g.layout("kamada_kawai")                # Kamada-Kawai (stress minimization)
layout_drl = g.layout("drl")                        # DrL (large graphs, fast)

# Other layouts
layout_circle = g.layout("circle")
layout_grid = g.layout("grid")
layout_random = g.layout("random")
layout_auto = g.layout_auto()                       # auto-selects based on graph size

# With parameters
layout_fr = g.layout("fruchterman_reingold", niter=500, seed=42)
```

## Plotting

```python
# Basic plot with matplotlib
fig, ax = plt.subplots(figsize=(10, 10))
ig.plot(
    g,
    target=ax,
    layout=layout_fr,
    vertex_size=20,
    vertex_color="lightblue",
    vertex_label=g.vs["name"],
    vertex_label_size=8,
    edge_width=0.5,
    edge_color="gray",
)
fig.savefig("igraph_network.png", dpi=150, bbox_inches="tight")
plt.close(fig)

# Plot communities with colors
palette = ig.RainbowPalette(n=len(communities))
fig, ax = plt.subplots(figsize=(12, 12))
ig.plot(
    communities,
    target=ax,
    layout=layout_fr,
    palette=palette,
    mark_groups=True,           # draw hulls around communities
    vertex_size=15,
    vertex_label=g.vs["name"],
    vertex_label_size=7,
    edge_width=0.3,
    edge_color="gainsboro",
)
fig.savefig("igraph_communities.png", dpi=150, bbox_inches="tight")
plt.close(fig)

# Scaled by centrality
vertex_sizes = ig.rescale(betweenness, (5, 40))
fig, ax = plt.subplots(figsize=(12, 12))
ig.plot(
    g,
    target=ax,
    layout=layout_fr,
    vertex_size=vertex_sizes,
    vertex_color=[palette.get(m) for m in communities.membership],
    edge_width=0.3,
)
fig.savefig("igraph_centrality.png", dpi=150, bbox_inches="tight")
plt.close(fig)
```

## Conversion to/from NetworkX

```python
# igraph -> NetworkX
nx_graph = g.to_networkx()
# Preserves vertex/edge attributes

# NetworkX -> igraph
import networkx as nx
nx_g = nx.karate_club_graph()
ig_g = ig.Graph.from_networkx(nx_g)
# Preserves node/edge attributes as vertex/edge attributes
```

## File I/O

```python
# GraphML (recommended — preserves all attributes)
g.save("network.graphml")
g_loaded = ig.load("network.graphml")

# GML
g.save("network.gml")

# Edge list
g.write_edgelist("edges.txt")

# Pickle
g.save("network.pickle")

# NCOL (simple weighted edge list)
g.save("network.ncol", format="ncol")
```

## Subgraphs and Filtering

```python
# Subgraph by vertex IDs
genes_of_interest = ["BRCA1", "TP53", "MYC"]
vertex_ids = [g.vs.find(name=n).index for n in genes_of_interest]
subg = g.induced_subgraph(vertex_ids)

# Delete low-weight edges
to_delete = [e.index for e in g.es if e["weight"] < 0.5]
g_filtered = g.copy()
g_filtered.delete_edges(to_delete)

# Remove isolated vertices
isolated = [v.index for v in g_filtered.vs if v.degree() == 0]
g_filtered.delete_vertices(isolated)

# Largest connected component
components = g.connected_components()
largest = components.giant()
```

## Gotchas

- igraph uses integer vertex indices internally. Named vertices are accessed via `g.vs["name"]`. Use `g.vs.find(name="GENE")` to look up by name.
- `Graph.DataFrame()` expects columns named `source` and `target` by default. Other column names become edge attributes.
- `Weighted_Adjacency()` takes a list of lists (not numpy array directly). Convert with `.tolist()`.
- Community detection methods return either a `VertexClustering` object directly (Leiden, Louvain, Label Propagation, Infomap) or a `VertexDendrogram` that must be converted via `.as_clustering()` (Fast Greedy, Edge Betweenness, Walktrap).
- `community_leiden()` with `objective_function="CPM"` (Constant Potts Model) is resolution-limit-free, unlike modularity optimization. Good for finding small communities in large networks.
- `weights` parameter name varies: `weights=` for community_multilevel/leiden, `edge_weights=` for community_infomap. Check the method signature.
- `ig.plot()` requires a matplotlib `target` axis for matplotlib backend. Without `target=`, igraph uses Cairo (if installed) and saves to file.
- `ig.rescale()` scales values to a specified range. Useful for mapping centrality to visual properties (node size, color).
- igraph is significantly faster than NetworkX for large graphs. For networks with >10k nodes, prefer igraph.
- `delete_edges()` and `delete_vertices()` modify the graph in-place and reindex vertices. Always copy first with `g.copy()` if you need the original.
- The `layout()` function returns a `Layout` object (list of coordinate pairs). Access coordinates with `layout.coords` or index directly.
