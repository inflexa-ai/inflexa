# Prior-Knowledge Networks Reference

Resolving and reading the interaction, regulon and pathway-weight files that
network-based and causal methods consume.

**Nothing here is fetched.** The OmniPath web service is unreachable, the
`omnipath` Python package is not installed and cannot be, and every `dc.op.*()`
loader in decoupler is a web fetcher. There is no retry, proxy or timeout that
changes this. Everything below reads a file you resolved from the reference
inventory.

## Resolve the File Before You Write the Script

Ask for the *dataset* by what it is, not by a path — reference data is
provisioned per environment, so the directory, the filename and the format all
vary and none are yours to assume:

| You need | Ask for | Standard sources |
|-|-|-|
| TF activity | A TF-target regulon network for your organism | CollecTRI; or DoRothEA filtered to confidence A-C |
| Pathway activity | Pathway responsive-gene weights for your organism | PROGENy (14 pathways) |
| PPI / kinase-substrate / ligand-receptor graphs | A signed, directed interaction network for your organism | OmniPath |

Then read it with the reader its format calls for — these circulate as CSV, TSV
and R `.rda`, and a wrong-format read fails immediately. Match the organism too:
a human network over mouse data runs happily and returns meaningless results.

Two properties of the OmniPath interaction export decide whether your code is
correct, and both are stated in its inventory entry rather than here: it carries
several organisms in one table and must be filtered to yours, and it has two
identifier columns where only one holds gene symbols. It is an opt-in download —
if it does not resolve, say so and scope the analysis to the networks that did,
rather than substituting a different network or fabricating edges.

The interaction subsets the web API exposed are properties of the *data*, so ask
for them by name and filter the loaded frame: curated PPI, kinase-substrate,
TF-target, miRNA-target, ligand-receptor, enzyme-substrate.

## Reading an `.rda`

PROGENy and DoRothEA are published as R `.rda`, which pandas cannot open:

```python
import pandas as pd
import rpy2.robjects as ro
from rpy2.robjects import pandas2ri


def read_rda_frame(path: str) -> pd.DataFrame:
    """Load the data frame an R .rda holds (PROGENy, DoRothEA) into pandas."""
    names = list(ro.r["load"](path))  # load() returns the names it created
    with (ro.default_converter + pandas2ri.converter).context():
        return ro.conversion.get_conversion().rpy2py(ro.r[names[0]])


# Paths you resolved, not literals to copy.
collectri = pd.read_csv(regulon_path)      # CollecTRI is CSV
progeny = read_rda_frame(pathway_path)     # PROGENy is .rda — read_csv fails outright
```

## Network Format

Activity-inference methods consume one long format:

| Column | Type | Description |
|-|-|-|
| `source` | str | Regulator name (TF for a regulon network, pathway for PROGENy) |
| `target` | str | Target gene symbol (HGNC for human, MGI for mouse) |
| `weight` | float | Regulons: +1 activation, -1 repression. PROGENy: signed float. |

Column names vary by source — DoRothEA ships `tf`/`target`/`mor`, and some
releases carry extra provenance columns. Inspect the frame after loading and
rename before passing it on:

```python
collectri = collectri.rename(columns={"tf": "source", "mor": "weight"})[["source", "target", "weight"]]
```

Prefer CollecTRI over DoRothEA where the inventory offers both — DoRothEA is
superseded.

Interaction networks are wider. The columns that decide an analysis:
`source_genesymbol` / `target_genesymbol` (the symbol-bearing pair, as opposed
to the accession columns beside them), `is_directed`, `is_stimulation` /
`is_inhibition` for sign, `type` for the subset, and `sources` / `references`
for provenance. The `type` vocabulary varies by release — inspect it before
filtering rather than assuming values.

## Activity Inference

```python
import decoupler as dc

# data: samples x genes. net: the long-format frame above.
acts, padj = dc.mt.ulm(data=mat, net=collectri)     # univariate — the default
acts, padj = dc.mt.mlm(data=mat, net=progeny)       # multivariate, for correlated sets
```

For an AnnData, pass it directly and results land in `.obsm`. Genes must be
columns and samples rows; the 1.x `dc.run_ulm(mat=...)` entry points no longer
exist in decoupler 2.x.

## Gotchas

- **Do not call `dc.op.*()`.** Those are the web fetchers — `dc.op.collectri()`,
  `dc.op.progeny()`, `dc.op.msigdb()` and the rest all query omnipathdb.org.
  decoupler itself is installed and fine; only these loaders are unusable.
- **Never assume a format.** Use the reader the inventory reports for the file.
- **Organism must match the data**, or the run returns meaningless scores with no
  error.
- **A full interaction network is millions of rows.** Filter to your genes or
  interaction type immediately after loading rather than carrying the whole
  frame.
- **Interactions can appear in both directions.** Use `is_directed` and
  `consensus_direction` before treating an edge as oriented.
- **Be honest about absence.** If a network does not resolve, say so and scope
  the analysis down — do not substitute a different one and present it as the
  network you were asked for.
