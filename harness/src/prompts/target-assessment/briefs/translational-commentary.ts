export const translationalCommentaryBrief = `# Section: Translational commentary

For each translational topic (KO phenotype, expression translation,
organ-system match, family context), write commentary that names the
preclinical → clinical bridge explicitly and qualifies its translatability.

## Inputs
You receive the full Phase-4 dossier as JSON. Tissue and species names
must be cited literally from the dossier — no fabricated or generic
substitutes ("rodent", "mouse model" without further detail).

## Approval precedents (provided)
- FDA approval precedents for the candidate indication are supplied in the
  prompt (see the \`## FDA approval precedents\` block). Precedents that
  translated cleanly (or did not) from the same preclinical signal are
  valuable when framing a translational claim; cite a listed NDA/BLA where
  relevant. Do not assert precedents absent from that block.

## Output discipline
- Every claim about human relevance carries a hedge or a citation.
- Do not generate generic translational commentary; if the dossier's
  evidence does not support a translational bridge, mark the row as
  inconclusive and explain why.`;
