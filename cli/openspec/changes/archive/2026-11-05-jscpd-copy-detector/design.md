# Design

## Context

The cli lint stack (#813 to #828) runs the full oxlint preset and the type
check command, but no tool finds copied code. Harness already runs the jscpd
gate (#734, recalibrated to 60 tokens and 15 lines). This change gives cli the
same gate at the same care: the pinned tool, the committed configuration with
its measured calibration ladder, the `dupes` script, the CI step, and the first
sweep of every copy the gate reports. The commit the first run measured is
`56dc6568` (the tip of `main` at the start of this change).

All numbers below come from trial runs of `jscpd@5.4.2` on that tree, run on
the machine that wrote this change; the reports are local and are not part of
the repository.

## Goals / Non-Goals

**Goals:**

- `bun run dupes` exits 0 on the tree this change leaves behind, and exits
  non-zero when a pull request adds a copy at or above the floor.
- Each copy the first run reports is gone through a named shared abstraction,
  or stays with an ignore region that carries its reason.
- The reason for the floor is readable where the floor is set.

**Non-Goals:**

- No scan of `harness/` or `prov-kernel/` — the issue scopes the gate to cli.
- No `--similarity`, `--semantic`, or baseline modes: the gate reports exact
  token clones above the floor, and the tree holds zero of them after the
  sweep. A baseline would re-legitimize the copies this change removes.
- No tightening below the chosen floor in this change; the epic tightens later
  once the gate has held.
- No document change: the README script table is selective today, and the
  harness change touched no document either.

## Decisions

### Decision 1: jscpd at an exact pin, config at the cli root

`jscpd@5.4.2` is a dev dependency at one exact version — the exact version of
harness — and `.jscpd.json` sits at the cli root where the detector
auto-discovers it. The issue asks for the version of harness, so a later bump
of one without the other is a deliberate act that re-runs both gates. Token
counts shift between jscpd versions, so a floating range would let an
unrelated lockfile update change what CI fails on.

### Decision 2: the floor is 60 tokens and 15 lines, and the reason sits in the config

The issue says to start from the floor of harness. Measured clone counts over
the code formats of `src` and `scripts`, on `56dc6568`:

| Floor | Clones | Copied lines |
| --- | --- | --- |
| 60 tokens and 5 lines | 349 | 2.14 % |
| 60 tokens and 10 lines | 129 | 1.16 % |
| 60 tokens and 15 lines | 45 | 0.56 % |
| 70 tokens and 15 lines | 39 | 0.50 % |
| 100 tokens and 20 lines | 11 | 0.18 % |

The full 45-clone set at 60/15 was inspected: every report names a real
repeated block — 11 in source files and 34 in test files. Below the line floor
(129 at 60/10) the reports stop being copies of logic — they are parameter
tables, builder chains, and short setup blocks whose repetition carries no
name. At 100/20 the floor hides whole families: the session-dialog test
scaffold and the prompt chrome each span more sites than the pairs the detector
reports at that floor, because a one-word difference drops each other pair
below it — the same flaw the harness recalibration found. The recorded reason
in the config states the measured ladder, so a future calibration re-runs the
same measurement instead of a new judgment.

### Decision 3: the code formats are TypeScript and TSX

The hand-written code of the `src` and `scripts` trees is TypeScript and TSX
and nothing else. The package-store fixtures under
`src/modules/libs/test-fixtures/` mimic third-party package payloads — Python
modules, R packages, binaries — and hold no TypeScript or TSX file. They are
fixture data, not cli code, so the format list keeps them outside the scan
without an ignore entry. The data formats (JSON, YAML, plain text) stay
outside for the harness reason: fixtures repeat data by design, and a data
gate would force destructured test payloads for no gain. The reasons sit in
the config beside the floor reason.

### Decision 4: the gate exits through `--exit-code` and `--fail-on-empty`

jscpd 5.x exits 0 even when it finds clones (verified on the harness change);
the `dupes` script therefore passes `--exit-code`, which exits 1 on any clone
at or above the floor and 0 on a clean tree. `--fail-on-empty` exits 1 when
the filters match no file, so a future config typo cannot turn the gate into a
vacuous pass. The command line carries the paths (`jscpd src scripts
--exit-code --fail-on-empty`); the config carries the floor, the formats, and
the ignores. This is the harness script verbatim, over the cli trees. The
config also ignores `node_modules` although the command already scopes the
scan to `src` and `scripts`, so a future widening of the paths can never pull
in the working-copy harness that CI links under
`cli/node_modules/@inflexa-ai/harness`.

### Decision 5: the fix of a reported copy is a shared abstraction, not a per-site edit

Decision 2 of #608 governs the cleanup of every task group: each reported copy
collapses into an abstraction that removes the shape, and the call sites move
onto it. No mechanical find-and-replace across call sites. An ignore region is
not a second path of equal standing — it keeps a copy only for a reason the
code can state. The known shapes of the 45:

- **The spec-table oracle stays, with its reason.** `src/test_support/file_types.ts`
  holds a test copy of the map of `src/modules/fs/file_kind.ts` (47 lines, the
  largest source clone). The copy is the oracle: the local-server spec writes
  the table, and an independent copy in the test is what fails when the map
  and the spec disagree. An import would make the test tautological. The table
  in the test file takes `jscpd:ignore-start`/`ignore-end` markers with the
  reason in a comment beside them, and the route tests keep asserting each row.
- **One dispatch helper for the profile trigger.** The parity ladder and
  `forceReprofile` of `src/modules/harness/profile_trigger.ts` share the
  materialize → seed → trigger → outcome-mapping block. The two differ in one
  arm: a `failed` trigger result reports a failure at parity and takes the
  retry claim under force. A shared dispatch helper takes the failed-row
  policy as a parameter, and each caller states its own.
- **One per-artifact check for the reference receipts.** `receiptFilesPresent`
  and `receiptFilesIntact` of `src/modules/refs/store.ts` share the per-file
  owned-path, lstat, kind, and size checks; intact adds the digest. A shared
  per-artifact file check returns the checked file, and `intact` adds its
  hash step on top.
- **One part-reader tail for the chat frame switches.** The REPL reader of
  `src/modules/harness/dev/chat.ts` and the TUI reader of
  `src/tui/hooks/conversation.ts` share the switch tail: the four no-op frame
  kinds, the one `checkChatPart` gate, the log-and-drop of a part that fails
  the check, and the hand-off to the renderer. A shared helper takes the
  apply callback and returns its result, so the REPL can await its async
  renderer while the TUI keeps its synchronous apply. The helper lives in
  `src/lib/`, the one home the layer rules give both callers: a client may
  import `src/lib/`, a module may import `src/lib/`, and a dev surface may
  import product code. The harness contract stays the source of the check.
- **One guard prologue for the session flows.** `openParentSession`,
  `openReportSession`, `deleteSessionFlow`, and `purgeSessionFlow` of
  `src/tui/commands.tsx` repeat the absent-scope guard, the not-ready
  refusal, and the unreadable-thread notice (two clone pairs inside one
  file). A file-local helper returns the read thread or notifies, and each
  flow keeps its own words for its own facts.
- **One prompt frame for the ask and pause prompts.** The two prompts of
  `src/tui/components/` share the chrome box: the ref callback with the inert
  focus rule, the raised background with its padding, and the warning-gutter
  row. A shared frame component in `src/tui/components/` takes the gutter
  glyph and the content; each prompt keeps its own bindings and its own
  key layer.
- **One spinner clock for the two indicators.** `BootIndicator` and
  `ThinkingIndicator` share the frame and age signals driven by one 80 ms
  interval. A shared clock helper beside them owns the interval and the
  cleanup; each indicator keeps its own layout and tone.
- **One focus tracker for the two editors.** `TextArea` and `TextInput` share
  the focus/blur subscription pair inside the inline ref callback. A shared
  helper takes the renderable and the focus sink; the ref callback stays
  inline at each editor, because the reactivity lint reads it there, and
  `TextInput` keeps its own scroll-margin step.
- **One capture scaffold for the two CLI runners.** `runCli` and
  `runCliAsync` of `src/test_support/cli.ts` share the temp directory, the
  two descriptors, the read-back, and the cleanup; they differ in the spawn
  call alone. One helper takes the spawn function, and the files-not-pipes
  comments move onto it.
- **The test clusters join the shared-test conventions.** The 34 test clones
  split into within-file repeats, which parameterize into cases or a local
  helper, and cross-file repeats, which move into one shared helper per
  cluster. The home of a shared test helper is `src/test_support/` — the one
  home the cli tree already uses for every cross-file test helper, in files
  like `threads.ts` and `builders.ts`; no non-test helper file lives inside a
  `test/` folder today, and the sweep keeps it that way. A repeat whose every
  consumer sits in one file stays file-local. The known clusters: the
  session-dialog render scaffold of `src/tui/test/` (delete, remove, restore
  — one shared scaffold), the keymap render harness, the dialog render
  scaffolds, the run fixture builders of `src/tui/hooks/test/`, and the
  command-path fixtures. The implementor names each abstraction from what
  the repeated block does, not from the file it sits in.

This sweep accepts one reason to keep a copy: the spec-table oracle above.
Every other reported clone collapses into a named abstraction. A change
after this one can accept a further reason of the harness kind — a fixture
that pins bytes, or a test that must not share state with its sibling — and
then the copy keeps the ignore markers with the reason comment beside them.
The markers were verified to suppress a clone on 5.4.2 (harness change,
Decision 5).

### Decision 6: the gate runs in the `lint (cli)` job, after the Typecheck

The issue names the job. The step needs only the install that the job already
does, so it sits after `Typecheck` and before `Docs generation check`: a
source-validity gate over the cli tree, cheap enough not to need its own job —
the same placement and comment shape as the harness step. The workflow keeps
the job name `lint (cli)`, so no gate that waits on the name changes.

## Risks / Trade-offs

- [A contributor hits the floor with code that has no shared abstraction] →
  the ignore region with its reason is the escape hatch, and the reviewer owns
  the judgment; the spec forbids only the reason-less ignore and the blanket
  exclusion.
- [A jscpd bump changes token counts and breaks CI] → the exact version pin;
  a bump re-runs `bun run dupes` in the same change and states the new floor.
- [The floor is too loose to catch small copies] → accepted: the same trade
  the harness took. The gate catches the next large copy; the epic tightens
  the floor later.
- [The spec-table oracle region hides a real drift of the map] → the region
  wraps the table only, and the route tests still assert each row of the
  oracle, so a map drift that breaks a row fails the suite.

## Migration Plan

One pull request on `feat/831-jscpd-copy-detector-cli`. The tasks land in
order: dependency and configuration first, the script and its local
verification next, then the abstractions per reported copy, then the CI step.
Rollback is reverting the branch; the gate is additive and no published
surface changes.
