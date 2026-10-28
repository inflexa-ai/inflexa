# Repair a tool name that a proxy alias left behind

## Why

The decision evals run on the CLI model behind CLIProxyAPI. Its Claude cloak renames each client tool to `mcp__<server>__<word>_<tool>`, and it maps the name back on the response. The model sometimes drops the `mcp__<server>__` part. Then the proxy maps nothing back, and the loop gets a call of `<word>_<tool>`, for example `art_read_file` or `round_run_script`. The loop answers it as an unknown tool, and the model spends a request on a second call. The eval reports show such calls in about 2% of the trials since the step that added `run_script`. The upstream issue (router-for-me/CLIProxyAPI#6848) is closed as not planned, and its reporter remaps the name on the client side.

## What Changes

- The loop gives the AI SDK a `repairToolCall` function. For a call of an unknown tool whose name is one lowercase word, an underscore, and a declared tool id, it gives the call of that tool, and it logs the alias. Each other repair stays with the default: no repair.
- A declared tool always keeps its own name, thus the repair cannot change a call of a real tool.

## Impact

- New: `harness/src/loop/tool-name-repair.ts` and its test.
- `harness/src/loop/run-loop.ts`: the `repairToolCall` option of `streamText`.
