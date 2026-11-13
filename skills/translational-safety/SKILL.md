---
name: translational-safety
description: Read before you grade adverse events or lab values, screen off-target or structural liabilities, assess CYP or drug interaction risk, detect adverse-event signals, or make matched negative genes for a tissue. It gives thresholds, the limits of the safety panel, and prohibited claims.
version: 1.1.0
tags: [safety, toxicology, CTCAE, hERG, hepatotoxicity, CYP, DDI, adverse-events, biomarkers, matched-negatives]
---

# Translational Safety

This skill guides safety assessment for translational medicine,
covering computational toxicology, safety biomarker interpretation,
and adverse event classification.

## CTCAE v5 Grading (Common Terminology Criteria for Adverse Events)

When clinical or laboratory safety data includes adverse event severity,
use CTCAE v5 grading:

| Grade | Description | Clinical Action |
|-------|-------------|-----------------|
| 1 | Mild; asymptomatic or mild symptoms | Observation only |
| 2 | Moderate; minimal intervention indicated | Outpatient management |
| 3 | Severe; hospitalization indicated | Dose modification/interruption |
| 4 | Life-threatening | Urgent intervention |
| 5 | Death related to AE | — |

When grading lab values:

### Hepatotoxicity (Drug-Induced Liver Injury)
- **ALT/AST**: Grade 1: >ULN–3x ULN, Grade 2: 3–5x ULN, Grade 3: 5–20x ULN, Grade 4: >20x ULN
- **Total bilirubin**: Grade 1: >ULN–1.5x ULN, Grade 2: 1.5–3x ULN, Grade 3: 3–10x ULN, Grade 4: >10x ULN
- **Hy's Law**: ALT >3x ULN AND bilirubin >2x ULN (without ALP >2x ULN) — high risk of fatal DILI
- **RUCAM score**: Use to assess causality (drug vs other cause)

### Nephrotoxicity
- **Creatinine**: Grade 1: >ULN–1.5x baseline, Grade 2: 1.5–3x baseline, Grade 3: 3–6x baseline, Grade 4: >6x baseline
- **eGFR**: Monitor trend; acute decline >25% is concerning
- **Proteinuria**: Grade 1: +1, Grade 2: +2–3, Grade 3: nephrotic range

### Cardiotoxicity
- **Troponin**: Any elevation above ULN warrants investigation
- **LVEF**: Grade 1: asymptomatic decline, Grade 2: <50% or decline >10%, Grade 3: symptomatic CHF
- **QTc prolongation**: Grade 1: 450–480ms, Grade 2: 481–500ms, Grade 3: >500ms or >60ms increase

### Hematological Toxicity
- **Neutrophils**: Grade 1: <LLN–1500, Grade 2: 1000–1500, Grade 3: 500–1000, Grade 4: <500
- **Platelets**: Grade 1: <LLN–75000, Grade 2: 50000–75000, Grade 3: 25000–50000, Grade 4: <25000

## Safety Target Panel Quick Lookup

A curated secondary-pharmacology off-target safety panel (~30 well-established
liability targets, organ-tagged) is available to you. Use it as a fast
first-pass screen before reaching for live tools.

**From the agent:**

Screen identifiers — ChEMBL IDs, gene symbols, or UniProt accessions —
against the panel with the safety-panel lookup available to you. It
returns matched entries plus a summary by severity and organ. An
unmatched identifier is not a panel hit, which is not the same as being
safe: it may still carry Open Targets signals.

Each matched entry carries:

| Field | Contents |
|-|-|
| `chembl_id` | ChEMBL target identifier — the join key against candidate targets |
| `gene_symbol` | HGNC gene symbol |
| `uniprot` | UniProt accession |
| `organ_system` | Organ system the liability presents in (cardiovascular, hepatic, …) |
| `severity` | Severity tier for the liability |
| `clinical_consequence` | The observed clinical effect |

**From a sandbox script (Python/R):**

**The panel is a lookup, not a file.** It ships inside the agent runtime and is
never staged onto disk, so there is no path to resolve and nothing to read — a
script that goes looking for a safety-panel CSV is hunting for a file that does
not exist in any environment.

To use the panel in a script, look the identifiers up first, then persist the
result into your working directory and read it back:

```python
import pandas as pd

# Written from the panel lookup you ran before invoking the script.
panel = pd.read_csv("output/safety_panel_hits.csv")
hits = candidates.merge(panel, left_on="target_chembl_id", right_on="chembl_id")
```

Screen the whole candidate list in one lookup rather than one call per target,
and write the result once — the panel is small and fully in memory, so batching
costs nothing and keeps the script's input a single reviewable file.

**This panel is NOT exhaustive.** It is the well-cited tier-1 set, so a
clean screen against it is weak evidence of safety and must never be
reported as a clear result. For comprehensive liability assessment also
pull Open Targets organ-specific safety signals and in-vitro
high-throughput screening data (EPA CompTox / ToxCast) using the
target- and chemical-lookup tools available to you. The panel
short-circuits the easy cases; the live sources cover the long tail.

## CYP Metabolism Liability Assessment

When evaluating drug metabolism risk from omics data:

### Key CYP Enzymes
| CYP | % Drug Metabolism | Key Substrates | Key Inhibitors |
|-----|-------------------|----------------|----------------|
| CYP3A4 | ~50% | midazolam, cyclosporine, statins | ketoconazole, ritonavir, grapefruit |
| CYP2D6 | ~25% | tamoxifen, codeine, metoprolol | fluoxetine, paroxetine, quinidine |
| CYP2C9 | ~15% | warfarin, phenytoin, NSAIDs | fluconazole, amiodarone |
| CYP2C19 | ~10% | clopidogrel, omeprazole | omeprazole, fluvoxamine |
| CYP1A2 | ~5% | caffeine, theophylline | fluvoxamine, ciprofloxacin |

### Pharmacogenomic Variant Impact

Look up known gene-drug interactions in PharmGKB through the gene-drug
interaction lookup available to you — there is no egress, so its web API is
not a route from a script. That lookup spans several corpora and reports which
of them answered; a corpus that could not be reached is not one with nothing
to say. If the annotation does not resolve, fall back to the CYP table above
and say it was not consulted. Flag the poor metabolizer (PM) and the ultrarapid metabolizer (UM)
phenotypes.

## Structural Alert Analysis

When compound structures are available (SMILES/SDF), screen against PAINS, Brenk, and NIH structural alert catalogs using RDKit's FilterCatalog module.

Flag but do NOT automatically exclude — structural alerts are
context-dependent. Report: alert type, affected substructure, and
the specific liability concern.

### hERG Liability Indicators

No predictive hERG model is available in the sandbox. Instead:
- Flag compounds with `ALogP > 3.5` AND `basic nitrogen` — known hERG liability correlates
- Retrieve existing hERG bioactivity for the compound against target CHEMBL240 through the ChEMBL lookup available to you. There is no egress, so do not write an HTTP call to the ChEMBL API; if the lookup returns nothing for the compound, report the gap rather than substituting a guess
- Report: "hERG liability not computationally assessed; experimental
  patch-clamp assay recommended for compounds entering lead optimization"

## Safety Biomarker Panels

When clinical lab data is available alongside omics data:

### Organ-Specific Safety Panels
| Organ | Biomarkers | Alert Thresholds |
|-------|-----------|------------------|
| Liver | ALT, AST, ALP, TBil, GGT | Hy's Law criteria |
| Kidney | Creatinine, BUN, eGFR, KIM-1, NGAL | >1.5x baseline |
| Heart | Troponin I/T, BNP/NT-proBNP, CK-MB | Any troponin >ULN |
| Bone Marrow | ANC, platelets, hemoglobin, reticulocytes | CTCAE Grade 3+ |
| Pancreas | Amylase, lipase | >3x ULN |

Compute the maximum toxicity grade of each patient across the
timepoints. Correlate the safety biomarkers with the omics features with
Spearman correlation and FDR correction, and report the result as an
association, not a causal claim.

## Drug-Drug Interaction Assessment

When more than one drug is in scope, find the CYP pathways of each drug
(PharmGKB through the interaction lookup, or the CYP table above where it
returns nothing). Flag the CYP substrates that overlap and the known
inhibitor-substrate pairs, and search FAERS for the combination.

## Pharmacovigilance Signal Detection

When analyzing FAERS data for safety signals, use disproportionality
analysis to distinguish real signals from background noise.

FAERS is reached through the adverse-event lookup available to you, never from
a sandbox script — there is no egress, so do not write an HTTP call to openFDA.
The lookup returns event counts; the disproportionality maths below is yours to
compute from them.

### Disproportionality Measures

| Measure | Formula | Interpretation | Threshold |
|---------|---------|---------------|-----------|
| PRR (Proportional Reporting Ratio) | `(a/(a+b)) / (c/(c+d))` | Frequentist, easy to compute | PRR > 2, chi-squared > 4, N >= 3 |
| ROR (Reporting Odds Ratio) | `(a/b) / (c/d)` | Odds ratio analog, wider CI | Lower 95% CI > 1 |
| IC (Information Component) | `log2((O + 0.5) / (E + 0.5))` | Bayesian shrinkage, WHO-UMC method | IC025 > 0 (lower credibility bound) |
| EBGM (Empirical Bayes Geometric Mean) | Bayesian shrinkage estimate | FDA standard method | EB05 > 2 (5th percentile) |

Contingency table: a = drug+event, b = drug+no-event,
c = no-drug+event, d = no-drug+no-event.

### Signal Constraints

- With longitudinal FAERS data, report the time-to-onset of each event. An
  onset < 30 days suggests a direct pharmacological effect. An onset > 90
  days suggests cumulative or immune-mediated toxicity.
- Apply the signal threshold: PRR > 2 AND N >= 3 AND chi-squared > 4.
- Compare each signal with the adverse events of the drug label, to
  separate known signals from novel signals.
- For a drug-drug interaction, query drug A alone, drug B alone, and the
  combination. Flag the combination when its PRR is more than the PRR of
  each drug alone.

See `references/pharmacovigilance.md` for PRR/ROR computation
functions and visualization patterns.

## Matched Negative Gene Set for a Tissue Risk Benchmark

When a request gives a list of positive genes for one tissue and asks for
matched negatives, read `references/matched-negative-gene-set.md` first. It
gives the method in six parts: the symbol resolution, the expression universe,
the exclusion sources, the two definitions, the matching, and the diagnostics.
The tissue is a parameter, and the liver is the worked example.

Two definitions exist, and the request selects one:

| Definition | Meaning | Pool |
|-|-|-|
| `annotation_free` | No hit in the four exclusion sources: the mouse phenotypes, the human phenotypes, the safety events, and the viability calls. Absence of evidence. | Large |
| `tested_clean` | The `annotation_free` rule, and a tested early-adult colony with no hit. Evidence of absence. | Small |

When the briefing names no definition, make both sets, each with its own
diagnostics. Never make one set with a silent choice. A lethal knockout leaves
the pool by default, because its tissue label is unknown. A definition whose
exclusion source is absent from the reference store gets no negatives file:
name the absent source instead.

## References

| Reference | File | Contents |
|-----------|------|----------|
| Pharmacovigilance | `references/pharmacovigilance.md` | PRR, ROR, IC computation from FAERS data, signal detection workflow, DDI signal analysis, temporal pattern visualization |
| Matched negative gene set | `references/matched-negative-gene-set.md` | Symbol resolution across mouse and human, the tissue expression universe, the exclusion sources, the two negative definitions, matching on expression and connectivity, balance diagnostics |

## Anti-Patterns

- **A script that looks for a safety-panel file**: The panel is a lookup in
  the agent runtime, not a file on disk. Run the lookup, write the result
  to the working directory, and read it from the script.
- **A clean panel screen reported as a clear result**: The panel holds the
  tier-1 targets only. Add Open Targets and ToxCast signals through the
  lookups.
- **A hERG prediction**: No predictive hERG model is in the sandbox. Use
  the ChEMBL bioactivity for CHEMBL240 and the ALogP and basic-nitrogen
  flag, and report the gap.
- **An HTTP call to openFDA, ChEMBL, or PharmGKB from a script**: The
  sandbox has no network. Use the lookups.
- **A PharmGKB corpus that did not answer, reported as no interaction**:
  Say that it was not consulted.
- Assign CTCAE grades without actual clinical lab values — grading
  requires measured values, not predicted values
- Report disproportionality signals as confirmed causal associations —
  FAERS data has known limitations (underreporting, confounding,
  notoriety bias)
- Report FAERS counts as rates, or a signal without a comparator — the
  reporting denominator changes over time and across regions
- Use PRR alone without minimum case count (N >= 3) — low-count
  signals are statistically unreliable
- Infer the species of a gene symbol from its case — match the human
  table and the mouse table, then map the ortholog
- Join the expression table to the network on the symbol — a renamed
  gene drops out in silence, thus join on the Ensembl gene id
- Compute network metrics on the full graph — the positives and the
  negatives must share one induced subgraph
- Report a clean mouse knockout screen as proof of safety — it is
  evidence of absence in the mouse, not in the human
- Pad a short negative tier from the other tier — report the shortfall
- Claim that a computational prediction equals an experimental safety
  assay (hERG patch-clamp, Ames test, in vivo toxicology)
- Use predicted ADMET properties as a definitive safety assessment — they
  are screening-level signals
- Present a structural alert as proof of toxicity — many drugs with
  alerts are safe
- Omit the "experimental validation needed" caveat from a computational
  safety prediction
