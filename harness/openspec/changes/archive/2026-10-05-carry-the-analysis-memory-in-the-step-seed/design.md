## Context

The parent workflow `executeAnalysis` composes the seed of each step at its dispatch. `composeStepSeed` (`src/workflows/execute-analysis.ts`) runs inside `DBOS.runStep` with the name `compose-step-seed:<stepId>`. Thus DBOS records the seed, and a replay gives the recorded string. The function reads the data-profile status and the upstream handoffs. Then it calls `composeStepBriefing` (`src/prompts/briefing.ts`), which is a pure renderer.

Working memory (`src/memory/working-memory.ts`) holds four sections: the goal, the constraints, the hypotheses, and the findings. Only the conversation agent reads it, and only the conversation agent writes it. A step agent has no memory tool.

## Goals / Non-Goals

**Goals:**

- Give each step agent the goal and the constraints of the analysis, each constraint with its origin.
- Keep the seed stable under a replay.
- Keep the system prompt of a sandbox agent a function of its agent type only.

**Non-Goals:**

- A memory tool for a step agent. The copy is read only.
- The hypotheses and the findings in the seed.
- A change of the store, of its caps, or of the chat render.

## Decisions

### One function does the reads, and the renderer stays pure

`gatherStepPackage` does each read for the package of one step: the data-profile status, the upstream handoffs, and working memory. It gives the `StepBriefing` value. `composeStepSeed` calls it, and then it calls `composeStepBriefing`. Thus a new section adds a read in one place, and the renderer stays a pure function of its data.

### The memory is read at the dispatch of each step, not one time for each run

The harness reads working memory in `gatherStepPackage`, inside the checkpointed step of each dispatch. It does not read it one time at the start of the run.

The conversation agent can edit working memory while a run is live. Because of this decision, an edit reaches each step that the scheduler dispatches after the edit. As a result, two steps of one run can see different memory states. A step that started before the edit keeps its old copy.

The alternative is a copy at the start of the run in `ExecuteAnalysisInput`. That copy gives the same memory to each step of the run. But a new rule from the user then waits for the next run. The plan data of a run stays a snapshot, because a plan edit must not change the task of a live run. A memory edit is a different item. It states a rule of the analysis, not a task of a step.

The read is inside the checkpointed step. Thus a replay gives the recorded seed, with the memory state of the first dispatch.

### A failed read leaves the section out

A failed memory read does not stop the step. The seed step logs a warning and composes the seed without the memory section. The memory is context for the step, and the plan step already carries its own constraints. Thus a database fault on the memory table must not stop the dispatch of an analysis.

DBOS records the seed string. Thus a replay of that step also gives a seed without the section. The warning in the log names the analysis and the step, so that the fault stays visible.

### The composition root gives the store

`ExecuteAnalysisDeps` gets the field `workingMemory: WorkingMemoryStore`. The bag of `buildExecuteAnalysis` in `CoreWorkflowDeps` omits it. `assembleCoreRuntime` gives `createWorkingMemory(conversation.pool)`. Thus the step seeds read the table that the conversation agent writes, and an embedder cannot give a different store.

### The section has its own heading and states the origin

The section starts with `## Analysis memory (read only)`. The plan step has its own section, `Constraints (each one is a requirement of this step)`. The two headings are different, because the two lists have different sources.

The section tells the agent to obey a constraint from the user. It tells the agent to use a constraint from the agent as context. Each constraint shows its origin in parentheses. The section shows no entry id, because the step agent cannot address an entry.

The renderer obeys `WORKING_MEMORY_LIMITS`. It clamps the goal and each constraint text. It shows the newest constraints up to the cap, and it counts the older ones. A memory with no goal and no constraints gives no section.

### The system prompt names the section, with no interpolation

The orient core (`src/prompts/sandbox-standards.ts`) gets one paragraph in "Your Briefing Is Authoritative". It names the heading as literal text. Thus the system prompt stays a constant for each agent type, and the prompt cache keeps its prefix. A test makes sure that the orient core and the renderer use the same heading.

## Risks / Trade-offs

- Two steps of one run can obey different constraints. → This is the intended result of the read at each dispatch. A step that must obey a new rule starts after the edit.
- The seed grows by the size of the memory section. → The caps limit the section to a goal of 500 characters and 20 constraints of 300 characters.
- A failed memory read gives a step without the constraints of the memory. → The plan step carries its own constraints, and the log records a warning with the analysis and the step.

## Open changes on the same capability

The open changes `compact-the-chat-thread` and `save-each-chat-round-and-add-context-on-change` also change `harness-working-memory`. This change only adds a requirement. It changes no requirement of the two changes.
