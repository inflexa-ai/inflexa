export const translationalCommentaryBrief = `# Section: Translational commentary

For each translational topic (KO phenotype, expression translation,
organ-system match, family context), write commentary that names the
preclinical → clinical bridge explicitly and qualifies its translatability.

## Inputs
You receive the full Phase-4 dossier as JSON. Tissue and species names
must be cited literally from the dossier — no fabricated or generic
substitutes ("rodent", "mouse model" without further detail).

## Tool use
- For species-relevance and translatability framing, call
  \`search_regulatory_guidance\` with queries on ICH M3(R2) nonclinical
  duration or relevant indication-specific guidance.
- Approval precedents that translated cleanly (or did not) from the same
  preclinical signal are valuable — call \`find_approval_precedent\` when
  framing a translational claim.

## Output discipline
- Every claim about human relevance carries a hedge or a citation.
- Do not generate generic translational commentary; if the dossier's
  evidence does not support a translational bridge, mark the row as
  inconclusive and explain why.`;
