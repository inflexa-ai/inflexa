# Proposal

## Why

The run synthesizer reached evidence only through the `literature_reviewer` sub-agent. The reviewer gave back a prose report, thus the lookup results, and each PMID in them, stayed in the transcript of the reviewer. `submit_synthesis` could not find a cited PMID in a lookup result. The prompt of the synthesizer said so: an invented PMID reached the reader as a real citation. Each delegation also ran a full sub-agent loop in a child workflow, under a budget of 3 calls for each run.

The synthesizer was the only caller of the reviewer. The user decided to remove the reviewer, and to give its lookups to the synthesizer.

## What Changes

- The synthesizer holds the lookup tools itself: `search_gene`, `search_protein`, `lookup_annotation`, `search_interactions`, `pubmed`, `resolve_citation`, `drug_gene_interactions`, and `gene_preclinical_profile` (`createSynthesisLookupTools`). The runtime builds them one time, with the bio keys of the embedder and the shared citation resolver. It passes them as `synthesisLookups` through `ExecuteAnalysisDeps` and `SynthesizeRunDeps` into `generateRunSynthesis`.
- The tool surface of the synthesizer is `submit_synthesis`, `report_blocker`, the lookups, and `read_tool_output` when the composition has a tool output store.
- Each lookup records the PMIDs of its ok result. `submit_synthesis` refuses each numeric PMID in `findings[].references[].pmid` and in `keyReferences[].pmid` that no lookup of the run returned, with the message `pmid "<id>" is in no lookup result of this run`. The record is a call record of the loop, thus a replay gives the same set as the first run.
- The synthesis prompt tells the agent to look up its evidence itself. It also says that each cited PMID must be in a lookup result of the run.
- `SYNTHESIZER_MAX_ITERATIONS` goes from 25 to 40. The tool budget `{ literature_reviewer: 3 }` goes.
- **BREAKING:** the `literature_reviewer` tool, `createLiteratureReviewerTool`, the reviewer prompt, and the registered sub-agent workflow `sub-agent.literature-reviewer` go.
- **BREAKING:** `delegationCount` goes from `SynthesisProgressPart` and from `SynthesisProgressPartSchema`. The schema strips an unknown key, thus a stream that an older harness wrote still parses.

## Capabilities

### New Capabilities

- `run-synthesizer`: the agentic loop that writes the synthesis of a run. It holds the loop, its tools, the lookups, and the PMID refusal. It also holds `submit_synthesis`, the run id stamp, the outcome, and the place of the loop in the run workflow. It takes the synthesizer requirements of `literature-reviewer` and of `sub-agent-workflows`. The name is the agent id of the loop (`run-synthesizer`), beside `run-synthesis-outcome` and `run-synthesis-blocker-discipline`.

### Modified Capabilities

- `literature-reviewer`: each requirement goes. The reviewer requirements go with the reviewer. The synthesizer requirements move to `run-synthesizer`, because a capability with the name of a removed agent must not own the synthesizer. The change declares `retire_capabilities: true`, thus the archive deletes the emptied spec.
- `sub-agent-workflows`: the synthesis no longer starts reviewer children, thus that requirement goes, and `run-synthesizer` states the loop in the body of the run. The requirement of two sub-agents in one reply returns under a new name, with a scenario of the analogical reasoner. OpenSpec refuses a MODIFIED block that drops a scenario, thus a REMOVED and an ADDED requirement replace it.
- `uniprot-tools`: `search_protein` reaches the conversation agent and the synthesizer lookups. The requirement for a usage note in a prompt goes, because the synthesis prompt names no lookup tool. The requirement returns under a new name for the same reason as above, and its sandbox rule becomes a requirement of its own.
- `literature-search`: the synthesizer lookups replace the reviewer in the list of consumers of the literature tools.
- `harness-tools`: the reviewer leaves the list of agents that declare `read_tool_output`. The scenario of a sub-agent that reads its own kept text names the analogical reasoner.
- `harness-durable-runtime`: the scenario of the shared citation resolver names the run synthesizer.
- `chat-turn`: the reviewer leaves the list of loops that keep the 5-minute cache.
- `work-pause`: the scenario of a paused sub-agent of a turn names the planner. The reviewer never ran in a turn.
- `llm-usage-accounting`: the scenario of the synthesis phase no longer says that the phase starts sub-agents.

These scenarios keep the reviewer id, because the id there is test data for a generic mechanism, and no scenario says that the reviewer exists:

- `harness-session-model`: `forSubAgent(session, "literature-reviewer")` is an example input of a pure derivation.
- `chat-frame-translation`: the call path `["conversation-agent", "literature-reviewer"]` is an example source of a frame.
- `harness-agent-loop`: the budget of 3 calls of `literature_reviewer` is an example of the budget policy, which stays.

## Impact

- `harness/src/tools/research/synthesis-lookups.ts` (new), `harness/src/execution/run-synthesis.ts`, `harness/src/app/synthesize-run.ts`, `harness/src/workflows/execute-analysis.ts`, `harness/src/runtime/assemble.ts`, `harness/src/schemas/run-synthesis.ts`, and `harness/src/prompts/synthesis-agent.ts`.
- Removed: `harness/src/tools/research/literature-reviewer.ts`, `harness/src/prompts/literature-reviewer.ts`, and the reviewer test.
- `harness/src/contracts/chat-parts.ts`, `harness/src/contracts/schemas/chat-parts.ts`, and `harness/src/sandbox/sandbox-step-translate.ts`: `delegationCount` goes.
- Recovery: a synthesis can be in flight at the upgrade, with a reviewer child workflow that started already. The recovery of that run can fail, because the operations of the body changed. The change adds no `DBOS.patch` path that keeps the reviewer. Refer to design.md.
- The cli and the evals hold the reviewer id only as test data and in comments. No embedder code reads `delegationCount` or builds the reviewer.
