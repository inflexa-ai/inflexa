# OmniPath via decoupler / omnipath Python API Reference

OmniPath is a comprehensive database of molecular interactions (PPI, TF-target, kinase-substrate, ligand-receptor). The `omnipath` package and `decoupler`'s `dc.op.*()` wrappers both reach it over HTTP.

## Resource Loading

**The OmniPath web service is not reachable.** There is no network egress, and the service itself (omnipathdb.org) is currently returning 502 — so a retry, a proxy attempt, or a longer timeout will not help. Every `omnipath.interactions.*.get()` and every `dc.op.*()` call in this reference is documentation of an API you cannot call here; each section below states what to load from a file instead.

**Resolve the file before you write the script.** Ask for the *dataset* by what it is, not by a path — reference data is provisioned per-environment, so the directory, the filename, and the format all vary and none of them are yours to assume:

| You need | Ask for | Standard sources |
|-|-|-|
| TF activity | A TF-target regulon network for your organism | CollecTRI; or DoRothEA filtered to confidence A-C |
| Pathway activity | Pathway responsive-gene weights for your organism | PROGENy (14 pathways) |
| PPI / kinase-substrate / ligand-receptor graphs | A signed, directed interaction network for your organism | OmniPath |

Then read it with the reader its format actually calls for — these circulate as CSV, TSV, and R `.rda` depending on the source, and a wrong-format read fails immediately. Match the organism too: a human network over mouse data runs happily and returns meaningless results.

**Be honest when a dataset is absent.** General OmniPath interaction data (PPI, kinase-substrate, ligand-receptor) is not currently part of the reference data available to you. If you resolve it and it is not there, say so and proceed with what the analysis can support — do not silently substitute a different network, and do not fabricate edges.

```python
import pandas as pd

# `regulon_path` and `pathway_path` are paths you resolved, not literals to copy.
collectri = pd.read_csv(regulon_path)
progeny = pd.read_csv(pathway_path)
```

### Network DataFrame Format

The activity-inference methods consume the same long format:

| Column | Type | Description |
|-|-|-|
| `source` | str | Regulator name (TF for a regulon network, pathway for PROGENy) |
| `target` | str | Target gene symbol (HGNC for human, MGI for mouse) |
| `weight` | float | Regulatory weight. Regulons: +1 (activation) or -1 (repression). PROGENy: signed float reflecting responsiveness. |

Column names vary by source — DoRothEA ships `tf`/`target`/`mor`, and some releases carry extra provenance columns (PMIDs, resource lists). Inspect the frame after loading and rename into `source`/`target`/`weight` before passing it on:

```python
collectri = collectri.rename(columns={"tf": "source", "mor": "weight"})
collectri = collectri[["source", "target", "weight"]]
```

NOTE: DoRothEA is superseded by CollecTRI — prefer a CollecTRI regulon set when the inventory offers both.

## omnipath Python Package (Direct Access)

Every call in this section is a **web query and will fail here** — the service is unreachable. They are listed so you can recognise the interaction subsets by name and ask for the equivalent from the reference data available to you; the query is never the way to get it in this environment.

```python
import omnipath

# UNAVAILABLE — all of these hit omnipathdb.org over HTTP.
omnipath.interactions.AllInteractions.get()      # all curated interactions
omnipath.interactions.OmniPath.get()             # curated PPI (high-confidence subset)
omnipath.interactions.KinaseSubstrate.get()      # kinase-substrate
omnipath.interactions.Transcriptional.get()      # TF-target
omnipath.interactions.miRNA.get()                # miRNA-target
omnipath.interactions.LigandReceptor.get()       # ligand-receptor
omnipath.interactions.EnzymeSubstrate.get()      # enzyme-substrate + modification details
```

Load the equivalent from a resolved file instead. The subset you want (PPI, kinase-substrate, TF-target, ligand-receptor) is a property of the *data*, so ask for it by name and then filter the loaded frame:

```python
import pandas as pd

# `interaction_path` resolved from the reference inventory — a signed, directed
# interaction network for your organism. Format varies; read it accordingly.
interactions = pd.read_csv(interaction_path)

# Filtering that the web API would have done server-side, done locally instead:
ppi = interactions[interactions["type"] == "post_translational"]
tf_target = interactions[interactions["type"] == "transcriptional"]
tp53 = interactions[
    (interactions["source_genesymbol"] == "TP53")
    | (interactions["target_genesymbol"] == "TP53")
]
from_signor = interactions[interactions["sources"].str.contains("SIGNOR", na=False)]
```

Column names and the exact `type` vocabulary vary by release — inspect the frame before filtering rather than assuming these values. If a general OmniPath interaction network is not in the inventory, report that plainly and scope the analysis to the networks that are (regulons, pathway weights).

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
import pandas as pd

# `interaction_path` resolved from the reference inventory — NOT a web query.
ppi = pd.read_csv(interaction_path)

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

# TF-target network, resolved + normalised per Resource Loading
collectri = pd.read_csv(regulon_path)

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
progeny = pd.read_csv(pathway_path)  # resolved + normalised per Resource Loading
pathway_acts, pathway_pvals = dc.run_mlm(
    mat=expression_df,
    net=progeny
)
```

## Building Custom Networks from OmniPath

```python
import pandas as pd

# `interaction_path` resolved from the reference inventory — NOT a web query.
# One file typically carries all interaction types; split it rather than
# issuing one query per type.
interactions = pd.read_csv(interaction_path)

ppi = interactions[interactions['type'] == 'post_translational']
ks = interactions[interactions['type'] == 'phosphorylation']
tf = interactions[interactions['type'] == 'transcriptional']

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
import networkx as nx
import matplotlib.pyplot as plt
import pandas as pd

# 1. TF-target network (resolved + normalised per Resource Loading), infer activities
collectri = pd.read_csv(regulon_path)
tf_acts, tf_pvals = dc.run_ulm(mat=expression_df, net=collectri)

# 2. Get top differential TFs
top_tfs = tf_acts.mean(axis=0).abs().sort_values(ascending=False).head(10).index.tolist()
print(f"Top TFs: {top_tfs}")

# 3. Build PPI network around top TFs.
#    `interaction_path` resolved from the reference inventory. If no general
#    interaction network is available, skip this step and report it — the TF and
#    pathway activities above stand on their own.
ppi = pd.read_csv(interaction_path)
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
progeny = pd.read_csv(pathway_path)  # resolved + normalised per Resource Loading
pathway_acts, _ = dc.run_mlm(mat=expression_df, net=progeny)

print(f"Network: {subgraph.number_of_nodes()} nodes, {subgraph.number_of_edges()} edges")
print(f"Active pathways:\n{pathway_acts.mean(axis=0).sort_values(ascending=False).head()}")
```

## Gotchas

- **No network access**: every `omnipath.interactions.*.get()` and every `dc.op.*()` call queries omnipathdb.org. There is no egress, and the service is additionally returning 502 — these calls cannot be made to work here. Load from a resolved file instead. `omnipath`'s built-in caching does not help: an empty cache still needs the first request.
- **Never assume a format**: resolved networks circulate as CSV, TSV, and R `.rda` depending on the source. Use the reader the inventory reports for the file; do not default to one.
- **Be honest about absence**: general OmniPath interaction data is not currently in the reference data available to you. If it does not resolve, say so and scope the analysis down — do not substitute a different network and present it as OmniPath.
- Install both `omnipath` and `decoupler` packages: `pip install omnipath decoupler`. The `omnipath` package is still useful for its column semantics even though its fetchers are unusable here.
- Prefer CollecTRI over DoRothEA for TF regulons — DoRothEA is superseded. If only DoRothEA is available, filter to confidence A-C and rename `tf`/`mor` to `source`/`weight`.
- For `dc.run_ulm()` / `dc.run_mlm()`, the expression matrix must have genes as columns and samples as rows.
- Gene symbols must match between expression data and network. OmniPath uses HGNC symbols for human, MGI for mouse — and the network's organism must match the data's, or the run silently returns meaningless scores.
- Some interactions appear in both directions. Use `is_directed` and `consensus_direction` columns to filter.
- A full interaction network is very large (millions of rows). Filter to your genes or interaction type immediately after loading rather than carrying the whole frame.
- NetworkX conversion: always check that your genes of interest exist as nodes before extracting subgraphs.
