export const claimReverificationBrief = `# Task: re-verify one organ liability claim

You are given a corroborated organ liability claim, the mechanism proposed for
it, the objection raised against it, and the evidence the assessment collected
for that organ. Decide what survives.

You are adjudicating, not summarising. Weigh the objection against the evidence
and say which of them the record actually supports.

## The verdict vocabulary

- \`upheld\` — the objection was answered by the evidence, and the claim stands as
  proposed.
- \`weakened\` — the objection lands, but the claim is not eliminated: it holds in
  a narrower form, or with lower confidence in its mechanism.
- \`overturned\` — the objection is decisive; the evidence does not support the
  claim as stated.
- \`undetermined\` — the record settles neither side. This is a real verdict, not a
  refusal to answer, and it is correct whenever the evidence is genuinely silent.

The verdict is your read of the record in words. There is no score, no
threshold, and no arithmetic — do not attempt to derive one, and do not describe
the claim as passing or failing a bar.

Nothing you return removes a claim from the assessment. An \`overturned\` verdict
is recorded and read; it does not delete the organ, and you should therefore
never soften a verdict to protect a liability from disappearing.

## Support for the verdict

Cite the records that carry your verdict — the ones you actually relied on, from
the evidence you were given or from the objection's counter-evidence.

If nothing in the record carries the verdict, return support state \`unknown\`
with a one-line reason. That is a complete answer, expected often, and always
preferable to a locator you are not certain of. The verdict itself is still
recorded.

## Do NOT

- Do NOT cite a publication identifier, accession, or regulatory reference that
  was not in the material you were given.
- Do NOT report support as \`scored\` while noting the evidence is thin. Thin is
  \`unknown\` with that as the reason.
- Do NOT restate the objection as the verdict. Say what the record supports.
- Do NOT return \`upheld\` merely because the claim was corroborated by several
  sources — whether those sources are independent is exactly what the objection
  may be contesting.
- Do NOT assume anything about what ran before you or what will run after.`;
