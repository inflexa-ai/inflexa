## ADDED Requirements

### Requirement: run_script shows its code, its output, and its value

`run_script` MUST declare a view of the kinds of `tool-call-values`, thus a host can show a script as code and its result as named parts:

- The input is the `code` leaf of the script, with the language `javascript`. The description of the script is the detail of the call, thus the input does not hold it again.
- The result of a script that succeeded is a `fields` value. Its first field is `output`, a `text` leaf of the printed output. Its second field is `value`, a `json` leaf of the returned value. Each field is absent when the script printed or returned nothing, and a script with neither gives no result.
- The result of a failed script is a `fields` value: `error`, a `text` leaf of the kind and the message of the failure, then `output` when the script printed something. A failed script is an ok outcome of the call, thus its failure shows in the result.
- The view declares `error`, thus a call with the outcome `error` shows its error text.

The view MUST NOT hold again what other parts carry: the nested calls are in the `data-subagent-activity` part of the call, and the saved script and the derived files are in its `data-file-reference` card. The printed output gets its own bound first, then the cap of each leaf.

#### Scenario: A script shows its code

- **GIVEN** a root call of `run_script` with the code `return 1 + 1`
- **WHEN** the loop emits the `tool-started` of the call
- **THEN** its `input` has the kind `code`, the language `javascript`, and the text `return 1 + 1`

#### Scenario: A script shows its output and its value

- **GIVEN** a root call of `run_script` whose script prints `hello` and returns `{ "n": 2 }`
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** its `result` is a `fields` value with `output`, the text `hello`, then `value`, the JSON text `{"n":2}`

#### Scenario: A failed script shows its failure first

- **GIVEN** a root call of `run_script` whose script prints `start` and then throws `Error: boom`
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** the outcome is `ok`, and its `result` is a `fields` value with `error`, which holds `boom`, then `output`, which holds `start`

#### Scenario: The nested calls are not in the value

- **GIVEN** a root call of `run_script` whose script calls a script tool
- **WHEN** the loop emits the `tool-finished` of the call
- **THEN** its `result` names no nested call, and the `data-subagent-activity` part of the call holds the nested call
