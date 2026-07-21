# target-synthesis-grounding Specification

## Purpose
TBD - created by archiving change ground-synthesis-with-approval-precedents. Update Purpose after archive.
## Requirements
### Requirement: Synthesis is grounded with FDA approval precedents

Phase-5 target-assessment synthesis SHALL be grounded with FDA approval
precedents supplied deterministically as prompt context, because the single-shot
forced-`submit` synthesis can call no retrieval tool.

Before the Phase-5 synthesis calls, the workflow SHALL run one durable step
(`ta-approval-precedents`) that:

1. Resolves a candidate indication from the assembled dossier — the top
   `indications` row by `composite_score` when `indications.coverage` is
   `"available"` and rows exist, otherwise the target header's
   `inferred_therapeutic_area`, otherwise none.
2. When an indication resolves, queries openFDA / Drugs@FDA once for prior
   approvals in that indication. A lookup failure (non-404 HTTP error) SHALL be
   non-fatal — it degrades to an empty result, never failing the assessment.
3. Renders a `## FDA approval precedents` markdown block: the precedents when
   present, an explicit "no precedents found" note when the query is empty, and a
   "no indication resolved" note when step 1 yielded none.

That block SHALL be threaded through `SynthesisAgentDeps.approvalPrecedents` and
appended to every Phase-5 synthesis prompt (`liability-bullets`,
`safety-flags-trail`, `translational-commentary`, `dossier-recommendation`). The
briefs SHALL instruct the model to cite only precedents present in that block (or
the dossier), never to call a retrieval tool. No `find_approval_precedent` tool
SHALL be rostered on any agent — the openFDA fetch is a plain function invoked by
the durable step.

#### Scenario: Precedents are fetched once and injected into synthesis

- **GIVEN** an assembled dossier whose top-ranked indication is a disease with FDA approvals
- **WHEN** the workflow runs Phase-5
- **THEN** the `ta-approval-precedents` step queries openFDA once and every synthesis prompt receives a `## FDA approval precedents` block listing the returned NDA/BLA precedents

#### Scenario: A precedent lookup failure does not fail the assessment

- **GIVEN** the openFDA query throws a non-404 error
- **WHEN** the `ta-approval-precedents` step runs
- **THEN** the step yields an empty precedents note, synthesis proceeds, and the assessment is not failed

#### Scenario: No indication resolves

- **GIVEN** a dossier with no available indications and a null `inferred_therapeutic_area`
- **WHEN** the `ta-approval-precedents` step runs
- **THEN** it queries nothing and injects a "no indication resolved" note into the synthesis prompts

