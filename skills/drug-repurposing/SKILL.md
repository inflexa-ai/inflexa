---
name: drug-repurposing
description: Systematic drug repurposing via signature matching, target-based analysis, network proximity, genetic evidence scoring, and clinical evidence mining
version: 1.0.0
tags: [drug-repurposing, repositioning, cmap, connectivity-score, network-proximity, genetic-evidence, indication-expansion]
---

# Drug Repurposing

This skill guides systematic identification of existing drugs for new
therapeutic indications using computational methods. Covers signature-
based, target-based, network-based, and genetics-based approaches.

## Strategy Selection Decision Tree

Choose the repurposing strategy based on available data:

1. **Signature-based repurposing** (have: disease DE signature)
   - Query a disease transcriptomic signature against drug perturbation
     profiles (CMap-style connectivity scoring).
   - Drugs that REVERSE the disease signature are therapeutic
     candidates. Drugs that MIMIC it may exacerbate.
   - See `references/repurposing-methods.md` for connectivity scoring
     with gseapy.prerank and permutation testing.
   - **Input**: ranked gene list from DE analysis
     (sign(log2FC) * -log10(pvalue)).
   - **Output**: ranked drugs by connectivity score with FDR.

2. **Target-based repurposing** (have: validated target gene list)
   - Map disease-relevant targets to known drugs via ChEMBL, DrugBank,
     and Open Targets.
   - Workflow:
     a. `searchTargets` — resolve gene symbols to target ChEMBL IDs.
     b. `searchCompounds` with searchType "target" — find compounds
        with bioactivity against each target.
     c. `getDrugInfo` — check approval status and existing indications.
     d. `getMechanism` — verify mechanism of action is relevant.
     e. If `searchDrugbank` available: get additional indication,
        interaction, and pharmacology data.
   - Prioritize: approved drugs > Phase 3 > Phase 2 > Phase 1 >
     preclinical.
   - Flag drugs already indicated for the target disease (not
     repurposing candidates).

3. **Network-based repurposing** (have: disease module / PPI network)
   - Compute network proximity between drug target sets and disease
     gene modules in a PPI network.
   - See `references/repurposing-methods.md` for network proximity
     scoring.
   - **Input**: disease gene set + drug-target mapping + PPI network.
   - **Output**: drugs ranked by proximity z-score.
   - Closer proximity = more likely to modulate disease biology.

4. **Genetics-based repurposing** (have: GWAS hits or genetic
   associations)
   - Drugs targeting genes with genetic evidence for a disease have
     higher clinical success rates.
   - Workflow:
     a. `searchGwasCatalog` — find genetic associations for the
        disease trait.
     b. `searchDisgenet` (if available) — get gene-disease association
        scores.
     c. Map GWAS genes to druggable targets via `searchOpenTargets`
        (check tractability).
     d. Find existing drugs for those targets via ChEMBL/DrugBank.
   - Prioritize targets with both genetic evidence AND existing drugs.

5. **Clinical evidence mining** (validation layer)
   - For any candidate, check real-world evidence:
     a. `searchClinicalTrials` — is the drug already being tested for
        this indication?
     b. `searchFaers` — are there safety signals specific to the
        proposed patient population?
     c. `searchPubMed` — is there published evidence for the
        drug-disease combination?
   - Report existing clinical evidence alongside computational
     predictions.

## Multi-Strategy Integration

The strongest repurposing candidates are supported by multiple
independent lines of evidence:

| Evidence Type | Source | Weight |
|--------------|--------|--------|
| Signature reversal | CMap-style connectivity | Mechanistic |
| Genetic association | GWAS/DisGeNET | Causal inference |
| Target druggability | ChEMBL/Open Targets | Feasibility |
| Network proximity | PPI-based | Biological context |
| Clinical precedent | ClinicalTrials.gov | Translational |
| Safety profile | FAERS | Risk assessment |
| Literature support | PubMed | Prior knowledge |

### Scoring Framework

When combining evidence from multiple strategies:

1. Score each evidence type independently (normalize to 0-1).
2. Weight by evidence quality (genetic > signature > network for
   target validation; signature > network > genetic for mechanism).
3. Report composite score with component breakdown.
4. Flag candidates with >= 3 independent evidence lines as
   high-priority.

## Compound Prioritization Criteria

After candidate identification, rank by:

| Criterion | Priority | Source |
|-----------|----------|--------|
| Approved for another indication | Highest | DrugBank/ChEMBL |
| Active clinical trials (Phase 2+) | High | ClinicalTrials.gov |
| Known safety profile | High | FAERS, DrugBank |
| Mechanism matches disease biology | High | Literature, pathway analysis |
| Genetic evidence supports target | High | GWAS, DisGeNET |
| Favorable ADMET profile | Medium | ChEMBL ADMET, RDKit descriptors |
| No IP/exclusivity barriers | Medium | DrugBank status |
| Preclinical evidence only | Lower | ChEMBL bioactivity |

## Reporting Standards

Every repurposing analysis must report:

1. **Strategy used** — which approach(es) and why.
2. **Disease signature or gene set** — exact definition, source,
   size, and how it was derived.
3. **Reference database versions** — CMap build, ChEMBL version,
   GWAS Catalog date.
4. **Statistical framework** — permutation testing for connectivity
   scores, multiple testing correction for multi-target analysis.
5. **Candidate table** — drug name, existing indication, proposed
   indication, evidence score, evidence sources, development stage.
6. **Validation evidence** — clinical trials, literature, safety data.
7. **Limitations** — computational predictions require experimental
   validation; repurposing candidates are hypotheses, not validated
   therapeutics.

## References

| Reference | File | Contents |
|-----------|------|----------|
| Repurposing Methods | `references/repurposing-methods.md` | CMap connectivity scoring with gseapy, network proximity algorithm, genetics-based target scoring, multi-evidence integration, candidate ranking |

## Do NOT

- Present computational repurposing candidates as validated
  therapeutics — they are hypotheses requiring experimental and
  clinical validation
- Use connectivity scores without permutation-based significance
  testing — raw enrichment scores are not interpretable without a
  null distribution
- Ignore existing indications — a drug already approved for the
  target disease is not a repurposing candidate
- Rank candidates by a single evidence type — multi-evidence
  integration is essential for meaningful prioritization
- Skip safety assessment — even approved drugs may have
  contraindications for the proposed patient population
- Claim "drug X treats disease Y" — say "drug X reverses the
  disease Y transcriptomic signature" or "drug X targets a gene
  genetically associated with disease Y"
- Use outdated perturbation databases without noting the version
  and its limitations
- Ignore drug-drug interactions when proposing repurposed drugs for
  patients likely on existing therapies
