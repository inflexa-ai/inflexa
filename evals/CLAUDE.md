# CLAUDE.md

Guidance for an agent that works in `evals/`, the decision evals of the Inflexa
agents.

A decision eval runs an agent on a real model, with canned tool results. A grader
reads the tool calls and the reply text of each trial. No model judges a trial.
The evals show if a prompt change or a tool change keeps the decisions of an
agent. The bench repository measures the full analysis, and this package does
not.

This package is young. The mechanisms below are the current ones, not a contract.
If a better method shows up, change the code, and then change this file to match
it.

## How a trial runs

- `bunfig.toml` preloads `harness-source.ts`. It resolves `@inflexa-ai/harness` to
  the harness source of this checkout. Thus a prompt edit reaches the next run
  with no build.
- `lib/agent.ts` builds each agent with its real factory, over deps that no tool
  reaches. The model sees the system prompt and the tool definitions of
  production.
- Each tool of a trial is scripted. A scripted tool keeps the id, the description,
  the schema, and the approval hook of the real tool. Only `execute` changes.
- `REAL_TOOL` keeps the real `execute`. Use it for a tool with no side effect, for
  example a submit tool that only parses its input.
- `lib/run.ts` runs the real loop in the process. No DBOS, no database, no
  sandbox, and no network takes part, except the model provider.
- A call of `run_script` is followed in the trial by the calls of its script.
  These nested calls have no input.
- A sandbox case with `summary` asks the step agent for its step summary after
  the task, with the request of the step workflow. With `summary: "only"`, the
  task does not run. The history of the case is the transcript of the task, and
  only the summary request runs. Use it when the scripted exec cannot give a
  result that the agent trusts.
- A conversation case with `compact` runs the compaction exchange of a chat
  turn on the history of the case, and not the turn.
- The `planner-knowledge` agent is the planner with `knowledge_recommend` and
  `knowledge_check`, as when the embedder binds a knowledge endpoint. A case
  scripts both tools.
- `--exposure` moves the plain file tools of each agent that runs scripts.
  `base` is production. `read-both` adds the read tools to the script tools and
  keeps them direct. `read-write-both` also adds `write_file`. `read-script`
  removes the read tools from the direct tools. The prompt digest changes with
  the exposure.

## Run the evals

Run `bun run evals` with no command for the usage. `main.ts` owns the flags.

Each trial makes paid model calls. Thus `bun test` runs only the unit tests of
`lib/`, never a case.

`--model <id>` runs a different model through the connection and the
credential of the CLI.

A trial that reaches its time bound is an error, not a failed grade. A stalled
provider gives no reply, and an error fails the gate of `compare`.

With no `--provider`, a run uses the conversation model of the CLI configuration.
The conversation agent holds the host tools of the CLI. Thus the CLI must resolve
the harness of this checkout. If the run refuses the CLI, run `bun run
harness:local` in `cli/`.

A report is a JSON file. It holds the grade and the token usage of each trial.
Only a failed trial also keeps its calls and its text, because they explain the
failure. A passing trial keeps the names of its calls in `tools`. A name ends
with `!` when its call gave an error result. The prompt digest of a report
identifies the prompt variant that ran.

A run writes its report to `results/`, under the commit that ran, the start time,
and the prompt digest. Commit the report with the change that it measures. A
report of a commit with uncommitted changes carries `-dirty`, thus it is not a
baseline that a later run can trust.

`results/` holds only the latest report of each case set, as the baseline of the
next change. When a run replaces a report, delete the old report. Git keeps the
history.

## Measure a change

Do these steps for each change of a prompt or of a tool description:

1. Find the baseline in `results/`: a report with the prompt digest of the code
   before the change, and the same provider, cases, and trial count. Match on the
   digest, not on the commit: a rebase merge gives each commit a new id, and the
   digest names what the model saw. If none exists, run the baseline on the code
   before the change, for example in a worktree.
2. Make one change.
3. Run the candidate with the same provider, cases, and trial count.
4. Run `compare` on the two reports. A regression of a case, a regression of a
   set, a case that only one report holds, or a trial error fails the gate.
5. Read each failed trial before you change a prompt. Find the cause in its
   detail, its calls, and its text.
6. Compare the cost, not only the pass rate. `compare` gives the token volume
   of each case. A set whose cost rises fails the gate.

A failed trial has one of two causes:

- A case defect. Fix the case. Some examples:
  - a scripted result that lacks the data of the question
  - a `maxSteps` that is too low for a correct path
  - a grader that a correct agent fails
- An agent defect. Change the prompt or the tool, and measure again.

The method is to cut, then measure, then adjust. Remove the prompt text that
the agent does not use. If a case then fails, add the smallest text that fixes
that failure. A prompt rule that no failure calls for is load on each request.

Tune against the `dev` set. The `held-out` set shows an overfit, thus keep it out
of the tune loop.

Five trials give a wide interval. Five passes of five give a 95 % interval of
about 57 % to 100 %. A difference of one trial is noise. Use more trials for a
decision with a high cost.

The cache changes the cost of input tokens. One weight that tracks the price of
Anthropic is: fresh input, plus 1.25 times the cache writes, plus 0.1 times the
cache reads. But the state of the cache changes between two runs, and that
noise can be larger than the effect of a change. Thus `compare` uses the token
volume: each input token, plus five times each output token.

## Keep or revert a change

These rules come from [Automating eval design and
hillclimbing](https://claude.dev/blog/automating-eval-design-and-hillclimbing/).

- Before the first change, run the baseline two times. If the noise between the
  two runs is larger than the smallest gain that you act on, add trials first.
- Make one change in each round. Make it large enough to show above the noise.
  Fix the cause of a failure: write the section that causes it again, or add
  the missing rule. Do not only change the words of one line.
- Keep a change only if the `dev` set and the `held-out` set both improve, and
  neither regresses. If `dev` improves and `held-out` stays flat, the change
  fits the cases, not the behavior. Revert it.
- If a gain is inside the noise, do not keep the change.
- Never copy a failed case into a prompt. A prompt that names the data of a
  case passes that case and nothing else.
- When the score stops for two or three rounds, sort the failures that remain
  by cause. The cause is often a case defect, a defect of the runner, or
  noise.
- When a set passes at about 95 % or more, the gain that remains is the cost.
  Then the objective is a lower token volume at the same pass rate.

A prompt, a skill, a tool description, and the model are cheap to change and
to revert. Code of the harness is not, thus prefer a change of text for a
climb. A rule that the evals show the model does not obey is the exception: it
goes into code, as `Agent-facing content` in the root `CLAUDE.md` says.

## Design a case

- A case gives a task that production gives. Do not select a task only because
  it is easy to make or to grade.
- Take the tasks first from real failures: a complaint, an issue, or a bug.
  Then add the tasks that a person can justify as hard. Do not select only the
  tasks that the current model fails. Such a set measures the weak points of
  one model, not the behavior.
- The grader checks only what the task states, or what a prompt rule or a tool
  description requires. Two experts must give the same grade to one trial.
- Grade the result of a decision, not a ritual. A grader that requires a call
  that changes no result passes a slow agent and fails a fast one. For example,
  a lookup of a package that the farm always holds is a ritual.
- A case that fails each trial on each model is probably a case defect: an
  ambiguous task, or a grader that refuses a correct answer. Read the trials
  before you change a prompt.
- A more capable model, or a higher effort, must pass at least as often. If
  Opus fails a case that Sonnet passes, look for a case defect first.
- Keep the state of one trial away from the next. A file or a history that
  remains can give the answer to the agent.

## Write a case

The cases are in `cases/`, one file for each agent or topic. The graders and the
history helpers are in `lib/case.ts`.

- Give each case one behavior, and name its origin in `source`: a complaint, an
  issue, or a prompt rule.
- Give each `dev` case a `held-out` twin. The twin tests the same behavior with
  different words and different data.
- Grade the decision: the tool calls first. Use the reply text for a fact that the
  reply must state, for example a count.
- Give the trial what a correct path uses. The scripted results hold the data of
  the question. A file that the user names has a path. `maxSteps` covers the full
  path, and a script path can use more steps.
- Script each tool that a correct path calls. A tool with no script gives an
  error result. A script for a tool that the agent does not hold stops the run.

## Add an agent

1. Add the agent kind and its builder in `lib/agent.ts`. Build the agent with
   the factory of production. If the harness does not export that factory, export
   it from the harness.
2. In `turnInputOf` (`lib/run.ts`), give the first message as production gives
   it. A sub-agent gets its seed. A chat thread gets the user message and the
   context records.
3. Add the cases of the agent, and add them to `cases/index.ts`.

## When the harness changes

The evals import the harness source. A rename in the harness makes
`bun run typecheck` fail here. Fix the evals in the same change as the rename.
