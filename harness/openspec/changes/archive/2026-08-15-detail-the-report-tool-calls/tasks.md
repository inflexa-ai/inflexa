## 1. The seam

- [x] 1.1 Add the optional `describeResult` hook to `src/tools/define-tool.ts`, beside `describeCall`, with the same sentinel discipline.
- [x] 1.2 Add the result compute to `src/loop/tool-detail.ts`, inside the same guard and the same normalization.
- [x] 1.3 Carry the recomputed detail on the finished event in `src/loop/run-agent.ts`, only on an ok outcome, with the started detail as the fallback.
- [x] 1.4 Unit tests: the recompute, the error fallback, the throwing hook, and the normalization.

## 2. The providers

- [x] 2.1 `add_block` names the kind with the title or the bound file name.
- [x] 2.2 `preview_report` names the page path on a render, and the outcome kind otherwise.
- [x] 2.3 `record_report_version` names the version, and `examine_page` names the look outcome.
- [x] 2.4 `list_pinned_artifacts` names the listed count with the truncation.
- [x] 2.5 Tests for each provider.

## 3. The gates

- [x] 3.1 Run the targeted suites of the touched modules only.
- [x] 3.2 Run `bun run format:file` on the touched `src/` files, then `tsc -p tsconfig.json`.
- [x] 3.3 The seam is an exported surface, thus run `bun run harness:local` from `cli/` and the cli typecheck.
