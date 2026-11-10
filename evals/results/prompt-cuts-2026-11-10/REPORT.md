# The prompt and tool cuts of the step agents: results

The reports of each run are in this directory, and `regrade.ts` grades a report again with the current graders. Each
run: 34 step cases × 2 trials on Sonnet with real execution, or 136 conversation and planner cases × 2
trials.

## The results

| Run | Change | Pass | Volume for each trial |
| --- | --- | --- | --- |
| base-1, base-2 | none | 67/68, 66/68 | 261k |
| cand-p13 | layers moved, preferences cut to three lines | 67/68 | 252k |
| cand-p2 | environment layer cut, rules moved into the tools | 64/68 | 255k |
| cand-p4 | tool descriptions cut, outcome guidance in the results | 65/68 | 228k |
| cand-p3c | step contract cut | 65/68 | 208k |
| cand-p5 | SOUL execution core cut | 66/68 | 205k |
| cand-p6 | the example of `command` is a script | 66/68 | 213k |
| shared-base, shared-cand, shared-p5 | conversation and planner: before, after p2 to p4, after p5 | 270/272, 270/272, 268/272 | 118k, 113k, 113k |

The step volume falls by 20 %, with a 95 % interval that excludes zero against both baselines. The pass rate holds. The
failures that remain are two cases that fail on each code:

- `domain-methylation-probe-bias`: 9/16 before the cuts, 10/20 after. A trial passes when the agent reads the
  `dna-methylation` skill, and fails when it reads only `enrichment`.
- `drug-approved-with-records`: the agent writes drug identifiers from memory. This is the known defect that a
  provenance check in code can fix.

## The sizes of the analyst

| Layer | Before | After |
| --- | --- | --- |
| SOUL execution core | 2.2k | 1.5k |
| Agent body (editable) | 1.8k | 2.4k |
| Skill index | 5.2k | 5.4k |
| Environment | 3.9k | 0.4k |
| Step contract | 7.0k | 2.1k |
| Tools | 28.3k | 22.7k |

## Grader defects found and fixed

Each fix has a unit test, and each `*.regraded.json` report is graded again with `regrade.ts`.

- `workScript` graded the first script that matched, also a check script. The event-coding and the lineage graders now
  pass when any script does the work.
- The lineage grader did not know a panel class that is coded again to `type`.
- The build-alignment grader required a merge keyword. A lift then a filter in a loop now passes.
- The dependency grader of the planner required a separate enrichment step. With one analyst, the planner puts the DE
  and the enrichment in one step, which is correct.

## Findings for a decision

- About 80 % of step trials run a command before they acquire a sandbox. A sentence in the description of
  `execute_command` did not change that. The example of the `command` field was a file read with `head`, and it is now a
  script (in the next run). The recovery costs one call. Automatic acquisition was rejected: it causes churn of the
  machines.
- `submit_file_metadata` is called during the task in about 18 % of trials, and the harness refuses it each time. The
  description now says not to call it during the task.
- The calls of `list_available_packages` fell from 21 to 9 for each run, with no rise of failed imports.

## The lease

The new example did not change the first command: 66 of 68 trials run a command before they acquire a sandbox. The agent
recovers in the next step. No prompt text changed this in three rounds, thus the prompts stop here.

## The state of the checks

On the worktree `prompt-layers`: the harness suite (6628 tests), the CLI suite (4969 tests), the eval tests (108), and
the typecheck of each package pass. Each spec validates.

## Not done yet

- A run on Qwen when the credits are sufficient. Sonnet passes almost each case, thus a cut that hurts a weaker model can
  show only there.
