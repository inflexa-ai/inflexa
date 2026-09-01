# Tasks — host-side-file-tool-writes

## 1. The host write path

- [ ] 1.1 Replace the sandbox exec in `mutator.writeFile` with a byte-write
  through the host filesystem, under the resolved workspace root
  (`src/tools/workspace/mutator.ts`).
- [ ] 1.2 Delete the `python3 -c` write program and the base64 encode of the
  content.
- [ ] 1.3 Keep the provenance recording unchanged: `recordFileToolWrite` on
  `status: "ok"` only.

## 2. The symlink checks

- [ ] 2.1 Before the write, find the deepest ancestor that exists, and compare
  its realpath against the write prefix.
- [ ] 2.2 Refuse a final component that is a symbolic link.
- [ ] 2.3 Refuse a symlinked ancestor whose realpath escapes the write prefix.
- [ ] 2.4 Make an absent parent directory only inside the write prefix.
- [ ] 2.5 Return each refusal as a confinement data variant. Do not throw.

## 3. The regex mode of edit_file

- [ ] 3.1 Add the optional `regex` flag to the input schema of `edit_file`
  (`src/tools/workspace/edit-file.ts`). When the flag is true, read
  `old_string` as a JS regular-expression pattern, and read `new_string` as
  the replacement with capture-group references.
- [ ] 3.2 Refuse a regex call that has neither `expected_matches` nor
  `replace_all: true`.
- [ ] 3.3 If the actual match count differs from `expected_matches`, write
  nothing. Report the actual count and the line numbers of the matches.
- [ ] 3.4 Keep the default exact-string mode unchanged.

## 4. Tests

- [ ] 4.1 Mutator tests: the host write lands the bytes, the confinement
  variants are unchanged, and the seam records provenance on `ok` only.
- [ ] 4.2 Symlink tests: an escaped ancestor is refused, a symlinked final
  component is refused, and a parent directory lands inside the prefix only.
- [ ] 4.3 Regex tests: the expected count, the mismatch report with the line
  numbers, `replace_all`, a capture-group reference, and the unchanged default
  mode.

## 5. Documents

- [x] 5.1 `harness/CONTEXT.md`: the mutate-surface passage.
- [x] 5.2 `harness/CLAUDE.md`: the Workspace bullet, and the write-restriction
  sentence in Sandbox Architecture.
- [x] 5.3 Root `SECURITY.md`: scope the containment claim to command
  execution.

## 6. Gates

- [ ] 6.1 `npx tsc --noEmit`, lint on the touched files, and the full harness
  test suite.
