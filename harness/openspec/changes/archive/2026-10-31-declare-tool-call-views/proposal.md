# Proposal

## Why

Issue #785 gives a host the input, the result, and the error of a tool call. The first version shows the full value of every tool, with name-based secret rules as the only control. Those rules miss common forms, for example `--password hunter2`, `DB_PASS`, and `https://user:pw@host`. A tool author that forgets a rule leaks the value. The loop event also carries the raw input beside the redacted copy. The run-stream forwarders keep the raw input and remove the safe copy, and Cortex sends that stream to the browser with no filter.

The user decided that a tool shows only what it declares. Each tool must make that decision, as it does for `describeCall`. Thus a forgotten decision fails the build, and it cannot leak a value.

## What Changes

- **BREAKING** `defineTool` requires a `view` decision: a `ToolCallView` with optional `input`, `result`, and `error` members, or the literal `"none"`. A tool with `"none"` shows no value. A tool shows only the members that it declares.
- **BREAKING** `ToolCallValue` becomes a value with a `kind`: `text`, `json`, `code` (with a `language`), or `fields` (an ordered list of named values). A host selects a renderer from the kind. The harness exports helper functions to make each kind in a view.
- The emit site runs the view, then the control-character step, the secret rules, and the cap on each leaf value. A view that throws or breaks a rule gives no value, and the call runs as before.
- **BREAKING** The loop event `tool-started` loses its raw `input`. The loop event names the shown values `input`, `result`, and `error`, as the frame does. The step activity and the profile activity use the `detail` of the event. The call-policy events get their `detail`. The detail resolver has no caller after this, and it goes.
- Only a root call carries values. A sub-agent call and a nested call of a script carry none.
- The run-stream forwarders send no value.
- The secret rules get new forms. They cover a private-key block, a URL password, a `curl -u` password, a `--name value` flag, a header or YAML pair, and a cookie. The word `pass` joins the secret words, and a quoted field can hold a number. The spec lists the forms that the rules remove, and it does not promise that no secret leaves the server.
- The root tools of the chat agents declare their views. Most of them show their input and their result. `read_file`, `grep`, `read_tool_output`, `generate_plan`, and `execute_analysis` show their input only. A display tool and each tool that never reaches a chat display declares `"none"`.
- `run_script` shows its code as `javascript` code. Its result shows the printed output and the returned value as fields, or the script error and the output for a failed script. The nested calls stay in the activity part, and the files stay in the file card.
- The cli host tools declare their views. `run_inflexa` shows its argv, its status, and its stdout and stderr. `manage_inputs` shows its input and its result. `list_launch_dir` declares `"none"`.
- The scenario "A client gets no tool payload" of `chat-turn-stream` changes to the declared values.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tool-call-values`: the view decision, the kinds, the root-only rule, the event fields, the run stream, the secret forms, and the views of the root tools.
- `tool-call-detail`: the activity surfaces read the detail of the event, and the shared resolver goes.
- `script-tools`: the view of `run_script`.
- `chat-turn-stream`: a client gets the declared values of a call.

## Impact

- `harness/src/tools/define-tool.ts` and a new view module beside it, `harness/src/loop/tool-value.ts`, `harness/src/loop/tool-adapter.ts`, `harness/src/loop/run-loop.ts`, `harness/src/loop/types.ts`, `harness/src/input-sanitization.ts`.
- `harness/src/contracts/chat-events.ts`, `contracts/schemas/chat-events.ts`, `contracts/chat-frame.ts`, `contracts/message.ts`, and the export lists in `contracts/index.ts` and `src/index.ts`.
- `harness/src/workflows/sandbox-step.ts`, `harness/src/workflows/execute-analysis.ts`, `harness/src/tasks/data-profile.ts`, `harness/src/tasks/data-profile-activity.ts`, `harness/src/sandbox/sandbox-step-translate.ts`, `harness/src/tools/detail-resolver.ts` (removed), `harness/src/tools/script/run-script.ts`.
- Each `defineTool` call in `harness/src` and in its tests, and the cli host tools `cli/src/modules/harness/inflexa_tool.ts`, `inputs_tool.ts`, and `launch_dir_tool.ts`.
- An embedder that defines a tool must declare a view. Cortex defines no tool. The values are not in a published harness version yet, thus no host reads the old value shape.
- Flamme and the cli TUI do not show the values yet. Each needs a renderer for the kinds in its own change.
