# Drug Repurposing Methods Reference

Computational methods for systematic drug repurposing: connectivity
scoring, network proximity, genetic evidence scoring, and
multi-evidence integration.

## Core Imports

```python
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy import stats
```

## Signature-Based Repurposing (CMap-Style)

### Disease Signature Preparation

```python
def prepare_disease_signature(de_results, n_top=250):
    """
    Prepare a ranked gene list for connectivity scoring from DE results.

    Parameters
    ----------
    de_results : DataFrame
        Must have columns: gene, log2FoldChange, pvalue (or padj).
    n_top : int
        Number of top up and down genes to include.

    Returns
    -------
    DataFrame
        Ranked gene list with columns: gene, rank_metric.
    """
    df = de_results.copy()
    df["rank_metric"] = np.sign(df["log2FoldChange"]) * -np.log10(
        df["pvalue"].clip(lower=1e-300),
    )
    df = df.sort_values("rank_metric", ascending=False)
    df = df.dropna(subset=["rank_metric"])

    up_genes = df.head(n_top)
    down_genes = df.tail(n_top)
    signature = pd.concat([up_genes, down_genes])

    return signature[["gene", "rank_metric"]].reset_index(drop=True)
```

### Connectivity Scoring with gseapy

```python
def connectivity_score_prerank(disease_signature, drug_gene_sets,
                                permutations=1000, min_size=10):
    """
    Compute connectivity scores between a disease signature and
    drug perturbation gene sets using GSEA prerank.

    Parameters
    ----------
    disease_signature : DataFrame
        Columns: gene, rank_metric. From prepare_disease_signature.
    drug_gene_sets : dict
        {drug_name: [target_gene_list]} or path to .gmt file.
    permutations : int
        Number of permutations for significance testing.
    min_size : int
        Minimum gene set size.

    Returns
    -------
    DataFrame
        Drug connectivity results with NES, p-value, FDR.
    """
    import gseapy

    rnk = disease_signature.set_index("gene")["rank_metric"]

    result = gseapy.prerank(
        rnk=rnk,
        gene_sets=drug_gene_sets,
        outdir=None,
        no_plot=True,
        permutation_num=permutations,
        min_size=min_size,
        seed=42,
    )

    res = result.res2d.copy()
    res = res.rename(columns={
        "Term": "drug",
        "NES": "nes",
        # gseapy's prerank res2d column is "p-val" (not "NOM p-val",
        # which is the GSEA desktop label). DataFrame.rename ignores
        # keys it cannot match SILENTLY, so getting this wrong leaves
        # no "pval" column at all and every downstream significance
        # filter raises KeyError.
        "p-val": "pval",
        "FDR q-val": "fdr",
        "Lead_genes": "lead_genes",
    })
    res["connectivity"] = res["nes"].apply(
        lambda x: "reversal" if x < 0 else "mimicry",
    )

    return res.sort_values("nes", ascending=True)
```

### Drug Target Gene Set Construction

```python
def build_drug_target_sets(drug_target_df):
    """
    Build gene sets from a drug-target mapping table.

    Parameters
    ----------
    drug_target_df : DataFrame
        Must have columns: drug_name, gene_symbol.

    Returns
    -------
    dict
        {drug_name: [gene_symbols]}.
    """
    return (
        drug_target_df.groupby("drug_name")["gene_symbol"]
        .apply(list)
        .to_dict()
    )
```

## Network-Based Repurposing

### Network Proximity

```python
def network_proximity(drug_targets, disease_genes, graph,
                       n_random=1000, seed=42):
    """
    Compute network proximity between drug targets and disease genes.

    Uses the closest measure: average minimum shortest path from
    drug targets to disease genes (Guney et al., Nat Commun, 2016).

    Parameters
    ----------
    drug_targets : set
        Gene symbols targeted by the drug.
    disease_genes : set
        Disease-associated gene symbols.
    graph : networkx.Graph
        Protein-protein interaction network with gene symbols as nodes.
    n_random : int
        Number of random permutations for z-score computation.
    seed : int
        Random seed.

    Returns
    -------
    dict
        d_c (closest distance), z_score, p_value.
    """
    import networkx as nx

    nodes = set(graph.nodes())
    drug_in = drug_targets & nodes
    disease_in = disease_genes & nodes

    if not drug_in or not disease_in:
        return {"d_c": np.nan, "z_score": np.nan, "p_value": np.nan}

    lengths = dict(nx.all_pairs_shortest_path_length(graph))

    def closest_distance(targets, genes):
        dists = []
        for t in targets:
            if t not in lengths:
                continue
            min_d = min(
                (lengths[t].get(g, np.inf) for g in genes),
                default=np.inf,
            )
            dists.append(min_d)
        return np.mean(dists) if dists else np.inf

    d_observed = closest_distance(drug_in, disease_in)

    rng = np.random.default_rng(seed)

    # DEGREE-PRESERVING null (Guney et al. 2016). Drug targets and
    # disease genes are strongly hub-enriched, and hubs sit closer to
    # everything, so sampling nodes uniformly builds a null of
    # low-degree nodes that are further apart than they should be.
    # That inflates mu and makes every z-score look more negative --
    # i.e. manufactures proximity that is not there. Sample each
    # random node from the degree bin of the node it replaces.
    degrees = dict(graph.degree())
    bins = {}
    for node, deg in degrees.items():
        # Log-spaced bins keep hub bins populated enough to sample from.
        bins.setdefault(int(np.log2(deg + 1)), []).append(node)

    def degree_matched_sample(reference_nodes):
        picked = set()
        for node in reference_nodes:
            bucket = bins[int(np.log2(degrees[node] + 1))]
            for _ in range(20):  # retry to avoid collisions
                cand = bucket[rng.integers(len(bucket))]
                if cand not in picked:
                    picked.add(cand)
                    break
        return picked

    d_randoms = []
    for _ in range(n_random):
        d_randoms.append(closest_distance(
            degree_matched_sample(drug_in),
            degree_matched_sample(disease_in),
        ))

    # Disconnected pairs give inf, which poisons mean/std into inf/nan.
    d_randoms = np.array(d_randoms, dtype=float)
    d_randoms = d_randoms[np.isfinite(d_randoms)]

    if d_randoms.size == 0 or not np.isfinite(d_observed):
        return {"d_c": float(d_observed), "z_score": np.nan, "p_value": np.nan}

    mu = np.mean(d_randoms)
    sigma = np.std(d_randoms)

    # A degenerate null is not the same as "no proximity signal".
    # Returning 0 here would rank the drug as exactly average instead
    # of flagging that the null could not be built.
    z_score = (d_observed - mu) / sigma if sigma > 0 else np.nan
    p_value = np.mean(d_randoms <= d_observed)

    return {
        "d_c": float(d_observed),
        "z_score": float(z_score),
        "p_value": float(p_value),
    }
```

## Genetics-Based Evidence Scoring

```python
def score_genetic_evidence(gene, gwas_results=None,
                            disgenet_results=None,
                            opentargets_results=None):
    """
    Compute a composite genetic evidence score for a target gene.

    Parameters
    ----------
    gene : str
        Gene symbol.
    gwas_results : list of dict, optional
        GWAS Catalog associations, each with a "pValue" key.
    disgenet_results : list of dict, optional
        Gene-disease associations, each with a "score" key.
    opentargets_results : dict, optional
        Open Targets target record with a "geneticAssociationScore" key.

    Returns
    -------
    dict
        Composite score and component breakdown.
    """
    scores = {}

    if gwas_results:
        best_pval = min(
            (a.get("pValue", 1) for a in gwas_results), default=1,
        )
        scores["gwas"] = min(1.0, -np.log10(max(best_pval, 1e-300)) / 30)

    if disgenet_results:
        best_gda = max(
            (a.get("score", 0) for a in disgenet_results), default=0,
        )
        scores["disgenet"] = best_gda

    if opentargets_results:
        genetic_score = opentargets_results.get(
            "geneticAssociationScore", 0,
        ) or 0
        scores["opentargets_genetic"] = genetic_score

    if not scores:
        return {"gene": gene, "composite_score": 0, "components": {}}

    composite = np.mean(list(scores.values()))
    return {
        "gene": gene,
        "composite_score": float(composite),
        "components": {k: float(v) for k, v in scores.items()},
    }
```

## Multi-Evidence Integration

```python
def integrate_repurposing_evidence(candidates):
    """
    Integrate multiple evidence sources for drug repurposing candidates.

    Parameters
    ----------
    candidates : list of dict
        Each dict must have:
        - drug_name: str
        - evidence: dict with optional keys:
          connectivity_nes, genetic_score, network_proximity_z,
          clinical_trials, literature_pmids, safety_reports.

    Returns
    -------
    DataFrame
        Ranked candidates with composite scores.
    """
    rows = []
    for c in candidates:
        ev = c.get("evidence", {})

        sig_score = 0
        if "connectivity_nes" in ev:
            # Only NEGATIVE NES is therapeutic: the drug REVERSES the
            # disease signature. abs() would score a drug that mimics
            # the disease (positive NES, potentially harmful) exactly
            # like one that reverses it. One-sided, matching net_score.
            sig_score = min(1.0, max(0.0, -ev["connectivity_nes"]) / 3)

        gen_score = ev.get("genetic_score", 0)

        net_score = 0
        if "network_proximity_z" in ev:
            z = ev["network_proximity_z"]
            net_score = min(1.0, max(0, -z / 3))

        clinical = 1.0 if ev.get("clinical_trials") else 0.0
        literature = min(1.0, len(ev.get("literature_pmids", [])) / 5)
        # Absence of FAERS data is NOT evidence of safety. Defaulting
        # the count to 0 would hand the bonus to every drug nobody has
        # assessed, which is the "skip safety assessment" anti-pattern.
        safety_reports = ev.get("safety_reports")
        safety_ok = 0.5 if (safety_reports is not None
                            and safety_reports < 100) else 0.0

        evidence_count = sum(1 for s in [
            sig_score, gen_score, net_score, clinical, literature,
        ] if s > 0)

        # The five evidence weights sum to exactly 1.0, so this is a
        # convex combination bounded by [0, 1]. (The previous
        # `np.mean([...]) / 0.2` computed the same number -- mean of 5
        # terms divided by 0.2 IS their sum -- but obscured that the
        # weights already normalize.) The safety bonus sits outside
        # that combination and would push the maximum to 1.05, so the
        # result is clamped to keep the documented 0-1 scale.
        composite = (
            sig_score * 0.3
            + gen_score * 0.25
            + net_score * 0.2
            + clinical * 0.15
            + literature * 0.1
            + safety_ok * 0.1
        )
        composite = min(1.0, composite)

        rows.append({
            "drug": c["drug_name"],
            "existing_indication": c.get("existing_indication", ""),
            "proposed_indication": c.get("proposed_indication", ""),
            "composite_score": float(composite),
            "signature_score": float(sig_score),
            "genetic_score": float(gen_score),
            "network_score": float(net_score),
            "clinical_evidence": bool(clinical),
            "literature_support": float(literature),
            "evidence_lines": evidence_count,
            "development_stage": c.get("development_stage", ""),
        })

    df = pd.DataFrame(rows).sort_values("composite_score", ascending=False)
    return df.reset_index(drop=True)
```

## Visualization

### Repurposing Candidate Ranking Plot

```python
def plot_repurposing_candidates(candidate_df, top_n=20):
    """
    Horizontal bar chart of top repurposing candidates.

    Parameters
    ----------
    candidate_df : DataFrame
        From integrate_repurposing_evidence.
    top_n : int
        Number of top candidates to show.
    """
    df = candidate_df.head(top_n).iloc[::-1]

    fig, ax = plt.subplots(figsize=(10, max(6, top_n * 0.35)))

    colors = []
    for _, row in df.iterrows():
        if row["evidence_lines"] >= 4:
            colors.append("#2ca02c")
        elif row["evidence_lines"] >= 3:
            colors.append("#1f77b4")
        elif row["evidence_lines"] >= 2:
            colors.append("#ff7f0e")
        else:
            colors.append("#d62728")

    ax.barh(range(len(df)), df["composite_score"], color=colors)
    ax.set_yticks(range(len(df)))
    ax.set_yticklabels(
        [f"{r['drug']} ({r['evidence_lines']} ev.)" for _, r in df.iterrows()],
        fontsize=8,
    )
    ax.set_xlabel("Composite Repurposing Score")
    ax.set_title(f"Top {top_n} Drug Repurposing Candidates")

    from matplotlib.patches import Patch
    legend_elements = [
        Patch(facecolor="#2ca02c", label="4+ evidence lines"),
        Patch(facecolor="#1f77b4", label="3 evidence lines"),
        Patch(facecolor="#ff7f0e", label="2 evidence lines"),
        Patch(facecolor="#d62728", label="1 evidence line"),
    ]
    ax.legend(handles=legend_elements, loc="lower right", fontsize=7)

    plt.tight_layout()
    return fig
```

### Evidence Heatmap

```python
def plot_evidence_heatmap(candidate_df, top_n=20):
    """
    Heatmap showing evidence types per candidate drug.
    """
    import seaborn as sns

    df = candidate_df.head(top_n)
    evidence_cols = [
        "signature_score", "genetic_score", "network_score",
        "literature_support",
    ]
    plot_df = df.set_index("drug")[evidence_cols]
    plot_df.columns = ["Signature", "Genetic", "Network", "Literature"]

    fig, ax = plt.subplots(figsize=(8, max(6, top_n * 0.35)))
    sns.heatmap(
        plot_df, cmap="YlOrRd", ax=ax, xticklabels=True,
        yticklabels=True, linewidths=0.5, vmin=0, vmax=1,
        annot=True, fmt=".2f",
    )
    ax.set_title("Evidence Type Breakdown")
    plt.tight_layout()
    return fig
```

## Gotchas

- **Connectivity score direction**: Negative NES = drug reverses the
  disease signature (therapeutic). Positive NES = drug mimics the
  disease (potentially harmful). This is the opposite of standard
  GSEA interpretation.
- **Permutation count**: Use >= 1000 permutations for significance.
  100 permutations is insufficient for reliable FDR estimation.
- **Gene set size**: Very small drug target sets (< 5 genes) produce
  unreliable enrichment scores. Report gene set size alongside
  connectivity scores.
- **Network proximity depends on network quality**: PPI networks have
  known biases (study bias toward well-characterized proteins), and an
  aggregating network mixes predicted edges with measured ones. Flag
  both limitations, and report the confidence cutoff you applied — an
  unfiltered genome-scale graph is dense enough that shortest-path
  distances stop separating anything.
- **`nx.all_pairs_shortest_path_length` is O(V²) in memory**: as written
  above it materialises the full distance dictionary, which on a
  genome-scale PPI network (~20k nodes) is hundreds of millions of
  entries and will exhaust memory. It is also recomputed on every call,
  so scoring a drug panel repeats the same all-pairs BFS per drug.
  Compute distances once outside the loop, and for large graphs use
  per-source `nx.single_source_shortest_path_length` seeded from the
  disease genes only.
- **Connectivity scoring needs perturbation signatures, not target
  sets**: `connectivity_score_prerank` above scores whatever gene sets
  it is handed. Passing drug-*target* sets measures target enrichment
  in the disease ranking — a legitimate analysis, but it is not CMap
  connectivity and must not be labelled as one.
- **Drug stage matters**: An approved drug with connectivity evidence
  is far more actionable than a preclinical compound. Always report
  development stage.
- **Existing indications**: Always check whether the drug is already
  approved or in trials for the target disease before calling it a
  repurposing candidate.
