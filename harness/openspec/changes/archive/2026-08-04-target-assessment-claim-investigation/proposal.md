## Why

The corroboration spine tells a reader which organs several independent sources agree on. Agreement is
not scrutiny: a claim four sources repeat because they all descend from one curation pass is
corroborated and still wrong. Nothing in the assessment currently takes a candidate organ liability and
works out whether it survives being argued against, and nothing states which candidate claims went
uninterrogated. The dossier therefore ships agreement as if it were adjudication.

## What Changes

- Add a claim-investigation phase to `executeTargetAssessment`, running after Phase-4 assembly and
  before Phase-5 synthesis, over the corroborated organ claims. Its shape is
  **propose → critique → re-verify → converge**, bounded and explicit.
- The adversarial critique is a distinct step whose stated job is to argue the claim does NOT hold, and
  it is the only step allowed to reach past the collected evidence for disconfirming records.
- Add a `claim_investigation` dossier section carrying the per-organ verdicts, the mechanism proposed
  for each, the surviving objection, the convergence account, and a completeness list naming every
  candidate claim that was not investigated and why.
- Every assertion the phase makes — mechanism, objection, verdict — uses the shared claim contract:
  scored with locator-bearing evidence, or `unknown` with a reason. The prompts state that `unknown` is
  a complete answer, so the model is never pushed to invent a locator to satisfy the type.
- Move the safety-corroboration fold from Phase-5 persist into its own durable step ahead of the
  investigation, so the investigation and the synthesis read the same corroboration record rather than
  two computations of it.
- Wire the previously unsupplied `ClinicalConsequenceAnnotatorDeps` bundle from the workflow body, so
  the off-target clinical-consequence annotator and its Postgres cache are reachable.

## Capabilities

### New Capabilities

- `target-claim-investigation`: interrogation of corroborated organ claims — the propose / adversarial
  critique / re-verify / converge structure, its bound, the claim-contract discipline on every verdict,
  the completeness account, and the coverage-enveloped dossier section that carries them.

### Modified Capabilities

None. The claim contract (`target-dossier-evidence`), the coverage envelope
(`target-dossier-coverage`), the organ vocabulary (`target-organ-vocabulary`) and the corroboration
fold (`target-safety-corroboration`) are consumed as they stand; no requirement of theirs changes.

## Impact

- `src/contracts/target-dossier.ts` — new `claim_investigation` section and its row schemas; new
  required top-level key on `DossierSchema`, so every producer must emit it.
- `src/workflows/target-assessment/investigation/` — new phase driver.
- `src/prompts/target-assessment/investigation/` — new prompts (proposal brief, adversarial critic
  system prompt, re-verification brief).
- `src/workflows/execute-target-assessment.ts` — new phase between assembly and synthesis; new durable
  steps `ta-safety-corroboration` and `ta-investigate:*`; annotator deps wired into Phase 4.
- `src/workflows/target-assessment/phase5-persist.ts` — no longer folds the corroboration itself.
- `src/workflows/target-assessment/assemblers/orchestrator.ts`, `phase4-assemble.ts` — emit the new
  section as `not_loaded`; accept the annotator deps.
- Consumers reading a persisted dossier gain a section; none loses one.
