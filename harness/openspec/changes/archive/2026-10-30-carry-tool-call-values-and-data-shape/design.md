# Design

## Context

### Tool calls

The loop emits `tool-started` and `tool-finished` from the tool adapter (`harness/src/loop/tool-adapter.ts:215-238`) and from the call policy (`harness/src/loop/run-loop.ts:874-889`). The loop `tool-started` already carries the raw `input` (`harness/src/loop/types.ts:80-93`). The data-profile activity reads that raw input (`harness/src/tasks/data-profile.ts:800`), and the step forwards each raw loop event to its run stream (`harness/src/workflows/sandbox-step.ts:604-607`).

`toChatFrame` makes the wire frame, and its module imports only types from outside `src/contracts/` (`harness/src/contracts/chat-frame.ts:1`). `applyChatFrame` builds the tool-call part (`chat-frame.ts:176-205`). The display recorder stores the part through `ToolCallDisplaySchema` (`harness/src/memory/conversation-display-storage.ts:110-119`). That schema is not strict, thus zod drops a key that it does not declare.

A `tool-started` from a tool step is a progress frame. A replay of the step does not give it again, thus a round that a recovery stores keeps only the `tool-finished` (`harness/src/loop/chat-stream.ts:49-57`).

The loop cuts a result over 32 KiB for the model (`cutLongOutput`, `tool-adapter.ts:322-340`). `redactSecrets` covers prefixed formats only, and its spec forbids a loose key-value pattern (`harness/openspec/specs/harness-tools/spec.md:156-158`). `normalizeDetail` is the precedent for a value that the emit site cleans one time (`harness/src/loop/tool-detail.ts:95`).

### The data shape

The profiler agent submits through `submit_profile` (`harness/src/schemas/data-profile-schemas.ts:369-412`). `buildDataProfileResult` projects the submission into the snapshot (`harness/src/tasks/data-profile.ts:308-333`). `buildAbsorbedResult` copies the prior snapshot with `...prior` (`data-profile.ts:406-424`). The prompt already sends the agent to `head` or `wc -l` for a data file (`harness/src/prompts/sandbox/data-profiler.ts:79`).

## Goals / Non-Goals

**Goals:**

- Give the input, the result, and the error of a call on the events, on the part, and in the stored display.
- Keep each value bounded and with no secret.
- Give the shape of the primary matrix on the snapshot when the agent measured it.

**Non-Goals:**

- No values on the calls that a `run_script` script makes. Their frames feed only the activity entries of a sub-agent part, and an entry holds no value (`harness/openspec/specs/chat-frame-translation/spec.md:262`). A script can make many calls, thus values there cost stream bytes that no reader uses. The `run_script` call itself carries its values: the code is its input.
- No change to the run stream of a step.
- No change to the redaction of a user message or of a detail.
- No render of the shape in the orientation or in `inspect_data_profile`. Issue #783 asks for the stored field only.
- No per-file dimensions. The snapshot keeps no record per input file.

## Decisions

### D1. One value type, with text and a cut flag

`ToolCallValue` is `{ text: string; cut: boolean }`. A value is text, not a JSON value, because a cut JSON text is not JSON, and a host shows text. `cut` is a field and not a marker in the text alone, thus a host can show a "cut" badge with no parse.

The wire names are `input`, `result`, and `error` on `ToolStartedEvent`, `ToolFinishedEvent`, and `ToolCallPart`.

### D2. The emit site makes each value, and the loop event carries it beside the raw input

`toChatFrame` must stay loadable in a browser, thus it cannot import the redaction code. The emit site makes each value, as it makes the detail. The loop event carries the values in `inputValue`, `resultValue`, and `errorValue`. The raw `input` stays for the activity readers. `toChatFrame` copies `inputValue` to `input`, `resultValue` to `result`, and `errorValue` to `error`.

A new module in `harness/src/loop/` holds the value code: one function for a JSON value and one for a text. The tool adapter and the call policy call it.

### D3. `tool-finished` carries the input again

A replay of a tool step does not give its `tool-started` again. Thus a round that a recovery stores has only the `tool-finished`. The input rides on the `tool-finished` too, as the detail does. Then a recovered round keeps it.

### D4. The values come from the output before the cut for the model

The adapter makes `resultValue` from the ok value, and `errorValue` from the error text, of the settled output before `cutLongOutput`. Thus the display shows the start and the end of the whole text, and not of the excerpt. `cutLongOutput` already serializes the same value, thus the cost does not change in class.

A string value shows as the string itself. Each other value shows as its JSON text, from `JSON.stringify` with no indent.

### D5. The cap: 8,192 code units, the start and the end

The cap is 8,192 UTF-16 code units. A longer text keeps its first 3,072 and its last 5,120 code units, with the line `[... N characters not shown ...]` between them. The end gets more room, because the end of a command output holds its errors. `excerptOf` uses the same split for the same reason. The cut uses `pairSafeIndex` from `harness/src/loop/tool-output.ts`, thus no surrogate pair is divided.

The cap bounds one value. A call has at most two values on each event. Thus a `tool-finished` adds at most about 16 KiB to the stream and to the stored display.

### D6. The secret removal for a value, apart from `redactSecrets`

New functions in `harness/src/input-sanitization.ts` clean a value, beside `redactSecrets`. The value module runs these steps:

1. On a JSON value: replace the value of each object field whose name ends with a secret word. The walk goes to each depth, thus the field `GITHUB_TOKEN` of an `env` object is found.
2. On each string of the JSON value, or on a text: remove the control characters (D7).
3. On the same strings: replace the value of each `NAME=value` assignment and of each quoted `"name": "value"` field whose name ends with a secret word. A quoted value ends at its closing quote, and an escaped quote inside it does not end it.
4. On the same strings: `redactSecrets`.
5. Serialize a JSON value (D4).
6. Cut the text (D5).

Steps 2 to 4 run on each string before the serialization, thus no text rule meets a JSON escape. An error text that parses as a JSON object is a JSON value, because the adapter writes the error of a tool as `{"error": ..., "retryable": ...}`. The value keeps that JSON text form. A string result keeps its own text, thus a JSON file that a tool reads keeps its layout. A string that holds JSON gets the quoted-field rule on its raw quotes. A string that holds JSON inside JSON keeps escaped quotes, and the quoted-field rule does not see that field. The structural rule and `redactSecrets` still apply there.

The secret words are `password`, `passwd`, `secret`, `secretkey`, `token`, `apikey`, `accesskey`, `privatekey`, `credential`, `credentials`, and `authorization`. The comparison ignores the case, `_`, and `-`. "Ends with" and not "holds" keeps `max_tokens`, `tokenizer`, and `tokenCount` intact. Each marker has the form `[REDACTED: <rule>]`, as `redactSecrets` writes.

`redactSecrets` does not change, because its spec forbids a key-value rule for a user message. A name-anchored rule cannot match a nucleotide or a protein sequence, because it needs a secret word before `=` or `:`.

### D7. The control characters

The value code removes each control character except the tab, the line feed, and the carriage return, with `normalizeUnicode`. It runs before the text rules of D6, as in `normalizeDetail`, thus a control byte inside a secret cannot stop a pattern. A terminal host shows the text, thus an escape sequence in a command output is an injection. The step also removes a NUL, which a stored display row cannot hold. As a result, the shown text can differ from the text that the model reads. An ANSI color code of a command output does not show.

### D8. A sub-agent call carries its values too

The emit site does not know whether a frame reaches a display. The tracker of the sub-agent activity does not read the values, and the display recorder keeps the root frames only. The cap bounds the stream cost of each sub-agent call.

### D9. The stream of a run drops the values

A step (`harness/src/workflows/sandbox-step.ts:604-607`) and the synthesis (`harness/src/workflows/execute-analysis.ts:861-869`) forward each loop event under `data-loop-event`. Each removes `inputValue`, `resultValue`, and `errorValue` before it forwards, thus the stream of a run keeps its current content. One helper in `harness/src/loop/` removes the three fields, and the two forwarders call it.

A `data-loop-event` part has no registry entry, thus `parseRunEventPart` never delivers it to a client (`harness/src/execution/run-event-parts.ts:33-46`). The removal saves stream bytes. It is not a secret boundary.

### D10. The stored display

`ToolCallDisplaySchema` gets the three optional fields, with one zod schema for `ToolCallValue` in `contracts/schemas/chat-events.ts`. The replay spreads the stored data, thus it gives them. A row with no field reads as before. No schema version changes, as for `durationMs`.

### D11. The shape is the measure of the agent

`submit_profile` accepts an optional `shape`. Its schema checks positive integers for `rows` and `columns`, and text that is not empty after a trim for the units. `buildDataProfileResult` copies it.

`buildAbsorbedResult` keeps the prior `shape` only when the new input signature equals `prior.inputSignature`. Otherwise it sets `shape` to `undefined` after the spread, thus the stored row has no key. The digest of the signature covers the identity, the size, and the mtime of each input (`harness/src/contracts/data-profile.ts`, `DataProfileInputSignature`). A deliberate re-profile of an unchanged tree is a full absorb (data-profile-rerun spec, "An unchanged tree costs no model call"). Without this rule such a re-profile would lose the shape. A prior row with no signature drops the shape. This rule keeps the reason of the rule that the user approved: new or changed inputs can change the shape.

The user approved this design: the agent picks the primary matrix, it measures the matrix in the sandbox, and it names the units. No code of the harness selects a matrix or names an axis.

The prompt gets one short section with the rules of the spec. The "Do NOT decode a file in full" entry stays: a line count reads a file and decodes no record.

### D12. The cost of the shape

A measurement on the dev server ran four profiles of the current code on synthetic count matrices: 61,533 x 28 with a sample sheet, and 61,533 x 2,000 (600 MB). Each profile took 23 to 31 s with 4 to 6 model calls. In each profile the agent already ran `wc -l` on the matrix in its one `execute_command`. Thus the shape needs no new command in this case.

The same four profiles ran again after the change, on a fresh dev analysis each:

| Fixture | Run | Before: seconds, model calls, output tokens | After: seconds, model calls, output tokens | After: `shape` |
|-|-|-|-|-|
| 61,533 x 28 and a sample sheet | 1 | 27, 4, 2891 | 29, 4, 2595 | 61533 genes x 28 samples |
| 61,533 x 28 and a sample sheet | 2 | 25, 4, 2759 | 24, 4, 2503 | 61533 genes x 28 samples |
| 61,533 x 2,000 (600 MB) | 1 | 23, 6, 2699 | 24, 5, 2201 | 61533 genes x 2000 samples |
| 61,533 x 2,000 (600 MB) | 2 | 31, 4, 2841 | 23, 5, 2291 | 61533 genes x 2000 samples |

Each after profile measured the shape inside its one `execute_command`, and it made no new tool call. The input tokens of a model call grew by about 0.5 K, which is the new prompt section. The differences in time are inside the variation between runs.

### D13. No workflow patch

The change adds fields to stream writes that exist, and it adds no step, no `recv`, no stream write, and no child start. Thus a paused workflow replays with no `DBOS.patch`.

## Risks / Trade-offs

- The cost of a value grows with the size of the value: the field walk, the text rules, and the serialization each read the whole value before the cut. `cutLongOutput` already serializes the same value, thus the class does not change. A review measured about 1 s for a JSON result of 10.5 MB. A tool result of that size is rare, and no cheap bound keeps the field rule exact.
- The JSON text of an input escapes the line breaks of a string, for example the code of `run_script`. A host can parse the text again when `cut` is false, and show the code with its lines.

- A result that holds pictures as base64 text shows the start and the end of that text. The cap bounds it.
- A field whose name ends with `token` and that holds no secret, for example a page token, shows a redaction marker. That costs a display fact only.
- The shape comes from the agent. The resolution does not compute it, as it computes the group counts. The prompt forbids an estimate, and the schema refuses a value that is not a positive integer.
- The profiler prompt changes, thus the first profile after the change pays one new write to the prompt cache.
