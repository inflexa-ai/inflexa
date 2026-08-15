## 1. The stamp

- [x] 1.1 Make the stamp walk in a new `src/report-model/` module. It fills an absent hash from `snapshotEntry`, and it collects each unknown path-only reference into a typed refusal.
- [x] 1.2 Wire the walk into `addBlock` and `changeBlock` in `src/report-model/draft-operations.ts`, before the grammar parse.
- [x] 1.3 Unit tests: the fill, the unknown-path refusal with the path in the detail, the untouched explicit hash, the derivation inputs, and the non-reference pass-through.

## 2. The listing tool

- [x] 2.1 Make the listing tool in `src/tools/report-session/`. It reads the snapshot through `openReportThread`, and it lists the path, the hash, and the file type in the code-unit order of the path.
- [x] 2.2 Add the bounded header read: `resolveWorkspacePath` containment, a 16 KiB cap, the delimiter by extension, and no columns for a no-cell file type or an unreadable file.
- [x] 2.3 Export the tool, and put it on the report roster beside the other session tools.
- [x] 2.4 Unit tests: the listing order, the columns of a CSV and of a TSV, the absent-file arm, and the no-cell arm.

## 3. The teaching surfaces

- [x] 3.1 Extend the `add_block` and `change_block` descriptions: a reference names the path, and the session stamps the hash.
- [x] 3.2 Extend `src/prompts/report-session.ts`: the listing tool as the orientation source, the path-only rule, and the hash-probe anti-pattern in the "Do NOT" list.

## 4. The gates

- [x] 4.1 Run the targeted suites of the touched modules only.
- [x] 4.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
