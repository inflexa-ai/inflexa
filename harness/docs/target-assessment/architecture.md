# Target Assessment — Architecture

## What it is

A target assessment is a snapshot-style dossier for one human gene/protein
target. It answers, in a structured Zod-schema-validated document:

- Is this target druggable, and with what modality?
- What clinical record exists, and what is the prior probability of success?
- What safety signals exist now, and which are likely to emerge in the clinic?
- Where is the biology weak — what evidence tiers are missing?

It is independent of analyses: no input files, no artifacts, no chat thread.
One Postgres row per assessment, dossier persisted as JSONB. Re-runs are
immutable — a re-run produces a new row with a new id, prior dossiers are
preserved.

See the Dossier schema in `harness/src/contracts/target-dossier.ts` for the
canonical specification of the dossier sections.

## Data model

```
cortex_target_assessments
  id UUID PK
  organization_id TEXT NOT NULL
  target_id TEXT NOT NULL, target_label TEXT NOT NULL
  goal TEXT NULL
  status TEXT NOT NULL  ('queued' | 'running' | 'completed' | 'failed' | 'deleted' | 'suspended_insufficient_funds')
  progress TEXT NULL    (single human-readable phase string)
  dossier JSONB NULL    (full dossier — see Dossier schema in `harness/src/contracts/target-dossier.ts`)
  billing_context_id TEXT NOT NULL (opaque id minted by the embedder at trigger time)
  error JSONB NULL      ({ kind, message, details? })
  requested_by TEXT NOT NULL
  workflow_run_id TEXT NULL   (run id of the executeTargetAssessment workflow)
  workflow_id TEXT NULL       (DBOS workflow id; for DBOS-shaped rows = assessment id)
  created_at, updated_at TIMESTAMPTZ NOT NULL; completed_at TIMESTAMPTZ NULL
```

Indexes: `(organization_id, created_at DESC)` for list views,
`(organization_id, target_id, created_at DESC)` for "show me prior dossiers
for this target," and `(workflow_id)` for DBOS workflow lookups.

## Workflow phases

The `executeTargetAssessment` workflow is a fixed pipeline. Each parallel work unit is its own DBOS child workflow; fan-out batches run with bounded concurrency; multi-step parallel branches are nested DBOS workflows.

```
Phase 0  resolveTarget          single step (HGNC/UniProt/Ensembl/ChEMBL); the only
                                step allowed to fail the run
Phase 1  12 collectors          opentargets, chemblModulators, ctgov, faersByTarget,
         (parallel)             expressionHuman, expressionMultiSpecies, clinvar,
                                cbioportal, impc, pubmedIndex, pathways, stringPpi
                                → phase1Aggregate
Phase 2  4 decision agents      modulatorTriage, failedTrialClassifier,
         (parallel)             offTargetCurator, drugsInClass
                                → phase2Aggregate
Phase 3  4 fan-out sub-         perModulatorFaers, perTrialAes,
         workflows (parallel;   perModulatorPolypharm, perClassDrugAes
         each maps over a       → phase3Aggregate
         bounded-concurrency
         batch)
Phase 4  assemble + correct     deterministic assemblers + bounded correction loop
Phase 5  3 synthesis agents     liabilityBullets, safetyFlagsTrail,
         (parallel)             translationalCommentary
                                → phase5Persist
```

**Why a workflow, not a chat:** The dossier is fundamentally not an
`executeAnalysis` workload. Fixed schema, no input files, no artifacts, no
sandbox compute, no chat thread, known DAG. Forcing it into the analysis
lifecycle would drag in analysis memory, run/artifact accounting, and chat data
parts that have no purpose here.

## Section → collector mapping

| Dossier section | Phase | Source |
|-|-|-|
| §1.1 Entity | Phase 0 | identifier-resolver (HGNC + UniProt + Ensembl + ChEMBL) |
| §1.2 Summary | Phase 4 | header-counters assembler |
| §2.1 Liability summary | Phase 5 | liability-bullets agent + counters |
| §2.2 Tractability | Phase 1 | opentargets collector + family fallback |
| §2.3 Indications | Phase 4 | indications-rank assembler over Phase 1 |
| §2.4 Drug interactions | Phase 4 | drug-interactions-dedup assembler |
| §2.5 Clinical development | Phase 1+2 | ctgov collector + failed-trial-classifier agent + clinical-benchmarks |
| §2.6.1 Organ rollup | Phase 4 | organ-rollup assembler over Phase 3 |
| §2.6.2 FAERS summary | Phase 3 | per-modulator FAERS sub-workflow |
| §2.6.3 Trial AEs | Phase 3 | per-trial AEs sub-workflow |
| §2.6.4 Off-target panel | Phase 2+3 | off-target-curator agent + per-modulator polypharm |
| §2.6.6 Class precedent | Phase 2+3 | drugs-in-class agent + per-class-drug AEs |
| §2.6.7 Safety flags | Phase 5 | safety-flags-trail agent (rules-first) |
| §2.7 Off-tissue risk | Phase 4 | off-tissue assembler over expression-human |
| §3.1–3.6 Reference biology | Phase 1 | opentargets, pubmed-index |
| §3.4 Genetic alterations | Phase 1 | cbioportal + clinvar collectors |
| §3.7 Pathway context | Phase 1 | pathways collector (KEGG + Reactome) |
| §3.8 PPI network | Phase 1 | string-ppi collector + ppi-dedup assembler |
| §3.9 Normal tissue | Phase 1 | expression-human collector |
| §3.10 Preclinical | Phase 1+5 | impc + multi-species expression + translational-commentary agent |
| §3.11 Key papers | Phase 1 | pubmed-index collector |
| §4.1 Conflicts | Phase 4 | evidence-conflicts assembler |
| §4.2 Timeline | Phase 4 | evidence-timeline assembler |
| §4.3 Translational chain | Phase 4 | translational-chain assembler |
| §4.4 Additional evidence | Phase 4 | additional-evidence-filter assembler |
| §4.5 Discovery trials | Phase 1 | ctgov collector (low/medium-confidence rows) |

## Resilience contract

DBOS child workflows are fail-fast when a parent cancels them. To honor the spec's "never abort, always disclose"
rule, every collector / decision-agent / fan-out / synthesizer step
wraps its work in try/catch and returns a typed output with a `coverage`
discriminator. Steps NEVER throw on data-source failure. Only Phase 0
(target resolution) is allowed to throw — that is the one failure that
legitimately aborts the workflow with `status: failed,
error.kind: "target-unresolved"`.

```ts
// Pure async function; the workflow body wraps the call in
// DBOS.runStep({ name: "ta-collector:opentargets" }) so recovery replays
// the cached coverage envelope instead of re-issuing the HTTP call.
async function opentargetsCollector(
  input: ResolvedTarget,
): Promise<OpenTargetsBundle> {            // bundle includes the coverage discriminator
  try {
    const data = await opentargetsClient.fetch(input);
    return { coverage: "available", data };
  } catch (error) {
    return { coverage: "queried_no_data", error: serializeError(error) };
  }
}
```

## Billing

Call attribution is resolved by the embedder via the `ResolveBilling` seam
(`src/billing/resolver.ts`).

## Progress

The target-assessment workflow persists the latest progress string on the row.
Core does not prescribe a transport for clients; hosts may expose progress via
polling, server-sent events, websockets, or any other mechanism.

The dossier UI is not a chat. Reusing `chat-data-parts` would force consumers to
reconcile a fake conversation that never existed; the target-assessment contract
is the dossier row and progress state.

## Re-runs are immutable

A new assessment SHALL produce a new row with a new id. The system MUST
NOT mutate `dossier` after `status` becomes `completed`. Re-running for
the same target SHALL create a new assessment row, preserving prior
dossiers under their original ids.

## Storage cap

Dossier size is soft-capped at ~16 MB to avoid blowing Postgres TOAST
limits. If `phase5Persist` detects the assembled dossier exceeds the cap,
it truncates the fetch-capped sections (preclinical literature, off-target
panel) with `truncated: true` flags, then re-validates against the schema.
