---
name: cheminformatics
description: Molecular structure analysis, SAR triage, compound library characterization, QSAR modeling, ADMET prediction, chemical space visualization, target engagement assessment, drug perturbation connectivity scoring, and selectivity profiling
version: 1.1.0
tags: [cheminformatics, rdkit, datamol, mordred, deepchem, sar, qsar, drug-discovery, molecular-properties, scaffold, pains, target-engagement, cmap, selectivity, kinase-selectivity]
---

# Cheminformatics

This skill guides method selection and execution for molecular structure analysis, structure-activity relationship (SAR) triage, compound library profiling, QSAR modeling, ADMET prediction, and chemical space visualization. All workflows assume Python with RDKit as the core cheminformatics toolkit, supplemented by datamol, mordred, and DeepChem for specialized tasks.

## Method Selection Decision Tree

Choose the method based on your input data and analytical goal:

1. **SAR Triage** (has structures + activity data)
   - Murcko scaffold decomposition via `rdkit.Chem.Scaffolds.MurckoScaffold` -- group compounds by core ring system.
   - Property profiling via `rdkit.Chem.Descriptors` + `datamol` -- MW, logP, TPSA, HBD, HBA, RotBonds for each compound.
   - Druglikeness assessment: Lipinski Ro5 (MW<=500, logP<=5, HBD<=5, HBA<=10), Veber (TPSA<=140, RotBonds<=10), Ghose rules.
   - Structural alert screening via `rdkit.Chem.FilterCatalog` -- PAINS, Brenk, NIH catalogs.
   - Activity distribution analysis: `pandas` + `scipy.stats` for distribution statistics, outlier detection, and potency binning.
   - Scaffold-activity cross-tab: scaffold x potency matrix to identify chemotypes with best activity profiles.

2. **Library Profiling** (structures only, no activity data)
   - Property distributions: MW, logP, TPSA, HBD, HBA, RotBonds -- histogram/violin for each, Ro5 reference lines overlaid.
   - Chemical diversity: Tanimoto similarity on Morgan fingerprints (radius=2, 2048 bits) + Butina clustering (cutoff=0.4).
   - Chemical space map: UMAP or t-SNE on Morgan fingerprints, colored by cluster assignment.
   - Structural alert sweep: PAINS, Brenk, NIH catalogs -- report clean percentage and most common alert types.

3. **Compound Comparison** (two or more compound sets)
   - Property comparison: violin/box plots per set for MW, logP, TPSA, HBD, HBA, RotBonds -- Mann-Whitney U or KS test for statistical comparison.
   - Scaffold overlap: Venn diagram on Murcko scaffolds (generic framework) to show shared vs unique chemotypes.
   - Chemical space overlap: UMAP on combined fingerprint matrix, colored by set membership, with convex hulls or density contours.

4. **QSAR Modeling** (predictive modeling)
   - Small data (<1K compounds): Morgan fingerprints (radius=2, 2048 bits) + sklearn RandomForest or GradientBoosting. 5-fold cross-validation. Report R2 and RMSE.
   - Medium data (1K-100K): DeepChem `CircularFingerprint` + `MultitaskClassifier` or `MultitaskRegressor` (dense MLP). Scaffold split for evaluation.
   - Large data (>100K): DeepChem `MolGraphConvFeaturizer` + `GraphConvModel` or `AttentiveFPModel` (GPU recommended). Scaffold split mandatory.

5. **ADMET Prediction**
   - Computed descriptors: rdkit (basic) + mordred (1800+ 2D/3D descriptors) for comprehensive molecular characterization.
   - Rule-based assessment: Lipinski Ro5, Veber rules, PAINS alerts -- fast, interpretable, no training data needed.
   - Learned models: train on labelled data already in the workspace. DeepChem's pretrained weights and its MoleculeNet benchmark loaders (Tox21, BBBP, ClinTox, SIDER) both fetch over the network and are unavailable in the sandbox — see `references/deepchem-api.md`.

6. **Structure Processing**
   - Format conversion: `dm.from_sdf()` / `dm.to_sdf()` for SDF, `Chem.MolFromSmiles()` / `Chem.MolToSmiles()` for SMILES.
   - Standardization: `datamol.standardize_mol()` -- salt stripping, neutralization, tautomer canonicalization in one call.
   - Salt stripping / neutralization: `datamol` handles common salt forms and charge states automatically.
   - 3D conformer generation: `rdkit.AllChem.EmbedMolecule` with ETKDGv3, followed by MMFF optimization.

## Compound Acquisition

When compound data is not already in the workspace, acquire it through the
compound-database lookup capabilities available to the agent. Nothing in the
sandbox can reach these databases directly — egress is blocked — so acquisition
happens through the conversation layer's lookup tools, and the retrieved data is
written into the workspace before any sandbox analysis reads it.

**ChEMBL** (curated drug-like bioactives) — ask for:
- resolution of gene symbols to ChEMBL target identifiers
- compounds by target, name, or SMILES
- bioactivity measurements (IC50/EC50/Ki) for compound-target pairs
- mechanism of action for a drug
- approved drugs by indication

**PubChem** (broad coverage, far larger and far less curated) — ask for:
- compound identity and computed properties by name, SMILES, InChI, InChIKey, or CID
- cross-references bridging a PubChem CID to ChEMBL, DrugBank, KEGG, and PDB identifiers
- HTS assay screening results (active/inactive/inconclusive)

**Recommended workflow for unknown compounds:**
1. Try ChEMBL first if the query is target-based or drug-related
2. Fall back to PubChem for compounds not in ChEMBL
3. Bridge a PubChem CID to a ChEMBL ID via cross-references, then query ChEMBL for curated activity data
4. Use PubChem assay data for broader screening evidence when ChEMBL has no bioactivity

If a lookup returns nothing, report the gap — never fabricate structures,
identifiers, or activity values to fill it.

## Druglikeness Rules Reference

| Rule Set | Criteria | Interpretation |
|----------|----------|----------------|
| Lipinski Ro5 | MW <= 500, logP <= 5, HBD <= 5, HBA <= 10 | Oral bioavailability likelihood |
| Veber | TPSA <= 140, RotBonds <= 10 | Oral bioavailability (complementary to Ro5) |
| Ghose | 160 <= MW <= 480, -0.4 <= logP <= 5.6, 40 <= MR <= 130, 20 <= atoms <= 70 | Drug-like chemical space |
| REOS | MW 200-500, logP -5 to 5, HBD 0-5, HBA 0-10, formal charge -2 to 2, RotBonds 0-8, heavy atoms 15-50 | Rapid elimination of swill |

## Standardization-First Principle

Always standardize structures before any analysis: strip salts, neutralize charges, canonicalize tautomers. Use `datamol.standardize_mol()` as the default pipeline. This handles the most common issues in a single call:

1. **Salt stripping**: Remove counterions (Na+, Cl-, etc.) to get the parent compound.
2. **Neutralization**: Convert charged species to neutral form where chemically reasonable.
3. **Tautomer canonicalization**: Pick a consistent tautomeric form so the same compound always produces the same canonical SMILES.
4. **Validation**: Parse with `Chem.MolFromSmiles()` and check for `None`. Invalid SMILES must be flagged or removed before any downstream analysis.

Structures from different sources (ChEMBL, PubChem, vendor catalogs) will have different salt forms, charge states, and tautomers. Without standardization, the same compound can appear as multiple distinct entries, corrupting scaffold counts, similarity calculations, and clustering results. Standardization is not optional.

## Fingerprint Selection Guide

| Fingerprint | Best For |
|-------------|----------|
| Morgan/ECFP4 (radius=2, 2048 bits) | General similarity, clustering, QSAR (default choice) |
| Morgan/ECFP6 (radius=3, 2048 bits) | Higher resolution substructure capture |
| RDKit/Daylight-like (2048 bits) | Path-based similarity, alternative to Morgan |
| MACCS keys (166 bits) | Fast screening |

Default recommendation: **Morgan radius=2 (ECFP4), 2048 bits**. This is the most widely used fingerprint in cheminformatics. Always report the fingerprint type, radius, and bit length in outputs so results are reproducible.

## Chemical Space Visualization

For chemical space maps, compute Morgan fingerprints (radius=2, 2048 bits) for all compounds, then apply UMAP or t-SNE to reduce to 2D. Color points by activity value, cluster assignment, or set membership. Always report: fingerprint type, radius, bits, dimensionality reduction method, and key hyperparameters (n_neighbors, min_dist for UMAP; perplexity for t-SNE).

For activity cliff detection, plot pairwise delta-Activity vs Tanimoto similarity. Activity cliffs are compound pairs with high structural similarity but large activity differences -- these are the most informative pairs for SAR.

## Figure Conventions

| Type | Tool | When |
|------|------|------|
| Molecule grids | RDKit Draw module | Annotated with activity, top hits |
| Property radar | matplotlib spider plot | MW, logP, TPSA, HBD, HBA, RotBonds |
| Chemical space | UMAP/t-SNE on Morgan FPs | Colored by activity, cluster, or set |
| Activity cliffs | scatter plot | delta-Activity vs Tanimoto similarity |
| SAR heatmap | seaborn | Scaffold x property matrix |
| Property distributions | violin/histogram | With Ro5 reference lines overlaid |

## Output Conventions

- Tractability JSON per target (when evaluating tractability): `{ target, chembl_id, compound_count, series_count, best_potency_nM, pains_clean_pct, drug_like_pct, tractability_verdict, top_scaffolds }`
- Property tables as CSV with columns: SMILES, name, MW, logP, TPSA, HBD, HBA, RotBonds, scaffold, alerts
- QSAR model reports: algorithm, fingerprint type/radius/bits, train/test split method, CV folds, R2, RMSE (regression) or ROC-AUC, accuracy (classification)
- Structural alert reports: per-compound alert status, alert description, clean/flagged counts, most common alert classes
- Figures: PNG 300 DPI + PDF vector
- Write a summary narrative describing key findings: library composition, chemotype diversity, druglikeness profile, notable structural alerts

## Target Engagement Assessment

**Reference**: `references/target-engagement.md` — occupancy model with
free drug hypothesis, residence time pharmacology, functional readout
selection guide, and integrated assessment framework. Read it before
writing occupancy or engagement analysis code.

### When to Assess Target Engagement

- Compound has in vitro binding data (Kd/Ki) and PK parameters (Cmax, Ctrough, fu) available
- Evaluating whether a compound achieves sufficient target coverage at clinical doses
- Comparing compounds in a series by predicted occupancy
- Assessing whether residence time contributes to sustained pharmacology

### Key Concepts

- **Occupancy estimation**: Predict fraction of target bound from free drug concentration and Kd. Use free (unbound) concentration, not total plasma — see free drug hypothesis in reference.
- **Residence time**: tau = 1/koff. Long residence time sustains effect beyond plasma exposure.
- **Functional readouts**: Always pair occupancy estimates with at least one functional readout (phospho-protein, reporter gene, enzyme activity). Occupancy without functional consequence may indicate a non-productive binding mode.

### Reporting

Report predicted occupancy at Cmax, Ctrough, and steady-state Cavg. A target engagement threshold of >= 90% occupancy at Ctrough is a common benchmark for continuous target suppression.

## Drug Perturbation Signature Matching (CMap-Style)

**Reference**: `references/gseapy-connectivity.md` — gseapy.prerank API
for connectivity scoring, NES interpretation, multi-drug panel scoring,
query signature best practices, and sandbox constraints (custom dicts
work offline; Enrichr library names do NOT). Read it before writing
CMap-style analysis code.

### When to Use

- Matching a disease gene signature against drug perturbation profiles to find compounds that reverse or mimic the query
- Drug repurposing: identify compounds whose perturbation profile opposes a disease signature
- Mechanism-of-action similarity: find compounds with concordant profiles

### Workflow

1. **Generate query signature** — from differential expression analysis, take the top N up-regulated and top N down-regulated genes (typically N = 100-500). Use gene symbols as identifiers.
2. **Obtain reference profiles** — a drug-perturbation signature collection is in the reference inventory as an opt-in download, so resolve it by what it is and expect it may not be staged; ChEMBL is not a substitute, carrying bioactivity rather than transcriptomic perturbation profiles. The collection arrives as directional gene sets, one pair per experiment: **score the up and down halves of a pair separately and subtract**, because connectivity is that difference. Pair them by their shared term prefix rather than by position. If nothing resolves, fall back to perturbation experiments already staged in the workspace; if there are none either, report that CMap-style scoring cannot be run and say what would be needed. Never invent a reference path and never substitute drug-target gene lists for perturbation signatures — scoring target sets against a disease ranking is target enrichment, not connectivity, and must not be reported as a connectivity score.
   - Signatures are cell-line responses, so a reversal found in one line is a hypothesis about that context, not about a tissue or a patient. Report the cell line alongside the score.
3. **Score all references** — use `gseapy.prerank` (preferred) or KS-based connectivity scoring from the reference.
4. **Assess significance** — permutation-based FDR from gseapy, or empirical p-value from 1000 label permutations.
5. **Interpret results**:
   - Score < -0.5, p < 0.05 → strong reversal candidate (drug repurposing lead)
   - Score > 0.5, p < 0.05 → strong mimicry (similar mechanism or toxicity concern)
   - |Score| < 0.3 → no meaningful connectivity

## Selectivity Profiling

**Reference**: `references/selectivity-scoring.md` — metric formulas
with edge cases, input preparation (why raw IC50 breaks Gini), S-score
interpretation table (Karaman et al. 2008), entropy thresholds
(Uitdehaag & Zaman 2011), and a complete reporting template. Read it
before computing selectivity metrics.

### Selectivity Metrics

When profiling a compound against a panel of targets (kinase panel, GPCR panel, safety panel), quantify selectivity with these metrics. See the reference for implementations, edge cases, and input preparation.

| Metric | Selective When | Panel Type |
|--------|---------------|------------|
| Gini coefficient | > 0.8 | Any (uses %inhibition or pIC50, NOT raw IC50) |
| S-score | S(3μM) < 0.05 | Kinase panels (uses Kd values) |
| Selectivity entropy | < 2 | Kinase/GPCR (uses pIC50 values) |
| Selectivity window | > 100-fold | Any (primary vs closest off-target IC50 ratio) |

### Panel Types and Reporting

**Kinase selectivity panel** (e.g., DiscoverX scanMAX, Eurofins):
- Report: S(1μM), S(3μM), Gini coefficient, selectivity entropy
- Highlight: top 5 off-target kinases by Kd
- Visualize: selectivity heatmap (compound x kinase), sorted by Kd

**GPCR/ion channel safety panel** (e.g., Eurofins SafetyScreen44):
- Report: %inhibition at 10μM for each target
- Flag: any target with >50% inhibition at 10μM
- Highlight: hERG (>50% at 10μM is a red flag), muscarinic, adrenergic

**Selectivity window**: Report the ratio between primary target potency and the most potent off-target. >100-fold is excellent; <10-fold means off-target effects are expected at therapeutic doses.

## Anti-Patterns

- **Skipping standardization**: Structures from different sources have different salt forms, charge states, tautomers. Always standardize first.
- **Assuming SMILES validity**: Always parse with `Chem.MolFromSmiles()` and check for `None` before proceeding.
- **Fingerprint without specifying type/radius**: Always state fingerprint type (Morgan/ECFP) and radius (default 2 for Morgan = ECFP4).
- **DeepChem GNN on CPU with >10K compounds**: Will be extremely slow. Use fingerprint-based sklearn models instead.
- **Tanimoto on counted fingerprints**: Use bit vectors (`GetMorganFingerprintAsBitVect`), not count vectors, for Tanimoto similarity.
- **Interpreting PAINS as definitive rejection**: PAINS flags indicate potential assay interference, not definitive exclusion. Report and flag, don't silently filter.
- **Not reporting which Ro5 rule is violated**: Don't just say "fails Ro5" -- report which specific rules are violated.
- **Chemical space UMAP without standardizing fingerprint parameters**: Different FP radius/bits gives different spaces. Always report parameters.
- **Running QSAR without scaffold split**: Random train/test splits allow similar scaffolds in both sets, inflating apparent performance. Use scaffold split for realistic evaluation.
- **Mordred on raw (unstandardized) molecules**: Descriptor values change with salt forms and charge states. Standardize first.
- **Not checking feature matrix for NaN before ML**: Mordred and RDKit descriptor calculation can fail on some molecules. Always check and clean before model fitting.
- **Clustering without reporting parameters**: Always report fingerprint type, radius, bits, and distance cutoff used for clustering.

## QSAR Model Selection

| Data Size | Featurization | Model | Notes |
|-----------|--------------|-------|-------|
| <1K | Morgan FP (2048) | sklearn RandomForest/GBM | 5-fold CV, fast, interpretable |
| 1K-10K | Morgan FP (2048) or mordred descriptors | sklearn GBM or DeepChem MultitaskRegressor | Scaffold split for evaluation |
| 10K-100K | DeepChem CircularFingerprint | DeepChem MultitaskClassifier/Regressor | Dense MLP, moderate GPU benefit |
| >100K | DeepChem MolGraphConvFeaturizer | AttentiveFPModel or GraphConvModel | GPU required, scaffold split mandatory |

For regression tasks, report R2 and RMSE on the test set. For classification, report ROC-AUC and optionally PR-AUC (especially for imbalanced datasets). Always use scaffold split for final evaluation -- random splits overestimate performance on molecular data.

## Additional Available Packages

- **umap-learn** (Python): Dimensionality reduction for chemical space visualization on binary fingerprints.
- **scikit-learn** (Python): Ensemble models, cross-validation, and feature selection for QSAR modeling on fingerprint or descriptor matrices.
- **scipy.stats** (Python): Statistical tests for property comparisons (Mann-Whitney U, KS test) and activity distribution analysis.
- **seaborn** (Python): Statistical visualization for property distributions, heatmaps, and pairwise comparisons.
- **matplotlib** (Python): Base plotting library for all custom figures.

## References

| File | Purpose |
|------|---------|
| `references/rdkit-core.md` | RDKit core API: Chem, Descriptors, Scaffolds, FilterCatalog, Draw, AllChem |
| `references/datamol-api.md` | datamol: standardization, fingerprints, clustering, scaffolds |
| `references/mordred-api.md` | Mordred: molecular descriptor calculation |
| `references/deepchem-api.md` | DeepChem: featurizers, models, MoleculeNet |
| `references/structural-alerts.md` | Structural alerts: PAINS, Brenk, NIH via FilterCatalog |
| `references/target-engagement.md` | Target engagement: occupancy model, residence time, functional readouts |
| `references/gseapy-connectivity.md` | GSEApy prerank for CMap-style drug perturbation connectivity scoring |
| `references/selectivity-scoring.md` | Selectivity metrics: Gini, S-score, entropy, selectivity window |
