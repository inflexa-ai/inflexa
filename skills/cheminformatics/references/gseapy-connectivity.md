# GSEApy for Drug Perturbation Connectivity Scoring

Using gseapy.prerank for CMap-style connectivity analysis — matching
query gene signatures against drug perturbation reference profiles.

## Sandbox Constraint

Sandboxes have **no network access**. For CMap-style connectivity
scoring, pass **custom gene sets as Python dicts** — this works
offline. Do NOT pass Enrichr library name strings.

```python
import gseapy as gp
import pandas as pd
import numpy as np
```

## Core Pattern: prerank with Custom Gene Sets

CMap connectivity scoring uses `gp.prerank()` with a custom dict of
query gene sets scored against a reference perturbation ranking:

```python
# reference_signature: pd.Series indexed by gene symbol, values = signed
#   fold-change or z-score from a drug perturbation experiment
# query_up: list of gene symbols up-regulated in the disease/query
# query_down: list of gene symbols down-regulated in the disease/query

reference_signature = reference_signature.sort_values(ascending=False)

result = gp.prerank(
    rnk=reference_signature,
    gene_sets={
        "query_up": query_up,
        "query_down": query_down,
    },
    min_size=10,
    max_size=1000,
    permutation_num=1000,
    outdir=None,
    seed=42,
    no_plot=True,
)

df = result.res2d
```

### Interpreting NES for Connectivity

| query_up NES | query_down NES | Interpretation |
|-------------|---------------|----------------|
| Positive | Negative | Drug **mimics** the query signature (concordant) |
| Negative | Positive | Drug **reverses** the query signature (therapeutic candidate) |
| Same sign | Same sign | No clear directional relationship |
| Near zero | Near zero | No connectivity |

**Key**: For drug repurposing, look for drugs that **reverse** the
disease signature — negative NES for query_up genes (disease-up genes
are ranked LOW in drug response) and positive NES for query_down genes.

### Connectivity Score from NES

```python
def nes_connectivity_score(result_df):
    """
    Derive a single connectivity score from gseapy prerank NES values.

    Returns score in [-1, 1]:
      Negative = reversal (therapeutic candidate)
      Positive = mimicry
    """
    up_row = result_df[result_df["Term"] == "query_up"]
    down_row = result_df[result_df["Term"] == "query_down"]

    nes_up = up_row["NES"].values[0] if len(up_row) > 0 else 0.0
    nes_down = down_row["NES"].values[0] if len(down_row) > 0 else 0.0

    # Reversal: up genes depleted (negative NES) + down genes enriched
    # (positive NES)
    if np.sign(nes_up) != np.sign(nes_down):
        return (nes_up - nes_down) / 2
    return 0.0
```

## Scoring Multiple Drug References

When scoring a query against many drug perturbation profiles:

```python
def score_drug_panel(query_up, query_down, drug_signatures,
                      permutation_num=1000):
    """
    Score a query signature against a panel of drug perturbation profiles.

    Parameters
    ----------
    query_up : list of str
        Gene symbols up-regulated in query.
    query_down : list of str
        Gene symbols down-regulated in query.
    drug_signatures : dict of str -> pd.Series
        Drug name -> signed fold-change Series (index = gene symbols).

    Returns
    -------
    pd.DataFrame
        Columns: drug, nes_up, nes_down, connectivity, fdr_up, fdr_down.
    """
    results = []
    gene_sets = {"query_up": query_up, "query_down": query_down}

    for drug_name, sig in drug_signatures.items():
        sig_sorted = sig.sort_values(ascending=False)
        try:
            res = gp.prerank(
                rnk=sig_sorted,
                gene_sets=gene_sets,
                min_size=5,
                max_size=2000,
                permutation_num=permutation_num,
                outdir=None,
                seed=42,
                no_plot=True,
            )
            df = res.res2d
            up_row = df[df["Term"] == "query_up"]
            down_row = df[df["Term"] == "query_down"]

            nes_up = up_row["NES"].values[0] if len(up_row) > 0 else 0
            nes_down = down_row["NES"].values[0] if len(down_row) > 0 else 0
            fdr_up = up_row["FDR q-val"].values[0] if len(up_row) > 0 else 1
            fdr_down = (
                down_row["FDR q-val"].values[0] if len(down_row) > 0 else 1
            )

            conn = (
                (nes_up - nes_down) / 2
                if np.sign(nes_up) != np.sign(nes_down)
                else 0.0
            )

            results.append({
                "drug": drug_name,
                "nes_up": nes_up,
                "nes_down": nes_down,
                "connectivity": conn,
                "fdr_up": fdr_up,
                "fdr_down": fdr_down,
            })
        except Exception:
            continue

    return pd.DataFrame(results).sort_values("connectivity")
```

## Query Signature Best Practices

| Parameter | Recommended | Why |
|-----------|------------|-----|
| Signature size (N) | 100-500 genes per direction | Too few = noisy; too many = diluted signal |
| Gene ID type | Gene symbols (HGNC) | Must match reference profile index |
| Ranking metric | Signed fold-change or -log10(p) * sign(FC) | Must reflect both magnitude and direction |
| min_size | 10 | Smaller gene sets produce unreliable NES |
| max_size | 1000-2000 | Upper bound to exclude very large sets |
| permutation_num | 1000 (production) / 100 (exploration) | More permutations = more stable FDR |

## prerank() Result Columns

| Column | Description |
|--------|-------------|
| `Term` | Gene set name ("query_up" or "query_down") |
| `ES` | Enrichment score (raw) |
| `NES` | Normalized enrichment score |
| `NOM p-val` | Nominal p-value |
| `FDR q-val` | FDR-adjusted q-value |
| `FWER p-val` | Family-wise error rate p-value |
| `Tag %` | Percentage of gene set before running sum peak |
| `Gene %` | Percentage of ranked list before peak |
| `Lead_genes` | Leading edge genes (semicolon-separated) |

## Gotchas

- `outdir=None` is required to suppress file output. Without it,
  gseapy writes TSV and plot files to the current directory.
- `no_plot=True` suppresses automatic plot generation. Always set this
  when running programmatically.
- `rnk` must be a pre-sorted pd.Series (descending by score). If
  unsorted, NES values are unreliable.
- Custom gene set dict values must be **lists** of strings, not sets
  or tuples.
- Gene symbols in query lists that don't appear in the reference
  ranking are silently dropped. Check overlap before scoring.
- With `permutation_num=1000` and many drug references, this is slow.
  Use `permutation_num=100` for initial exploration, then re-run
  top hits with 1000.
- Results are in `res2d` (DataFrame), not `results` (dict). Always
  use `.res2d` for consistent access.
