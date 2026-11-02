# Design

## Context

The oxlint preset (#724) and its review fixes (#733, commit `01a46598`) already
removed the hand-found copies: `asyncIterableOf` lives in
`src/lib/test/async-iterable.ts`, and `ErrnoCodeSchema` and `holdsNoRank` are
gone. What is missing is the gate. This change adds `jscpd` to harness, wires a
`dupes` script into the `lint (harness)` CI job, and removes the copies that the
first run reports. The commit the first run measured is `26b04a6f` (the tip of
`main` at the start of this change).

All numbers below come from trial runs of `jscpd@5.4.2` on that tree, run on
the machine that wrote this change; the reports are local and are not part of
the repository.

## Goals / Non-Goals

**Goals:**

- `bun run dupes` exits 0 on the tree this change leaves behind, and exits
  non-zero when a pull request adds a copy at or above the floor.
- Each copy the first run reports is gone through a named shared abstraction, or
  stays with an ignore region that carries its reason.
- The reason for the floor is readable where the floor is set.

**Non-Goals:**

- No scan of `cli/` or `prov-kernel/` — the issue scopes the gate to harness.
- No `--similarity`, `--semantic`, or baseline modes: the gate reports exact
  token clones above the floor, and the tree holds zero of them. A baseline
  would re-legitimize the copies this change removes.
- No tightening below the chosen floor in this change; the epic can tighten
  later once the gate has held.

## Decisions

### Decision 1: jscpd at an exact pin, config at the harness root

`jscpd@5.4.2` is a dev dependency at one exact version, and `.jscpd.json` sits at
the harness root where the detector auto-discovers it. The alternative detectors
are weaker: `jsinspect` is unmaintained and JavaScript-only; ESLint has no
multi-language copy rule; the similarity features of jscpd itself need a model
or a tree scorer that this gate does not need. Token counts shift between
jscpd versions, so a floating range would let an unrelated lockfile update
change what CI fails on; the exact pin makes a bump a deliberate act that
re-runs the gate.

### Decision 2: the floor is 100 tokens and 20 lines, and the reason sits in the config

Measured clone counts over the code formats of `src` and `scripts`:

| Floor | Clones |
| --- | --- |
| 50 tokens (the jscpd default) | 880 |
| 70 tokens | 321 |
| 100 tokens, no line floor | 78 |
| 100 tokens and 20 lines | 23 |
| 150 tokens and 20 lines | 7 |

The counts fall fast as the floor rises, and the reports of the lower floors
were inspected for what they name: below 100 tokens the reports stop being
copies of logic — they are parameter tables, type declarations, and short
builders whose repetition carries no abstraction — and without the 20-line
floor the set of 78 still holds token-dense blocks that are structural rather
than copied. At 100 tokens and 20 lines, every one of the 23 reports names a
real repeated block — 3 in production code and 20 in tests — which is the set
this change removes. The recorded reason in the config states the measured
counts and that each of the 23 reports names a repeated block. JSON has no
comments, so the reason lives in a `"//"` key of `.jscpd.json`; the detector
tolerates unknown keys (verified on 5.4.2).

### Decision 3: the code formats of the trees — TypeScript, TSX, JavaScript, Python, R, bash

The format list covers each code language that `src` and `scripts` hold: the
TypeScript and TSX of the source, the JavaScript and TypeScript of `scripts/`,
the Python of the input-scan decoder and of the gallery derive scripts, the two
R derive scripts, and the two shell scripts of `scripts/`. Adding `r` and
`bash` to the measured run changes nothing: the 23 clones stay 23, because the
R pair and the shell pair share no block at the floor.

The data formats stay outside: `src` tracks 242 JSON files (the default jscpd
run analyzed 186 of them — its 50-token file floor skips the smallest), 3 YAML
files, and text fixtures beside the code. The default run called 43.5% of the
analyzed JSON lines duplicated: fixtures repeat data by design, and a data gate
would force destructuring test payloads for no gain. The reason for leaving the
data formats out sits in the config beside the floor reason. `dist` and
`node_modules` are gitignored, and jscpd respects `.gitignore`; the config names
them anyway, plus the three generated gallery data directories
(`src/report-render/gallery/data/`, `data.new/`, `data.old/` — the gallery tree
beside them holds hand-written code that stays in the scan), so every exclusion
is explicit and carries its reason rather than being inherited silently.

### Decision 4: the gate exits through `--exit-code` and `--fail-on-empty`

jscpd 5.x exits 0 even when it finds clones (verified); the `dupes` script
therefore passes `--exit-code`, which exits 1 on any clone at or above the floor
and 0 on a clean tree. `--fail-on-empty` exits 1 when the filters match no file,
so a future config typo cannot turn the gate into a vacuous pass. The command
line carries the paths (`jscpd src scripts --exit-code --fail-on-empty`); the
config carries the floor, the formats, and the ignores.

### Decision 5: the fix of a reported copy is a shared abstraction, not a per-site edit

Decision 2 of #607 governs the cleanup of every task group, and the coordinator
steering repeats it: each reported copy collapses into an abstraction that
removes the shape, and the call sites move onto it. An ignore region is not a
second path of equal standing — it keeps a copy only for a reason the code can
state: a fixture that pins bytes, or a test that must not share state with its
sibling. That rule governs groups 2, 3, and 4 alike. The known shapes:

- `resolveDerivation` exists in `src/report-model/fixture-resolver.ts` and
  `src/report-model/production-resolver.ts` (67 lines, 456 tokens apart). The
  bodies differ in one function: the fixture side resolves each input with
  `resolve`, the production side with `resolveArtifactValue`. A shared
  derivation helper in `src/report-model/` takes the input resolver as a
  parameter, and both resolvers call it.
- The 29-line pair (`fixture-resolver.ts:67`, `production-resolver.ts:675`) is
  the row-selection block: the fixture resolver holds it inline in
  `resolveArtifactValue`, and the production resolver holds it as `selectCell`.
  A shared row-selection helper takes the rows and the locator and returns the
  selected row or the failure, and both call sites keep their own row access.
- The 25-line pair (`fixture-resolver.ts:136`, `production-resolver.ts:725`) is
  the row-bound and column-projection body of `resolveArtifactTable` in each
  resolver: the row-bound check, the absent-column check, and the projection
  loop are the same steps over each side's rows, so they collapse into one
  shared table-read helper.
- The test repetitions (20 reports) split into within-file repeats
  (`k8s-client.test.ts`, `execute-analysis.test.ts`, `validate.test.ts`,
  `reconcile-manifest.test.ts`), which parameterize into cases or shared local
  helpers, and cross-file repeats (the data-profile fixtures shared by
  `app/test` and `tools/research/test`, the report-session spawn helper shared
  by `app/test` and `tools/test`), which move into a shared helper at the
  natural home of the two callers. The implementor names each abstraction from
  what the repeated block does, not from the file it sits in.
- A block that is duplicated for one of the two accepted reasons above stays,
  wrapped in `jscpd:ignore-start`/`ignore-end` markers with a reason comment.
  The markers were verified to suppress a clone on 5.4.2.

### Decision 6: the gate runs in the `lint (harness)` job, after the typecheck

The issue names the job. The step needs only the install that the job already
does, so it sits after `Typecheck` and beside the `Ruff` step: a
source-validity gate over the harness tree, cheap enough not to need its own
job. The workflow keeps the job name — `release-harness.yml` and `release.yml`
wait for `lint (harness)` by name.

## Risks / Trade-offs

- [A contributor hits the floor with code that has no shared abstraction] → the
  ignore region with its reason is the escape hatch, and the reviewer owns the
  judgment; the spec forbids only the reason-less ignore and the blanket
  exclusion.
- [A jscpd bump changes token counts and breaks CI] → the exact version pin;
  a bump re-runs `bun run dupes` in the same change and states the new floor.
- [The floor is too loose to catch the copies #733 found by hand] → accepted:
  the `asyncIterableOf` copy sat well below 20 lines. The gate catches the next
  large copy; the epic tightens the floor later.
- [Ignoring the gallery data by path drifts if the directory moves] → the
  exclusion names the directory, and the spec keeps the duty on the config to
  name every excluded tree with a reason.

## Migration Plan

One pull request on `feat/734-jscpd-copy-detector`. The tasks land in order:
dependency and configuration first, the script and its local verification next,
then the abstractions per reported copy, then the CI step. Rollback is reverting
the branch; the gate is additive and no published surface changes.
