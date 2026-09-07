# Knowledge plane: Phase 0 review and completion plan

Review date: 2026-09-07. Base commit: `69bfbef81e09848a1eee0c18e115c653a790f390`.
This review includes the changes in the working tree and the available evaluation records.

## Revised assessment

Keep the typed service, declarative rules, SQLite snapshot, and template renderer.
Use these parts to reduce the cost of a correct analysis, not only to attach evidence.
Quality is the constraint. Cost is the primary objective. Speed is secondary.

The proposed success target is at least 5× lower cost at comparable or better quality. A 10× reduction is the stretch target.

The initial review identified contract defects, but did not make the economic proof a Phase 0 requirement.
This revision corrects that omission.
The original design accepts plan non-inferiority and measures cost without a target.
[Design:641](knowledge-plane-phase-zero.html#L641), [design:749](knowledge-plane-phase-zero.html#L749), [design:751](knowledge-plane-phase-zero.html#L751).

The present evidence does not establish the proposed target.
The manual comparison reports about one-sixth fewer output tokens in two steps, substantial additional scripts, and an incomplete with-tools run.
[PHASE0-REPORT.md:89](knowledge/eval/PHASE0-REPORT.md#L89), [PHASE0-REPORT.md:99](knowledge/eval/PHASE0-REPORT.md#L99), [PHASE0-REPORT.md:109](knowledge/eval/PHASE0-REPORT.md#L109).
Thus cheaper models and less model work must act together.

The requirements below are proposed amendments to the HTML design.
The HTML and implementation remain unchanged by this review revision.
The numbered technical findings remain evidence for the work list.

## Proposed changes to the Phase 0 specification

| Existing requirement | Revised requirement | Reason |
| --- | --- | --- |
| Plan quality establishes the proof. | Completed analyses must meet the scientific quality gate. | A correct plan can fail during execution. |
| Report time and tokens without a target. | Establish a cost ratio of at most 0.20 per valid completion. Report time separately. | The business depends on a material cost advantage. |
| Compare models inside Inflexa. | Keep that control. Also compare the complete product against a named competing workflow. | A frontier model inside Inflexa is not Claude Code. |
| Airway serves template tests only. | Make airway a mandatory end-to-end acceptance case. Keep separate held-out real studies. | Acceptance on real data and evidence of generalization are different requirements. |
| No prompt change, with spontaneous tool use as an exit gate. | Keep spontaneous use as a diagnostic. Permit a compact template contract in the step briefing. | A cheap model must receive the contract necessary for one valid call. |
| A fixed factorial campaign precedes the decision. | Use a development pilot to select the candidate and estimate variance. Freeze a separate confirmatory campaign. | Spend the evaluation budget on the principal quality and cost claims. |

The original scope remains bulk RNA-seq differential expression and enrichment, from counts or Salmon quantifications.
Read alignment remains outside Phase 0.
[Design:641](knowledge-plane-phase-zero.html#L641).
Do not expand the supported modalities to obtain a larger corpus.

## Work list in dependency order

All boxes describe work that remains. This revision completes none of the implementation or campaign tasks.

- [ ] **W01 — Freeze the scope and acceptance protocol.** Name the supported designs, required outputs, competing workflow, and cost basis. Set the scientific tolerances before candidate runs. Use the evaluation contract below. **Done:** each exit gate has a fixed measure and threshold.
- [ ] **W02 — Make the situation and procedure scientifically consistent.** Correct findings [1](#1-assemble-one-consistent-procedure)–[4](#4-complete-the-salmon-input-path). Validate design facts against the actual inputs. Preserve unknown facts instead of guesses. **Done:** supported cases give compatible methods, parameters, and templates. Negative cases cannot receive false success.
- [ ] **W03 — Reduce model work in each standard step.** Correct findings [5](#5-give-the-step-agent-the-template-contract-before-the-render-call) and [6](#6-return-only-evidence-that-the-procedure-uses). Reuse standard computed outputs across the template and report. Measure additional scripts and retries. **Done:** the agent can bind, execute, and interpret each supported template without a duplicate statistical fit.
- [ ] **W04 — Make each run stable and inspectable.** Correct findings [7](#7-make-the-snapshot-pin-effective-and-replay-stable)–[9](#9-apply-data-minimization-to-every-request). Pin the service release. Keep each script record with its later edits. Protect local identifiers. **Done:** a restart preserves the executed bytes and their evidence.
- [ ] **W05 — Establish the release gates.** Correct finding [11](#11-make-release-gates-establish-the-claimed-validation). Bind scientific review and template results to the candidate release and actual environment. **Done:** every advertised template branch has valid evidence or an explicit unsupported result.
- [ ] **W06 — Prepare real datasets and independent reference analyses.** Add airway acceptance inputs and the held-out studies below. Pin input checksums, sample metadata, identifier mappings, and gene sets. **Done:** the reference outputs and tolerances exist before model evaluation. The candidate cannot read them.
- [ ] **W07 — Extend the evaluator through the complete analysis.** Run input profiling, the planner, sandbox steps, and the final report. Record all model roles, tool responses, costs, failures, and artifacts. **Done:** airway reaches a terminal result automatically in each principal arm. No prepared plan or factual profile replaces these stages.
- [ ] **W08 — Correct the scorer and validate the judge.** Correct finding [10](#10-make-the-evaluation-support-the-intended-decision). Score actual outputs and claim applicability. Calibrate the report judge against experts. **Done:** an incorrect contrast, fabricated claim, or incomplete result cannot pass through good prose.
- [ ] **W09 — Run the development pilot.** Use airway and separate development simulations. Select one economical model configuration. Locate cost in the complete trace. **Done:** the candidate, budgets, repeat count, pricing basis, and confirmatory protocol are frozen. Held-out results do not influence selection.
- [ ] **W10 — Run the confirmatory evaluation and close Phase 0.** Execute the frozen candidate and baselines on the same held-out workload. Apply the exit gates below. **Done:** a reproducible report states pass, fail, or inconclusive for each gate. A negative result is not deferred to Phase 1.

W05 and W06 can proceed during W02–W04. W07 and W08 can proceed together.
W09 depends on the complete measurement path. W10 depends on every earlier item.
Paid campaigns and implementation changes are future work, not actions authorized by this document revision.

## End-to-end evaluation contract

### Boundary and fair comparison

Start with a biological question, actual input files, and their sample metadata.
End with the numerical results, requested figures, final report, and observed execution record.
For Salmon, start with quantification outputs, not raw reads.
Stage the same inputs and reference resources before each arm starts.
Include profiling and every subsequent model call in the measured cost.

The current runner supplies a profile from task facts and stops after plan retrieval.
It therefore bypasses both input interpretation and execution.
[run.ts:96](knowledge/eval/src/run.ts#L96), [tasks.ts:130](knowledge/eval/src/tasks.ts#L130), [run.ts:149](knowledge/eval/src/run.ts#L149).
Retain that runner for cheap development checks, but do not use its score as the end-to-end result.

Use equal input access, scientific requirements, compute resources, and tool permissions across comparable arms.
Record necessary differences between product interfaces.
Each arm must make its own plan and scripts through its normal workflow.
No arm receives a reference plan, expected answer, or manual repair.

Define a shared clarification policy for questions that a real user can answer from the supplied metadata.
Log such answers and their cost. Do not give an answer from the reference analysis.

### Real and simulated datasets

**Airway is mandatory.** Use the eight-sample dexamethasone subset of GSE52778: treated and untreated samples from four human airway smooth-muscle cell lines.
The package contains both the gene-count object and additional quantification-derived data.
Pin the exact object and package version to prevent accidental input changes.
[Airway experiment documentation](https://bioconductor.org/packages/release/data/experiment/vignettes/airway/inst/doc/airway.html).

The acceptance question asks for the dexamethasone effect with cell-line differences accounted for, followed by enrichment and a report.
The reference design is `~ cell + dex`, with the treated-versus-untreated contrast.
[Bioconductor RNA-seq workflow](https://bioconductor.org/packages/release/workflows/vignettes/rnaseqGene/inst/doc/rnaseqGene.html).
The model receives the experimental metadata, not that formula as an answer.

The airway acceptance gate must establish all of these conditions:

- Sample identifiers match between the counts and metadata. The analysis retains the four biological pairs.
- The executed model estimates the requested contrast with the correct direction and cell-line adjustment.
- The result contains every tested gene, effect estimates, p-values, and false discovery rate (FDR) values.
- Enrichment uses the declared identifiers, a pinned gene-set collection, and the correct tested universe or ranked input.
- The figures and report agree with the computed results. Interpretation respects the study design and its limitations.
- All required steps finish within the frozen resource limits, without manual repair. Claims and script hashes resolve to this run.

Prepare the reference independently of the knowledge templates.
Two scientific reviewers must agree on the reference analysis and permitted numerical differences.
Compare effects, ranks, and adjusted p-values on aligned gene identifiers.
Use set overlap as a supplementary measure, not the only measure.
Do not treat published gene totals or a familiar marker as biological ground truth.
Use predefined acceptance rules for scientifically valid alternatives, not exact equality with DESeq2 output.

Run a second airway acceptance variant from complete Salmon quantifications to exercise the other supported input boundary.
Do not use a two-sample demonstration as the eight-sample analysis.
The airway documentation distinguishes the two-sample quantification example from the complete experiment.
[Airway experiment documentation](https://bioconductor.org/packages/release/data/experiment/vignettes/airway/inst/doc/airway.html).
The two input variants have separate reference outputs and count as one biological study, not two independent studies.

**Keep airway outside the confirmatory generalization estimate.** It is a published tutorial and a development acceptance case.
Renamed samples do not make it held-out evidence.
[Bioconductor RNA-seq workflow](https://bioconductor.org/packages/release/workflows/vignettes/rnaseqGene/inst/doc/rnaseqGene.html).

Retain the original eight design patterns and two fresh simulations per pattern.
Use at least three additional, independent real studies, with paired, unpaired, and covariate-adjusted designs represented.
W06 must select their accessions and establish their references before the freeze.
These are coverage minima, not an assertion of sufficient statistical power.
Set the final study count from development variance and the agreed precision requirement.
Group multiple contrasts, input variants, and metadata perturbations from one study as one statistical cluster.

Include negative cases for absent replicates, confounded treatment, unknown pairing, and unsupported input states.
A correct warning, clarification, or descriptive result must match the task's expected outcome.
An unjustified refusal of an answerable task is a failure.
Use simulations for truth-based accuracy. Use real studies for reference agreement and scientific review.

### Candidate, controls, and competitor

The principal technical comparison is the frozen economical configuration with knowledge versus the frontier configuration without knowledge in the same harness.
The principal commercial comparison uses a named competing product, such as Claude Code, on the same workload.
Record the product version, model identifiers, settings, and available tools before the campaign.
Do not describe a same-harness model comparison as evidence against the competing product.

Use economical-without-knowledge and frontier-with-knowledge arms on a predefined diagnostic subset.
Use a template-disabled ablation on that subset to locate the savings.
These controls explain the mechanism at less cost than a full factorial campaign.
If a claim covers multiple economical models, obtain confirmatory evidence for each model.
Do not choose the best model after examination of the held-out results.

### Quality and cost measures

Score the executed results and report against the independent reference, not only the plan.
Separate scientific validity, valid completion, numerical agreement, and report quality.
W01 must set absolute result tolerances and the minimum valid-completion rate with the scientific reviewers.
Set a separate non-inferiority margin for the valid-completion rate.
An unset threshold blocks the campaign freeze.

Retain the original five-point non-inferiority margin only for the calibrated 0–100 rubric.
That margin does not permit a wrong contrast, unsupported inference, or missing required output.
Do not count citation presence as a substitute for scientific quality.
Use the original expert calibration target of weighted kappa at least 0.7, with 15% of runs double-scored.
[Design:774](knowledge-plane-phase-zero.html#L774).

For each arm, calculate:

`cost_per_valid_completion = total_cost_of_all_attempts / number_of_valid_completions`

`cost_ratio = candidate_cost_per_valid_completion / baseline_cost_per_valid_completion`

Include failed attempts, retries, and any stronger-model fallback in the numerator.
If there are no valid completions, report the cost as undefined and the arm as failed.
Evaluate expected-stop tasks separately so that cheap refusals cannot produce the commercial saving.
Freeze task weights before the campaign. Report real and simulated results separately as well as the combined workload.

The cost record must include:

- Provider usage for every model role, with input, output, reasoning, and cache categories as the provider bills them.
- A dated price basis and actual charges where available. Prevent double counting of cache tokens inside total input tokens.
- Sandbox, tool, and knowledge-service costs on the same allocation basis across arms.
- Amortized curation and maintenance costs under explicit volume assumptions, separate from marginal run cost.

Use total execution cost for the paired ratio, with every model call, tool, and runtime charge included.
Report customer charges and resource costs separately. Do not compare internal delivery cost with a competitor's retail price.
Show the effect of amortized curation on the candidate's economics at the declared volume.
A 10B-token projection is a scenario with explicit workload and price assumptions, not a measured campaign result.
Keep judge and benchmark-development expenditure separate from the product cost. Report that expenditure as the evaluation budget.
Measure elapsed time and peak resources as secondary results, subject to the operational limits fixed in W01.

### Campaign discipline and exit decision

Use at least three independent runs per task and principal arm, as in the original design.
Increase the study or repeat count when the development variance makes the intended conclusion unreliable.
Freeze that count before confirmatory runs.
Randomize arm order.
Isolate each workspace.

Record the cache policy. Do not warm one arm with answers from another.

Use paired confidence intervals with biological study as the cluster for real data.
Use simulation dataset as the cluster for simulated data.
Repeated runs and multiple contrasts do not increase the independent study count.
Retain the one-sided 97.5% confidence convention and adjust the declared primary contrasts for multiplicity.
[Design:767](knowledge-plane-phase-zero.html#L767), [design:781](knowledge-plane-phase-zero.html#L781).

| Gate | Evidence necessary for a pass |
| --- | --- |
| Supported execution | W02–W05 pass on the frozen release. Both airway input variants complete with the scientific conditions above. |
| Quality | Absolute scientific and completion thresholds pass. Completion is non-inferior within its declared margin. The adjusted rubric lower bound exceeds −5 points. Real-data results pass separately. |
| Safety of the method | No incorrect inferential success on the frozen negative cases. No wrong contrast or silently unsupported design in an accepted result. |
| Economic advantage | The adjusted upper confidence bound of the cost ratio is at most 0.20 against the named competitor. A bound at most 0.10 establishes the stretch target. |
| Grounding | At least 95% of method steps have applicable, returned claims in the exact snapshot. Fabricated references total zero. Every executed template has its script record. |
| Evidence completeness | Every scheduled attempt has a terminal outcome, usage record, and scoring disposition. The release and reference artifacts are reproducible. |

Apply the economic gate on one common cost basis, fixed in W01.
For a customer-price claim, include all customer fees. A resource-cost comparison alone does not establish a customer-price claim.
Unknown material charges block a positive economic conclusion.
Missing usage or absent judgments do not disappear from the denominator.
An unscorable required outcome blocks a positive conclusion until adjudication.

Phase 0 can close with a completed evaluation and a negative result.
It succeeds only when every success gate passes.
An inconclusive interval is not evidence of parity or a 5× saving.
An incomplete campaign does not satisfy the end-to-end exit requirement.

## Work that does not block this proof

Defer graph storage, new modalities, a general ontology reasoner, and offline snapshot distribution.
Keep the optional service boundary. Do not add a mandatory product-wide plan gate solely to make this benchmark pass.
A stable release identity and script records suffice for the proof. Full provenance vocabulary changes can remain in Phase 1.
Do not add automatic model routing unless the pilot demonstrates that it is necessary for the frozen cost-quality target.
Retain wider corpus content, but label capabilities outside the tested scope as unvalidated by this campaign.
Apply the technical remedies to the frozen scope.
An outside-scope rule blocks this proof only if it changes an in-scope result.
Preserve requested sensitivity analyses. Include their cost.

## Technical findings

### 1. Assemble one consistent procedure

The engine selects methods by specificity, but merges parameters from every applicable rule of the step.
It selects each step independently.
[procedure.ts:109](knowledge/src/engine/procedure.ts#L109), [procedure.ts:184](knowledge/src/engine/procedure.ts#L184), [procedure.ts:221](knowledge/src/engine/procedure.ts#L221).

Direct probes used human STAR counts, two groups, no batch, and no pairing, except where stated:

| Situation | Returned conflict | Cause |
| --- | --- | --- |
| Two replicates per group | edgeR quasi-likelihood with `test=Wald`. TMM with median-of-ratios parameters. | Defaults survive a method change. [R-0001:21](knowledge/kb/rules/R-0001.yaml#L21), [R-0026:17](knowledge/kb/rules/R-0026.yaml#L17). |
| Four time points | DESeq2 likelihood ratio test with `test=Wald`. | A broad rule contributes an incompatible parameter. [R-0001:11](knowledge/kb/rules/R-0001.yaml#L11). |
| Signature scores, six replicates | UCell with classifier parameters and required cross-validation preprocessing. | The classifier rule tests only the data state. [R-0155:18](knowledge/kb/rules/R-0155.yaml#L18). |

Give each method-specific parameter an explicit method scope.
Give each task-specific rule conditions that distinguish its task.
Select the inferential method before its normalization, shrinkage, and enrichment requirements.
If two applicable requirements conflict, return the conflict with both rule identifiers.
Do not ask the model to repair a procedure that the service calls deterministic.

Acceptance: each example returns one consistent method and parameter set.
A method change also changes its dependent requirements.

### 2. Prevent false success from the check

For a design with one sample per group, direct probes returned `ok: true` for all three drafts:

- An `apeglm` shrinkage step.
- A Benjamini-Hochberg multiple-testing step.
- A DESeq2 Wald step with `outcome: descriptive_only`.

The assembler drops the first two step types, and the checker skips a draft without an expected step.
The outcome field bypasses the method checks in the third case.
Thus a descriptive label can conceal an explicitly inferential method.
[procedure.ts:252](knowledge/src/engine/procedure.ts#L252), [check.ts:142](knowledge/src/engine/check.ts#L142), [check.ts:150](knowledge/src/engine/check.ts#L150), [check.ts:170](knowledge/src/engine/check.ts#L170).

Keep prohibitions after procedure assembly.
Before you accept an outcome, validate it against the actual method and parameters.
Use the method identifier from the recommendation for an exact match.
Retain an explicit unresolved result for free text, because the current token score does not establish method identity.
[check.ts:70](knowledge/src/engine/check.ts#L70).

Acceptance: the three drafts fail with the applicable rule.
A descriptive method passes.
An unsupported step returns `not_assessed`, not a successful scientific check.
This corrects the optional check without the deferred mandatory gate.

### 3. Preserve the method and design across languages

A direct probe requested Python pathway scores for paired samples with a balanced batch.
The answer named GSVA with limma, but selected `tpl-decoupler-scores`.
That template uses a different score and a two-sample t-test that ignores the pair and batch.
The template itself states this limitation.
[M-0034:2](knowledge/kb/methods/M-0034.yaml#L2), [template.yaml:13](knowledge/kb/templates/tpl-decoupler-scores/template.yaml#L13), [template.yaml:29](knowledge/kb/templates/tpl-decoupler-scores/template.yaml#L29).

The Python multigroup template also replaces the named likelihood ratio test with combined Wald p-values.
The script records the substitution after method selection.
[body.py:9](knowledge/kb/templates/tpl-pydeseq2-multigroup/body.py#L9).
The [PyDESeq2 0.5.4 API](https://pydeseq2.readthedocs.io/en/v0.5.4/api/docstrings/pydeseq2.ds.DeseqStats.html) documents the Wald procedure.

Give a statistical substitute its own method identity and eligibility conditions.
Expose the substitute before the planner chooses it.
Restrict a template that ignores pairs or covariates to designs without those requirements.
If the requested language cannot realize the selected method, report that limit explicitly.
A language preference must not silently change the scientific question.

Acceptance: the paired probe cannot select an unpaired test.
The recommendation, template, package list, and decision record name the same procedure.

### 4. Complete the Salmon input path

Salmon quantifications are explicitly in Phase 0 scope.
The rules request `tximport` with length offsets or abundance-derived counts.
But the selected two-group template accepts integer CSV counts and uses `DESeqDataSetFromMatrix` without length input.
[Design:641](knowledge-plane-phase-zero.html#L641), [R-0018:18](knowledge/kb/rules/R-0018.yaml#L18), [template.yaml:30](knowledge/kb/templates/tpl-deseq2-two-group/template.yaml#L30), [body.R:90](knowledge/kb/templates/tpl-deseq2-two-group/body.R#L90).

The missing input distinction changes the analysis.
The [tximport guide](https://bioconductor.org/packages/release/bioc/vignettes/tximport/inst/doc/tximport.html) specifies original counts with offsets or bias-corrected counts without offsets.
The guide gives a separate rule for 3-prime libraries.

Represent the import state explicitly: quantifications, original estimated counts with lengths, or counts after the permitted correction.
Supply a tested import-to-model path for the supported state.
Carry the transcript-to-gene mapping and correction mode into its record.
If the necessary input is absent, report the missing input.
A quantifier name alone does not establish that the correction occurred.

Acceptance: a Salmon fixture with fractional estimates reaches the model through the correct import path.
An isoform-change fixture detects loss of the length correction.

### 5. Give the step agent the template contract before the render call

The briefing gives a template identifier but no slot contract.
The tool accepts an arbitrary `slots` object.
The service exposes the contract through HTTP, but the harness client exposes no operation to retrieve it.
Thus the agent must guess slot names or learn them from rejected calls.
[briefing.ts:141](harness/src/prompts/briefing.ts#L141), [template.ts:80](harness/src/tools/knowledge/template.ts#L80), [server.ts:97](knowledge/src/service/server.ts#L97), [client.ts:163](harness/src/tools/knowledge/client.ts#L163).

Retrieve the selected contract in the host before step dispatch.
Give the agent only the adaptable slots, their types, defaults, permitted values, and input requirements.
Bind the scientific settings from the selected procedure to the render request.
Validate any change to those settings explicitly.
This removes discovery through errors and prevents template defaults from silently replacing plan decisions.

Acceptance: a model that does not know the template can make one valid render call from its briefing.
The rendered settings agree with the plan.

### 6. Return only evidence that the procedure uses

A direct QC-only probe returned 58 claims for a procedure that referenced one claim.
The concise response contained 80,802 JSON characters.
With only that claim, the response contained 2,248 characters and the same procedure.
These are character counts, not token estimates.

The handler returns every applicable claim, including claims for steps outside the requested procedure.
The harness then adds a skeleton beside the original procedure.
[handlers.ts:124](knowledge/src/service/handlers.ts#L124), [recommend.ts:59](harness/src/tools/knowledge/recommend.ts#L59).

Return the claims referenced by the selected steps, flags, alternatives, and disputes.
Keep the detailed evidence available on demand.
Give the planner one compact executable representation, with shared evidence referenced by identifier.
Preserve substantive caveats and alternatives.
Measure the response reduction before adding a cache or another retrieval layer.

Acceptance: a QC answer contains no unrelated method claims.
Measure tokens and plan quality on the same tasks before and after this reduction.

### 7. Make the snapshot pin effective and replay stable

The snapshot digest covers corpus records, but excludes the schema version and tool-definition hash.
The supposed tool hash covers `service/api.ts`, not the tool descriptions or imported schemas.
The loader trusts stored hashes.
The build can overwrite the same dated destination.
[store.ts:44](knowledge/src/store.ts#L44), [store.ts:62](knowledge/src/store.ts#L62), [store.ts:124](knowledge/src/store.ts#L124), [build-snapshot.ts:44](knowledge/src/build/build-snapshot.ts#L44), [build-snapshot.ts:58](knowledge/src/build/build-snapshot.ts#L58).

Neither check nor render sends the plan's expected digest.
The render call also runs outside the durable step that protects each file write.
After a restart, a fresh response can disagree with files from a cached write.
Code inspection identified this replay risk. This review did not reproduce a workflow restart.
[client.ts:224](harness/src/tools/knowledge/client.ts#L224), [template.ts:94](harness/src/tools/knowledge/template.ts#L94), [mutator.ts:216](harness/src/tools/workspace/mutator.ts#L216).

Make the release identity cover the corpus, schema, and engine/renderer version.
Record the actual tool-definition hash with the run.
Validate the artifact digest at load time.
Refuse an overwrite of a published artifact.
Make the expected digest mandatory on subsequent operations, with an explicit mismatch result.
Cache the render response in a durable step before either file write.

Acceptance: a service update cannot silently change an existing plan.
A replay uses the same response and records hashes of the same bytes.

### 8. Record the connection from claims to executed code

The decision record holds template citations, but no selected rule identifiers.
The renderer always sets `unvetted_edits` to an empty list.
The file-edit tool changes the script but does not update that record.
Every render in one step uses the same decision-record path, so a second template replaces the first record.
[api.ts:124](knowledge/src/service/api.ts#L124), [handlers.ts:193](knowledge/src/service/handlers.ts#L193), [template.ts:27](harness/src/tools/knowledge/template.ts#L27), [edit-file.ts:237](harness/src/tools/workspace/edit-file.ts#L237).

Bind each record to the step, selected claims, template, resolved settings, and original script hash.
Keep a separate record per script or render.
At execution, compare the script hash with the original hash.
Record a change as unvetted, with the final hash and available diff.
An execution-time comparison also detects changes outside `edit_file`.
Use the existing file provenance to preserve the records.

Acceptance: two templates keep two records.
A later script change cannot retain a false assertion of no unvetted edits.
The record connects the cited decision to the bytes that actually ran.

### 9. Apply data minimization to every request

The design states that typed fields prevent sample identifiers from leaving the machine.
But `blocking_factor` and `covariates` accept arbitrary strings.
The template tool sends input paths, column names, and contrast levels to the service.
If the service is remote, those strings can disclose identifiers.
[Design:501](knowledge-plane-phase-zero.html#L501), [model.ts:71](knowledge/src/model.ts#L71), [template.ts:70](harness/src/tools/knowledge/template.ts#L70), [client.ts:225](harness/src/tools/knowledge/client.ts#L225).

Keep local paths, column names, and contrast labels in a local parameter file.
Use categorical roles in the remote situation and scientific settings in the remote render request.
Bind the local values when the script runs.
Validate this boundary in the host before serialization.
Typed strings alone do not enforce the stated privacy contract.

Acceptance: unique sentinel identifiers in local paths and labels never appear in captured outbound requests.
The locally bound script retains the correct inputs and contrast.

### 10. Make the evaluation support the intended decision

The current evaluation has three distinct limits:

- **Grounding can pass without valid evidence.** A direct probe with a fabricated claim and an empty flagged claim list scored 100% grounding. One correct step digest made the whole run appear pinned. Resolution counts do not correct this score. [score.ts:88](knowledge/eval/src/score.ts#L88), [score.ts:104](knowledge/eval/src/score.ts#L104), [score.ts:119](knowledge/eval/src/score.ts#L119).
- **The automated campaign stops at the plan.** It loads the submitted plan and records planner usage. It does not measure executed results, script changes, or template savings. The manual comparison contains an incomplete with-tools run. [run.ts:149](knowledge/eval/src/run.ts#L149), [PHASE0-REPORT.md:89](knowledge/eval/PHASE0-REPORT.md#L89).
- **The evidence for generalization is incomplete.** The runner uses the default simulation seed, and records no tool responses. The report excludes absent judge scores and emits non-inferiority labels without a calibration gate. One-run tasks produce a within-task standard deviation of zero. [run.ts:96](knowledge/eval/src/run.ts#L96), [run.ts:126](knowledge/eval/src/run.ts#L126), [tasks.ts:100](knowledge/eval/src/tasks.ts#L100), [report.ts:40](knowledge/eval/src/report.ts#L40), [report.ts:159](knowledge/eval/src/report.ts#L159).

Score grounding per method step against the exact snapshot and the claims returned for that situation.
Make claim applicability mandatory, not only existence.
Keep unresolved evidence distinct from fabricated evidence.

Freeze the task set, corpus, runtime, provider settings, and judge before a confirmatory campaign.
Use separate development and held-out tasks, with fresh seeds and the planned expert calibration.
Record tool responses, failures, and the complete experiment identity.

Make the small-model-with-tools versus frontier-without-tools contrast primary.
Use the design's correction for multiple contrasts.
Report insufficient repetitions as unknown variability, not zero variability.

Run the existing core design patterns through execution in both arms.
Measure result accuracy, failed runs, total time, and tokens per completed step.
Declare Phase 0 inconclusive when a required criterion lacks evidence.
Exploratory results remain useful, but a plan score does not establish the performance of the complete product.
[Design:764](knowledge-plane-phase-zero.html#L764), [design:774](knowledge-plane-phase-zero.html#L774).

### 11. Make release gates establish the claimed validation

The build runs the Zod and referential gates only.
Source resolution, scientific review, and template execution are not mandatory build gates.
The current test workflow has jobs for the CLI, harness, and provenance kernel, but none for knowledge.
[build-snapshot.ts:36](knowledge/src/build/build-snapshot.ts#L36), [test.yml:21](.github/workflows/test.yml#L21), [test.yml:64](.github/workflows/test.yml#L64), [test.yml:125](.github/workflows/test.yml#L125).

The template runner defaults to the `latest` image tag and the current catalog farm.
These defaults do not establish execution in the declared environment.
Source resolution examines HTTP success, but does not validate returned metadata or evidence support.
[template-tests.ts:32](knowledge/src/build/template-tests.ts#L32), [validate.ts:125](knowledge/src/build/validate.ts#L125).

Keep a quick local build, but make publication depend on recorded gate results.
Include schema agreement, complete-procedure checks, template execution, source metadata, and scientific approval of the cited assertion.
Pin the actual image and farm used by the template gate.
Exercise materially different adaptable branches.
Reject unsupported design combinations.
Link these results to the release digest.

This makes “tested and cited” an artifact property that a consumer can inspect.

Acceptance: a release cannot pass with a changed template, incompatible environment, or unreviewed assertion after its validation record.

## Verification and limits

The results below belong to the initial review, not a new evaluation campaign.

The knowledge suite passed: 46 tests, 219 assertions.
The tree validation passed: 161 rules, 51 methods, 40 templates, and 146 sources.
The knowledge typecheck passed.
The harness knowledge tools passed 15 tests, and the HTTP client passed four tests.
The HTTP tests required permission to bind a temporary local port outside the sandbox.

Direct probes used the current corpus in memory and changed no implementation file.
They reproduced the procedure conflicts, false check results, language substitution, response size, and false grounding score reported above.
This review did not run a new model campaign, every template in Docker, or the LinkML gate.
It inspected the existing reports, including the current [four-models report](knowledge/eval/results/four-models/report-fable.md).
The review makes no claim that the current corpus passed an independent scientific audit.

This revision examined the evaluation boundary again and used the primary Bioconductor sources for the airway requirements.
It changed only this document. It did not run model campaigns or change implementation files.
