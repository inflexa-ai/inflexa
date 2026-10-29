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

## Run the evals

Run `bun run evals` with no command for the usage. `main.ts` owns the flags.

Each trial makes paid model calls. Thus `bun test` runs only the unit tests of
`lib/`, never a case.

With no `--provider`, a run uses the conversation model of the CLI configuration.
The conversation agent holds the host tools of the CLI. Thus the CLI must resolve
the harness of this checkout. If the run refuses the CLI, run `bun run
harness:local` in `cli/`.

A report is a JSON file. It holds each trial: the grade, the calls, the text, and
the token usage. The prompt digest of a report identifies the prompt variant that
ran.

A run writes its report to `results/`, under the commit that ran, the start time,
and the prompt digest. Commit the report with the change that it measures. A
report of a commit with uncommitted changes carries `-dirty`, thus it is not a
baseline that a later run can trust.

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
6. Compare the cost, not only the pass rate. Use the `usage` of each trial.

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
cache reads.

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
