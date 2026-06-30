# OmniPath via decoupler / omnipath Python API Reference

OmniPath is a comprehensive database of molecular interactions (PPI, TF-target, kinase-substrate, ligand-receptor). Accessed in Python via the `omnipath` package or through `decoupler`'s OmniPath wrappers.

## decoupler OmniPath Wrappers (Recommended)

```python
import pandas as pd

# CollecTRI: curated transcription factor-target gene regulatory network
# Load from pre-staged ref store — NEVER call dc.op.collectri() (no network access).
collectri = pd.read_parquet("<path from list-available-refs>/omnipath/processed/organism_9606/interactions_by_dataset/interactions__dataset_collectri.parquet")
# Returns DataFrame: source, target, weight, PMID, ...
# source = TF, target = gene, weight = mode of regulation (+1/-1)

# NOTE: DoRothEA is superseded by CollecTRI. Do not use dc.op.dorothea().

# PROGENy: pathway-responsive gene signatures
# Load from pre-staged ref store — NEVER call dc.op.progeny() (no network access).
progeny = pd.read_parquet("<path from list-available-refs>/progeny/processed/progeny_human.parquet")
# Returns: source (pathway), target (gene), weight (responsiveness score)
```

## omnipath Python Package (Direct Access)

```python
import omnipath

# All curated interactions (comprehensive)
interactions = omnipath.interactions.AllInteractions.get()
# Large DataFrame: source, target, type, references, etc.

# OmniPath curated PPI (high-confidence subset)
ppi = omnipath.interactions.OmniPath.get()

# Specific interaction types
kinase_sub = omnipath.interactions.KinaseSubstrate.get()      # kinase-substrate
tf_target = omnipath.interactions.Transcriptional.get()       # TF-target
mirna = omnipath.interactions.miRNA.get()                     # miRNA-target
ligand_receptor = omnipath.interactions.LigandReceptor.get()  # ligand-receptor

# Filter by source database
interactions_filtered = omnipath.interactions.OmniPath.get(
    resources=['SignaLink3', 'SIGNOR']
)

# Filter by protein
tp53_interactions = omnipath.interactions.AllInteractions.get(
    genesymbols=['TP53']
)

# Enzyme-substrate relationships (with modification details)
enz_sub = omnipath.interactions.EnzymeSubstrate.get()
# Includes: enzyme, substrate, residue_type, residue_offset, modification
```

## Interaction DataFrame Columns

```python
# Common columns in interaction DataFrames:
# source           - source gene symbol (e.g. TF, kinase, ligand)
# target           - target gene symbol (e.g. target gene, substrate, receptor)
# source_genesymbol - source as gene symbol
# target_genesymbol - target as gene symbol
# is_directed      - whether the interaction has directionality
# is_stimulation   - activating interaction
# is_inhibition    - inhibitory interaction
# consensus_direction      - consensus on directionality
# consensus_stimulation    - consensus on activation
# consensus_inhibition     - consensus on inhibition
# references       - PubMed IDs supporting the interaction
# sources          - databases reporting this interaction

# Example filtering
activating = interactions[interactions['is_stimulation'] == True]
inhibitory = interactions[interactions['is_inhibition'] == True]
directed = interactions[interactions['is_directed'] == True]
```

## Converting to NetworkX Graph

```python
import networkx as nx
import omnipath

# Get interactions
ppi = omnipath.interactions.OmniPath.get()

# Build directed graph
G = nx.DiGraph()
for _, row in ppi.iterrows():
    G.add_edge(
        row['source_genesymbol'],
        row['target_genesymbol'],
        is_stimulation=row.get('is_stimulation', False),
        is_inhibition=row.get('is_inhibition', False),
        references=row.get('references', ''),
        sources=row.get('sources', '')
    )

print(f"Nodes: {G.number_of_nodes()}, Edges: {G.number_of_edges()}")

# Undirected PPI network
G_undirected = G.to_undirected()

# Subnetwork for genes of interest
genes_of_interest = ['TP53', 'MDM2', 'CDKN1A', 'BAX', 'BCL2']
subgraph = G.subgraph(genes_of_interest).copy()

# Neighborhood (1-hop) around a gene
neighbors = set(G.predecessors('TP53')) | set(G.successors('TP53'))
neighborhood = G.subgraph(neighbors | {'TP53'}).copy()
```

## Decoupler Activity Inference with OmniPath Networks

```python
import decoupler as dc
import pandas as pd

# Get TF-target network
collectri = pd.read_parquet("<path from list-available-refs>/omnipath/processed/organism_9606/interactions_by_dataset/interactions__dataset_collectri.parquet")

# Run enrichment analysis on expression data
# mat: DataFrame (samples x genes), net: DataFrame (source, target, weight)
# Returns: estimate (activity scores) and pvalues
acts, pvals = dc.run_ulm(
    mat=expression_df,              # samples x genes
    net=collectri                   # source, target, weight
)

# Multivariate Linear Model (MLM) for TF activity
acts_mlm, pvals_mlm = dc.run_mlm(
    mat=expression_df,
    net=collectri
)

# Pathway activity with PROGENy
progeny = pd.read_parquet("<path from list-available-refs>/progeny/processed/progeny_human.parquet")
pathway_acts, pathway_pvals = dc.run_mlm(
    mat=expression_df,
    net=progeny
)
```

## Building Custom Networks from OmniPath

```python
import omnipath
import pandas as pd

# Combine multiple interaction types for a comprehensive signaling network
ppi = omnipath.interactions.OmniPath.get()
ks = omnipath.interactions.KinaseSubstrate.get()
tf = omnipath.interactions.Transcriptional.get()

# Standardize columns and concatenate
def standardize(df, interaction_type):
    return df[['source_genesymbol', 'target_genesymbol',
               'is_stimulation', 'is_inhibition']].assign(type=interaction_type)

combined = pd.concat([
    standardize(ppi, 'PPI'),
    standardize(ks, 'kinase_substrate'),
    standardize(tf, 'transcriptional')
]).drop_duplicates()

# Assign weights: +1 for stimulation, -1 for inhibition, 0 for unknown
combined['weight'] = 0
combined.loc[combined['is_stimulation'] == True, 'weight'] = 1
combined.loc[combined['is_inhibition'] == True, 'weight'] = -1

# Filter to a gene set of interest
target_genes = set(deg_df['gene'].tolist())
relevant = combined[
    (combined['source_genesymbol'].isin(target_genes)) |
    (combined['target_genesymbol'].isin(target_genes))
]
```

## Complete Workflow Example

```python
import decoupler as dc
import omnipath
import networkx as nx
import matplotlib.pyplot as plt
import pandas as pd

# 1. Get TF-target network and infer TF activities
collectri = pd.read_parquet("<path from list-available-refs>/omnipath/processed/organism_9606/interactions_by_dataset/interactions__dataset_collectri.parquet")
tf_acts, tf_pvals = dc.run_ulm(mat=expression_df, net=collectri)

# 2. Get top differential TFs
top_tfs = tf_acts.mean(axis=0).abs().sort_values(ascending=False).head(10).index.tolist()
print(f"Top TFs: {top_tfs}")

# 3. Build PPI network around top TFs
ppi = omnipath.interactions.OmniPath.get()
G = nx.DiGraph()
for _, row in ppi.iterrows():
    G.add_edge(row['source_genesymbol'], row['target_genesymbol'])

# Extract subnetwork
tf_neighbors = set()
for tf in top_tfs:
    if tf in G:
        tf_neighbors |= set(G.successors(tf)) | set(G.predecessors(tf))
subgraph = G.subgraph(tf_neighbors | set(top_tfs)).copy()

# 4. Pathway activities
progeny = pd.read_parquet("<path from list-available-refs>/progeny/processed/progeny_human.parquet")
pathway_acts, _ = dc.run_mlm(mat=expression_df, net=progeny)

print(f"Network: {subgraph.number_of_nodes()} nodes, {subgraph.number_of_edges()} edges")
print(f"Active pathways:\n{pathway_acts.mean(axis=0).sort_values(ascending=False).head()}")
```

## Gotchas

- Install both `omnipath` and `decoupler` packages: `pip install omnipath decoupler`.
- OmniPath queries hit a remote server. Cache results for repeated use; `omnipath` has built-in caching.
- Pre-staged OmniPath resources (CollecTRI, PROGENy) are parquet DataFrames with `source`, `target`, `weight` columns. Load via `pd.read_parquet()` — never call `dc.op.*()` (no network access). Do not use DoRothEA — it is superseded by CollecTRI.
- License matters: `license='academic'` returns the most complete data. `'commercial'` may exclude some sources.
- For `dc.run_ulm()` / `dc.run_mlm()`, the expression matrix must have genes as columns and samples as rows.
- Gene symbols must match between expression data and network. OmniPath uses HGNC symbols for human, MGI for mouse.
- Some interactions appear in both directions. Use `is_directed` and `consensus_direction` columns to filter.
- `omnipath.interactions.AllInteractions.get()` returns a very large DataFrame (millions of rows). Filter early by `resources`, `genesymbols`, or interaction type.
- NetworkX conversion: always check that your genes of interest exist as nodes before extracting subgraphs.
