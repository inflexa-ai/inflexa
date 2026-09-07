# Knowledge plane: the Phase 0 work plan

This document holds the work plan of the Phase 0 review. Read
`knowledge-plane-phase-zero-review.md` first, because that document holds the
requirement. This document holds the units of work, the shared contracts, and
the state of each unit.

## Where this plan comes from

Two agent workflows made this plan on 2026-09-07:

1. Eight agents read the code behind the technical findings 1 to 6 and 10, and
   the execution path of the harness. Each agent reported the current behavior,
   the change points, and the risks, with a reference to a file and a line.
2. One agent turned the eight maps into 25 units of work. It ordered the units
   by dependency and put them into the groups G0 to G6. Two units in one group
   never change the same file.

Then one agent did each unit, and one agent verified each group. The user chose
the work items W02, W03, W07, and W08. The user did not choose the comparison
against a competing product.

Obey these limits when you read the plan:

- An agent wrote the unit text and the contracts. No person reviewed each line.
- The plan states the code as it was at commit `84a928ad`. The code moved after
  that commit. Thus read the code for a fact, and read the plan for a name, a
  shape, or a decision.
- The plan holds the acceptance of each unit. The acceptance of the review is
  the authority above it.

## The state of the work

The five commits below hold the units U01 to U24:

```
360c7aad feat(knowledge): assemble one consistent procedure, and complete the Salmon path
4f65964e feat(harness): mirror the situation, check, and step fields of the review
9e8d8a12 feat(knowledge): score claims, outputs, and judgments the way the review asks
670ab6aa feat(knowledge): run one analysis end to end from the evaluator
f7c414af feat: bind the plan settings to the template, and return only the used claims
```

| Unit | Item | Group | Title | State |
| --- | --- | --- | --- | --- |
| U01 | W02 | G0 | Schema and model fields for findings 1, 3, and 4 | Done. Commit 360c7aad. |
| U02 | W02 | G0 | Salmon and isoform-switch fixtures in the simulator | Done. Commit 360c7aad. |
| U03 | W02 | G0 | Stage tximport in the package store | Done. Commit 360c7aad. |
| U04 | W08 | G0 | Campaign manifest and the judge record | Done. Commit 9e8d8a12. |
| U05 | W07 | G0 | Input staging for a headless attempt | Done. Commit 670ab6aa. |
| U06 | W07 | G0 | Eval composition root, recording provider, and usage sink | Done. Commit 670ab6aa. |
| U07 | W02 | G1 | Method scope, parameter conflicts, and two-pass assembly in the engine | Done. Commit 360c7aad. |
| U08 | W02 | G1 | Rule corpus for one consistent procedure | Done. Commit 360c7aad. |
| U09 | W02 | G1 | Import branch of tpl-deseq2-two-group 1.1.0 | Done. Commit 360c7aad. |
| U10 | W08 | G1 | Run record with tool responses, seed, and the manifest gate | Done. Commit 9e8d8a12. |
| U11 | W02 | G2 | Check refuses dropped steps, matches by method id, and reports not_assessed | Done. Commit 360c7aad. |
| U12 | W02 | G2 | Template manifests, substitute methods, and the tree gates for finding 3 | Done. Commit 360c7aad. |
| U13 | W08 | G2 | Scorer: claim applicability, unresolved versus fabricated, per-step pin | Done. Commit 9e8d8a12. |
| U14 | W08 | G2 | Executed-output score for simulated tasks | Done. Commit 9e8d8a12. |
| U15 | W08 | G2 | Calibration tooling for the report judge | Done. Commit 9e8d8a12. |
| U16 | W02 | G3 | Template eligibility, substitution, language limit, and package by language | Done. Commit 360c7aad. |
| U17 | W02 | G3 | Harness mirror of the situation, check, and step fields | Done. Commit 4f65964e. |
| U18 | W07 | G3 | Headless end-to-end runner on the simulated patterns | Done. Commit 670ab6aa. |
| U19 | W08 | G3 | Report: unknown variability, missing judgments, Holm, splits, and decisions | Done. Commit 9e8d8a12. |
| U20 | W02 | G4 | Import-state rules, the service default, template exclusions, and the eval tasks | Done and verified. Commit f7c414af. |
| U21 | W03 | G4 | Harness client contract operation | Done and verified. Commit f7c414af. |
| U22 | W03 | G4 | One representation for the planner, plan settings, and the skeleton | Done and verified. Commit f7c414af. |
| U23 | W03 | G5 | Service: referenced claims only, and the contract inputs and notes | Done and verified. Commit f7c414af. |
| U24 | W03 | G5 | Template tool binding and the durable binding input | Done and verified. Commit f7c414af. |
| U25 | W03 | G6 | Template contract in the step briefing and the seed | Done and verified. Commit after d6bff3c1. |


## The work that remains

Every unit is done and verified. A verifier passed U23, U24, and U25 together
on 2026-09-07. The live-run part of the U25 acceptance holds since the
campaign `u25-live-3`. The plan carries the template of each grounded step. Each
step agent renders its script through `knowledge_template`. The decision
record of the differential expression step lists `min_count` and `lfc_shrink`
under `bound_slots` with no override. Two fixes after the verifier pass made
that true. The planner restores a template that the model dropped from the
skeleton, and a plan setting binds only when its value fits the slot. The text
below describes U25 as it was before that verifier pass.

### The unit that remains: U25

U25 is the part that the technical finding 5 asks for. The host can read a
template contract, and it can refuse a slot change that no override declares.
But the step agent still does not see the slot list. Thus the agent guesses a
slot name, or it learns the name from a rejected call. U25 puts the contract
into the briefing of the step, and it binds the settings of the plan to the
render call.

The pieces that U25 needs are in the tree already:

- `client.contract(template)` reads `GET /v1/templates/{id}`, in
  `harness/src/tools/knowledge/client.ts`.
- `SandboxStepInput.templateBinding` carries the binding to the child step, in
  `harness/src/workflows/sandbox-step.ts`.
- `GroundingSchema.settings` carries the settings of the plan, in
  `harness/src/schemas/workflow-state.ts`.
- The fake client answers `contract` and records `calls.contract`, in
  `harness/src/tools/knowledge/__fixtures__/fake-client.ts`.

`composeStepSeed` in `harness/src/workflows/execute-analysis.ts` returns a
string today. U25 changes it to return the prompt and the binding.

### The verification that is absent

The units U23, U24, and U25 need one verifier pass together. A verifier reads
the acceptance of each unit, runs the typecheck of each subsystem, runs each
named test file, and confirms the acceptance. A verifier changes no file.

The state of U23 and U24 today:

- The knowledge typecheck passes, and the knowledge suite passes 189 tests.
- The harness typecheck passes, and `template-binding.test.ts` passes 12 tests.
- The corpus validation passes with 165 rules, 53 methods, and 40 templates.

## How to work a unit

Give these conventions to the agent that does the work:

- Go into the subsystem that you change, and read its `CLAUDE.md` first. The
  root `CLAUDE.md` applies to each document and each commit message.
- Change only the files of the unit, and a test file for them. If a file outside
  the unit must change, stop, and report the exact change as a blocker.
- Run only the test files that the unit names or that you changed. Never run the
  whole harness suite, because each run starts a Postgres container.
- Run the typecheck of the subsystem at the end. In knowledge, run
  `bun run validate` after a change to `kb/` or to the schema.
- In the harness, run `bun run format:file <path>` on each source file that you
  changed. Do not format a markdown file, a YAML file, or a spec file.
- Do not add a dependency. Do not make a README, an example, or a configuration
  file.
- The code is the authority for a fact. The contracts below are the authority
  for a name and for a shape.

## The units that are open

### U25 Template contract in the step briefing and the seed (carries harness tests)

Work item W03. It depends on U24.

Files:

```
- harness/src/prompts/briefing.ts
- harness/src/prompts/briefing.test.ts
- harness/src/workflows/execute-analysis.ts
- harness/src/workflows/step-seed.test.ts
- harness/src/workflows/execute-analysis.test.ts
- cli/src/modules/harness/run_deps.ts
- harness/openspec/changes/add-knowledge-plane-tools/specs/knowledge-plane-tools/spec.md
- harness/openspec/specs/sandbox-format-standards/spec.md
```

Steps:

```
1. briefing.ts: StepBriefing.template?: TemplateBrief; renderTemplateContract renders the section Template contract (one bullet per adaptable slot: name (type; required | default value [source]): description; permitted values; pattern), Inputs, Bound by the plan (name = value (source)), Unbound settings, and one rule line (send the bound values as they are or state an overrides entry with a reason); MAX_TEMPLATE_SLOTS 24 and a 160-character description clamp; empty string when absent; renderGrounding adds "Template contract: not retrieved (<reason>)" when the grounding names a template and the brief is absent.
2. execute-analysis.ts: ExecuteAnalysisDeps.knowledge?; composeStepSeed fetches client.contract(ref) when step.grounding.template is set and a client is bound, compares the served version with the ref version (a mismatch gives a caveat and no binding), projects the adaptable slots, intersects grounding.settings by slot name into bound (a setting that names a pinned slot with a different value becomes a pinned-conflict caveat; a setting naming no slot goes to unbound_settings), passes template into composeStepBriefing, and returns {prompt, templateBinding?} from the checkpointed runStep; buildChildInput threads templateBinding into SandboxStepInput. run_deps.ts buildExecuteAnalysisDeps passes knowledge when the composition holds it.
3. briefing.test.ts: adaptable slots only and alpha absent; enum, pattern, default with source, required-without-default rendered; inputs; bound settings with source; unbound named; empty when absent; size bound; replay byte-identical; the coverage guard handles grounding.settings as an array of objects. step-seed.test.ts: fake deps gain a fake knowledge client; a grounded step renders the section and returns a binding; no client -> no section; unavailable -> the not-retrieved line; a version mismatch -> caveat and no binding; byte-identical across two calls. execute-analysis.test.ts: templateBinding threads into childInputs.
4. spec.md: client seam has four operations; new requirements The step briefing carries the template contract and The plan settings bind to the render request with the scenarios of the shared contract; sandbox-format-standards spec lists the Template contract section among the seed sections with one scenario.
```

Tests:

```
- cd harness && bun test src/prompts/briefing.test.ts src/workflows/step-seed.test.ts src/workflows/execute-analysis.test.ts (harness test run)
- cd harness && bun run typecheck; cd cli && bun run typecheck
```

Acceptance:

```
composeStepBriefing of a grounded step with the fake contract contains every adaptable slot name with its permitted values and not the pinned alpha; a run with the knowledge client bound answers the first knowledge_template call of T1S2 with status ok and every slot named in grounding.settings shows source caller in decision_record.json with settings_overrides empty.
```

### U23 Service: referenced claims only, and the contract inputs and notes

Work item W03. It depends on U16, U20.

Files:

```
- knowledge/src/service/handlers.ts
- knowledge/src/service/api.ts
- knowledge/src/service/tree.test.ts
- knowledge/src/service/contract.test.ts
```

Steps:

```
1. handlers.ts recommend: referenced = union of procedure.steps[].rules, flags[].rule, alternatives[].rules, disputed.rule, plus the top-level flags; claims = applicable.filter(referenced).map(claimView) in match order; ClaimView shape unchanged.
2. handlers.ts templateContract: add inputs (template.inputs ?? []) and notes (applicability.notes); api.ts: TemplateContract gains inputs and notes; document RecommendResponse.claims as the referenced views with the full view at GET /v1/claims/{claim}.
3. tree.test.ts: for qc, differential_expression, enrichment, full_plan, and the no-replicates case assert new Set(claims.map(c => c.id)) equals new Set(procedure.flatMap(s => s.rules)) and the enrichment flag rule resolves in claims. contract.test.ts: templateContract of tpl-deseq2-two-group returns the adaptable flags, honors, inputs, and notes.
```

Tests:

```
- cd knowledge && bun test src/service && bun run typecheck && bun run build
```

Acceptance:

```
The scratch size probe prints claims returned == referenced (1 for qc, 2 for qc with low_depth_sample, 36 for full_plan, 19 for differential_expression) and the qc answer holds no method claim outside its procedure.
```

### U24 Template tool binding and the durable binding input (carries harness tests)

Work item W03. It depends on U21, U22.

Files:

```
- harness/src/tools/knowledge/template.ts
- harness/src/workflows/sandbox-step.ts
- harness/src/agents/sandbox/shared.ts
- cli/src/modules/harness/run_deps.ts
- harness/src/tools/knowledge/template-binding.test.ts
```

Steps:

```
1. sandbox-step.ts: SandboxStepInput.templateBinding? (shared contract), optional like dependsOn. shared.ts: SandboxStepCoords.templateBinding? and pass deps.step.templateBinding as binding into createKnowledgeTemplateTool. run_deps.ts buildStepAgent: templateBinding: ctx.input.templateBinding in step.
2. template.ts: KnowledgeTemplateDeps.binding?; input overrides?: [{slot, reason}]; execute refuses with match rejected and no service call when the requested template differs from binding.template or a model slot value differs from a bound value with no override naming the slot (the issue names the slot, the bound value, its source); merge {...binding.slots, ...slots} into the render request; write bound_slots and settings_overrides beside script_path in the decision record; return method and substitute_for from the render answer in template; description says the briefing lists the slots and the bound values.
3. template-binding.test.ts: bound slots ride into the render request without a model value; a differing value without override -> rejected, calls.render empty, no file written; an override with a reason renders and the record on disk holds settings_overrides; a differing template ref is refused; the schema accepts overrides; method and substitute_for reach the output.
```

Tests:

```
- cd harness && bun test src/tools/knowledge/template-binding.test.ts src/agents/sandbox/catalog.test.ts (harness test run)
- cd harness && bun run typecheck; cd cli && bun run typecheck
```

Acceptance:

```
createKnowledgeTemplateTool with binding.slots {lfc_shrink: apeglm} and model slots {lfc_shrink: ashr} and no overrides answers match rejected with calls.render.length 0; with an override it renders and records the change.
```
## The shared contracts

Each unit obeys these names and shapes.

```
- Situation.classifier?: boolean — schema, model.ts, harness situation.ts and client.ts; false is dropped by OPTIONAL_FLAGS; a rule tests classifier eq true.
- Situation.import_state?: "quantifications" | "estimated_counts_with_lengths" | "corrected_counts" | "integer_counts" | "unknown" (ImportStateEnum) — never required; the service sets unknown when data_state is counts and the field is absent; the harness sends it optional.
- Engine-derived condition field inferential_method (an M-id) — set by pass 2 of assembleProcedure, stripped from a caller situation in normalizeSituation, listed in SITUATION_FIELDS, never a Situation slot in LinkML or the harness.
- ParameterValue.methods?: string[] (M-ids) — a parameter applies only when the step selects a listed method; a parameter of a rule with action.method and no methods list is implicitly scoped to that method; a method-less rule with no list is generic.
- ProcedureStep.conflicts?: { parameter: string; entries: { rule: string; value: unknown }[] }[] — emitted at equal specificity and equal strength with different values; the parameter is omitted; the harness renders it as a caveat, never a constraint. A method tie stays the alternatives list.
- DraftedStep.method_id?: string (^M-\d{4}$) in knowledge api.ts, harness check tool schema, and harness client DraftedStep — exact match wins over the wording; an unknown id is a violation naming the id and the permitted ids.
- CheckResponse.not_assessed: { step_type: string; reason: "no_rule"; message: string }[] — ok stays violations.length == 0 && warnings.length == 0; the harness describeResult appends ", N not assessed".
- INFERENCE_ONLY_STEPS = {shrink_lfc, multiple_testing} and removingFlag(steps) exported from procedure.ts; a draft on such a step under a removing flag is a violation with the flag rule regardless of the stated outcome; the violation for a forbidden method with a stated outcome names the escape `method_id: <expected.method.id>`.
- resolveMethod returns undefined when the best score equals the second-best score.
- Template.applicability.honors?: ("pairing" | "blocking_factor" | "covariates" | "batch")[] — absent means the template is not subject to design requirements; [] means subject and honors none. Requirement mapping: paired true -> pairing; blocking_factor not null -> blocking_factor; covariates non-empty -> covariates; batch == known_balanced -> batch. Suspected batch is not a requirement.
- Template.substitute_for?: string (M-id) — required when a method lists a template whose method field differs; the engine then emits the substitute's method, label, and package on the step with substitution: { for: string; label: string; template: string }.
- ProcedureStep.limit?: { requested_language: "R" | "python"; reason: string; skipped: { template: string; missing: string[] }[] } — present when a preference was given and no template of that language holds; the step keeps the first template that holds.
- primaryPackage follows the language of the chosen template: python -> first package with track python; R -> first bioconductor or cran package; else packages[0].
- New method ids: M-0059 (decoupler ulm per-sample pathway scores with a two-sample t-test on the scores, substitute for M-0034) and M-0060 (pydeseq2 Wald contrasts per level with a Bonferroni-Holm minimum-p any-difference table, substitute for M-0002). New rule ids: R-0166 (independent_filtering conditioned on inferential_method, U08), R-0167 (estimated_counts_with_lengths), R-0168 (corrected_counts), R-0169 (warn report_missing_length_input) (U20).
- DecisionRecord.template and RenderResponse.template gain method: { id, label } and substitute_for?: { id, label }; TemplateContract gains honors?, substitute_for?, inputs: { name, path, description }[], notes?: string.
- tpl-deseq2-two-group@1.1.0 slots: import_state (string enum of the five ImportState values, adaptable, required), counts_path (required false), quant_dir, tx2gene_path, lengths_path (strings, adaptable), counts_from_abundance (enum no | lengthScaledTPM | scaledTPM, default no), length_offset (boolean, default true); outputs import_counts and import_lengths; summary.import = { state, mode, counts_from_abundance, length_offset, tx2gene: { path, sha256, n_transcripts, n_genes, n_unmapped }, files: [{ sample, path, sha256 }] }; template tests salmon-quant, isoform-switch, isoform-switch-naive with the expectation kind truth_switch_calls <results.csv> <op> <fraction>.
- model_design parameter values by import state: quantifications -> import = tximport_gene_level_avg_tx_length_offset, import_tool = tximport, tx2gene (required), counts_from_abundance = no (required); estimated_counts_with_lengths -> import = estimated_counts_with_avg_tx_length_offset, length_input (required); corrected_counts -> import = length_corrected_counts_no_offset, counts_from_abundance (required), length_offset = none; integer_counts or unknown with a quantifier -> warn flag outcome report_missing_length_input, import = gene_counts_without_length_offset, missing_input (required).
- Fixture files of the Salmon patterns: quant/<sample>/quant.sf (Name, Length, EffectiveLength, TPM, NumReads with fractional NumReads), tx2gene.csv (transcript, gene), transcripts.csv, counts.csv as the naive integer sum; truth.csv planted_set ISOFORM_SWITCH with de = 0 for 300 genes in isoform_switch_n6; sim.json n_transcripts, n_switch_genes.
- RecommendResponse.claims holds only the claim views of the rules the procedure references (union of procedure[].rules, flags[].rule, alternatives[].rules, disputed.rule, top-level flags), in match order, ClaimView shape unchanged; GET /v1/claims/{claim} is the on-demand detail.
- Harness knowledge_recommend model-facing output: { match, snapshot, situation, flags, dropped, uncovered, environment_source, plan_skeleton, claims } with no procedure; a skeleton step gains alternatives: { method, label, when, rules }[], disputed?: { rule, sides }, forbids: string[], environment (the central step's package and collection facts), and grounding.settings.
- GroundingSchema.settings?: { step: string; name: string; value: string | number | boolean | string[]; source?: string }[] in harness/src/schemas/workflow-state.ts and contracts/schemas/chat-parts.ts, filled by buildPlanSkeleton from procedure step parameters.
- KnowledgeClient.contract(template: string): Promise<TemplateContract | KnowledgeUnavailable | KnowledgeRejected> — GET /v1/templates/{id} with the bearer key; a 404 is rejected with field template; the fake client exposes contract, calls.contract, contractAnswer().
- SandboxStepInput.templateBinding?: { template: string; slots: Record<string, string | number | boolean | string[]>; sources: Record<string, string> }; SandboxStepCoords.templateBinding? mirrors it; KnowledgeTemplateDeps.binding? receives it; knowledge_template input overrides?: { slot: string; reason: string }[]; the decision record on disk gains bound_slots and settings_overrides: { slot, plan_value, new_value, reason }[] beside script_path.
- StepBriefing.template?: TemplateBrief = { ref, version_served, slots: adaptable-only projection, inputs, bound: { name, value, source }[], unbound_settings: string[] }; the seed section is titled Template contract; MAX_TEMPLATE_SLOTS = 24; when absent the Grounding section carries "Template contract: not retrieved (<reason>)".
- knowledge/eval/src/record.ts exports RunRecord (moved from run.ts and re-exported there as a type) with knowledgeCalls: KnowledgeCall[], toolCalls[].{ toolUseId, outcome, durationMs }, seed, split, connection: { provider, baseUrl, providerOrder, requestTimeoutMs }, manifest: { path, digest }, exploratory?: true; KnowledgeCall = { seq, op: "recommend" | "check" | "render", request, response, responseChars, elapsedMs } where response keeps for recommend { match, snapshot, situation, procedure[].{ step, method.id, template, rules, flags }, claims[].id, flags, dropped, uncovered }, for check { ok, snapshot, violations, warnings, not_assessed }, for render { snapshot, template, slots, decision_record, script_sha256 } and never the script body.
- FullRunRecord extends RunRecord with identity { campaign, arm, task, run, seed, models_by_role, snapshot_digest, image_digest, farm_lock_sha256, refs_receipt, harness_commit }, profile { status, durationMs, result }, plan { planId, outcome, clarifications[], plan }, run { runId, status, error, synthesis_status, steps[] { stepId, agent, status, durationMs, finishReason, hitMaxSteps, error, blockedReason }, artifacts[], environment_missing[] }, usage { byRole, byStep, total }, toolCallsByStep, knowledgeTemplateCalls[], failures[], timings, outputs { de_table, enrichment_table, figures[], synthesis, report_step_summary }, transcript_source.
- Result file name <task>.seed-<s>.run-<n>.json; an old <task>.run-<n>.json stays readable and scores its claims unresolved. Attempt directory of run-full: eval/results/<campaign>/<condition>--<model>/<task>.seed-<s>.run-<n>/ with record.json, calls.jsonl, usage.jsonl, events.jsonl, profile.json, plan.json, steps/<stepId>/transcript.jsonl, steps/<stepId>/files/, synthesis.json, workspace/; one Postgres database per campaign named eval_<campaign>; <campaign dir>/workspaces.json maps analysisId to workspace root.
- results/<campaign>/manifest.json = { campaign, frozen_at, task_set: { path, digest, ids, split: { development, held_out }, weights }, seeds: { development, held_out }, corpus: { date, digest, schema_version, tool_definition_hash }, runtime: { harness_commit, knowledge_commit, bun }, arms: [{ name, condition: with | without, role: economical | frontier, provider, model, baseUrl, providerOrder, requestTimeoutMs }], judge: { provider, model, tag, prompt_digest }, statistics: { margin: 5, alpha_one_sided: 0.025, contrasts: [[economical_with, frontier_without] (primary), [economical_with, economical_without], [frontier_with, frontier_without], [economical_with, frontier_with]], runs_per_task }, price_basis }; W01 fills the completion margin, tolerances, weights, and price basis.
- results/<campaign>/calibration.json = { campaign, judge, n, kappa_total, kappa_by_criterion, expert_agreement, threshold: 0.7, pass, double_scored_share }; kappa_total is quadratic-weighted on the 0-100 total in 5-point bins; a judge verdict file carries { judge, provider, prompt_digest, scores, rationale } and a failed call writes { failed, judge, prompt_digest }.
- DeterministicScore fields: method_steps, snapshot_pinned (every method step), snapshot_pinned_steps, grounded_applicable_steps, flagged_applicable_steps, inapplicable_steps, unresolved_steps, fabricated_steps, ungrounded_steps, grounding_share (applicable / method_steps), claims_applicable, claims_inapplicable, claims_unresolved, claims_fabricated, fabricated_references, resolution_snapshot_mismatch; applicability is response-level (claim id in claims[].id of a recorded recommend response with the record's digest).
- scoreOutputs result: { valid_completion, missing_outputs, de_recall, de_fdr, failed_steps, total_ms, tokens_per_completed_step, report_present }; the DE table is found by the columns gene, log2_fold_change, adjusted_pvalue.
- report.json contrast: { family, arms: [a, b], primary, n_pairs, n_missing, diff, lower, upper, p_one_sided, holm_adjusted_p, rejected, decision: non_inferior | not_shown | blocked_missing_judgments | uncalibrated }; arm summary gains judged_runs, unjudged_runs, usage_missing_runs, variability: unknown | estimated, rubric_sd_within_task nullable, split, seed; the cluster of a simulated task is task.pattern.
- Clarification policy of run-full: one round; the answer is always "The sample table holds every known fact; state your assumption and continue", logged with its cost; a second clarification is the terminal outcome clarification_needed.
```

## The decisions

The plan took these decisions for the user, with the reason inside each line.

```
- Two-pass assembly with the engine-derived condition field inferential_method, not a depends_on_step schema: it reuses conditions.ts and the specificity count, so a dependent rule wins its step without a new operator.
- A parameter of a rule that names action.method is implicitly scoped to that method; the explicit methods list serves only method-less rules. This removes the foreign defaults of the three probes without touching R-0001, R-0002, R-0026, R-0154, R-0126, R-0095, R-0096.
- conflicts covers parameters only; a method tie at equal specificity stays the alternatives list, because the review asks for a conflict record on requirements, not on the method choice.
- classifier is a boolean Situation field, not a new question kind: a question kind would touch centralStep, question_steps, QuestionEnum, and the harness enum for one rule.
- shrink_lfc and the report columns on the edgeR QL and limma-voom paths stay uncovered (reported, not filled); the counterpart rules are curation the review does not name.
- ok keeps the meaning no violation and no warning; not_assessed is a separate list so a step the rules cannot cover never asks the planner for a revision it cannot satisfy.
- A draft on a dropped inference-only step fails regardless of a stated outcome: a shrinkage or an adjustment without a test has no meaning.
- An unknown method_id is a violation that names the permitted ids, not a 400, so the planner sees the escape inside the same tool answer.
- A tie in resolveMethod is unresolved: the token score cannot establish identity, as the review states.
- A declared substitute becomes the method of the step (with substitution.for) and the spec sentence is revised; keeping it as an alternative would leave the skeleton naming an R procedure for a Python request.
- A known_balanced batch counts as a design requirement; a suspected batch does not (tpl-deseq2-sva declares honors [] and stays selected by its own condition).
- pairing is declared only where a slot names a block, pair, or subject term (blocking_column, subject_column, or a design slot whose text names a block); a design slot that names only a batch or a covariate declares [blocking_factor, covariates, batch].
- honors absent means not subject to design requirements; [] means subject and honors none, so QC, ORA, and annotation templates stay eligible for a paired design without a declaration.
- import_state is optional and the service defaults it to unknown when data_state is counts; a required field would turn every existing caller into a 400, and unknown is the explicit state the review asks for (a quantifier name alone establishes nothing).
- The import path lives inside tpl-deseq2-two-group@1.1.0 rather than in a separate tximport template, because the skeleton grounds one template per step and a second template would not reach the step agent.
- The edgeR, limma-voom, and pydeseq2 count templates are excluded from the quantification states by condition instead of gaining an import branch; a python preference on a quantification state falls back to the R template with a limit.
- tximport enters through a manifest entry (the catalog) plus inflexa store add on this machine; the lock files come from the build workflow as images/README.md states.
- The template contract is fetched and bound in the parent composeStepSeed and rides the durable SandboxStepInput, so the seed and the binding are checkpointed and replay-stable; the child fetches nothing.
- The settings ride on grounding.settings written by the planner from the skeleton; the harness persists no recommend answer, so re-deriving them host-side would need a new store.
- A model slot value that differs from a bound value without an override is refused host-side before the service call: deterministic, no round trip, and the decision record keeps the audit line.
- The model-facing recommend output drops procedure and keeps the name plan_skeleton; the skeleton gains alternatives, disputed, forbids, and environment so nothing substantive is lost.
- The concise ClaimView keeps its shape; only the filter to referenced claims is applied, and responseChars is recorded per call so the before-and-after measurement can be taken on the next campaign.
- The eval is a second embedder that composes bootHarness directly and duplicates buildStepAgent from the CLI; lifting it into the harness is deferred.
- run-full drives the planner tool directly (no conversation agent): profiling, planning, sandbox steps, and the synthesis run inside the measured boundary, which is what W07 names.
- The fixed catalog farm is bound and a plan package absent from it is recorded as environment_missing rather than linked, because extendAnalysisFarm needs the CLI store composition.
- Step transcripts are exported from dbos.operation_outputs and marked as such; a harness seam for transcripts is deferred.
- The embedding provider is the harness createEmbeddingProvider over the configured endpoint, not a fake, so workspace_search behaves as in the product.
- One Postgres database per campaign, because DBOS owns the dbos schema of the database it launches in.
- Claim applicability is scored at the response level (the claim was returned for the run's situation on the exact digest); a per-step check against the skeleton group mapping is deferred.
- The cluster of a simulated task is its pattern, derived in the report; the development and held-out split lives in the manifest, not in tasks.yaml.
- The primary family is the four contrasts of the shared contract with the economical-with versus frontier-without contrast first, one-sided alpha 0.025, Holm step-down.
- Kappa acceptance rests on the 0-100 total in 5-point bins against both experts; per-criterion kappa is reported.
- The judge is frozen by model and prompt digest; a changed CRITERIA text invalidates the verdicts of the manifest.
- A recorded render response keeps the script sha256, the slots, and the decision record, never the script body.
- A failed judge call leaves a failed file that the report counts as an absent judgment and the judge retries; a verdict file is skipped only when it parses.
- Records without knowledgeCalls score unresolved, never fabricated, so the four-models campaign stays readable.
```

## Out of scope

The plan does not cover these items.

```
- Airway inputs, the airway Salmon variant, and the profile-vocabulary entry for a quantification set (W06); W07 validates on two-group-n6-enrich and the simulated patterns.
- Expert scoring and the calibration itself; W08 delivers calibrate.ts and the report gate, and every contrast reads uncalibrated until calibration.json exists.
- The before-and-after token and plan-quality campaign for finding 6; the tooling records responseChars per call.
- A conversation-agent driver for run-full (headless runChatTurn).
- Adding enrichment to INFERENTIAL_STEPS (an inferential fgsea draft at n = 1 still returns ok); outside the three drafts of finding 2.
- Counterpart rules for the edgeR QL and limma-voom paths (shrink_lfc, report columns, rank metric, fit diagnostics) and the R-0027 TMM parameter.
- tximport branches (lengthScaledTPM, catchSalmon) in the edgeR and limma-voom templates, and a Python template for the quantification states.
- Per-gene lengths for goseq from the per-sample import lengths.
- Per-task clarification answers (tasks.yaml answers) and task-declared real datasets; the default policy serves the simulated tasks.
- Lifting buildStepAgent and runChatTurn into harness exports; a harness seam that persists step transcripts.
- A batch form of GET /v1/claims.
- Step-level claim applicability against the skeleton group mapping.
- Findings 7, 8, 9 (W04) and 11 (W05): snapshot pin, script records with later edits, data minimization, release gates; the records store the digests only.
- W01 thresholds: completion margin, scientific tolerances, task weights, price basis; the manifest holds the fields.
- A model.test.ts for the LinkML and Zod mirror.
- Deprecation or removal of M-0016 (tximport as a method).
- Running any paid campaign.
```

## The units that are done

This record holds the acceptance of each unit that is complete.

### U01 Schema and model fields for findings 1, 3, and 4

```
Item: W02
Files: inflexa/knowledge/schema/inflexa-knowledge.yaml, inflexa/knowledge/src/model.ts, inflexa/knowledge/src/build/validate.ts
Acceptance: validate, validate:linkml, typecheck, and bun test pass on the unchanged kb with the new slots present in both the LinkML file and model.ts.
```

### U02 Salmon and isoform-switch fixtures in the simulator

```
Item: W02
Files: inflexa/knowledge/eval/src/simulate.R, inflexa/knowledge/eval/src/simulate.ts, inflexa/knowledge/src/build/template-tests.ts
Acceptance: The Salmon fixture holds fractional NumReads per sample with a tx2gene map, the isoform fixture marks 300 switch genes as non-DE truth, and both seed directories exist.
```

### U03 Stage tximport in the package store

```
Item: W02
Files: inflexa/images/package-store/manifest.yaml
Acceptance: The manifest entry validates against manifest.schema.json in the build, and the local catalog farm lock names tximport so U09's template test can run.
```

### U04 Campaign manifest and the judge record

```
Item: W08
Files: inflexa/knowledge/eval/src/freeze.ts, inflexa/knowledge/eval/src/freeze.test.ts, inflexa/knowledge/eval/src/judge.ts, inflexa/knowledge/package.json
Acceptance: freeze.ts writes results/<campaign>/manifest.json with the served snapshot identity and refuses a second write; judge.ts records the judge identity in every verdict and leaves a failed file for a failed call.
```

### U05 Input staging for a headless attempt

```
Item: W07
Files: inflexa/knowledge/eval/src/stage.ts, inflexa/knowledge/eval/src/stage.test.ts
Acceptance: A staged workspace holds only the inputs of the task under data/inputs/local with a manifest the harness data profile accepts.
```

### U06 Eval composition root, recording provider, and usage sink

```
Item: W07
Files: inflexa/knowledge/eval/src/compose.ts, inflexa/knowledge/eval/src/record-provider.ts, inflexa/knowledge/eval/src/usage-sink.ts, inflexa/knowledge/eval/src/usage-sink.test.ts
Acceptance: composeEvalRuntime typechecks against the harness exports and returns a booted runtime whose providers and usage recorder write to the attempt directory.
```

### U07 Method scope, parameter conflicts, and two-pass assembly in the engine

```
Item: W02
Files: inflexa/knowledge/src/engine/procedure.ts, inflexa/knowledge/src/engine/engine.test.ts, inflexa/knowledge/src/service/handlers.ts
Acceptance: The engine cases pass: foreign parameters drop, a tie returns conflicts naming both claims with no merged value, and a dependent rule fires only in pass 2.
```

### U08 Rule corpus for one consistent procedure

```
Item: W02
Files: inflexa/knowledge/kb/rules/R-0155.yaml, inflexa/knowledge/kb/rules/R-0009.yaml, inflexa/knowledge/kb/rules/R-0040.yaml, inflexa/knowledge/kb/rules/R-0010.yaml, inflexa/knowledge/kb/rules/R-0166.yaml, inflexa/knowledge/kb/rules/R-0029.yaml, inflexa/knowledge/kb/rules/R-0036.yaml, inflexa/knowledge/kb/rules/R-0038.yaml, inflexa/knowledge/kb/rules/R-0039.yaml, inflexa/knowledge/kb/rules/R-0085.yaml, inflexa/knowledge/kb/rules/R-0087.yaml, inflexa/knowledge/kb/rules/R-0099.yaml, inflexa/knowledge/kb/rules/R-0107.yaml, inflexa/knowledge/kb/rules/R-0045.yaml, inflexa/knowledge/src/build/validate.ts, inflexa/knowledge/src/service/tree.test.ts
Acceptance: The three review probes (2 vs 2, four time points, signature scores) each return one method with no foreign parameter, and the classifier case returns M-0055 with its parameters.
```

### U09 Import branch of tpl-deseq2-two-group 1.1.0

```
Item: W02
Files: inflexa/knowledge/kb/templates/tpl-deseq2-two-group/template.yaml, inflexa/knowledge/kb/templates/tpl-deseq2-two-group/body.R
Acceptance: The Salmon fixture with fractional estimates reaches DESeq2 through tximport with the mapping and mode in the summary, and the isoform fixture detects the lost correction (naive >= 0.5 switch calls, offset path <= 0.05).
```

### U10 Run record with tool responses, seed, and the manifest gate

```
Item: W08
Files: inflexa/knowledge/eval/src/record.ts, inflexa/knowledge/eval/src/record-client.ts, inflexa/knowledge/eval/src/run.ts, inflexa/knowledge/eval/src/record-client.test.ts
Acceptance: A planner run writes a record whose knowledgeCalls hold the recommend response (claims ids, procedure rules, flags, situation, snapshot) and whose tool calls carry outcomes; a lane outside the manifest is refused without --exploratory.
```

### U11 Check refuses dropped steps, matches by method id, and reports not_assessed

```
Item: W02
Files: inflexa/knowledge/src/engine/check.ts, inflexa/knowledge/src/engine/procedure.ts, inflexa/knowledge/src/service/api.ts, inflexa/knowledge/src/service/handlers.ts, inflexa/knowledge/src/engine/engine.test.ts, inflexa/knowledge/src/service/tree.test.ts
Acceptance: The three drafts of the review fail with R-0003, a descriptive draft passes by exact id or by an unresolved wording that states the outcome, and an uncovered step returns not_assessed instead of ok.
```

### U12 Template manifests, substitute methods, and the tree gates for finding 3

```
Item: W02
Files: inflexa/knowledge/kb/methods/M-0059.yaml, inflexa/knowledge/kb/methods/M-0060.yaml, inflexa/knowledge/kb/templates/tpl-decoupler-scores/template.yaml, inflexa/knowledge/kb/templates/tpl-pydeseq2-multigroup/template.yaml, inflexa/knowledge/kb/templates/*/template.yaml (honors declarations on every template whose step_types hold a group test), inflexa/knowledge/src/build/validate.ts, inflexa/knowledge/CLAUDE.md
Acceptance: validate passes with every group-test template carrying honors and both substitutes bound to their own method with substitute_for.
```

### U13 Scorer: claim applicability, unresolved versus fabricated, per-step pin

```
Item: W08
Files: inflexa/knowledge/eval/src/score.ts, inflexa/knowledge/eval/src/score.test.ts
Acceptance: The synthetic record of the review (one flagged step with [] claims, one step with R-9999@0000) scores grounding_share 0, claims_fabricated 1 with the service on the same digest, and claims_unresolved 1 when the service is down or serves another digest.
```

### U14 Executed-output score for simulated tasks

```
Item: W08
Files: inflexa/knowledge/eval/src/score-outputs.ts, inflexa/knowledge/eval/src/score-outputs.test.ts
Acceptance: An incomplete run or a run without its required tables scores valid_completion false regardless of its prose; a complete simulated run yields recall and FDR against truth.csv.
```

### U15 Calibration tooling for the report judge

```
Item: W08
Files: inflexa/knowledge/eval/src/calibrate.ts, inflexa/knowledge/eval/src/calibrate.test.ts, inflexa/knowledge/package.json
Acceptance: Two identical sheets give kappa_total 1.0 and pass true; the exported packets carry no arm, model, or grounding text.
```

### U16 Template eligibility, substitution, language limit, and package by language

```
Item: W02
Files: inflexa/knowledge/src/engine/procedure.ts, inflexa/knowledge/src/engine/check.ts, inflexa/knowledge/src/service/handlers.ts, inflexa/knowledge/src/service/api.ts, inflexa/knowledge/src/engine/engine.test.ts, inflexa/knowledge/src/service/tree.test.ts
Acceptance: The paired probe cannot select tpl-decoupler-scores, and for the substitute cases the recommendation, template, package list, and decision record name the same procedure.
```

### U17 Harness mirror of the situation, check, and step fields (carries harness tests)

```
Item: W02
Files: inflexa/harness/src/tools/knowledge/situation.ts, inflexa/harness/src/tools/knowledge/client.ts, inflexa/harness/src/tools/knowledge/check.ts, inflexa/harness/src/tools/knowledge/skeleton.ts, inflexa/harness/src/tools/knowledge/recommend.ts, inflexa/harness/src/tools/knowledge/__fixtures__/fake-client.ts, inflexa/harness/src/tools/knowledge/knowledge-tools.test.ts, inflexa/harness/src/tools/knowledge/client.test.ts, inflexa/harness/openspec/changes/add-knowledge-plane-tools/specs/knowledge-plane-tools/spec.md
Acceptance: The harness parses and renders every new wire field of findings 1-4 from the fake client, sends method_id to the service, and the spec states the revised preference rule.
```

### U18 Headless end-to-end runner on the simulated patterns

```
Item: W07
Files: inflexa/knowledge/eval/src/run-full.ts, inflexa/knowledge/eval/src/clarification.ts, inflexa/knowledge/eval/src/clarification.test.ts, inflexa/knowledge/package.json, inflexa/knowledge/CLAUDE.md
Acceptance: With Postgres, the engine and image, the store with tximport, the refs, the knowledge service, and cliproxy up: `bun eval/src/run-full.ts --campaign e2e-smoke --condition with --model <model> --provider cliproxy --tasks two-group-n6-enrich --runs 1 --pg-url postgres://inflexa:inflexa@127.0.0.1:8432/eval_e2e_smoke` gives record.json with profile.status completed, plan.outcome plan_submitted, run.status completed, run.synthesis_status produced, usage.byRole keys including data-profiler, planner, bulk-transcriptomics-agent, enrichment-agent, file-metadata-describer, step-summary-writer, run-synthesizer, non-null de_table and enrichment_table paths, figures > 0; no sandbox container remains; usage.jsonl, calls.jsonl, events.jsonl are non-empty.
```

### U19 Report: unknown variability, missing judgments, Holm, splits, and decisions

```
Item: W08
Files: inflexa/knowledge/eval/src/report.ts, inflexa/knowledge/eval/src/report.test.ts
Acceptance: `bun eval/src/report.ts --campaign four-models --judge-tag fable --exploratory` prints judged 44/46 for without--claude-opus-5, its contrast shows n_missing 2 and decision blocked_missing_judgments, every arm shows variability unknown, and every pre-change record shows claims_unresolved > 0 with claims_fabricated 0.
```

### U20 Import-state rules, the service default, template exclusions, and the eval tasks

```
Item: W02
Files: inflexa/knowledge/kb/rules/R-0018.yaml, inflexa/knowledge/kb/rules/R-0031.yaml, inflexa/knowledge/kb/rules/R-0065.yaml, inflexa/knowledge/kb/rules/R-0167.yaml, inflexa/knowledge/kb/rules/R-0168.yaml, inflexa/knowledge/kb/rules/R-0169.yaml, inflexa/knowledge/kb/templates/{tpl-pydeseq2-two-group,tpl-edger-ql,tpl-limma-voom-fixed,tpl-limma-voom-qw,tpl-deseq2-blocked,tpl-deseq2-interaction,tpl-deseq2-multigroup,tpl-deseq2-sva,tpl-deseq2-lrt-timecourse,tpl-dream-repeated,tpl-limma-voom-dupcor,tpl-pydeseq2-interaction,tpl-pydeseq2-multigroup}/template.yaml, inflexa/knowledge/src/build/validate.ts, inflexa/knowledge/src/service/handlers.ts, inflexa/knowledge/src/service/tree.test.ts, inflexa/knowledge/eval/src/tasks.ts, inflexa/knowledge/eval/tasks/tasks.yaml
Acceptance: A quantifications situation selects tpl-deseq2-two-group@1.1.0 with the tximport parameters and a required tx2gene; a Salmon count table of unknown state receives the missing-input warning instead of a tximport promise; no integer-CSV template applies to a quantification state.
```

### U21 Harness client contract operation (carries harness tests)

```
Item: W03
Files: inflexa/harness/src/tools/knowledge/client.ts, inflexa/harness/src/tools/knowledge/__fixtures__/fake-client.ts, inflexa/harness/src/tools/knowledge/client.test.ts
Acceptance: client.contract returns a typed contract from the stub, and the fake client exposes the same operation for the host and tool tests.
```

### U22 One representation for the planner, plan settings, and the skeleton (carries harness tests)

```
Item: W03
Files: inflexa/harness/src/tools/knowledge/skeleton.ts, inflexa/harness/src/tools/knowledge/recommend.ts, inflexa/harness/src/schemas/workflow-state.ts, inflexa/harness/src/contracts/schemas/chat-parts.ts, inflexa/harness/src/tools/knowledge/knowledge-tools.test.ts, inflexa/harness/openspec/changes/add-knowledge-plane-tools/specs/knowledge-plane-tools/spec.md
Acceptance: The planner receives one representation whose steps carry alternatives, disputed sides, forbids, environment, and settings, and the plan schema stores the settings.
```
