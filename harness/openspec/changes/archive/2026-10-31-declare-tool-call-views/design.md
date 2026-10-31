# Design

## Context

See proposal.md for the reason. The first version of #785 is in the archived changes `2026-10-30-carry-tool-call-values-and-data-shape` and `2026-10-30-bound-tool-call-value-cost`. This change keeps their cap, their head and tail split, their windowed cost bound, the order of the cleaning steps, and the stored display. It changes what a value holds and who decides it.

Facts that shape the approach:

- `describeCall` is a required decision of `defineTool`, a function or `"none"`, and the sentinel goes at construction (`src/tools/define-tool.ts:256`, `:359-363`). `describeResult` is optional (`:286`). Each gives one line of at most 120 code points (`src/loop/tool-detail.ts:95-104`). The Flamme chip, the cli tool line, and the step activity show that line as a label. Thus neither hook can carry a value.
- The raw `input` of the loop event `tool-started` has two readers, the step activity (`src/workflows/sandbox-step.ts:608`) and the profile activity (`src/tasks/data-profile.ts:800`). Each passes it to a resolver that runs `computeDetail` again (`src/sandbox/sandbox-step-translate.ts:97-100`, `src/tools/detail-resolver.ts:51-54`). The tool adapter already put that same detail on the event (`src/loop/tool-adapter.ts:216-229`). Only the call-policy events carry no detail (`src/loop/run-loop.ts:872-923`). `toolsById` is in scope there (`run-loop.ts:~823`).
- The run-stream forwarders send the whole loop event (`src/workflows/sandbox-step.ts:606`, `src/workflows/execute-analysis.ts:864-869`). Cortex sends each entry of a run stream to the browser with no filter (`cortex/managed/http/run-stream.ts:406-440`).
- `toChatFrame` lives in a module that imports only types from outside `src/contracts/`, because a browser loads it (`chat-frame-translation` spec).
- `run_script` already emits a `data-subagent-activity` part with each nested call (`src/tools/script/run-script.ts:404-430`, `:488`) and a `data-file-reference` card with the saved script (`:489-492`). A failed script is an ok outcome with `ok: false` (`:518`).
- The values are not in a published harness version: `harness/package.json` is 0.48.0, the release commit `baff42f3`, and the values came after it. Flamme and the cli do not read the values yet.

## Goals / Non-Goals

**Goals:**

- A value shows only when its tool declares it, and a missing decision fails the typecheck.
- A host can select a renderer from the kind of a value, with no parse of a text that the cap can cut.
- No raw input of a call rides on any event, thus no forwarder can leak it.

**Non-Goals:**

- No renderer in Flamme or in the cli TUI. Each host does that in its own change.
- No `code` kind for the file tools. `read_file`, `write_file`, and `edit_file` can mark a language later, from the extension of the path.
- No per-turn budget for the stored display. The cap bounds each leaf, and the bound of each call stays as before.
- No change to `redactSecrets` or to the redaction of a user message.

## Decisions

### D1. A new required `view` decision, beside `describeCall`

`ToolDefinition` gets `view: ToolCallView<Input, Output> | "none"`. `ToolCallView` has the optional members `input(input)`, `result(input, result)`, and `error: true`. `defineTool` drops the sentinel, and it binds the view as it binds `describeCall`. The packaged `Tool` carries `view?`.

The decision is required, as the user asked, and as `describeCall` is. An absent key would also show nothing, thus it would be leak-safe. The required key adds a decision of the author, and a forgotten view fails the build. The cost is one line at each `defineTool` call: the production tools, the cli host tools, and the test fixtures. Cortex defines no tool.

Alternatives:

- A full value by default, with an optional hook that narrows it. The user refused it: an author that forgets the hook leaks the value.
- An extension of `describeCall` or `describeResult`. Each is a one-line label by contract, and three hosts show it as a label. A result view also needs the ok value, which `describeCall` never sees.
- Separate `showCall` and `showResult` fields. Two required fields double the sweep, and they add no safety.

### D2. The member runs at the emit site, under the same guard as the detail

The tool adapter runs `input` on the parsed input before the dispatch, and `result` on the ok value after the call. An input that fails the parse gives no input value, but the error of the call still shows when the view declares `error`. A throw, a value that cannot serialize, or a value that breaks a rule of D3 gives no value of that member, and the adapter logs a warning. A member that gives `undefined` gives no value. The value never fails a call. `error: true` shows the error message of the call, the `error` field of the text that the adapter writes for the model, as a `text` leaf.

The call policy runs `input` and `describeCall` of the tool from `toolsById` for a refused call and for a denied call. A refused call shows the refusal text as its `error` for each tool. The call policy writes that text, and it holds no data of the tool.

### D3. A value has a kind, and a helper makes each kind

`ToolCallValue` is a union in `src/contracts/chat-events.ts`:

```ts
type ToolCallLeaf =
    | { kind: "text"; text: string; cut: boolean }
    | { kind: "json"; text: string; cut: boolean }
    | { kind: "code"; language: string; text: string; cut: boolean };
type ToolCallValue = ToolCallLeaf | { kind: "fields"; fields: Array<{ name: string } & ToolCallLeaf> };
```

A member gives `unknown`. A string gives a `text` leaf, and each other plain value gives a `json` leaf. A new module `src/tools/tool-view.ts` exports `viewText`, `viewJson`, `viewCode`, and `viewFields`. Each returns an instance of a class of that module, and the emit site tests the class with `instanceof`. The lint rules of the harness refuse a type predicate on `unknown`, thus a class is the test that they permit. The emit site makes a kind only from such an instance, thus a tool result with a field named `kind` stays a `json` leaf. `viewJson` writes a string as a JSON string. The barrel `src/index.ts` exports the helpers and the types, because an embedder defines tools.

The rules are in the spec: at most 4 fields, a bounded name, a bounded language, and no `fields` inside `fields`. The contract module keeps only types. The helpers and the checks live outside `src/contracts/`.

Alternatives:

- A `kind` with no `fields`. Then the result of `run_script` is one JSON text of the output and the value. A cut text of that JSON cannot be parsed, and the printed output shows with escaped line breaks.
- A `run_script` data part, as `data-file-reference` is. It needs a registry entry, a schema, a stored-display case, and host code in Flamme and in the cli. It also makes the tool a second place that cleans a value.

### D4. Each leaf gets the steps of the first version

The emit site cleans each leaf with the existing functions of `src/loop/tool-value.ts`: `text` and `code` as a text, `json` as a JSON value. The cap, the head and tail split, the marker line, and the windows stay. A `fields` value holds at most 4 leaves, thus a value holds at most 4 cut texts and their markers. The two values of a `run_script` result and of a `run_inflexa` result hold at most two leaves each.

### D5. The loop event carries the shown values, and no raw input

`EmitEvent` `tool-started` loses `input: unknown`. `inputValue`, `resultValue`, and `errorValue` become `input`, `result`, and `error`, with the type `ToolCallValue`. `toChatFrame` copies them by their names. The step activity and the profile activity read `event.detail`, and `activityForTool` takes a name and a detail. The resolver `src/tools/detail-resolver.ts` has no caller after this, and it goes with its test. `run_script` emits its nested start frame with no raw input.

Alternatives:

- Rename the raw field to `rawInput`. The raw value then still rides on each forwarded event, and each new forwarder must remember to remove it.
- Remove the raw input only at the two forwarders. The same risk applies to each new forwarder.

### D6. Only a root call carries values

The tool adapter makes values only when `run.source.callPath` has at most one entry, the test of `isRootFrame`. The display recorder and `applyChatFrame` keep the root frames only, and the activity of a sub-agent holds no value. Thus a value on a sub-agent call costs stream bytes that no reader shows. A step agent of a run is a root loop, thus it makes values, and the forwarder removes them (D7).

### D7. The run-stream forwarders remove the values

`withoutToolValues` removes `input`, `result`, and `error`. With D5, the forwarded event holds no raw input. The write stays, thus no workflow operation changes, and no `DBOS.patch` is necessary.

### D8. The new secret forms

`src/input-sanitization.ts` gets these rules for a value only: a private-key block, the password of a URL, and a `--name value` or `--name=value` flag. It also gets the password of a `-u user:password` option, a `name: value` pair of a header or of YAML, and a `Cookie` or `Set-Cookie` header. The probe of the challenge found each of these forms in a value. A key-block end line with no begin line hides the text before it, because the last window of a long text can start inside a block. The quoted-field rule also matches a number or a bare word. `pass` and `cookie` join the secret words. In a JSON array of strings, the element after a secret `--name` element and the password of the element after `-u` or `--user` go too, because an argv array divides a flag from its value. The detail gets the same text forms before its collapse to one line, because the detail of a command tool holds its argv. The words do not get `pwd`, because `PWD` is the working directory in an environment. `redactSecrets` does not change, because its spec forbids a key-value rule for a user message. The spec lists the forms and does not promise that no secret leaves the server. The view is the control for each other form.

### D9. The views of the root tools

The user approved this set:

| Tools | View |
|-|-|
| `run_script` | `input`: `viewCode("javascript", code)`. `result`: `viewFields` of `output` and `value`, or of `error` and `output` for a failed script. `error: true` |
| `write_file`, `edit_file`, `update_working_memory`, `workspace_search`, `list_files`, `file_stat`, `scan_inputs`, `inspect_run`, `inspect_data_profile`, `inspect_capability_data`, `list_available_refs`, `list_available_packages`, `examine_page`, `list_pinned_artifacts` | `input`, `result`, and `error: true`, each the whole value |
| `read_file`, `grep`, `read_tool_output`, `generate_plan`, `execute_analysis` | `input` and `error: true` |
| cli `run_inflexa` | `input`, `result`: `viewFields` with `status`, then `exitCode` for `ran`, `stdout` and `stderr` when not empty for `ran` and `timed_out`, and `message` for `invalid` and `blocked`. `error: true` |
| cli `manage_inputs` | `input`, `result`, and `error: true` |
| Each other tool, and the cli `list_launch_dir` | `"none"` |

The view of `run_script` holds no nested call and no file: the activity part and the file card carry them. The description of the script is its detail. The printed output keeps its own bound of 24,000 characters, then the cap of each leaf.

## Risks / Trade-offs

- [The required key touches each `defineTool` call, the test fixtures included] → A scripted sweep adds `view: "none"` beside each `describeCall`. Then the approved tools get their views by hand.
- [A step agent computes values that the forwarder removes] → The windowed bound limits the cost of each value. The step agents use the file tools, which hold views.
- [A stored row of this branch holds a value with no `kind`] → The values are not released. Such a row can fail the display schema, and the reader drops the part, as it drops each retired part. No migration.
- [A view shows a secret in a form that no rule matches] → The view is the control, and a tool author narrows it. The spec lists the forms that the rules remove.
- [An embedder that defines a tool must add a `view` at the next harness version] → The type error names the field. The cli host tools change in this change.

## Migration Plan

No data migration. The cli changes its host tools in the same working tree. The cli CI links the working-copy harness. A cli release comes after the harness publish and the pin bump.
