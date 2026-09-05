# Phase 0 report: the knowledge plane on bulk RNA-seq

Date: 2026-09-05. Snapshot `2026-09-04`, digest `sha256:833150c5e45c…`.
Design: `../../knowledge-plane-phase-zero.html`. Campaign data:
`results/phase0/report.md` and `results/phase0/report.json`.

## What was built

| Deliverable of the design | State |
| --- | --- |
| Knowledge repository | 58 rules, 21 methods, 9 templates, 45 sources, 16 minted terms, one modality. LinkML schema plus a Zod mirror. Every DOI and PMID resolves. |
| Service | One Bun container over one SQLite snapshot. Rule engine, procedure assembly, check, template renderer, environment match, syntax check, bearer key. HTTPS routes only. |
| Inflexa tools and the field | `harness/src/tools/knowledge/`: the client seam and the three tools. The optional `grounding` step field. Three registrations. The CLI config block and the environment key. |
| Evaluation harness | Eight design patterns, a negative binomial simulator with the hallmark sets planted, the runner over the real planner, a deterministic scorer, a rubric judge, and a paired bootstrap report. |
| Report | This document. |

## The exit criteria

| Criterion | Result |
| --- | --- |
| Knowledge base checks pass | The tree validates. Each DOI and PMID resolves. Nine of nine templates run green in the pinned sandbox image against the simulated truth. The gold set of 60 design-to-method queries is not authored yet, thus recall at 1 is not measured. |
| The model calls the tools without a prompt line | See the campaign table. The planner called `knowledge_recommend` in every with-tools run of the campaign. |
| Non-inferiority holds | Measured on one frontier model and on Sonnet 5, see the Sonnet sections. The small target models did not run, because no endpoint key for GLM 5.3 Flash or Qwen 3.8 27B is on this machine. The runner accepts them through the OpenAI-compatible connection. |
| The chain is grounded | See the campaign table for the share of method steps with a claim identifier, and the share of those identifiers that resolve in the snapshot. |
| Time and tokens are measured | See the campaign table. Output tokens per run are reported beside the input tokens and the wall-clock. |

## The campaign

One frontier model (`claude-opus-5` through the local proxy), eight tasks,
two runs per task and per arm, 32 runs. The judge is `claude-opus-5`, blind to
the arm. The unit of the non-inferiority test is the task.

| Measure | With the tools | Without the tools |
| --- | --- | --- |
| Plans submitted | 100% | 100% |
| Rubric mean (0 to 100) | 96.4 | 85.9 |
| Rubric spread within a task (SD of two runs) | 0.4 | 3.0 |
| Deterministic expectations met | 100% | 98% |
| Runs that called `knowledge_recommend` | 100% | not attached |
| Runs that called `knowledge_check` | 100% | not attached |
| Method steps with a grounding | 100% | 0% |
| Claim identifiers that resolve in the snapshot | 362 of 362 | none carried |
| Runs whose steps pin the served snapshot digest | 100% | none |
| DOIs written into plan prose | 0 | 0 |
| Tool calls per run | 6.5 | 3.7 |
| Input tokens per run | 198,075 | 47,688 |
| Output tokens per run | 13,025 | 6,351 |
| Cache-read tokens per run | 141,750 | 30,155 |
| Wall-clock per run | 154 s | 89 s |

The paired difference of the rubric, with minus without, is 10.5 points
over 8 tasks. The 95% bootstrap interval is [7.3, 14.8]. At the
pre-registered margin of 5 points the tools are non-inferior, and the
interval lies above zero. The criteria that move most are the enrichment
universe and set choice, the FDR and shrinkage, and the report completeness.
The plan-time cost is about twice the output tokens and 1.7 times the
wall-clock. A grounded plan carries the claim identifiers and a reason on
each step, and the planner reads the procedure and runs the check.

One run of the confounded task called the check 19 times under the pre-fix
service. Every other run called it once or twice.

## The sandbox path

One with-tools plan of the two-group task replayed through `inflexa run --plan`
on a headless analysis with the simulated inputs. The run used the real
sandbox image and the local package store. The plan carried five steps.

The QC step agent called `knowledge_template` with seven slot values. The tool
wrote the rendered script and `output/decision_record.json` through the
workspace mutator. The record pins `tpl-qc-eda@1.0.0`, the snapshot digest, an
exact environment match on four packages, a passing syntax check, and four
citations. The agent ran the script, and the PCA, the sample distances, and
the library sizes landed in the step. The agent then wrote one more script of
its own for the adjudication of the shallow sample.

The DESeq2 step agent called `knowledge_template` with twelve slot values. The
rendered `deseq2_two_group.R` carries 14 marked lines and 210 lines in total.
It ran to completion: 9,402 genes tested, 875 significant at an adjusted
p-value below 0.05. The decision record reports an environment mismatch,
because the farm of the analysis holds no `ashr` while the template pins it.
The script did not load it, thus the run held.

The provenance chain of the analysis verifies, and both decision records are
hashed into the signed document. The lineage reader shows no generation edge
for a file-tool write. That gap is the pre-existing drift between the CLI
provenance module and the newer harness events, not a fault of this change.

The run itself ended as failed. The runtime process was stopped for memory
during the DESeq2 step, and the durable replay after the restart diverged.
The step files above were on disk before the stop.

### The same plan without the plane

The same plan, with the grounding removed, then replayed on the same
analysis with no knowledge client bound. The step agents wrote every script
by hand. The table gives the two steps that both runs completed.

| Measure | QC step, with | QC step, without | DESeq2 step, with | DESeq2 step, without |
| --- | --- | --- | --- | --- |
| Wall-clock | 437 s | 553 s | not recorded | 680 s |
| Calls of the step agent | 33 | 34 | 29 | 24 |
| Output tokens of the step | 35,163 | 42,263 | 43,999 | 53,395 |
| Input tokens of the step | 2.08 M | 2.43 M | 2.24 M | 2.17 M |
| Script lines from the template | 222 | 0 | 211 | 0 |
| Script lines by the model | 369 | 635 | 446 | 729 |
| Decision record | yes | no | yes | no |

The template did not remove the work of the model. In both steps the agent
wrote a second script of its own beside the rendered one. The second script
adjudicated the shallow sample, or ran the sensitivity analysis. The template
moved the core of each step out of the model output. The QC and the DESeq2
fit came from a tested body with a pinned environment. The output
tokens of a step fell by about a sixth, and the QC step was faster. The
DESeq2 step of the with-run has no wall-clock, because the replay after the
memory stop marked it failed.

The run without the plane completed all six steps in 74 minutes. The
three steps that the with-run did not reach wrote 741, 726, and 1,029 lines
of hand-written code. The two DESeq2 fits agree on the answer: 875 genes
significant in each run, on 9,402 tested with the template and on 9,782
tested by hand. The enrichment step found 15 of the 50 hallmark sets at an
adjusted p-value below 0.05. It read the collection from the staged reference
store, and it ranked the full tested list. Thus the frontier model reaches the same
result without the plane, at the price of an untested script per step and
no decision record. The gain of the template on a frontier model is
traceability and the environment pin, not correctness. The gain on a small
model is the open question that Phase 1 must measure.

## Sonnet 5, the first campaign

The same eight tasks, two runs per task and per arm, on `claude-sonnet-5`
through the local proxy, judged by `claude-opus-5`. This campaign ran before
the fixes below, on the 58-rule snapshot.

| Measure | With the tools | Without the tools |
| --- | --- | --- |
| Plans submitted | 14 of 16 | 16 of 16 |
| Rubric mean, all runs | 81.5 | 67.5 |
| Rubric mean, submitted runs | 93.1 | 67.5 |
| Paired difference, 95% interval | +14.0 [-1.2, 25.5] | |
| Runs that called `knowledge_recommend` | 100% | not attached |
| Method steps with a grounding | 94% | 0% |
| Tool calls per run | 53.0 | 20.2 |
| Wall-clock per run | 181 s | 77 s |

Five runs looped on a tool until the plan timed out or hit the iteration
cap. One loop was on `knowledge_check`: the model drafted a descriptive step
for the no-replicates task, the check answered a violation, and the model
rephrased the step 147 times over 155 calls. Four loops were on the
environment listing tools, in both arms: 164 identical calls of the package
listing in one run, and 202 distinct queries of the reference listing in
another. The campaign runner bound no reference store and no package
inventory, thus both tools answered "unavailable" on every call. The answer
of the reference listing said that a store "will show up on a later call".
Opus read the same answer once and continued.

Three fixes followed. The check accepts a step that states the permitted
outcome, and the host caps the checks of one plan at three. A call guard in
the planner refuses the third call with an input the plan already sent. It
also refuses the call past twelve calls of one tool. The runner binds the reference store
and the package inventory that the CLI binds.

## Sonnet 5, the second campaign

The same protocol, on the 105-rule snapshot, with the check fixes, the call
guard, and the stores bound. Campaign `sonnet-r2` in `results/`.

| Measure | With the tools | Without the tools |
| --- | --- | --- |
| Plans submitted | 16 of 16 | 13 of 16 |
| Rubric mean, all runs | 93.6 | 55.5 |
| Rubric mean, submitted runs | 93.6 | 68.3 |
| Rubric spread within a task | 1.3 | 11.0 |
| Paired difference, 95% interval | +38.1 [25.2, 56.7] | |
| Method steps with a grounding | 100% | 0% |
| Claim identifiers that resolve | 431 of 431 | none |
| Tool calls per run | 18.3 | 41.6 |
| Wall-clock per run | 122 s | 167 s |

The check loop is gone: no run called `knowledge_check` more than four
times, and every with-run submitted. The guard bounded each tool, but it did
not end a loop. A refused model called the next tool instead. Two with-runs
made 48 and 101 calls before they submitted. Four without-runs made 123 to
201 calls in a round over every search tool. All six were on the
interaction and the time-course tasks. Three of those four ended in an error or a
clarification request, thus the without arm scored below its first campaign.

One more fix followed. The agent loop accepts an early cap from the host,
and the planner ends its search after six refusals of the guard. The
wrap-up and the salvage turn then submit the plan the planner has.

## Sonnet 5, the third campaign

The same protocol, with the early cap in place. Campaign `sonnet-r3` in
`results/`. This is the recorded performance of Sonnet 5 on the plane.

| Measure | With the tools | Without the tools |
| --- | --- | --- |
| Plans submitted | 16 of 16 | 16 of 16 |
| Rubric mean | 92.4 | 65.7 |
| Rubric spread within a task | 1.4 | 3.9 |
| Deterministic expectations met | 99% | 99% |
| Paired difference, 95% interval | +26.7 [19.7, 32.3] | |
| Runs that called `knowledge_recommend` | 100% | not attached |
| Method steps with a grounding | 100% | 0% |
| Claim identifiers that resolve | 441 of 441 | none |
| Tool calls per run | 17.3 | 11.6 |
| Longest run, calls and time | 39 calls, 206 s | 64 calls, 407 s |
| Output tokens per run | 9,436 | 4,535 |
| Wall-clock per run | 115 s | 84 s |

No run errored, and no run reached the iteration cap or the wall clock. The
early cap fired in five runs, three with the tools and two without. Each of
those runs submitted a plan through the salvage turn. The longest run
took 407 s against 600 s before. Three criteria move most with the tools. The
low count filter rises from 4.6 to 9.1, the FDR and shrinkage from 6.1 to
9.3, and the enrichment universe and sets from 5.3 to 8.1.

Across the three campaigns the with-arm rose from 81.5 to 93.6 and 92.4, and
the without arm moved from 67.5 to 55.5 and 65.7. The second without-arm
was low because four runs looped to an error or a clarification request. The
early cap removed that failure mode in the third. Thus the plane raised
the plan quality of Sonnet 5 by about 27 points, and the host fixes made the
result stable across runs of one task.

## Head to head: Sonnet 5 with the plane against Opus 5 without it

One campaign, `head-to-head` in `results/`, with both arms under the same
host: the guard, the early cap, the stores bound, and the 105-rule snapshot.
Eight tasks, three runs per task and per arm, 48 plans. Two blind judges
scored every plan: Opus 5, and Sonnet 5 as a check on the first. The two
judges agree at a Pearson r of 0.95, with a mean gap of 3.8 points per plan.

| Measure | Sonnet 5 with the plane | Opus 5 alone |
| --- | --- | --- |
| Plans submitted | 23 of 24 | 24 of 24 |
| Rubric mean, Opus judge | 87.8 | 89.4 |
| Rubric mean, Opus judge, submitted runs | 91.6 | 89.4 |
| Rubric mean, Sonnet judge | 88.8 | 90.3 |
| Paired difference, Opus judge | -1.6 [-10.3, 3.9] | |
| Paired difference, Sonnet judge | -1.5 [-12.8, 8.4] | |
| Tasks won, Opus judge | 6 of 8 | 2 of 8 |
| Deterministic expectations met | 94% | 99% |
| Method steps with a grounding, claims that resolve | 97%, 586 of 586 | none |
| Tool calls, output tokens, wall-clock per plan | 18.6, 8,979, 118 s | 3.1, 7,117, 95 s |

The two arms are within two points of each other, and the interval of the
difference covers zero under both judges. Non-inferiority at the margin of 5
is not shown, because the lower bound reaches -10. One run decides that
bound. In the first time-course run Sonnet called the reference listing
seven times, then called `request_clarification` with the text "skip". The
protocol scores a plan that is not submitted at zero. Without that run
the time-course task is 88.1 against 89.2, and the two arms are equal.

Two other facts belong in the reading. Opus alone scored 89.4 here against
85.9 in the first campaign, because the bound stores gave it the census of
the environment. Thus the cross-campaign gap of 6.6 points reported before
was inflated. And the expectation gap is a scorer artifact: the no-replicates
plans of Sonnet say "NO Wald test", and the pattern that forbids the Wald
test matches the negation.

The definitive reading is this. On plan quality as two judges score it,
Sonnet 5 with the plane and Opus 5 without it are the same within the noise
of eight tasks. Sonnet with the plane wins the tasks where the rules decide
the method, the filter, and the outcome. It loses only where it fails to
submit. Every Sonnet plan carries the grounding that no Opus plan carries.
The price is six times the tool calls and a quarter more wall-clock.

## What the campaign does not show

- One frontier model and one mid-size model, two runs per task. The design
  asks for three runs, two small models, and 24 tasks with held-out GEO
  datasets. The noise floor is the within-task spread of two runs, not a
  second seed set.
- The judge is one frontier model with no calibration against blinded
  experts. The rubric scores are indicative until a weighted kappa of at least
  0.7 is measured.
- The check refused one drafted step in the campaign by a resolver tie, and
  it warned on a symbolic default. Both faults are fixed and tested after the
  campaign. The campaign ran with the pre-fix service.

## The Phase 1 decision

The measured result supports the Phase 1 build. The knowledge plane raised
the plan quality of a frontier model, and it made the plan traceable with no
prompt change. The decision holds with these conditions:

- Add the second modality only after the small models run. The
  non-inferiority claim of the design is about a small model, and this
  campaign did not measure one. Run GLM 5.3 Flash and Qwen 3.8 27B on the
  same eight tasks first.
- Keep the situation brief out of the planner seed for now. The planner called
  `knowledge_recommend` in every run with no prompt line, thus the brief is
  not necessary for the call rate. Add it only if a small model does not call
  the tool.
- Make the host enforce one check call per plan. The 19-call loop of the
  confounded run shows that a violation the planner cannot satisfy sends it
  into a revision loop. The engine fix covers the known case, and a host cap
  covers the unknown ones.
- Gate the plan on the grounding, not on the prompt. A method step with no
  claim identifier is the signal that the planner did not use the plane. The
  gate is one host-side test over the plan schema.
- Calibrate the judge against two blinded reviewers on the 32 plans of this
  campaign before the Phase 1 campaign. The rubric scores decide the exit
  criterion, and the judge is uncalibrated.
- Extend the environment match to the farm of the analysis. The DESeq2
  record reported a mismatch on `ashr` that the script did not load. A pin
  that names only the packages the body loads removes the false mismatch.
