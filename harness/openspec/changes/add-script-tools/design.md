## Context

See proposal.md, "Why". The current state before the change:

- Each request of a conversation declares each tool of the agent with its description and its JSON input schema. The prompt cache of the provider matches only an unchanged prefix, thus the tools stay the same for each request (the harness-agent-loop capability).
- The conversation agent declared its lookups beside its other tools. A lookup is a read-only API call that asks no approval and starts no workflow.
- Inside a workflow, each tool call that starts no workflow is one durable step `<tool>.<toolCallId>` (`adaptTools` in `loop/tool-adapter.ts`). A replay gives the output of the step from the cache.
- `docs/code-sandbox-research.md` compares the runtimes for "codemode", and it recommends `@earendil-works/pi-codemode`.

## Goals / Non-Goals

**Goals:**

- Cut the context of each request of the conversation agent.
- Let the model join and filter lookup results before it reads them.
- Keep the declared tools of a conversation the same for each request.

**Non-Goals:**

- No script tool that writes, asks an approval, or starts a workflow.
- No durable step for each nested call. Refer to "A script is one durable step".
- No output schema for a script tool.
- No script tools for the run synthesizer, the planner, the analogical reasoner, or a sandbox agent. They keep their declared lookups. The synthesizer needs the call record of each lookup for its PMID check, and a nested call has no call record.

## Decisions

### The loop adds run_script, not the agent factory

An agent names its script tools in `AgentDefinition.scriptTools`. `withRunScript` adds `run_script` in `openConversation`, which `runLoop` and `continueLoop` both call. Thus the run, the salvage, each follow-up request, and each compaction exchange declare the same `run_script`. Its description is a function of the script tools only, thus the prefix of each request stays the same.

`run_script` comes after each tool of the agent, the host tools included. An agent with no script tools goes through unchanged.

### QuickJS through pi-codemode

`run_script` runs each script in a new `CodemodeSandbox`: QuickJS-NG in its own WASM instance, in a worker thread. The reasons, from the research:

- The only capability of a script is the tools that the host gives. No file rule and no network rule is necessary.
- It runs on Node and on Bun, in the harness process. Thus no host gets a new backend.
- The research gives each other candidate a defect for this use. A sandbox container takes seconds to minutes to start. isolated-vm and workerd had critical escapes in 2026. `node:vm` is no boundary. Programmatic tool calling ties the harness to one provider.

The package is young, thus `harness/package.json` pins 1.4.0 exactly.

### A nested call runs the execute of the tool directly

`tools.<name>(args)` parses `args` with the Zod schema of the tool. Then it runs `execute` with the `ToolContext` of the `run_script` call, and gives the JSON of the ok value. A failed parse and an `err` result throw a JavaScript `Error`. The nested call does not go through the tool adapter, thus it has none of these:

- tool events and a call detail
- the call policy: a mask, a budget, or a guard over the id of a lookup does not stop a nested call
- the cut of a long result: the script reads the whole value
- a call record or a result image: the JSON copy drops the symbol keys
- the repair of a stringified argument

The `run_script` call itself goes through the adapter. Its events, its cut, and the call policy apply to it. The conversation agent sets no mask, budget, or guard on a lookup.

### A script is one durable step

`run_script` starts no workflow, thus inside a workflow it is one step, the same as each other tool. A replay gives the cached result of the script and runs no nested call again. A crash during a script runs the whole script again on recovery, with each lookup in it.

The research recommends a different path: the VM in the workflow body, with a step for each nested call and a deterministic clock and seed. That path lets a script call a tool that writes. This change has only read-only script tools, thus a second run costs time and API quota, and nothing else. `withRunScript` refuses a script tool that asks an approval or starts a workflow, because neither can run inside a step.

### The description is the script API and a catalog

The description of `run_script` gives the script API and one catalog line for each script tool: its id and the first sentence of the first line of its description. `describe("<name>")` gives the full description and a TypeScript-like input type (`renderToolSample` of pi-codemode). Thus the first sentence of a lookup description must say what the lookup does, and the agent reads the rest on demand.

### The result

The result is `{ ok, output, value?, error?, calls }`. A failed script is an ok result with `ok: false`, thus the model reads the printed output and the calls before the failure. `output` keeps its first and its last 12,000 characters above 24,000 characters. `run_script` does not bound `value`, and the loop cuts a long `run_script` result the same as each other result.

### The limits

A script ends at 180 seconds, for each call in it together. The heap of the VM stops at 128 MiB, because a script holds lookup results and small tables, not datasets. The signal of each nested call joins the signal of the `run_script` call and the signal of the sandbox.

## Risks / Trade-offs

- [A bundled host has no VM files on disk] → `CodemodeSandbox` loads its QuickJS wasm and its worker file from `node_modules` by default. A Bun single-file binary has neither on disk. The harness ships both in `dist/` (`tools/script/quickjs.wasm`, `tools/script/codemode-worker.js`), and `ScriptRuntime` takes their embedded paths. The CLI build embeds both and gives the paths. A host that runs from `node_modules` (Cortex under Node and `tsx`, the CLI under `bun run dev`) gives nothing.
- [The model reads a result without a type] → The script tools declare no output schema. The catalog gives each input signature, but no result type, thus the model reads the result defensively. Output schemas are a follow-up.
- [The user sees one call] → A nested call emits no tool event of its own. The user sees one `run_script` call, with a result detail that lists the nested tools. A lookup no longer shows to the user at the time it completes.
- [A rule past the first sentence of a description] → The model reads it only through `describe`. An example is the rule of the structure card in the description of `alphafold_prediction` (the structure-presentation capability).
- [A crash reruns each lookup of a script] → The lookups are read-only, thus the cost is time and API quota.
- [No cap on the workers] → Each `run_script` call starts one worker, and `acquireWorker` is not used. Many calls in one reply start many workers, each with a heap of up to 128 MiB.

## Migration Plan

No data migration. A stored thread holds the direct lookup calls of its earlier turns, and the model reads them as history. The declared tools change one time at the upgrade, thus the prompt cache of each thread misses one time.

## Open Questions

- When a script tool must write, does the VM move into the workflow body, with a step for each nested call?
- Which worker cap fits the harness pod on EKS?
