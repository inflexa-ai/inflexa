---
name: multi-omics-integration
description: Multi-omics integration methods including factor analysis, supervised classification, network fusion, and causal modeling across modalities
version: 1.0.0
tags: [multi-omics, integration, mofa, diablo, snf, factor-analysis, cross-modality]
---

# Multi-Omics Integration

This skill guides method selection and execution for integrating data across multiple omics modalities, including exploratory factor analysis, supervised biomarker discovery, network fusion, and causal/mechanistic modeling.

## Method Selection Decision Tree

Choose the method based on your analytical question and data characteristics:

### 1. Exploratory: What factors drive variation across modalities?

- Use **MOFA+** via `muon.tl.mofa()` (mofapy2 backend).
- Unsupervised factor analysis that decomposes shared and modality-specific variation.
- Handles **missing data** (samples absent in some modalities).
- Outputs: latent factors, factor loadings per modality, variance explained per factor per modality.
- Inspect factors for biological interpretation; correlate with phenotype metadata.

### 2. Supervised: Predict outcome from multiple omics

- Use **DIABLO** (`block.splsda`) via **mixOmics** (R via rpy2).
- Sparse PLS-DA variant that performs simultaneous feature selection and classification across modalities.
- Requires a categorical outcome variable (e.g., disease vs. control, responder vs. non-responder).
- Tune `keepX` (features per component per modality) via cross-validation.
- Outputs: discriminant components, selected features per modality, circos correlation plot.

### 3. Network-based: Find cross-omics interactions

- Prior knowledge (kinase-substrate, TF-target, ligand-receptor, enzyme-metabolite) must come
  from an interaction file resolved from the reference data available to you. The **OmniPath**
  web service is unreachable — egress is blocked, so `omnipath.interactions.*.get()` and every
  `dc.op.*()` loader fail. General interaction data is often not provisioned at all; if it does
  not resolve, report that and scope the analysis to the networks that are available.
- Build a custom cross-omics network from those edges + data-driven correlations.
- Analyze with **NetworkX** or **igraph**: community detection, centrality, shortest paths.
- Appropriate when you want to model regulatory or signaling relationships between modalities.

### 4. Similarity-based: Cluster patients across modalities

- Use **SNF** (Similarity Network Fusion) via `snfpy`.
- Constructs per-modality patient similarity networks, then fuses into a single network.
- Apply spectral clustering or Leiden on the fused network for patient stratification.
- Best when each modality captures different aspects of patient heterogeneity.

### 5. Causal/mechanistic modeling

- **CARNIVAL** (R via rpy2): Infers signaling topology from TF/pathway activity scores and prior knowledge network.
  - Requires: activity scores (from decoupler), a prior-knowledge network, perturbation context.
- **COSMOS** (R via rpy2): Extends CARNIVAL to bridge signaling and metabolism.
  - Requires: TF activities, metabolite abundances. Unlike CARNIVAL it carries its own
    prior-knowledge network, so nothing external has to be resolved for it.
- **Both take a solver by explicit path, and the default is not the one you want.** Each
  falls back to a pure-R solver its own documentation describes as suitable for testing
  only — it will not close on a full-size network, and the symptom is a run that never
  finishes rather than an error. A real MILP solver is installed; pass its path
  explicitly, because neither package discovers one. If you did not set it, say so when
  reporting the result, since a filtered-down network is a different claim.
- These methods are computationally intensive and require careful prior knowledge curation.
- Both hinge on a prior-knowledge network that cannot be fetched at run time. Confirm one
  resolves from the reference data available to you *before* planning either step.

## Integration Paradigm Selection

| Paradigm | Approach | When to Use | Limitations |
|-|-|-|-|
| Early | Concatenate features across modalities | Quick exploratory PCA/UMAP | Dominated by largest modality |
| Intermediate | Shared latent space (MOFA+, DIABLO) | Primary recommendation | Requires matched samples |
| Late | Combine per-modality results | When modalities processed independently | Misses cross-omics interactions |

**Default recommendation**: Start with MOFA+ (intermediate, unsupervised), then move to DIABLO (intermediate, supervised) if there is a clear outcome variable.

## Data Preparation Requirements

1. **Per-modality QC and normalization BEFORE integration**: Each modality must be individually quality-controlled and normalized. Integration does not fix upstream data problems.
2. **Match samples across modalities**: Ensure sample identifiers are consistent. Document which samples are missing in which modalities.
3. **Handle missing modalities explicitly**: MOFA+ handles missing data natively. For other methods, either impute or restrict to complete cases.
4. **Standardize scales**: If concatenating features (early fusion), standardize each modality to zero mean, unit variance to prevent scale-dominated results.
5. **Feature pre-selection**: For high-dimensional modalities (e.g., methylation 450k/EPIC), pre-filter to top variable features (top 5000-10000) before integration.

## MuData as Standard Container

- Use **MuData** (`.h5mu`) as the standard multi-omics container in Python.
- Each modality is stored as a separate AnnData within `mdata.mod['rna']`, `mdata.mod['atac']`, etc.
- MOFA+ results integrate directly into `mdata.obsm` (factors) and `mdata.varm` (loadings).
- Shared sample metadata in `mdata.obs`, per-modality metadata in `mdata.mod['x'].obs`.

## Output Conventions

- Save factor/component scores as TSV: sample, factor_1, factor_2, ..., factor_k.
- Save feature loadings/weights as TSV: feature, modality, factor, loading, rank.
- Save variance explained as TSV: factor, modality, variance_explained_pct.
- Generate variance decomposition heatmap (factors x modalities, color = % variance).
- Generate factor scatter plots colored by phenotype for top factors.
- For DIABLO: generate circos plot showing cross-modality feature correlations.
- For SNF: generate fused similarity heatmap with cluster assignments.
- Write a summary describing key factors/components, which modalities contribute most, and biological interpretation.

## Anti-Patterns

- **Integrating without per-modality QC**: Garbage in, garbage out. Each modality must be independently quality-controlled before integration. Batch effects in one modality contaminate all integrated results.
- **Sample mismatch across modalities**: Mismatched sample IDs silently produce wrong results. Verify sample correspondence before integration.
- **Different normalization scales without standardization**: Concatenating TPM (range 0-1M) with methylation beta values (range 0-1) without scaling means the larger-scale modality dominates entirely.
- **Early fusion on high-dimensional data without feature selection**: Concatenating 20k genes + 400k CpGs is computationally intractable and noise-dominated. Pre-filter per modality.
- **Ignoring missing modalities**: Dropping samples with any missing modality can severely reduce sample size. Use MOFA+ (handles missing data) or explicit imputation strategies.
- **Too many MOFA+ factors**: Start with 10-15 factors. Most biological signal is in the first 5-8. Excess factors capture noise.
- **Not validating integration quality**: Check that integrated clusters/factors are not driven by batch, modality, or technical artifacts. Plot factors colored by batch variables.
- **Applying supervised methods without sufficient samples**: DIABLO with small N and many features overfits easily. Require N > 3x the number of selected features per component.

## References

| File | Purpose |
|-|-|
| `references/muon-mofa-api.md` | muon/MOFA+ API: factor analysis, variance decomposition |
| `references/mixomics-rpy2-api.md` | mixOmics via rpy2 API: DIABLO block.splsda, tuning |
| `references/omnipath-api.md` | OmniPath API: prior knowledge queries, interaction types |
| `references/snfpy-api.md` | snfpy API: similarity network fusion, affinity matrices, spectral clustering |
