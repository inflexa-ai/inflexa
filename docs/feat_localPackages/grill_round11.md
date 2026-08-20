# Grill round 11 — the findings of /opsx:verify

The verification pass of the harness change found four warnings and two
suggestions. This document gives the full context of each one. The questions
are in the chat. Each finding carries its evidence, thus the answers need no
code read.

## W1 — the `validate_plan` tool does not exist

**The history.** The planner had a real tool named `validate_plan`: a
non-terminal dry-run that took a candidate plan in any shape and returned
`{valid, issues[]}`. The commit `ae57869d` ("Fix planner terminal submission
flow", 2026-07-30) removed the tool. It folded the dry-run into
`submit_plan`: a rejected candidate now returns the same structured issues,
and the planner fixes the plan and submits again. The base spec
(`harness/openspec/specs/planning-enhancements/spec.md:17`) was not updated,
thus it still describes the removed tool. That is spec drift that predates
the rebuild.

**What the rebuild did.** The delta inherited the vocabulary of the base
spec: "`validate_plan`, and the re-validation of `submit_plan`, MUST report
an issue for every package entry that names a path". The implementation put
the location refusal into the shared validator
(`harness/src/schemas/validate-plan.ts:166`). Every validation path calls
that one function:

- `submit_plan` re-validates through it (`generate-plan.ts:439`).
- The launch re-validates a stored plan through it
  (`tools/execute-analysis.ts:127`).

Thus the BEHAVIOR of the requirement holds everywhere. Only the NAME in the
spec points at a tool that left the code one month ago.

**The options.**

- **(a) Amend the wording at sync.** The synced requirement speaks of "the
  plan validation" — the shared validator, the `submit_plan` re-validation,
  and the pre-launch re-validation. The stale base-spec sections about
  `validate_plan` correct at the same moment. No code changes.
- **(b) Resurrect the tool.** Add `validate_plan` back as a non-terminal
  dry-run. This reverts a deliberate product decision from July, and it
  costs a planner-surface change that no current requirement wants.

## W2 — `images/` holds five entries, not "exactly three"

The delta (`sandbox-image-catalog`) says the `images/` directory MUST
contain exactly three entries. The directory holds five: the three
subdirectories plus `README.md` and `install-build-toolchain.sh`. The
SCENARIO of the requirement checks the subdirectories only, and those are
exactly three.

`install-build-toolchain.sh` has exactly one consumer now: the provisioner
Dockerfile (`images/sandbox-provisioner/Dockerfile:55`). The retired variant
images were its other consumers. Thus the script can move into
`images/sandbox-provisioner/` with a one-line COPY-path change.

**The options.**

- **(a) Move the script into `images/sandbox-provisioner/`, and amend the
  requirement to "exactly three subdirectories".** The README stays — a
  directory README is not layout drift.
- **(b) Amend the wording only.** The script stays at the root as a shared
  location, although only one image reads it.

## W3 — the provisioner has no host-runnable unit tests

The spike proved the store logic with `test_provision.py`: 2469 lines of
stdlib-only `unittest` (no uv, no docker, no third-party package). The
rebuild did not port it, because the task list named only the container rig
(task 8.4). Thus the pure logic of the rebuilt provisioner has no test that
runs on a host. That logic covers the content address, the link merge, the
crash-atomic publish and its recovery, the committed-lock resolve, and the
spec parsing.

The spike tests are proven fragments, and they run with
`python3 -m unittest`. A port must adapt them: the subcommand parser, no
leases, no `verify`, `inflexa.lock` in place of `lock.json`, and the
per-package warm record.

**The options.**

- **(a) Port the applicable subset of the spike tests.** The best value: the
  cases are proven, and the adaptation is mechanical.
- **(b) Write a small fresh test file** for the highest-risk pure functions
  only.
- **(c) Accept the rig and the CI gates as the whole coverage.**

A sub-decision for (a) or (b): does a CI job run them, or do they stay a
local tool like the rig? The harness CI runs `bun test`, thus a Python test
file needs its own small step.

## W4 — the workflows and the rig never ran

The three new workflows and the container rig passed static validation only
(YAML parse, `bash -n`, `py_compile`). No run executed them, because a run
needs built images, network, and (for the workflows) the self-hosted
builders.

**The cheap real check, without the builders:** build the provisioner image
locally (`scripts/sandbox-images-build-local.sh` covers it, minutes — the
image compiles no R packages) and run
`scripts/package-store-check-provisioner.sh` against it. That executes the
acquire, both-hit, reclaim, and remove-farm paths for real, against PyPI and
CRAN. The full store build and the workflow dispatches stay a separate,
longer step on the builders.

## S1 — one scenario has no test

The lib-store delta says: with no store configured, the farm source MUST NOT
run. The code guards it (`docker-client.ts:286` resolves the farm only when
`libStorePath` is set), but no test asserts that the resolver stays uncalled
in the no-store case. The test is five lines in `docker-client.test.ts`.

## S2 — the acquisition egress classes live on the CLI side

The build spec says an acquisition run gets only two egress classes: the
Python index hosts and the pak repositories. The mechanism is the
`INFLEXA_EGRESS_ALLOW` env of the provisioner entrypoint
(`images/sandbox-provisioner/provisioner-entrypoint.sh`), and the INVOKER
composes the list. The catalog build passes all four classes
(`.github/workflows/package-store-build.yml:110`). The acquisition invoker
is the CLI flight — and the CLI change specs carry no egress requirement
today (a grep of `cli/openspec/changes/package-store-rebuild/specs/` finds
none). Without a line there, the CLI flight can launch the provisioner with
an open egress, and nothing fails.

**The option:** add one requirement to the CLI change (the flights spec)
before its apply: the flight passes the two-class allowlist.
