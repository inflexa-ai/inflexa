# Proposal

## Why

The conversation prompt (`harness/src/prompts/conversation.ts`) held 19,580 characters. Much of it restated a rule that a tool description, an input schema, or the code already held. Each copy can drift from the text that the model reads at the call, and each request paid for the copy.

The rewrite obeys one rule: a prompt carries only the product facts that no tool carries. A rule that a tool description, a schema, or code already holds is deleted from the prompt. Some specs still ask for the deleted text in the prompt, thus they disagree with the shipped prompt. This change moves each such requirement to the place where the rule lives now.

## What Changes

The rewrite came in four steps. The prompt falls from 19,580 to 5,128 characters.

- **Step 1, the duplicates.** The restatement of the `execute_analysis` schema goes ("never add or invent an agent id"), and so does the sentence on the sandbox specialist in the `execute_analysis` description. The paragraph "the workflow runs autonomously" goes. The prompt copy of the one-wait rule goes, and the `inspect_run` description keeps the rule. The stale-plan guidance moves into the messages of `PlanNotFoundError`, `PlanMalformedError`, and `PlanValidationError`: `Generate a new plan; a retry of this planId fails the same way.`
- **Step 2, the role, data, and run sections.** A new rule says when to start a run: for computation on the data that needs the sandbox. A lookup, a file read or write, or a summary is not a run. The prompt no longer tells the agent to confirm an input add in text. The host input tool asks through its approval hook, and a text question first asked the user two times. The revise instruction goes, because the `generate_plan` schema describes `parentPlanId` and `userConstraints`.
- **Step 3, the judgment sections.** The interpretation, translational, literature, hypothesis, and analogy sections keep only judgment.
- **Step 4, the reports and the ground rules.** The report section keeps the session path only. The section "Showing Things to the User" goes, because the descriptions of `show_user`, `show_file`, and `show_plan` carry it. The fact that a `.pdb` or `.cif` that a step wrote goes to `show_file` moves into the `show_file` description. The sections for errors, "Do NOT", and guidelines fold into "Ground Rules".

No behavior requirement goes. Each modified requirement keeps its behavior and names the new place of its rule.

### The evidence

The decision evals (`evals/`) ran after each step on the CLI model `claude-opus-5-5`: 34 cases (17 dev, 17 held-out), 5 trials for each case. Each step compared against the step before with `compare --fail-on-regression`:

| Step | Prompt digest | Dev | Held-out | Mean input tokens per trial |
| --- | --- | --- | --- | --- |
| 0, baseline | 62e15a54 | 85/85 | 85/85 | 158,229 |
| 1 | 538b6311 | 85/85 | 85/85 | 155,935 |
| 2 | e4a61b3a | 85/85 | 85/85 | 154,761 |
| 3 | 9220cd71 | 85/85 | 85/85 | 151,234 |
| 4 | bb17a988 | 85/85 | 85/85 | 147,955 |

The paired mean difference is 0 points for each step, in each set. These cases test the moved rules:

- `run-in-progress-one-wait`: at most one bounded wait in a turn, and no run.
- `approved-plan-no-relaunch`: an approval record means that the run started.
- `add-inputs-from-launch-dir`: an input add asks through the approval of the host tool, not in the reply text.
- `report-on-request` and `summary-no-report`: one report path, and a report only on request.
- `write-derived-file` and `trivial-question-no-run`: a file write or a lookup is not a run.

### The plan card

The order "generate a plan, then show it with `show_plan`" was a rule of the prompt. `generate_plan` now emits the card of the plan that it makes, thus the rule is code, and the prompt and `show_plan` drop it. No `DBOS.patch` keeps the old order, because nothing runs in production yet.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `planning-enhancements`: an added requirement, `generate_plan` shows the card of the plan that it makes.

- `structure-presentation`: "The agent is told where a structure is shown". The `show_user` description names the structure card, and the `show_file` description keeps a `.pdb` or `.cif` that a step wrote. The prompt section "Showing Things to the User" no longer exists.
- `conversation-run-awareness`: "Launch and prompt contracts prevent inspect polling loops". The `inspect_run` description teaches the one bounded wait. The prompt says only that runs are asynchronous and that their results are read on a later turn.
- `host-conversation-tools`: "The conversation prompt orients the agent to host input tools for unstaged data". The prompt no longer asks for a confirmation in text, because the host tool asks through its approval hook. The new text also drops the word for an injection point that the old text used.
- `harness-working-memory`: "The agent maintains working memory through one section-addressable tool". The `update_working_memory` description states the promotion criteria. The prompt did not state them before step 1 either, thus this requirement was already stale.
- `run-synthesis-outcome`: "Conversation guidance treats synthesis as present only when produced". The `inspect_run` description gates `synthesisPath` on a produced synthesis. The section "Interpreting Results" keeps the fallback to the step summaries.

These requirements still hold for the new prompt, thus this change does not touch them:

- `conversation-run-awareness`: "The prompt reads an approval record as a started run".
- `report-session-spawn`: "The roster of the conversation agent holds one report path". The section "Reports" names `start_report_session` and no other report tool.
- `adhoc-analysis-execution`: "Explicit computational intent authorizes ad hoc launch". The section "Analysis Runs" keeps the consent rule.

### The overlap with the open changes

No spec of this change is in the open changes `remove-literature-reviewer`, `add-script-tools`, or `declare-capability-data-requirements`. Thus the archive order is free.

- `add-script-tools` edits the same prompt after step 4: the section "Literature and Biology" names `run_script`. Its new capability `script-tools` asks for that sentence, and the prompt holds it.
- The design of `declare-capability-data-requirements` cites the environment-gap rule at `src/prompts/conversation.ts:374`. The rule is now an item of "Ground Rules". Before the agent calls a package or a reference dataset unavailable, it finds out whether a tool can give it.

## Impact

- `harness/src/prompts/conversation.ts`: the rewrite.
- `harness/src/tools/execute-analysis.ts`: the three plan error messages, and the `execute_analysis` description.
- `harness/src/tools/workspace/show-file.ts`: the `show_file` description names a `.pdb` or `.cif` that a step wrote.
- `harness/src/agents/test/conversation-agent.test.ts`: the tests pin the one-wait rule in the `inspect_run` description and the structure rules in the display tool descriptions, not in the prompt.
- No schema, storage, or wire change. The system prompt stays a function of the agent type, thus a new digest only starts a new prompt cache prefix.
