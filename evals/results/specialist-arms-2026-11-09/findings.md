# Findings of the thought experiment (v1, blind review, v2)

Files: `00-guidelines.md`, `v1/`, `eval-v1-own.md`, `review/blind-review.md`,
`v2/`. The executor body of v1 (`v1/06-executor.md`) did not change in v2.

## 1. The merge test: five specialists, not one executor

`v2/07-merged-executor.md` puts the five stances into one body. The shared
core is four lines, and it is the v1 executor. Each other line holds for one
kind of data only: five `[IF]` groups in the stance, five in "Done", and five
contracts.

The groups do not contradict each other when the right one applies. But the
wrong group gives the most expensive error of a domain. A cell object under
the matrix stance makes each cell a sample, and that gives per-cell tests of a
condition. Thus the selector is load-bearing.

The planner already makes this selection when it routes a step. A specialist
is the `[IF]` selection that moves from the model to the plan. The split is by
the unit of observation of the step input. That is a split by context, which
the fold article permits. It is not a split by problem type.

## 2. Inside each specialist, the branches are tooling, with two exceptions

- Matrix, cells, interpretation, and modeling: each assay branch is one
  example of one stance. The skill carries the tooling.
- **Genetics** fails the "Done" test (T7). An association and an annotation
  have different "Done" items. Annotation of a shortlist is evidence work:
  each claim has a source and a release. That is the stance of the
  translational-evidence specialist, which is not in the five.
- **Spatial** is the next split candidate. Its stance adds one variable and
  conflicts with nothing. Split it only if the spatial cases fail in a
  different way from the dissociated cases.

## 3. An abstract stance can be wrong for one assay

v1 turned assay rules into data properties, and two lines became wrong:

- "Collapse the peptides of one protein" invited the phospho roll-up that
  `skills/proteomics/SKILL.md:108` forbids.
- "A confounder goes in the model, not in a correction of the values" forbade
  the LOESS drift correction of `skills/metabolomics/SKILL.md:47`.

The blind review found both, and my read did not. Thus each stance line needs
a check against each skill that it spans before it ships. The check is a
review step, because no grader reads prose.

## 4. The residual risk is platform facts, and no body carries them

The blind review lists the most expensive error of each domain (T4). Most
errors are stance errors, and the v2 bodies stop them. Some errors depend on
recognizing a platform, and only a skill holds the fact:

- Olink NPX and ANML SomaScan arrive normalized.
- The arcsinh cofactor differs for CyTOF, flow, and IMC.
- Visium takes a grid neighbor graph.

The executor and a specialist depend equally on a skill read for these facts.
Round 8 showed that agents do not read skills reliably. Thus the fix is not
in a prompt. Code can attach the platform section of the skill to the
briefing. This is the "rules in code" line, applied to knowledge that a step
always needs. But the key is weak today: the profile gives the platform only
as the free-text `domain` and `subtype` (`harness/src/contracts/data-profile.ts:445-447`).

## 5. Interpretation is the weakest specialist

Its stance copies the anti-patterns of `skills/enrichment/SKILL.md:88-97`.
It survives only on T4: without a skill read, the executor does not stop a
whole-genome background. Round 9 measured the same trade (equal pass rate,
+16 % dev tokens when the content is only in the skill). Its domain cases
decide it.

## 6. What falls to the executor

These kinds of work get no owner from the five:

- peak annotation and signal tracks
- TCR and BCR repertoires
- methylation clocks
- called copy-number segments
- microbiome, cheminformatics, PK/PD, and the evidence work

Two consequences follow. First, the executor must become plannable
(`harness/src/agents/sandbox/scientific-executor.ts:3`). Second, a domain on
the executor loses its stance unless a skill read occurs. The cheapest carrier
is the level-1 index line of each skill. Today each line is a list of topics.
The microbiome line can say "compositional: compare log-ratios".

## 7. The body owns the contract

v2 gives each body its output contract. Each skill still has an "Output
Conventions" section with other names. If those sections stay, the drift
returns. The conflicts that exist on main today are in `tmp/claude/SESSION.md`.

## Decisions for the team

1. The scope of raw spectra (XCMS from mzML) and raw array files (IDAT).
   The current prompts do this work when the packages load. v2 calls it
   upstream, as the standards do.
2. Where the annotation of a variant shortlist goes: genetics, or an evidence
   specialist.
3. The executor as a plannable owner of the work above.

## What the runs measure

Each item of the decision delta of `review/blind-review.md` is one domain
case, graded on the script. Run each case on three arms: the current
specialist, the v2 specialist, and the executor with the same skills. Use
Sonnet 5.5 and GLM-5.3. The weak tier shows the difference, because Sonnet
already passes nearly every current case.
