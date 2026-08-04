## Context

`executeTargetAssessment` runs Phase 0 resolve → 1 collect → 2 decide → 3 fan-out → 4 assemble
(deterministic) → 5 synthesis + persist. Phase 4 produces the dossier body; Phase 5 writes prose over
it with single-shot forced-`submit` calls that can call no retrieval tool.

The corroboration spine (`assembleSafetyCorroboration`) folds every organ-bearing signal the run
collected into one record per canonical organ and reports how many independent sources back it. It is
a pure function over already-collected inputs and is currently invoked inside `phase5Persist`.

What the assessment has never had is interrogation. A corroborated organ is a *candidate* liability;
nothing asks whether the target plausibly produces it, nothing argues the other side, and nothing says
which candidates were left alone.

A reference implementation of this idea elsewhere is a source of negative constraints rather than a
model: it put prompts, LLM calls and durability behind a bespoke per-run deps factory that reached
straight into the durability engine and a billed LLM wrapper, with prompt strings inlined in that
factory; and it accumulated a numeric claim-soundness score, a layered "established" gate, and
mechanism-keyed critic deduplication, all of which were reversed or gutted in place.

## Goals / Non-Goals

**Goals:**

- Interrogate each corroborated organ claim: propose a mechanism, argue against it, re-verify, and
  record a verdict.
- Converge on an explicit, code-stated bound. Never loop unboundedly.
- Report what was not investigated and why, rather than presenting a partial pass as a complete one.
- Express every assertion through the existing claim contract, with `unknown` genuinely cheap to reach.
- Build the phase out of this package's own primitives: prompts in `src/prompts/`, durability through
  the injected `runStep` seam, `runAgent` + `defineTool` where a step is genuinely agentic,
  `structuredLlmCall` where it is a single-shot extraction, a session on every LLM call.

**Non-Goals:**

- Scoring claim soundness numerically, or deriving survival from a numeric threshold.
- A gate that decides whether a claim is "established". One axis, one mechanism.
- Re-deriving or restating an existing dossier section as a second evidence path.
- Deciding disposition. The executive recommendation remains Phase 5's job; the investigation is an
  input to it, not a replacement for it.

## Decisions

### Where the phase sits, and why the corroboration fold moves

The phase runs after Phase-4 assembly and before Phase-5 synthesis, over the corroborated organ claims.
Its input is therefore the corroboration record, which is itself derived from Phase-1 collectors plus
the per-organ FDA label signals segmented at the `ta-approval-precedents` step — a step that runs after
Phase 4. The fold is consequently lifted out of `phase5Persist` into its own durable step,
`ta-safety-corroboration`, placed immediately after the precedent step. The investigation reads that
record; the stamped dossier handed to Phase-5 synthesis carries both it and the investigation section,
so the synthesis prompts see the verdicts.

Alternative considered: leave the fold in `phase5Persist` and have the investigation compute its own
copy. Rejected — the fold is pure, so two calls agree today, but two call sites of a fold whose inputs
are assembled in two places is exactly how they stop agreeing.

### Step structure, and which steps are agents

| Step | Form | Why |
|-|-|-|
| Propose mechanism | single-shot `structuredLlmCall` | The instruction is "explain this organ liability *from the evidence in hand*". The evidence is already in the prompt; a tool loop would have nothing to fetch, and a retrieval surface here is an invitation to ground the mechanism in something the dossier never collected. |
| Adversarial critique | `runToTerminal` over `runAgent`, with tools | Disconfirmation is a search task. The dossier is assembled to state what the run found, not to refute it, so a critic confined to it can only object that the evidence is thin — which is the rubber stamp this step exists to avoid. The critic gets the literature tool and a terminal `record_critique` tool built with `defineTool`, and communicates its outcome exclusively through that tool. |
| Re-verify | single-shot `structuredLlmCall` | Given the proposal and the objection, both already in the prompt, the verdict is an extraction over supplied text. Nothing to retrieve. |
| Completeness pass | deterministic, no LLM | What was not investigated is known exactly: the candidates the claim budget cut, the organs the rollup carries that corroboration never reached, and the claims whose own investigation failed. Asking a model to report our own bookkeeping would make the one honest part of the phase the guessable part. |

The critic follows the loop-driving-agent pattern already used by `generate_plan`: outcome written into
a closure cell by a terminal tool, `resolved` checked by the loop, and one salvage continuation
(`runToTerminal`) when the first run stops without submitting. Its `runStep` is the injected seam, so
the investigation module imports no DBOS; the workflow body passes `durableStep`, and a step-name
formatter namespaces the loop's `llm-*` / `tool-*` cache keys per organ and round so parallel claims
and successive rounds cannot collide in the step cache.

### Convergence

One loop per claim, `round = 1 … roundBound`. Each round proposes, critiques, and re-verifies. It stops
when:

- the verdict is terminal (`upheld` or `overturned`) — nothing further to settle;
- the verdict repeats the previous round's — the argument has stopped moving;
- `roundBound` rounds have run — the bound.

`roundBound` defaults to 2 and is configuration, not a constant asserted as truth: the embedder may set
it, and the value in force is written into the section so a reader knows how hard the claim was pushed.
Likewise `claimBudget` (default 6 claims per run) and the critic's iteration budget.

Nothing numeric decides survival. The verdict is a four-state vocabulary the re-verification step
states in words — `upheld`, `weakened`, `overturned`, `undetermined` — and `undetermined` is a real
outcome, not a failure.

### The claim contract at the model boundary

Each LLM step returns a *model-facing* support shape structurally identical to `ClaimSupport` but with
no locator refinement, and the phase resolves it at its own boundary: evidence items carrying no
pmid / doi / accession / regulatory reference are dropped, and a scored claim left with nothing becomes
`unknown` with a reason naming what happened. So a fabricated bare-source citation degrades to an
honest `unknown` instead of failing the whole dossier's schema validation minutes later.

The prompts say, in their own words, that `unknown` costs nothing. This is load-bearing: a contract that
is harder to satisfy honestly than dishonestly is a contract that manufactures citations.

### Section shape and coverage

`claim_investigation` is a top-level coverage-enveloped section whose `data` holds the investigated
rows, the completeness list, and the two bounds in force. It reports:

- `not_loaded` — the phase could not run (no corroboration record was assembled).
- `queried_no_data` — the phase ran and there was no corroborated claim to interrogate.
- `available` — the phase ran over at least one candidate claim. `dropped_count` reports candidates the
  claim budget discarded.

`available` with an empty `rows` array is deliberate and is not an overstatement: the completeness list
is part of this section's data, and it names every candidate and the reason it produced no row. Routing
that case to `filtered` would drop the completeness account, which is the one thing the case needs to
carry.

Each row's own `support` backs its **verdict**; the mechanism and the objection are nested claims
carrying their own support. Two supports on one row would be ambiguous; nesting says which claim each
one is for.

### Critique deduplication

Critiques are deduplicated by organ, and only by organ: a row carries at most one objection, the last
round's. A later round's critique replaces the earlier one it was written in response to, and the round
count tells the reader how many passes it took.

### Explicitly not carried over

- **No numeric claim-soundness score.** Survival is not a number crossing a line.
- **No layered "established" gate.** The verdict vocabulary is the only thing policing this axis.
- **No mechanism-keyed critic deduplication.** Organ only.
- **No "scored with a note".** A claim that cannot be evidenced is `unknown` with a reason; there is no
  third shape carrying a caveat where evidence belongs.
- **No unratified thresholds.** Both bounds are named configuration with stated defaults, and the value
  in force is reported in the section.

### The clinical-consequence annotator seam — wired, not deleted

`ClinicalConsequenceAnnotatorDeps` is threaded through `assembleDossier` into `annotateOffTargetPanel`
and supplied by nothing, so `annotateClinicalConsequence` returns null on every cache miss. Since only
the LLM path writes that cache, the cache is never populated: the annotator, its prompt, its schema and
its host-concurrency budget are all unreachable.

It is wired. Every collaborator it needs is already constructed in the workflow body — chat provider,
model, usage recorder, session builder — so "delete the dead parameter" would in practice mean deleting
a complete working capability, not a stub. Phase 4 remains one durable step, so the annotation pass is
replay-cached with the rest of assembly; per-row failures stay swallowed, because an unannotated row is
the documented fallback.

## Risks / Trade-offs

- **A critic with a retrieval tool can wander** → its iteration budget is configuration with a small
  default, it is driven to a terminal tool rather than to prose, and a run that never reaches that tool
  makes the claim `investigation_unavailable` instead of yielding a fabricated objection.
- **Per-claim LLM cost scales with the claim budget** → the budget is the bound, defaults to a handful
  of claims, and the claims it cuts are named in the completeness list rather than dropped silently.
- **Adding a required top-level dossier key breaks any producer that does not emit it** → there is one
  producer (`assembleDossier`), and it emits the section as `not_loaded` for the investigation phase to
  replace. There is no version ladder, so this is the intended shape of a dossier change.
- **A model asked to argue against a claim will sometimes argue badly** → a bad objection lands as a
  claim with `unknown` support and a stated reason, which a reader can see and discount; it does not
  silently delete the liability, because nothing in this phase removes a corroborated organ from the
  dossier.
- **Moving the corroboration fold changes when it runs relative to a resumed workflow** → it moves to
  its own named durable step, so a replay reads it from the step cache exactly as before.

## Open Questions

None outstanding.
