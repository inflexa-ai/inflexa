## Why

Report generation is a core part of the product, but its ceiling is low. Two
structural limits cause this.

First, the report section model is a flat list of six types, and the types do not
nest (`harness/src/tools/iterate-report.ts:186`). A new report shape needs a new
type, and a section cannot hold another section.

Second, no number in a report binds to a real analysis artifact. Every figure
comes from the memory of the agent. Only a free-text footnote records the source.

Issue #221 rebuilds the subsystem. Issue #222 is its foundation: the typed block
model and the grounding-by-reference contract. Context transfer, composition, and
verification all bind to the types that this change defines. Thus the change comes
first.

## What Changes

- Add a composable block model. A report becomes a tree of typed blocks. The union
  discriminates on `kind`: `section`, `text`, `claim`, `metric`, `table`, `chart`,
  `figure`, and `citation`. A `section` holds other blocks, so a new report shape
  is a new arrangement, not a new type.
- Add a content grammar. The grammar constrains which block can hold which. A
  validator rejects a violation, for example a `chart` inside a `metric`.
- Add a grounding-by-reference contract. Each evidentiary block carries one
  canonical `Reference` object. A reference pins to a run, a file path, and a
  content hash, and it addresses a value with a locator. It reuses the coordinates
  that the harness already keys on (`cortex_runs.run_id`,
  `cortex_artifacts(path, hash)`).
- Turn fabrication into a condition that mechanical validation rejects. The
  validator resolves each reference against a pinned snapshot and matches an
  optional assertion. A `claim` whose reference does not resolve fails validation.
- Ground a derived number two ways. The default writes the value to a hashed
  artifact, then the claim binds to a cell. The `derivation` escape hatch carries a
  transform over input references, and each input must resolve.
- Land prototype Zod types, the mechanical validator, and a `ReferenceResolver`
  seam. Add a test that one of each block kind validates, and that a fabricated
  claim fails with a typed reason.
- No change to the current `iterative-report` capability. The block model
  supersedes its section union in a later rebuild change, not here.

## Capabilities

### New Capabilities

- `report-block-model`: the typed, composable block tree — the block kinds, the
  stable `id`, the discriminant `kind`, and the content grammar that constrains
  nesting.
- `report-grounding`: the canonical `Reference` shape, its resolution against a
  pinned snapshot, and the mechanical validation that a binding resolves and that
  an assertion matches.

### Modified Capabilities

<!-- None. `iterative-report` is unchanged; the new model lives beside it until the
     rebuild supersedes the old section union in a separate change. -->

## Impact

- **Code**: new prototype types in `harness/src/contracts/`, because the block
  model and the reference cross the #221 session seam and export through the
  barrel. A mechanical validator and a `ReferenceResolver` seam live in a sibling
  module. New tests accompany them.
- **Agent-facing behavior**: none yet. The Report Builder agent (#225) and
  composition consume these types later. This change adds no tool and no prompt.
- **Consumers**: the `Reference` type is defined one time, here. Context transfer
  (#221), composition, and verification import it. A consumer must not invent a
  parallel pointer shape.
- **Naming**: a capability `target-synthesis-grounding` already exists, and it is a
  different grounding (FDA precedent as prompt context). The new capability is
  named `report-grounding` to prevent a collision.
