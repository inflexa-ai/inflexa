---
name: network-regulatory
description: Network and regulatory analysis including co-expression networks, GRN inference, PPI analysis, and TF activity scoring
version: 1.0.0
tags: [network, wgcna, grn, ppi, regulatory, co-expression, networkx]
---

# Network & Regulatory Analysis

This skill guides method selection and execution for co-expression network construction, gene regulatory network inference, protein-protein interaction analysis, and transcription factor activity scoring.

## Method Selection Decision Tree

Choose the method based on your data type and analytical goal:

1. **Co-expression network from bulk RNA-seq or microarray**
   - Use **PyWGCNA** for weighted correlation network construction, module detection, and hub gene identification.
   - Requires variance-stabilized or log-transformed expression (NOT raw counts).
   - Soft-thresholding power: use `pickSoftThreshold()` to select; target scale-free topology fit > 0.8.

2. **Co-expression from single-cell data**
   - Aggregate to **pseudobulk** first (per cluster or per sample), then apply PyWGCNA.
   - Alternatively: compute correlation on top HVGs (3000-5000) from the log-normalized matrix.
   - Do NOT run WGCNA directly on single-cell count matrices.

3. **Gene regulatory network inference (single-cell)**
   - Use **pySCENIC** for TF-target regulon identification (GRNBoost2 + cisTarget motif pruning).
   - Outputs regulons (TF + target gene sets) and per-cell regulon activity scores (AUCell).
   - Computationally expensive: limit to top 2000-3000 HVGs, use multiprocessing.

4. **TF activity scoring (fast, per-cell)**
   - Use **decoupler** with **CollecTRI** regulon resource.
   - `dc.mt.ulm()` or `dc.mt.mlm()` on `adata` produces per-cell TF activity in
     `adata.obsm` under `score_ulm` / `padj_ulm`.
   - Faster than pySCENIC, preferred when regulon discovery is not the goal.

5. **Protein-protein interaction network**
   - The **STRING** and **OmniPath** web APIs are unreachable — egress is blocked, so
     every query fails. A PPI network has to come from an interaction file resolved
     from the reference data available to you; if none is provisioned, say so and
     scope the analysis to what is, rather than substituting another network.
   - Build graph with **NetworkX** or **igraph** for analysis.
   - Filter edges by confidence/evidence type before analysis.

6. **Community/module detection on any graph**
   - **Leiden** algorithm (preferred): `igraph` or `leidenalg` package. Better resolution than Louvain.
   - **Louvain**: acceptable fallback, available in both NetworkX and igraph.
   - **Greedy modularity**: for small networks where resolution parameter tuning is impractical.

7. **Hub gene identification**
   - Combine multiple centrality measures: **betweenness centrality**, **degree centrality**, and **module membership (kME)**.
   - Validate hubs against known biology (literature, pathway membership, TF status).
   - Report top N hubs per module with their centrality metrics.

8. **Module-trait correlation**
   - PyWGCNA built-in `module_trait_relationships()` or manual Pearson/Spearman correlation between module eigengenes and phenotype variables.
   - Apply FDR correction across all module-trait pairs.

## Memory Management

- Filter to top **3000-5000 variable genes** before building any correlation matrix.
- For N genes, the correlation matrix is N x N float64. At 5000 genes: ~200 MB. At 10000: ~800 MB.
- Use `float32` where possible to halve memory.
- For very large networks (>10k nodes), use sparse representations or adjacency list format.

## Output Conventions

- Save module assignments as TSV: gene, module_id, module_color, kME.
- Save network edges as TSV: source, target, weight, type (co-expression/PPI/regulatory).
- Generate module-trait heatmap (modules x traits, color = correlation, annotate with p-value).
- Generate network visualization for key modules (top 50 genes by kME, colored by module).
- Export networks in GML or GraphML format for external visualization tools.
- Write a summary describing module count, sizes, key hub genes, and trait associations.

## Anti-Patterns

- **WGCNA on >5000 genes without filtering**: Memory explosion and loss of biological signal in noise. Always pre-filter by variance or differential expression.
- **Correlation on raw/normalized counts**: Log-transform first. Pearson correlation on count data is dominated by high-count genes.
- **Not filtering low-variance genes**: Genes with near-zero variance contribute noise, not signal. Apply a variance threshold before network construction.
- **PPI network without confidence filtering**: interaction files carry all interactions including low-confidence predictions. Filter on the confidence/evidence column (STRING-style scores: combined_score >= 700) after loading the file — the filtering the web API would have done server-side has to happen locally.
- **Reporting hubs without biological validation**: Hub status from network topology alone is insufficient. Cross-reference with known TFs, pathway databases, or literature.
- **Using Pearson correlation for non-linear relationships**: Consider Spearman rank correlation or mutual information for non-linear co-expression patterns.
- **Ignoring batch effects in co-expression**: Batch-driven correlation creates spurious modules. Correct batch effects before network construction.
- **Running pySCENIC on all genes**: Computationally prohibitive. Limit to top 2000-3000 HVGs.

## References

| File | Purpose |
|-|-|
| `references/pywgcna-api.md` | PyWGCNA API: network construction, module detection, hub genes |
| `references/networkx-api.md` | NetworkX API: graph construction, centrality, community detection |
| `references/igraph-api.md` | igraph API: Leiden clustering, graph metrics, visualization |
| `references/decoupler-api.md` | decoupler API: TF activity (CollecTRI + ULM), pathway activity (PROGENy + MLM) |
