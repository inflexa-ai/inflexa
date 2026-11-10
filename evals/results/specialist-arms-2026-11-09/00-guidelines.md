# Guidelines for a specialist prompt

The body of a specialist prompt is composed before the skill index, the orient
core, and the step standards (`harness/src/agents/sandbox/shared.ts`,
`createSandboxAgent`). Thus the body holds only what those layers do not.

## What the body holds

1. **The stance.** What decides the method. What to distrust. What "done" means.
2. **The boundary.** The inputs it takes, what it hands on, when it stops.
3. **The output contract.** The files and the columns that the next step reads.
4. The tool set is in `meta.tools`, not in prose. A tool describes itself.

## What the body does not hold

- A method tree, a library API, a parameter value. These go to the skill.
- What is installed, which reference is in the store, what the network
  reaches. The tools answer these at run time.
- A rule about how not to use a tool, or an order of tool calls.
- An example that narrows the exploration.

## The exception (round 9)

Method content that nearly every step of the agent uses can stay in the body.
It is cached across steps, and a skill read is not. The test: would at least
half of the steps of this agent read that content?

## The tests for each draft

| Test | Question | Signal |
| --- | --- | --- |
| T1 Branch | How many sentences are true only for one modality or one assay? | Two or more branches with different stances: split. Branches that differ only in tooling: skill. |
| T2 Fold | Remove the stance. What is left that the standards and the executor do not already say? | Nothing: fold into the executor. |
| T3 Drift | Does a fact also appear in a skill or in the standards? | Yes: delete one copy. |
| T4 Weak model | If the model reads no skill, does the stance still stop the most expensive error of the domain? | No: the error belongs in the body, or in code. |
| T5 Contract | Do the column names agree with the standards and with the other specialists? | No: one name wins. |
| T6 Overlap | Can the planner select between this specialist and the others from the capabilities alone? | No: move the boundary. |

## The decision delta

For each specialist, list the decisions where its body changes what the agent
does, compared with the executor body plus the same skills. Each decision in
the list is a domain eval case. A specialist with an empty list folds.
