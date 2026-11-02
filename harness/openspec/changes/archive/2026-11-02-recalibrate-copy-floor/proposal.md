# Proposal

## Why

Increment 1 set the copy floor at 100 tokens and 20 lines, because that floor
reports no copy on the tree and each of its 23 reports named a real block. The
re-validation of that choice against the clone fragments showed the flaw of the
argument: a floor hides whole families, not only noise. One hand-rolled slug
loop exists in six production files, and the detector reports one pair of the
family, because a one-character difference drops each other pair below the
floor. The measured ladder gives 288 clones at 70 tokens and 5 lines, and the
fragments hold real abstraction work below 100 tokens: the chart
axis prologue three times, script staging twins, tool schema field blocks, and
run-loop event pairs. Issue #734 asks for the selection of the floor (task 3)
and the removal of each reported copy with a shared helper (task 5). The floor
selection was too coarse, and this change corrects it.

## What Changes

- `harness/.jscpd.json` lowers the floor to `minTokens: 60` and `minLines: 15`,
  and its reason records the measured ladder: 495 clones at 60 tokens and 5
  lines, 214 at 60/10, 48 at 60/15, 44 at 70/15, 0 at 100/20.
- A new `src/lib/slug.ts` gives the exact lowercase slug loop one name,
  `slugify(value, { maxLength, fallback })`. Five production sites call it, and
  each site keeps its own policy beside the call: the length cap and the
  fallback. The case-preserving and diacritic-folding variants keep their own
  loops, because their contracts differ.
- The 48 clones of the 60/15 set collapse into named shared abstractions, one
  per cluster: the chart axis and slot-group prologues, the page staging of the
  two render scripts, the run-loop tool-event pair, the destination fields of
  the authoring tools, and the test scaffolds (tool construction, client
  stubs, PDF and stream builders, context builders, and figure test twins).
- No ignore region enters the configuration. The set holds no copy whose reason
  the design accepts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `copy-detection`: the reason for the floor records the calibration ladder —
  the measured clone counts at the chosen floor and at the floors immediately
  above and below it — so a future calibration re-runs the same measurement
  instead of a new judgment.

## Impact

- `harness/.jscpd.json`: the floor and the reason.
- New `src/lib/slug.ts` with a colocated test; the slug call sites in
  `src/tasks`, `src/schemas`, `src/lib/regulatory-corpus`,
  `src/sandbox`, and `src/state/test`.
- `src/report-render/chart.ts`, `src/loop/run-loop.ts`,
  `src/tools/report-authoring/authoring-tools.ts`, and
  `src/tools/lib/opentargets-client.ts`.
- `scripts/render-fixture.ts` and `scripts/render-gallery.ts`, which share one
  new staging module.
- The test scaffolding of the clone clusters: `src/tools/lib/__fixtures__/`,
  `src/lib/test/`, and the test trees beside their consumers.
- No public interface of the harness changes: `sanitizeAgentName` and
  `deriveOutputPrefix` keep their names and signatures.
