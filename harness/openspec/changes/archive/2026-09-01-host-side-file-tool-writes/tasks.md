# Tasks — host-side-file-tool-writes

## 1. The host write path

- [x] 1.1 Replace the sandbox exec in `mutator.writeFile` with a byte-write
  through the host filesystem, under the resolved workspace root
  (`src/tools/workspace/mutator.ts`).
- [x] 1.2 Delete the `python3 -c` write program and the base64 encode of the
  content.
- [x] 1.3 Keep the provenance recording unchanged: `recordFileToolWrite` on
  `status: "ok"` only.

## 2. The symlink checks

- [x] 2.1 Before the write, find the deepest ancestor that exists, and compare
  its realpath against the write prefix.
- [x] 2.2 Refuse a final component that is a symbolic link.
- [x] 2.3 Refuse a symlinked ancestor whose realpath escapes the write prefix.
- [x] 2.4 Make an absent parent directory only inside the write prefix.
- [x] 2.5 Return each refusal as a confinement data variant. Do not throw.

## 3. The regex mode of edit_file

- [x] 3.1 Add the optional `regex` flag to the input schema of `edit_file`
  (`src/tools/workspace/edit-file.ts`). When the flag is true, read
  `old_string` as a JS regular-expression pattern, and read `new_string` as
  the replacement with capture-group references.
- [x] 3.2 Refuse a regex call that has neither `expected_matches` nor
  `replace_all: true`.
- [x] 3.3 If the actual match count differs from `expected_matches`, write
  nothing. Report the actual count and the line numbers of the matches.
- [x] 3.4 Keep the default exact-string mode unchanged.

## 4. Tests

- [x] 4.1 Mutator tests: the host write lands the bytes, the confinement
  variants are unchanged, and the seam records provenance on `ok` only.
- [x] 4.2 Symlink tests: an escaped ancestor is refused, a symlinked final
  component is refused, and a parent directory lands inside the prefix only.
- [x] 4.3 Regex tests: the expected count, the mismatch report with the line
  numbers, `replace_all`, a capture-group reference, and the unchanged default
  mode.

## 5. Documents

- [x] 5.1 `harness/CONTEXT.md`: the mutate-surface passage.
- [x] 5.2 `harness/CLAUDE.md`: the Workspace bullet, and the write-restriction
  sentence in Sandbox Architecture.
- [x] 5.3 Root `SECURITY.md`: scope the containment claim to command
  execution.

## 6. Gates

- [x] 6.1 `npx tsc --noEmit`, lint on the touched files, and the full harness
  test suite.

## 7. The conversation agent

- [x] 7.1 Add the `session` argument to `WorkspaceMutator.writeFile`, and add
  the session-scoped realization `createSessionWorkspaceMutator`
  (`src/tools/workspace/mutator.ts`).
- [x] 7.2 Add the `write-file` member to the session event union
  (`src/provenance/seam.ts`). The mutate seam emits it on each successful
  chat write.
- [x] 7.3 Wire `write_file` and `edit_file` into the conversation roster
  (`src/agents/conversation-agent.ts`).
- [x] 7.4 Add the `session_file_written` event to `@inflexa-ai/prov-kernel`:
  the ref type, the `applyProvEvent` arm, the document builder, the tests,
  and the `SPEC.md` section.
- [x] 7.5 Map the `write-file` session event onto the
  `prov.session_file_written` bus event in the cli provenance bridge.
- [x] 7.6 Tests: the roster holds the write pair, and a chat write lands the
  bytes and emits the event. The refusals emit nothing. The symlink checks
  hold in the chat context.
