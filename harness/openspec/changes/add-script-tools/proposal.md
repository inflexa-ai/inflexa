# Proposal

## Why

Each request of the conversation agent declared each lookup with its full description and its input schema. The lookups are read-only API calls, and most requests use none of them. Each lookup result also went into the transcript whole, also when the answer needed one field of it. Thus the declared tools filled most of the context of each request: 48 declared tools, about 135k characters for one request.

A script that calls the lookups as functions declares one tool. It reads a full description only when it needs one. It joins and filters the results before the model reads them, and only what it prints or returns reaches the model.

## What Changes

- `AgentDefinition` gets the optional field `scriptTools`: the tools that the agent calls from a script, and that no request declares.
- The new tool `run_script` (`harness/src/tools/script/run-script.ts`) runs one JavaScript script in QuickJS, a WASM VM in a worker thread. The VM has no files, no network, and no timers. `tools.<name>(args)` runs the `execute` of a script tool after a parse of its input. `describe("<name>")` gives the full description and the input type of a script tool. The result is `{ ok, output, value?, error?, calls }`. The deadline of a script is 180 s, and its heap stops at 128 MiB.
- The loop adds `run_script` after the tools of the agent at the open of each conversation, when the agent has script tools (`withRunScript` in `harness/src/loop/run-loop.ts`). It throws for a script tool with an approval hook or one that starts a workflow.
- The conversation agent moves its lookups from `tools` to `scriptTools`. The section "Literature and Biology" of the conversation prompt tells the agent to run its lookups in `run_script`.
- Light work on a table needs no analysis run. Three file tools of a script give a script its only way to a file: `read_table` reads a table of up to 16 MiB through the read seam, and `write_derived` and `render_chart` write a derived file or an SVG chart into `conversation-sessions/{threadId}/derived/`. A derived name holds one file for the life of the session. The heap of the VM grows to 256 MiB, which holds a table of the read cap as rows.
- With a scratch directory, `run_script` saves each script before it runs, shows the derived files and the script in one file card, and gives the reads and the writes to provenance as one `run-script` session event.
- Each nested call streams its start and its end one level below the `run_script` call, thus the activity line of the call shows what the script does. The input gets an optional `description`, which names the call.
- OTel metrics count each script by its failure, and each refused table read by its reason. A rise of the refusals for size and format is the signal for a warm sandbox.
- `show_user` sends data that is not chart-ready to `run_script`, not to a sandbox step.
- The report agent gets `run_script` with its own `read_table` over the pinned evidence and its own `write_derived`, which lands a derivation record of the session. Thus a derivation of a table of up to 16 MiB starts no container. A table over 16 MiB does not derive, because no derivation runs in a sandbox. A nested call of a script gets the code of its script (`ToolContext.script`), because the record holds the code.
- New dependency: `@earendil-works/pi-codemode` 1.4.0, with an exact pin.
- Measured on this branch: one conversation request falls from about 135k to about 64.5k characters, and from 48 to 25 declared tools.

## Capabilities

### New Capabilities

- `script-tools`: the tools that an agent calls from a script, and the `run_script` tool that the loop adds for them. It holds the script API, the isolation and the limits of a script, and its result. It also holds the place of a script in a durable workflow, and the lookups of the conversation agent.

### Modified Capabilities

- `provenance-seam`: a script that reads or writes a file emits one `run-script` event.
- `workspace-layout`: the scratch of a conversation lives under `conversation-sessions/{threadId}/`.
- `echart-layout`: data that is not chart-ready goes through `run_script` and `write_derived`.
- `report-session-agent`: a derivation of a small table runs in a script.

Each of these requirements said that the conversation agent declares a lookup in its tool array. Each now says that the lookup is a script tool of the conversation agent:

- `alphafold-tools`: the requirement that only the conversation agent holds `alphafold_prediction`.
- `amass-tools`: the requirement that gives the Amass tools to the conversation agent and to the drug-repurposing agent.
- `chembl-tools`: the requirement of the per-agent allowlist.
- `pubchem-tools`: the requirement of the per-agent allowlist and the conversation agent.
- `literature-search`: the requirement that names the consumers of the literature tools.
- `uniprot-tools`: "search_protein reaches the conversation agent and the run synthesizer".
- `web-research-tools`: the requirements that attach `web_search` and `web_fetch`.

The requirements of `chembl-tools`, `pubchem-tools`, and `literature-search` named the split tools that the code merged into one tool each: `chembl`, `pubchem`, and `pubmed`. A MODIFIED block holds the whole requirement, thus these blocks name the merged tools. The other requirements of the three specs still name the split tools, and this change does not touch them.

### The overlap with `remove-literature-reviewer`

The open change `remove-literature-reviewer` touches two of the same specs:

- `literature-search`: the two changes modify the same requirement. This change starts from the text of `remove-literature-reviewer`, thus the text keeps the run synthesizer in place of the reviewer.
- `uniprot-tools`: `remove-literature-reviewer` adds "search_protein reaches the conversation agent and the run synthesizer", and this change modifies it.

Thus archive `remove-literature-reviewer` first. An archive in the other order applies the older text last, and it loses the script tools in `literature-search`. The two changes also edit the "Key Components" section of `harness/CLAUDE.md`.

The lookups of the run synthesizer stay declared tools. The synthesizer reads each lookup result for its PMID record, and that record is a call record of the loop. A nested call of a script has no call record.

## Impact

- New: `harness/src/tools/script/run-script.ts` and its test.
- `harness/src/loop/types.ts` (`scriptTools`) and `harness/src/loop/run-loop.ts` (`withRunScript`, at the open of each conversation).
- `harness/src/agents/conversation-agent.ts`, `harness/src/prompts/conversation.ts`, and the conversation agent test.
- `harness/package.json` and `harness/bun.lock`: `@earendil-works/pi-codemode` 1.4.0.
- The evals script each script tool, and they count a nested call of a script as a lookup (`evals/lib/agent.ts`, `evals/lib/run.ts`).
- **CLI release blocker**: the CLI is a Bun single-file binary. `CodemodeSandbox` loads its QuickJS wasm and its worker file from `node_modules` by default, and the binary has neither on disk. The harness has no option yet that passes `wasm` and `workerUrl`. Under `bun run dev` and Node, `run_script` works. Refer to design.md.
- No data migration. A stored conversation holds the earlier tool calls of a lookup, and the model reads them as history.
