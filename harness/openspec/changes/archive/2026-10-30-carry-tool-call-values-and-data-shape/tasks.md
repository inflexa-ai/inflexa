# Tasks

## 1. The values of a tool call

- [x] 1.1 Add `ToolCallValue` to `harness/src/contracts/chat-events.ts`, and the optional `input` on `ToolStartedEvent` and `input`, `result`, and `error` on `ToolFinishedEvent`. Mirror them in `contracts/schemas/chat-events.ts`
- [x] 1.2 Add the optional `input`, `result`, and `error` to `ToolCallPart` in `harness/src/contracts/message.ts`. Export `ToolCallValue` from `harness/src/index.ts` beside `ToolCallDetail`, and from `harness/src/contracts/index.ts` beside `ToolStartedEvent`
- [x] 1.3 In `harness/src/input-sanitization.ts`, add the secret removal for a value of a tool call (design D6). Leave `redactSecrets` unchanged
- [x] 1.4 In `harness/src/test/input-sanitization.test.ts`, cover each rule of D6: a field name at depth, an env assignment, a quoted JSON field, and a prefixed token. Also cover a sequence and `max_tokens`, which must pass
- [x] 1.5 Add the value module in `harness/src/loop/`: one function for a JSON value and one for a text, with the steps of D6 in their order
- [x] 1.6 Add `harness/src/loop/test/` tests of the module. Cover a short value, a long value cut to its start and end, and the marker with `cut` true. Also cover a surrogate pair at the cut and a removed control character
- [x] 1.7 Add `inputValue` to the loop `tool-started` event, and `inputValue`, `resultValue`, and `errorValue` to the loop `tool-finished` event, in `harness/src/loop/types.ts`
- [x] 1.8 In `harness/src/loop/tool-adapter.ts`, fill the values from the input and from the settled output before `cutLongOutput` (D3, D4)
- [x] 1.9 In `harness/src/loop/run-loop.ts`, give `inputValue` on each event of a refused or a denied call, and the refusal text as `errorValue` of a refused call
- [x] 1.10 In `harness/src/loop/test/run-loop.test.ts`, assert the emitted values of an ok call, a failed call, a refused call, and a denied call. Also assert a result over the cap
- [x] 1.11 In `harness/src/contracts/chat-frame.ts`, copy the values in `toChatFrame` and set them in `applyChatFrame`. Cover the new scenarios of the chat-frame-translation delta in `contracts/test/chat-frame.test.ts`
- [x] 1.12 Add the three optional fields to `ToolCallDisplaySchema` in `harness/src/memory/conversation-display-storage.ts`
- [x] 1.13 In the memory tests, show that a recorded turn stores the values and that the replay gives them. Show that an old row with no value reads with no key. Add the values to the live and reload parity test
- [x] 1.14 Add a test that reads the frames of a turn from its stream and gets the input, the result, and the error of a call. Make sure that a secret of the input appears in no frame and in no stored part
- [x] 1.15 Add one helper in `harness/src/loop/` that drops the three values from a loop event. Call it where `harness/src/workflows/sandbox-step.ts` and `harness/src/workflows/execute-analysis.ts` forward under `data-loop-event`, and add a test

## 2. The shape of the data

- [x] 2.1 Add `DataProfileShape` and the optional `shape` on `DataProfileResult` in `harness/src/contracts/data-profile.ts`. Export the type from `contracts/index.ts` and `harness/src/index.ts` beside `DataProfileResult`
- [x] 2.2 Add the optional `shape` to `ProfileSubmissionSchema` in `harness/src/schemas/data-profile-schemas.ts`, with a `.describe` text for the agent
- [x] 2.3 Copy `shape` in `buildDataProfileResult`. In `buildAbsorbedResult`, keep the prior `shape` only when the input signature did not change (design D11) (`harness/src/tasks/data-profile.ts`)
- [x] 2.4 Add the shape section to `harness/src/prompts/sandbox/data-profiler.ts` with the rules of the data-profile-init delta
- [x] 2.5 In `harness/src/tasks/test/`, test a submission with a shape, one with no shape, and a refused bad shape whose error names the field. Also test an absorbed snapshot over changed inputs that drops a prior shape, and one over the same inputs that keeps it
- [x] 2.6 In `cli/src/server/routes/runs.test.ts`, under the `GET {A}/data-profile` describe, add a test that the stored `shape` reaches the response. Also show that a stored result with no `shape` gives a response with no `shape` key. Run the test file with `bun run test` in cli, and do not run `bun run harness:local`

## 3. Coordinator checks

- [x] 3.1 After groups 1 and 2, run `bun run harness:local` and `bun run typecheck` in cli
- [x] 3.2 Run the after half of the approved measurement, and record the before and after numbers in design D12
