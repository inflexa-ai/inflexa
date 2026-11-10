# Evaluation of v1 (own read, before the blind review)

## Across all drafts

- **T3 drift in each body.** Each "Boundary" repeats "raw input is upstream:
  name the processed form and stop". The step standards already say this
  (`sandbox-standards.ts`, "Scope — Analysis Starts at Processed Data"). Keep
  only the domain fact that the standards do not hold, for example "a call is
  made upstream".
- **T5 contract.** No runtime code reads the result columns. Only the report
  gallery uses the DESeq2 names (`report-render/gallery/gallery.ts:150`). The
  skills still write `log2FoldChange`/`padj` (`bulk-transcriptomics/SKILL.md:68`,
  `proteomics/SKILL.md:125`, `single-cell/SKILL.md:365`) against the standards
  (`sandbox-standards.ts:241`). This conflict exists today and survives v1.
- **New test T7, the "Done" test.** If the "Done" paragraph needs an "if", the
  agent does two kinds of work. This test found the genetics split before T1.

## 01 Matrix analyst

- T1: no sentence names an assay. The assay facts became data properties
  (scale, missingness, dependent features). Stance holds.
- T4: the most expensive errors are a count model on intensities and a second
  normalization of pre-normalized values (Olink NPX, ANML SomaScan). The body
  stops the first error. The second error depends on recognizing the platform,
  and that knowledge is in the skill. A weak model can miss it.
- Lost, and a scope decision: metabolomics from raw spectra (XCMS peak
  picking) and methylation from IDATs. v1 calls both upstream. The current
  prompts do them when the packages load. The standards call peak calling
  upstream, so the current metabolomics prompt already conflicts with them.
- Lost: QC-pool drift correction, blank subtraction, beta for reporting and
  M for statistics. These are skill content. The beta/M rule is used in each
  methylation step (round 9 exception), but methylation is a minority of
  matrix steps.
- **Gap (T6):** co-expression modules have no owner. Interpretation says "not
  yours", and the matrix analyst does not claim them.

## 02 Cell-resolved analyst

- T1 branches: the cytometry sentence (tooling: native R, marker types), the
  spatial bullet (a real stance element: neighbors are not independent), and
  the bulk deconvolution (a different unit of observation).
- The deconvolution branch fails the stance "the cell is the observation".
  Rephrase the stance as "a spot or a bulk sample is a mixture", then it is
  one stance with the spatial bullet.
- T4: per-cell tests between conditions are the most expensive error. The body
  stops it. Pass.
- **Immune profiling is split three ways.** Reference-based deconvolution goes
  here. Signature scoring (MCP-counter, immune signatures) is a score against
  prior gene sets, which is interpretation. Outcome models go to statistical
  modeling. This is the "telephone game" risk of the fold article. A routing
  case must cover it.

## 03 Interpretation

- T1: no branch. The strongest stance of the five.
- T2: real delta: the background, the identifier mapping fraction, the
  redundancy, activity against expression.
- T4 risk from round 9: the current body carries gseapy details that the
  eval `step-enrichment-offline-ora` grades (no `organism=` in `gp.enrich()`,
  the GMT from the store). v1 moves them to the skill. Round 9 measured the
  same move: equal pass rate, +16 % dev tokens. Expect the same here.
- TF activity has one owner now. The cell-resolved body gives it away, which
  adds a step for a single-cell TF question.

## 04 Statistical modeling

- T1: no branch. Survival, classification, and mixed models share the stance.
- T2: real delta: resampling holds every data-driven choice, events per
  variable, prognostic against predictive.
- Observation: this stance is the general stance of inference. Parts of it
  belong in the executor too ("distrust a perfect result").

## 05 Genetics

- T7 fails: "Done" names inflation and a threshold, which is wrong for a step
  that only annotates a shortlist.
- T1: two stances. Cohort association and Mendelian randomization share the
  genome-scale statistics and the confounding by ancestry. Annotation of a
  shortlist is evidence work: each claim has a source and a version. That is
  the stance of translational evidence, which is not in the five.
- Call: keep one agent for the experiment, and name the split as the
  first candidate if the domain cases fail on the annotation path.

## 06 Executor

- The central tension: the executor reaches a domain only through a skill
  read. Round 8 showed that agents do not read skills reliably
  (`step-consults-skills` held-out 0/3). Round 9 showed that the enrichment
  agent never read its skill.
- Thus a domain on the executor loses its stance. Microbiome is the clear
  case: the compositional stance is the first line of `microbiome/SKILL.md:14`,
  and the most expensive error (a count model on compositions) needs it.
- **Idea:** the level-1 index line of each skill carries the one-line stance.
  The executor then has each domain stance in its cached prompt, at one line
  each. A specialist is then justified only where its stance needs more than
  a line and the domain is frequent.
