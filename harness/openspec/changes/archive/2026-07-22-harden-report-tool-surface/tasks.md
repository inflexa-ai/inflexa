## 1. Remove the PDF promise

- [x] 1.1 Narrow the `format` input enum in `submitReportInputSchema` (`src/tools/iterate-report.ts`) to `"html"` only, keeping `"html"` as the default, and remove the PDF invitation from both its `.describe()` and the `submit_report` tool description above it
- [x] 1.2 Leave the `"html" | "pdf"` unions on `PreviewMeta`, `ReportRunnerOptions.format`, and `PreviewPart.format` untouched, and note at `ReportRunnerOptions.format` that only `"html"` is reachable from the tool boundary
- [x] 1.3 Remove the PDF claim from the report guidance in `src/prompts/conversation.ts`
- [x] 1.4 Test: `format: "pdf"` is rejected by `submitReportInputSchema` and no preview version is created
- [x] 1.5 Test: a `preview-meta.json` recorded with `format: "pdf"` still parses through `readPreviewMeta`

## 2. Refuse iteration against an unknown preview

- [x] 2.1 In `createReportSubmitTool`'s `execute` (`src/tools/iterate-report.ts`), add an iteration-mode precondition that the preview root holds at least one `v{N}` directory
- [x] 2.2 Order the check before `createPreviewPublisher`, before `stageReportAssets`, and before `runReportIteration`, so an unknown id costs no model turns and leaves no partial state
- [x] 2.3 Return the refusal in the existing shape — an `error` string on the result plus a `data-report-preview-failed` part — naming the unknown `previewId` and how to correct it
- [x] 2.4 Test: iterating a `previewId` with no preview directory fails, creates no version directory, and never constructs the builder
- [x] 2.5 Test: iterating a preview directory that exists but holds no `v{N}` fails rather than producing a fresh v1
- [x] 2.6 Test: iterating a preview whose latest version is 2 still succeeds and produces v3 from v2's template

## 3. Make the version filesystem honour its stated path contract

- [x] 3.1 In `resolveAgentPath` (`src/tools/report/version-fs.ts`), reject a leading-slash path as `out_of_scope` naming the offending path, replacing the current strip-and-continue
- [x] 3.2 Confirm the four tools built by `createVersionFsTools` all route through `resolveAgentPath` so the contract holds uniformly
- [x] 3.3 Update the `write_file` / `edit_file` / `read_file` / `mkdir` descriptions so the rejection is stated where it is now true
- [x] 3.4 Test: `write_file("/previews/abc/v1/report.html.j2")` returns `out_of_scope` and creates no file anywhere under the version dir
- [x] 3.5 Test: `write_file("report.html.j2")` still writes inside the version dir and returns `ok`
- [x] 3.6 Test: `read_file("../../etc/passwd")` still returns `out_of_scope`

## 4. Make the unavailable preview seam visible

- [x] 4.1 Add an optional `logger` to `PreviewSnapshotToolState` (`src/tools/report/preview-snapshot.ts`), resolved once against `createNoopLogger()` in the established `logger?` form
- [x] 4.2 Emit a warning carrying the `previewId` when `mintPreviewAccess` reports the seam unavailable, so an operator can see that the build's only visual verification step did not run
- [x] 4.3 Compose the returned error message from fields the seam actually supplied, so an absent HTTP status is omitted rather than rendered as `status=undefined`
- [x] 4.4 Pass the runner's logger into `createPreviewSnapshotTool` at its construction site in `src/execution/report-runner.ts`
- [x] 4.5 Test: an unavailable publisher yields `ok: false`, a warning through the injected logger, and a message containing no `status=undefined`

## 5. Correct the four stale capability claims

- [x] 5.1 Remove `grep` from the tool list in `src/prompts/report-builder.ts` so the prompt names exactly the roster `createVersionFsTools` returns
- [x] 5.2 Remove the skipped-oversized-source example from the builder `submit_report` description AND from the `notes` field's `.describe()` (`src/tools/report/submit-report.ts`) — pre-flight hard-fails the whole call, so no skip occurs and the schema the model reads must not offer one
- [x] 5.3 Remove the "15-min TTL" figure from the `mint_preview_url` description (`src/tools/report/mint-preview-url.ts`); the harness sets no TTL on this path and echoes the seam's `expiresAt`
- [x] 5.4 Remove `theme.css` from the design-system material named in `buildCreationPrompt` (`src/tools/iterate-report.ts`), leaving only material the builder can reach through its tools

## 6. Verify

- [x] 6.1 Run `bun test` with `TESTCONTAINERS_RYUK_DISABLED=true` and confirm no regressions (the plain run has a known Ryuk failure mode unrelated to this change)
- [x] 6.2 Run `tsc -p tsconfig.json --noEmit` clean
- [x] 6.3 Run `bun run format:file` on every changed file under `src/`
- [x] 6.4 Re-read each changed description and prompt line against its implementation, confirming no remaining claim outruns the code
- [x] 6.5 Validate the change with `openspec validate harden-report-tool-surface --type change --strict`

## 7. Verification follow-ups

- [x] 7.1 Pin the copy requirement with a test: derive the roster from `createVersionFsTools` and assert `reportBuilderPrompt` names exactly those tools, plus that `grep`, `theme.css`, and a specific TTL figure stay absent. Review alone is the mechanism that already missed all four claims — commit `fea90fb` swept for this class and did not touch this file
- [x] 7.2 Lift the mint-failure message composition to one shared home and use it in `mint_preview_url` as well, which still renders `status=undefined` against the OSS seam; widen the spec scenario to bind both tools
- [x] 7.3 Fix the nine type errors in `src/tools/iterate-report.test.ts` and `src/execution/report-runner.test.ts` that `tsconfig.json`'s `src/**/*.test.ts` exclusion hides
- [x] 7.4 Record as deferred, not fixed: the remaining 49 type errors in other test files and the tsconfig `types`/exclusion change needed to enforce them; and the untested `preview_snapshot` success path, which needs a real browser and is unreachable while the OSS seam returns unavailable
