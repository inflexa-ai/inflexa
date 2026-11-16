---
name: drug-repurposing
description: Read before you rank existing drugs for a new indication from a disease signature, a target list, a network, or genetic evidence. It gives the strategy for each input, the correct connectivity score, how to treat a source that did not answer, and the claims that are not permitted.
metadata:
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
     (sign(log2FC) * -log10(pvalue)), **plus** a set of drug
     perturbation profiles.
   - **Reference-data caveat**: a drug-perturbation signature
     collection is in the reference inventory as an opt-in download,
     so resolve it up front and expect it may not be staged. It
     arrives as directional gene sets — one up set and one down set
     per experiment — and connectivity is the difference between
     their two enrichment scores, so pair them by their shared term
     prefix and never score one alone. Failing that, search the
     workspace for staged perturbation data. If neither is present,
     say so and switch to a
     target-, network-, or genetics-based strategy — do not invent a
     signature path, and do not substitute drug-target gene sets for
     perturbation profiles and still call the output a connectivity
     score.
   - **Output**: ranked drugs by connectivity score with FDR.

2. **Target-based repurposing** (have: validated target gene list)
   - Map disease-relevant targets to known drugs via ChEMBL, DrugBank,
     and Open Targets.
   - The goal is the approved and clinical-stage drugs with activity
     against each target, with a mechanism of action that is relevant
     to the disease. Resolve the symbols to ChEMBL target identifiers
     first. Add DrugBank data where the lookup is available.
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
   - **Reference-data caveat**: a genome-scale scored PPI network is
     in the reference inventory as an opt-in download, so resolve it
     before planning on it and expect it may not be staged. It is
     keyed on internal protein identifiers and ships a companion
     mapping table — read the entry's stated contents rather than
     assuming symbols. Score it to high confidence before measuring
     distances: the unfiltered graph is dense enough that proximity
     stops discriminating. If nothing resolves, and none is staged in
     the workspace either, report the gap rather than constructing a
     placeholder network — proximity z-scores from an invented graph
     are meaningless.
   - **Output**: drugs ranked by proximity z-score.
   - Closer proximity = more likely to modulate disease biology.

4. **Genetics-based repurposing** (have: GWAS hits or genetic
   associations)
   - Drugs targeting genes with genetic evidence for a disease have
     higher clinical success rates.
   - The goal is the druggable targets with genetic evidence for the
     disease trait, and the drugs that exist for them. Use the GWAS
     Catalog, DisGeNET where the lookup is available, the tractability
     of Open Targets, and ChEMBL/DrugBank.
   - Prioritize targets with both genetic evidence AND existing drugs.
   - **Association is not causation, and the distinction decides whether the
     target is worth pursuing.** Where exposure and outcome GWAS summary
     statistics are supplied, Mendelian randomization tests whether the
     genetically-proxied exposure causes the disease — see the
     `genomic-variants` pack. Note what MR estimates: a lifelong effect of
     genetic proxy, not the effect of a drug given at one point in time, so a
     causal result supports the target without predicting the effect size.

5. **Clinical evidence mining** (validation layer)
   - For each candidate, look for the clinical-trial registries, the
     FAERS adverse-event reports, and the published literature.
   - All three are lookups available to you, not sources a script can
     reach: there is no egress, so do not write HTTP calls to openFDA,
     the trial registries, or a literature API.
   - Report existing clinical evidence alongside computational
     predictions.

## Multi-Strategy Integration

The strongest candidates have independent lines of evidence: signature
reversal, genetic association, target druggability, network proximity,
clinical precedent, safety, and literature.

- Score each evidence type on its own, normalized to 0-1. Report the
  composite score with the score of each component.
- Weight by evidence quality: genetic > signature > network for target
  validation, and signature > network > genetic for mechanism.
- Flag candidates with >= 3 independent evidence lines as high-priority.
- Rank an approved drug for another indication first, then a drug in
  an active Phase 2+ trial, then preclinical evidence.

**A source that did not answer is not a source that found nothing.** These
lookups fan out over several corpora and report which of them answered; some
need credentials the deployment may not hold, so what is reachable varies. Read
that report before scoring. A corpus that could not be reached must be recorded
as *not consulted* — never folded into the criterion as absent evidence, which
silently demotes every candidate that corpus would have supported. Name the
criteria you could not evaluate alongside the ranking, and do not present a
composite score as complete when one of its inputs never ran.

## Reporting Standards

Every repurposing analysis must report:

- The strategy and the reason for it.
- The exact definition, source, size, and derivation of the disease signature or gene set.
- The versions of the reference data: the perturbation collection, ChEMBL, and the GWAS Catalog date.
- The statistics: permutation tests for the connectivity scores, and multiple-testing correction across targets.
- The candidate table: drug name, existing indication, proposed indication, evidence score, evidence sources, development stage. State which sources were consulted and which could not be reached; a score assembled from fewer inputs is a different claim.

## References

| Reference | File | Contents |
|-----------|------|----------|
| Repurposing Methods | `references/repurposing-methods.md` | CMap connectivity scoring with gseapy, network proximity algorithm, genetics-based target scoring, multi-evidence integration, candidate ranking |

## Anti-Patterns

- **A source that did not answer, scored as absent evidence**: Record it
  as *not consulted*, and name the criteria that you could not evaluate.
- **Drug-target gene sets in place of perturbation profiles**: The
  result is target enrichment, not a connectivity score.
- **One half of a directional pair**: Connectivity is the difference
  between the up and the down scores. Pair the sets by their shared
  term prefix.
- **An HTTP call to openFDA, a trial registry, or a literature API from a
  script**: The sandbox has no network. These are lookups of the agent.
- **A placeholder PPI network**: Proximity z-scores from an invented graph
  have no meaning. Report the gap.
- **A claim that "drug X treats disease Y"**: Say "drug X reverses the
  disease Y transcriptomic signature" or "drug X targets a gene
  genetically associated with disease Y".
- **Connectivity scores without a permutation null**: A raw enrichment
  score has no meaning without a null distribution.
- **Candidates as validated therapeutics**: They are hypotheses that need
  experimental and clinical validation.
- **A drug already approved for the disease**: It is not a repurposing
  candidate.
- **A ranking from one evidence type**: Integrate the evidence types.
- **No safety assessment**: An approved drug can have contraindications in
  the proposed patient population.
- **No drug-drug interaction check**: The patients probably take other
  drugs already.
- **A perturbation database with no version**: Write the version and its
  limits.
