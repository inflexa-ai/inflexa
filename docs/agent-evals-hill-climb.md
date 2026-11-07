# Agent evals and the hill climb

This document records the work of the `eval-hill-climb` branch. It gives the
changes, the reason for each change, and the measurements. Read it before you
review the diff.

## Summary

The decision evals (`evals/`) now cover most of the behavior that the prompts,
the tool descriptions, and the specs expect from the agents. The runner can
now run the follow-up requests of a step and of a chat turn. A climb then
starts: find a failure, fix it, and measure the fix against a baseline.

The climb prefers a fix in code to a fix in the prompt. A rule in code is
verified each time. A rule in prose is advice, and the measurements below show
that the model does not always obey it.

## The method

1. Write a case for each expected behavior. Give each `dev` case a `held-out`
   twin that does a test of the same behavior with different words.
2. Run a baseline of the full suite.
3. Read each failed trial. Find the cause before you change the agent.
4. A failed trial has one of two causes:
   - A case defect: the case, the grader, or the scripted tools are wrong. Fix
     the case.
   - An agent defect: change the harness, then measure again.
5. Measure each change on the cases that it touches, with the same model and
   the same trial count. Run `bun run evals compare` on the two reports.

A case that passes on each model from the start is too lenient. Make it
stricter before you tune against it.

## The models

| Model | Role | Note |
| --- | --- | --- |
| Sonnet 5.5 | The model of the loop | Through the model proxy of the CLI. |
| GLM-5.3 | The open-weights tier | Through the z.ai coding endpoint. Its own pass bar. |
| Opus 5.5 | Gates only | Through the model proxy of the CLI, with `--model claude-opus-5-5`. It finds case defects that Sonnet does not show. |

Haiku is not a target, because no user runs it for this work.

## Changes to the evals

### New cases

The suite grew from 99 cases to 180 cases. Each new behavior has a `dev` case
and a `held-out` twin.

| Area | Behaviors |
| --- | --- |
| Conversation | Plan approval starts the plan run. Interpret a run from the synthesis or from the step summaries. `generate_plan` gets the facts of the user and not the profile. A clarification of the planner goes to the user. Analogies, and analogies kept out of the plan. An existing report session. Issues #172, #248, #281, and #632. |
| Working memory | Obey a constraint. Raise a conflict with a constraint. Record a constraint and a finding. Retire a hypothesis. Skip a transient ask. Compaction moves the lasting facts into the memory and adds no duplicate. |
| Planner | Packages that the pool resolves (#512). The exact capability phrase. No second plan of a completed step. Analyst Notes win. No invented specifics when the profile is pending. The knowledge tools. |
| Synthesis | An empty `findings` list. Not one finding for each step. A lookup before the draft. The organism correction of the user (#257). |
| Report | No zero p-value in prose. Citations only from the pinned evidence. An absent reference resolver. |
| Sandbox step | A missing reference. No data fetcher that needs the network. Fix a failed script. Obey the constraints of the memory. Read each document once (#259). The step summary. |
| Profiler | Conflicting sources give low confidence. A null organism when no input identifies it. |
| Analogy | An incoherent problem. Searches that return nothing. |

### New runner capabilities

| Capability | Why |
| --- | --- |
| The step summary after the task (`summary` on a sandbox case) | The summary is a follow-up request of the step. Production runs the file-metadata exchange first, and the runner does the same. |
| A summary-only case (`summary: "only"`) | The scripted sandbox cannot fake a full analysis well enough for an agent that examines its own output. A fixed transcript and real files do a test of the summary alone. |
| The compaction exchange (`compact` on a conversation case) | It sends the same request with the same tool mask as the loop of a chat turn. |
| The planner with knowledge tools (`planner-knowledge`) | The real knowledge tools over a fake client, built for each trial as `generate_plan` builds it. |
| The inputs of script calls | A frame of a nested call carries no input. Each script tool now records its input, thus a grader can read a block that a script adds. |
| `--timeout` is a floor | A slow provider needs a larger bound than the bound of a case. |
| A real reference store in the sandbox (`refStorePath`) | A case can use the real `list_available_refs`. |
| The planner of each trial (`plannerOfInvocation`), with the package pool of the case (`pool`) | Production builds the planner for each call. `submit_plan` reads the same census as the seed. |
| The result of each script call | A grader reads a block that landed, not a block that the draft refused. |
| `EVALS_LOG=1` | The log of the harness shows the tries of a provider, for example after a 429. |
| A trial that reaches its time bound is an error | A stalled provider gives no reply. As a failed grade, the stall lowered the pass rate. As an error, it fails the gate of `compare`. |
| `--model <id>` | A run on a different model, with the connection and the credential of the CLI. |
| The call names of a passing trial (`tools`) | The cost of a trial shows its path. A name ends with `!` when its call gave an error result. |

### New graders

`says`, `neverSays`, `inputLacks`, `atMostCalls`, `numbersGrounded`, and
`inSummary`. `numbersGrounded` fails a reply that gives a number that no
source of the trial gave. Unit tests in `evals/test/case.test.ts` cover them.

## Changes to the harness

### Round 1: `submit_plan` waits for `knowledge_check`

The defect: after a `knowledge_recommend` answer, the planner submitted the
plan with no `knowledge_check` of the draft. The description of the check
already said "once, after the draft and before `submit_plan`".

The change:

- `knowledge_check` folds each answer into the memory of the planner through
  `foldCallRecord`. A DBOS replay folds it again.
- `submit_plan` refuses a plan after a recommend answer that no check
  followed. The refusal says what to do.
- The order rule left the description of the check.
- `plannerOfInvocation` builds the planner of one call. The evals use it.

The gate does nothing when no knowledge client is bound. Without a client, no
knowledge tool attaches, no recommend answer occurs, and `submit_plan` behaves
as before.

| Case | Before | After |
| --- | --- | --- |
| `plan-knowledge-recommend-and-check` (dev) | 1/5 | 5/5 |
| `plan-knowledge-recommend-and-check-held-out` | 3/5 | 5/5 |
| `plan-knowledge-skips-uncovered` (both sets) | 10/10 | 10/10 |

Sonnet 5.5, 5 trials. In 2 of 10 trials, a refused submit came first. This
costs one extra round.

### Round 2: `list_available_refs` says what an empty query means

The defect: a step agent that does not find its gene sets searches the
filesystem (`find /`, `ls -R /mnt/refs`) until its step budget ends. The real
tool answers a query that matches nothing with an empty list and no other text.

The change applies to a query that matches nothing in a populated store. The
answer then says that the store is the only reference data of the sandbox. It
also says that the sandbox has no network. These are facts in a tool result,
not rules in a prompt.

| Case | Before | After |
| --- | --- | --- |
| `step-missing-reference-no-invention` (dev) | 5/5 | 5/5 |
| `step-missing-reference-no-invention-held-out` | 3/5 | 5/5 |

Sonnet 5.5, 5 trials. The tokens for each trial did not increase (dev 209k and
210k, held-out 190k and 179k). With the real tool, the defect is less frequent
than with the scripted tool of the first runs.

### Round 3: `submit_plan` resolves the packages of a plan (#512)

The change does what issue #512 designs, for the refusals:

- `submit_plan` resolves each `packages` entry against the package census of
  the session. It uses `resolveQuery`, the same ladder as the census listing
  and the link of the launch.
- A bare name that both tracks hold is refused. The issue names the two
  prefixed forms.
- A name that the pool does not hold is refused. The issue names the
  spelling that the pool holds, where there is one.
- A census that the planner cannot read refuses nothing. The launch links
  the packages again.
- `censusResolver` (`list-available-packages.ts`) gives the resolution. The
  listing and the check use the same rows.

Not done yet: the base R packages and the Python standard library do not
count as present (item 3 of the issue), and the specs are not updated (item
5). A plan that names `stats` or `json` is refused at submit, as the launch
refuses it today.

| Case | Model | Without the check | With the check |
| --- | --- | --- | --- |
| The package cases, the existing pair and a stricter pair | Sonnet 5.5 | 20/20 | Not run, because no plan failed |
| `plan-packages-resolve`, `plan-packages-habitual-absent` (dev) | GLM-5.3 | 6/6 | 6/6 |

Neither model shows the defect now. The issue measured it on Haiku 4.5. The
check is insurance for a weaker model, and its tests cover each refusal.

### Round 4: the draft refuses a PubMed id that the pinned evidence does not hold

The report session searches no literature. Thus a paper enters a report only
through a citation of the pinned evidence. The draft core (`commit` in
`draft-operations.ts`) now refuses an added or changed block that writes a
PubMed id (`PMID 123`, `PMID: 123`, or a PubMed URL) outside the pinned
evidence. The refusal is `unresolved-reference`, the same refusal as a
reference that does not resolve. Thus `add_block`, `change_block`, and the
calls of a script each obey it.

| Case | Model | Without the check | With the check |
| --- | --- | --- | --- |
| `report-cites-only-pinned` (dev) | Sonnet 5.5 | 5/5 | Not run |
| `report-cites-only-pinned` (dev) | GLM-5.3 | 3/3 | 3/3 |

The defect occurred one time in the first GLM baseline. It did not occur
again. The check is insurance, and its test covers the refusal.

### Round 5: `write_file` is also a script tool of the conversation agent

The change: `createConversationAgent` makes one `write_file` tool. The agent
declares it directly, and `run_script` also lists it. The write record of a
nested call folds through `run_script`, thus the provenance of the write does
not change. The approval of the user was necessary, because the exposure work
had stopped.

The baseline and the candidate both use `base` exposure. Thus the only
difference is `write_file` in the scripts. The cost here is all input tokens
plus 5 times the output tokens. The weight of the cache moves with the state of
the cache, and that noise was larger than the effect.

| Case (Sonnet 5.5, 5 trials) | Pass before | Pass after | Cost before | Cost after |
| --- | --- | --- | --- | --- |
| `write-derived-file` (dev) | 5/5 | 5/5 | 300k | 167k |
| `write-derived-file-held-out` | 1/5 | 5/5 | 214k | 156k |

On the 86 conversation cases at 3 trials, the pass count went from 249 to 248
of 252. The three cases that lost one trial write no file. The total cost
changed by -0.7 %.

### Round 6, reverted: `read_file` named the analysis-root form of a relative path

The defect: a GLM profiler read `data/inputs/...` first, because the menu of
its seed lists the paths in that form. A relative path resolves against the
working directory of the agent, thus each read gave `not_found`. A sentence in
the seed did not change this.

The change gave `analysisRootPath` with `not_found` when the analysis root holds
the path. The agent then used the absolute form at once. But the first reads
are parallel calls of the first step, thus no result can prevent them, and the
agent already recovered in one round.

| Case (GLM-5.3, 2 trials) | Without | With |
| --- | --- | --- |
| `profile-one-example-per-set` (dev) | 1/2 | 1/2 |
| `profile-conflict-low-confidence` (dev) | 1/2 | 1/2 |

The pass rate and the cost did not change, thus the change was reverted. Each
failed trial wrote a script, got no output from the scripted sandbox, and used
its steps on probes of the sandbox. This is a limit of the evals: the scripted
sandbox cannot run the code of the model.

### Round 7, reverted: a code limit on unanswered link passes

The defect: after `link_packages` answered `unavailable`, the agents linked again
and again. Each model made a third call, and GLM did not report the blocker.

The change: after two `unavailable` answers in one step, the tool did not call
the farm again. It answered with the last reason and said to report it. The
count came from `foldCallRecord`, thus a replay kept it.

| Case | Model | Without | With |
| --- | --- | --- | --- |
| `step-link-unavailable` (dev) | Sonnet 5.5, 5 trials | 2/5 | 3/5 |
| `step-link-unavailable-held-out` | Sonnet 5.5, 5 trials | 4/5 | 5/5 |
| Both | GLM-5.3, 2 trials each | 1/4 | 0/4 |

The failed Sonnet trials made the same three calls in both arms, and then they
reported the blocker. Only the third call changed: it did not reach the farm.
No decision changed, thus the change was reverted.

## Stricter cases

In the Sonnet baseline, Sonnet passed each trial of 157 of the 180 cases. A case
that always passes cannot measure a change. Thus these cases got a stricter
grade, or a harder twin.

| Case | The old grade | The new grade | Sonnet 5.5 | GLM-5.3 (dev) |
| --- | --- | --- | --- | --- |
| `lookup-batch` (both sets) | Some call of `opentargets` | The reply gives the score of each of the 5 genes, and the lookups run in at most 2 scripts | 10/10 | 2/3 |
| `memory-conflict-raised` (both sets) | No run, and the reply names 0.01 | Also: the reply asks the user, and the agent does not change the memory | 10/10 | 3/3 |
| `memory-records-constraint-in-passing` (new pair) | Not applicable | The user states a lasting rule inside a request to run. The agent records the rule and starts the run. | 10/10 | 3/3 |
| `report-derives-in-script` (both sets) | Some call of `write_derived` | The derived table holds the correct up and down counts, and a block binds that table | 10/10 | 3/3 |

Sonnet passes each stricter case. GLM fails only `lookup-batch`, one time: it
read the table in 4 scripts, and it used all of its steps.

A stricter grade did not make a stricter case in two places:

- A rule that the harness already obeys in code is not an agent behavior. The run
  workflow loads the working memory itself (`execute-analysis.ts`). Thus a grade
  that wants the constraint in the launch input is wrong.
- A "never do X" case that reaches `maxSteps` does not show what the agent does
  after the cap. In the step cases, the forbidden reads occur at the start of a
  step, and each case also wants a positive action. Thus the cap does not hide a
  failure there.

## Tool exposure

The question: does an agent do better when it can also call the plain file
tools from a script (codemode), or only from a script? The `--exposure` flag of
the evals builds each variant from the production agent. The harness does not
change.

| Exposure | The read tools | `write_file` |
| --- | --- | --- |
| `base` (production) | Direct | Direct |
| `read-both` | Direct and in a script | Direct |
| `read-write-both` | Direct and in a script | Direct and in a script |
| `read-script` | Only in a script | Direct |

The read tools are `read_file`, `grep`, `list_files`, `file_stat`, and
`workspace_search`. `edit_file` stays direct in each variant, because it runs as
its own durable step, and a script is one step.

The run: 15 dev cases that read or write files, 5 trials each, Sonnet 5.5. The
cases cover the chat agent, the synthesizer, the step agent, and the profiler.
The cost is in fresh-input token units: fresh input, plus 1.25 times the cache
writes, plus 0.1 times the cache reads, plus 5 times the output.

| Exposure | Pass | Total cost |
| --- | --- | --- |
| `base` | 75/75 | 2789k |
| `read-both` | 74/75 | 3335k (+20 %) |
| `read-write-both` | 74/75 | 3406k (+22 %) |
| `read-script` | 74/75 | 2919k (+5 %) |

On Sonnet, no variant is better than production. The pass rate does not change,
and one failed trial is noise. Each variant costs more.

The profiler doubles its
cost in each variant (34k to 62k–70k for each trial). A request to write a file
costs three times more in the "both" variants (13k to 45k). Some cases cost less
with `read-script`, for example the summary into a markdown file (95k to 50k).
But the total does not.

With `read-script`, a step agent read its documents with `cat` through
`execute_command`, not in a script. The direct read tool is the one that an
agent uses first.

Decision: production stays as it is for the read tools.

A later case showed one gap of `base`. The user asked for all 610 genes of a run
in a file at a path of the user. The agent computed the list in a script, but a
script could write only into the derived directory. The agent then refused to
type 610 lines into a direct `write_file` call. Round 5 adds `write_file` to
the script tools of the conversation agent only.

## Findings about the evals

These failures came from the evals, not from the agents. Each one is fixed.

- **The step summary.** The summary did not cite the totals of the step. The
  runner asked for the summary directly after the task, but production runs
  the file-metadata exchange first. With that exchange, 10 of 10 summaries
  cite the totals. No prompt change was necessary.
- **The report graders.** Two graders read the input of a script call, which
  was empty. They passed with no check. With the recorded inputs, the report
  cases pass for a real reason.
- **The scripted sandbox.** An agent that verifies its own output does not
  trust a file that its script did not name. A rule that writes fixed files
  makes a correct agent stop. Grade a decision, or use a summary-only case.
- **Correct behavior that a grader refused.** For example, a summary that
  quotes a row of a table that it read, or "600" for a total of 610. Each
  grader now accepts these.
- **A results table that did not agree with its synthesis.** The generated
  table gave 408 up and 202 down, but the synthesis said 412 and 198. An agent
  that read both reported the difference, and the case failed it. The table now
  gives 412 and 198.
- **Gene ids that were not real.** The table gave ISG15 the id
  `ENSG00000100000`. An agent that knew the real id stopped to resolve the ids,
  but the resolvers had no script. The top genes now have their real Ensembl ids,
  and both resolvers have a script.
- **A fixed size of a written file.** The scripted `write_derived` gave 512 bytes
  for each file. An agent that wrote 610 genes judged the file as cut, and it
  stopped. The script now gives the real size.
- **A user request that the data did not support.** A held-out case asked about
  a system that "shuts down its own alarm signal". The synthesis shows a
  response that starts. The agent correctly said that the data does not show
  this. The case now asks about the response that the data shows.
- **Fold changes that did not agree with the synthesis.** In the report
  cases, the table gave the top genes a log2 fold change of 1.1. The synthesis
  said 3.1 to 4.0. GLM found the difference and used its steps on it. The table
  now gives 4.0 to 3.1.

### Found by the second climb

- **A stalled proxy.** The CLI proxy stopped two times. The trials of the stall
  had no reply, and the runner graded them as failures. Now they are errors.
- **A grader that read JSON.** The match for "ran the script" read the JSON of
  the input. Thus the argv form `["python", "scripts/de.py"]` did not match, and
  an agent that fixed and ran its script failed. The match now reads the
  command line.
- **A fixture that did not agree with its history.** The scripted analogy report
  named other analogies than the earlier reply of the agent. A careful agent saw
  the difference and said that it invented the earlier analogies. The grader
  also refused the word "analogy" in a note that kept the analogy out of a plan.
- **A twin that was harder than its case.** `write-derived-file` asks for the
  top genes, and its twin asks for all 610 genes. The twin found a real gap
  (round 5), but the two cases do not test the same behavior.
- **A corpus that was too small for Opus.** The four papers of the analogy cases
  fit none of the analogies that Opus selected. Opus also sent the query
  "Attention is all you need", got nothing, and judged the search fake. The
  corpus now has real papers for those analogies and for that query.
- **An ambiguous user message.** A held-out twin named only one donor pair, and
  Opus correctly asked about the others. The message now names each pair.
- **A scripted sandbox that looked broken.** A script and an inline `python -c`
  gave a short note. GLM read the note as a broken interpreter, and it used its
  steps on probes. The note now says that the eval cannot run model code, that
  no named file appears, and that the sandbox works. On GLM, the two profiler
  cases then used 40 % fewer tokens, and one case went from 1/2 to 2/2.
- **A standard library that was not complete.** The scripted sandbox refused
  `import importlib`, because its list of standard modules was typed by hand.
  The list is now `sys.stdlib_module_names`.
- **Step limits that were too low.** A path that records the constraints of the
  user in the memory before the plan needs more than 3 steps.

## Open agent defects

| Defect | Models | Fix in progress |
| --- | --- | --- |
| A plan that needs a reference that the store does not hold | Sonnet (held-out 4/5), GLM (held-out 2/3) | No. A gate in this change covers only the declared capabilities. Issue #838 takes the general design of the requirements of a plan. |
| A zero p-value in the prose of a report | GLM (1/3 in the first baseline, 0/3 later) | No |
| A step reads the data profile that its briefing holds | Sonnet, GLM | No. The cost is one small call. A fix changes the tool set for each step, and that breaks the prompt cache. |
| `link_packages` called again after `unavailable` | Sonnet, Opus, GLM | No. A code limit did not change a decision (round 7). GLM also does not report the blocker: it tries the R track, the store paths, and a wait. |
| The profiler reads more than one file of a set | GLM | No |
| A lookup over a table reads the table in many scripts | GLM (1/3) | No |

## GLM status

The dev baseline of GLM-5.3 at 2 trials passed 60 of 90 cases. Most failures
were trials that gave no answer in their time bound.

The cause is the usage limit of 5 hours of the coding plan. On a 429 answer,
the provider tries again 11 times, with a wait between the tries. Thus a trial
that meets the limit spends its time bound in the tries. A trial alone, with
the log of the provider, passed with no try again. Set `EVALS_LOG=1` for each
GLM run, thus the log shows a 429.

After the limit reset, the round-4 case, the stricter cases, and the
missing-reference pair ran at 3 trials, with no 429. In the failed
held-out trial of the missing-reference pair, the planner saw that the store
held no regulon. It then used a different gene-set collection in its place, and
it submitted the plan. Issue #838 takes this defect.

The second dev baseline of GLM-5.3, at 1 trial, passed 85 of 92 cases. A stream
of the endpoint sometimes broke ("Failed to process successful response"), and
the cases of those trials ran again. The cases that failed are the profiler
cases, the link pair, and `step-briefing-no-hunt`. A profiler case costs about
500k tokens for each GLM trial, thus a profiler run uses the 5-hour limit fast.

## Opus status

The full suite of Opus 5.5 at 2 trials passed 366 of 382 graded trials, after
the case fixes above and a second run of the trials that the proxy stopped. The
failures are the open agent defects of the table above.

## The next steps

1. Issue #838: the requirements of a plan, as a general part of the plan.
2. Run the short bench tiers.
