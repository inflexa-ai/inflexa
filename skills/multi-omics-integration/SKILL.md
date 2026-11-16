---
name: multi-omics-integration
description: Read before you combine two or more omics types for the same samples (factor analysis, supervised classification, patient similarity, cross-omics networks, causal signal models). It gives the method for each question, the data preparation, and the traps of prior-knowledge networks and solvers.
metadata:
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
  `dc.op.*()` loader fail — but the same content is in the reference inventory as a static
  export, alongside a separate genome-scale scored PPI. Both are opt-in downloads: resolve what
  you need up front, and if it does not resolve, report that and scope the analysis to the
  networks that are available.
- Build a custom cross-omics network from those edges + data-driven correlations.
- Analyze with **NetworkX** or **igraph**: community detection, centrality, shortest paths.
- Appropriate when you want to model regulatory or signaling relationships between modalities.

### 4. Similarity-based: Cluster patients across modalities

- Use **SNF** (Similarity Network Fusion) through `SNFtool` (R, through rpy2).
- Constructs per-modality patient similarity networks, then fuses into a single network.
- Apply `spectralClustering()` or Leiden on the fused network for patient stratification.
- Best when each modality captures different aspects of patient heterogeneity.
- The python `snfpy` port is broken against current scikit-learn and is not installed. Do not plan around it.

### 5. Causal/mechanistic modeling

- **CARNIVAL** (R via rpy2): Infers signaling topology from TF/pathway activity scores and prior knowledge network.
  - Requires: activity scores (from decoupler), a prior-knowledge network, perturbation context.
  - The network must be **signed and directed** — a scored PPI carries neither, so it cannot
    stand in here however large it is; there is nothing for the method to orient. Resolve a
    causal interaction set instead, and reduce it to one edge per source/target pair with a
    single activating-or-inhibiting sign.
  - Its node names must land in the same identifier space as the activity scores you feed it,
    which come from TF regulons carrying gene symbols. Interaction sets commonly key on protein
    accessions as well, so check which column you are taking before building the network.
- **COSMOS** (R via rpy2): Extends CARNIVAL to bridge signaling and metabolism.
  - Requires: TF activities, metabolite abundances. Unlike CARNIVAL it carries its own
    prior-knowledge network, so nothing external has to be resolved for it.
- **Both need a MILP solver set explicitly — name and path.** The default, `lpSolve`, is
  testing-only by its own documentation: on a full-size network it does not close, and the
  symptom is a hang, not an error. **CBC** is installed but undiscovered — pass `cbc` and
  the path from `Sys.which("cbc")`. Empty means absent: report it rather than launching. If
  you shrink the network instead, say so — it is a different claim.
- These methods are computationally intensive and require careful prior knowledge curation.
- Both hinge on a prior-knowledge network that cannot be fetched at run time. Confirm one
  resolves from the reference data available to you *before* planning either step.

## Goal and Constraints

Start with MOFA+ (unsupervised). Move to DIABLO if the question has a clear categorical outcome.

- QC and normalize each modality before the integration.
- Match the sample identifiers across the modalities, and record which samples each modality does not have. MOFA+ accepts a sample without a modality. For the other methods, impute or keep the complete cases, and say which.
- If you concatenate the features, standardize each modality first. Otherwise the modality with the largest scale (TPM to 1M, beta values to 1) controls the result.
- Filter a high-dimensional modality (for example methylation 450k/EPIC) to the top 5000-10000 variable features.

## MuData as Standard Container

- Use **MuData** (`.h5mu`) as the standard multi-omics container in Python.
- Each modality is stored as a separate AnnData within `mdata.mod['rna']`, `mdata.mod['atac']`, etc.
- MOFA+ results integrate directly into `mdata.obsm` (factors) and `mdata.varm` (loadings).
- Shared sample metadata in `mdata.obs`, per-modality metadata in `mdata.mod['x'].obs`.

## Output Conventions

- Save factor/component scores as TSV: sample, factor_1, factor_2, ..., factor_k.
- Save feature loadings/weights as TSV: feature, modality, factor, loading, rank.
- Save variance explained as TSV: factor, modality, variance_explained_pct.

## Anti-Patterns

- **An OmniPath web query or a `dc.op.*()` loader**: The sandbox has no network, and each call fails. Use the static export from the reference inventory.
- **The python `snfpy` port**: It is not installed, because it breaks against the current scikit-learn. Use `SNFtool` through rpy2.
- **The default MILP solver for CARNIVAL or COSMOS**: `lpSolve` does not close on a full-size network, and the symptom is a hang, not an error. Pass `cbc` and the path from `Sys.which("cbc")`. If the path is empty, report that CBC is absent.
- **A scored PPI as the network of CARNIVAL**: The PPI has no sign and no direction. Use a causal interaction set, with one signed edge for each source/target pair.
- **Planning CARNIVAL or COSMOS before the network resolves**: The prior-knowledge network cannot be fetched at run time. Make sure that it resolves from the reference data before you plan the step.
- **Too many MOFA+ factors**: Start with 10-15 factors. Most biological signal is in the first 5-8, and the extra factors capture noise.
- **No check of the integration quality**: Plot the factors by batch, by modality, and by technical variables. A factor that a batch drives is not biology.
- **DIABLO on too few samples**: DIABLO with a small N and many features overfits. N must be more than 3x the number of selected features per component.

## References

| File | Purpose |
|-|-|
| `references/muon-mofa-api.md` | muon/MOFA+ API: factor analysis, variance decomposition |
| `references/mixomics-rpy2-api.md` | mixOmics via rpy2 API: DIABLO block.splsda, tuning |
| `references/prior-knowledge-networks.md` | Resolving and reading regulon, pathway-weight and interaction files: formats, `.rda` reading, column vocabulary, decoupler activity inference |
| `references/snftool-rpy2-api.md` | SNFtool through rpy2: similarity network fusion, affinity matrices, spectral clustering |
