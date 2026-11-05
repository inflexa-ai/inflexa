# Proposal

## Why

The cli lint stack (#813 to #828) turned on the full oxlint preset, but no tool
finds copied code in cli. Harness got the jscpd copy detector in #734 (PR #802),
with a floor of 60 tokens and 15 lines in `harness/.jscpd.json`. Decision 2 of
#608 says that the fix of a repeated shape is an abstraction that removes the
shape. A copy detector gives that decision a gate in CI, so a pull request that
adds a copy above the floor fails instead of waiting for a hand find.

## What Changes

- cli installs `jscpd@5.4.2` as a dev dependency at the exact version of
  harness.
- `cli/.jscpd.json` configures the scan: the code formats `typescript` and
  `tsx` — the hand-written code of the `src` and `scripts` trees is TypeScript
  and TSX alone, and the package-store fixtures under
  `src/modules/libs/test-fixtures/` hold third-party package payloads, among
  them Python modules, which are fixture data and not cli code — ignores
  `**/node_modules/**`, `**/dist/**`, and `**/dist-docs/**`;
  sets the copy floor `minTokens: 60` and `minLines: 15`; and carries the
  reasons — for the floor, for each ignored tree, and for the data formats and
  the fixture payloads that stay outside the scan — in a `"//"` key, because
  JSON has no comments.
- `cli/package.json` gains the script `dupes`, which runs the scan over `src`
  and `scripts` with `--exit-code` (exit 1 when a clone is reported) and
  `--fail-on-empty` (exit 1 when the filters match no file, so a config drift
  cannot pass silently).
- `.github/workflows/lint.yml` runs `bun run dupes` in the `lint (cli)` job,
  after the Typecheck step.
- Each copy that the first run reports at the chosen floor (45 clones on `main`
  at `56dc6568`: 34 in test files, 11 in source files) collapses into a named
  shared abstraction that removes the shape. One copy stays under an ignore
  region with its reason: the spec table of `src/test_support/file_types.ts`
  against `src/modules/fs/file_kind.ts`, because an independent test copy is
  the oracle that fails when the map and the spec disagree. No other ignore
  region enters the code or the configuration.

## Capabilities

### New Capabilities

- `copy-detection`: the jscpd gate of cli — the pinned tool, the committed
  configuration with its calibration ladder, the `dupes` script, the CI step,
  and the duty of a deliberate copy to carry its reason.

### Modified Capabilities

None. The lint-family specs (`syntax-bans`, `test-placement`, `test-shape`)
govern the oxlint rules and keep their scope; the copy gate is a separate tool.

## Impact

- `cli/package.json` and `cli/bun.lock`: the dev dependency and the `dupes`
  script.
- `cli/.jscpd.json`: new configuration file.
- `.github/workflows/lint.yml`: one step in the `lint (cli)` job.
- The source files that hold the 11 source clones: `src/modules/harness/profile_trigger.ts`,
  `src/modules/refs/store.ts`, `src/modules/harness/dev/chat.ts` with
  `src/tui/hooks/conversation.ts`, `src/tui/commands.tsx`,
  `src/tui/components/ask_prompt.tsx` with `src/tui/components/pause_prompt.tsx`,
  `src/tui/components/boot_indicator.tsx` with
  `src/tui/components/thinking_indicator.tsx`, `src/tui/components/text_area.tsx`
  with `src/tui/components/text_input.tsx`, and `src/test_support/cli.ts`;
  `src/test_support/file_types.ts` gains the ignore region.
- The test files that hold the 34 test clones: the session-dialog render tests
  of `src/tui/test/`, the keymap render tests, the dialog render tests of
  `src/tui/components/dialog/test/`, the fixture builders of
  `src/tui/hooks/test/`, and the command and store tests of `src/cli/test/`,
  `src/client/commands/test/`, `src/modules/embedding/test/`,
  `src/modules/harness/test/`, `src/modules/infra/test/`,
  `src/modules/prov/test/`, and `src/modules/refs/test/`, and the render and
  layout tests of `src/tui/layout/test/` and `src/tui/components/test/`.
- No public interface of cli changes: the swept shapes are internal, and each
  shared helper lands beside its callers.
