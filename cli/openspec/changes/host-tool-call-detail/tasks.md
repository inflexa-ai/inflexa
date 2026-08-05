## 1. Take the harness change

- [ ] 1.1 Bump the `@inflexa-ai/harness` pin in `package.json` to the release carrying `broaden-tool-call-detail`, and refresh the lockfile. Nothing below typechecks first; use `bun run harness:local` to work against the local harness until that release exists.

## 2. Declare the host tools' decisions

The new `defineTool` signature requires all three; the compiler will name any that is missed.

- [ ] 2.1 Export `toEffectiveArgv` from `src/modules/harness/inflexa_classify.ts`. It is already pure and synchronous — this only widens its visibility.
- [ ] 2.2 Add the `run_inflexa` hook in `src/modules/harness/inflexa_tool.ts`: normalize with `toEffectiveArgv`, map each element through the file's existing `displayArgvElement`, and join. No leading `inflexa` — the rendering surface prints the tool name itself.
- [ ] 2.3 Add the `manage_inputs` hook in `src/modules/harness/inputs_tool.ts`: the action, plus the path it acts on. Handle the three shapes the schema admits — one path, several paths, and absent `paths` (which `list` always is, and which `add`/`remove` can be, since the field is optional in the schema and enforced in `execute`).
- [ ] 2.4 Declare `describeCall: "none"` in `src/modules/harness/launch_dir_tool.ts`. Its `inputSchema` is `z.object({})`; do not invent a constant detail.

## 3. Source the chip's duration from the event

- [ ] 3.1 In `src/tui/hooks/conversation.ts`, prefer `event.durationMs` over the local `Date.now()` bracket in the `tool-finished` branch, falling back to the bracket when the field is absent. Keep `openTools` and its start stamp — the fallback needs them, and so does pairing an unmatched finished event.

## 4. Test

- [ ] 4.1 Extend `src/modules/harness/inflexa_tool.test.ts`: a word-argv call describes those words; a single-element command string describes the tokenized words rather than the submitted element; an element with embedded whitespace is encoded on the chip exactly as the approval prompt encodes it; a malformed argv is still described.
- [ ] 4.2 Extend `src/modules/harness/inputs_tool.test.ts` for the one-path, several-path, `list`, and absent-`paths` shapes.
- [ ] 4.3 Add a `launch_dir_tool.test.ts` assertion that the constructed tool exposes no `describeCall`.
- [ ] 4.4 Extend the emit-adapter tests in `src/tui/hooks/`: a round whose finished events carry differing durations renders each chip with its own; an event without the field falls back to the observed elapsed time; an unpaired finished event still renders.

## 5. Verify

- [ ] 5.1 Typecheck and lint.
- [ ] 5.2 `bun test`.
- [ ] 5.3 Open a chat and confirm on a real transcript that a multi-call round no longer shows one repeated duration, and that `run_inflexa` names its command.
