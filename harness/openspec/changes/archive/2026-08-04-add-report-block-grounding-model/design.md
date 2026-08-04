## Context

Issue #221 rebuilds the report subsystem. Issue #222 is its foundation. The block
model and the grounding contract are the types that context transfer (#221),
composition, and verification all bind to. Thus this change comes first.

The current state is a 6-variant discriminated union of report sections
(`harness/src/tools/iterate-report.ts:186`). It has two limits. The sections are a
flat list and do not nest. No number binds to a real artifact. The only provenance
is a free-text `source` or `transform` footnote.

The coordinate space already exists. A run is `cortex_runs.run_id`, a bare UUID that
is also the DBOS workflow id. A file is a row in `cortex_artifacts`, keyed on
`(analysis_id, path)`, with a `hash` in the form `sha256:<hex>`
(`harness/src/lib/fs-helpers.ts:14`). No sub-file locator exists today. A citations
subsystem exists (`harness/src/citations/`) with `resolve_citation` and a stable
`cit-<hash>` id, but no report code imports it.

The harness is host-agnostic. These types cross the #221 session seam. Thus they
belong in `harness/src/contracts/`, and a consumer imports them by a deep path.

## Goals / Non-Goals

**Goals:**

- Define the composable block tree of eight kinds with a content grammar.
- Define one canonical `Reference` shape that reuses the existing coordinates.
- Make fabrication a condition that mechanical validation rejects.
- Land prototype Zod types, a mechanical validator, a `ReferenceResolver` seam, and
  a test.

**Non-Goals:**

- No change to the `iterative-report` capability or its runtime.
- No Report Builder agent (#225), no context transfer (#221), and no composition or
  render step.
- No semantic verification. A model-judged pass on whether the prose follows from
  the value stays in a later verification pass.
- No production resolver against live storage. The prototype resolver reads a
  fixture snapshot.
- No public barrel export, and no schema versioning. The types stay deep-importable,
  and an unknown kind fails validation.

## Decisions

### D1. New capabilities beside `iterative-report`, not a modification

Issue #221 moves the report into its own session with its own runtime. The block
model is a new host-agnostic concept, and the current model keeps shipping
untouched. The alternative, a modification of `iterative-report` in place, couples
the new model to the old in-process runtime and risks the shipping path. Rejected.

### D2. A composable tree, not a flat list

A `section` becomes a block and nests other blocks. Thus a new report shape is a new
arrangement of existing blocks, not a new type. This breaks the flat ceiling. The
alternative, the flat six kinds plus a binding, adds grounding but keeps the
non-composable ceiling. Rejected.

### D3. The block set is eight kinds

The kinds are `section`, `text`, `claim`, `metric`, `table`, `chart`, `figure`, and
`citation`. The split of `claim` from `text` is load-bearing. A `claim` asserts
something about the data and must bind. A `text` block is connective prose and must
not carry a data assertion. A `metric` is a narrow `claim` with exactly one scalar
reference. A `citation` binds to an external record.

A `group` layout container was considered and dropped, because it is not necessary
yet. The flat catalog of domain sections (Differential Expression, TF Activity, and
so on) was the misread premise. Those strings are section titles, not a kind set.
Rejected.

### D4. One canonical `Reference` object

One shape unifies `artifact-value`, `artifact-table`, `derivation`, and `citation`
under a `locator`, so the #221 seam carries one type. It reuses `run`, `path`, and
`hash`. A bare URI string was considered as the source of truth, but a string is
hard to validate field by field. Thus the object is the source of truth, and a
canonical URI is a serialized carrier form. A PROV-style derivation triple is the
right model for the whole-report lineage, but it is too heavy as a per-claim
binding. Rejected for the binding.

### D5. `rowFilter` is the default row locator

A scientific table row order is not semantically stable. A stable predicate survives
a re-sort of the artifact. Thus the `locator` carries `column`, `rowFilter`, and
`row`, and `rowFilter` is the default. A `row` by index is permitted for a
fixed-order artifact. A locator resolves to exactly one value. Zero matches give
`locator-out-of-range`, and many matches give `ambiguous-match`.

### D6. A split of mechanical and semantic validation

Mechanical validation runs schema conformance, binding presence, resolution, and
assertion match. It uses no model, and it gives a hard guarantee that the number is
real and correctly transcribed. Semantic validation judges whether the prose follows
from the value. It is model-dependent, so it stays in the verification pass. To fold
the semantic pass into the contract gives false confidence. Rejected.

### D7. Derived numbers use materialize-first, with a derivation escape hatch

The default writes a derived value to a hashed artifact, then the claim binds to a
cell. This keeps validation a pure lookup and gives the strongest anti-fabrication
guarantee. The `derivation` node is the escape hatch, and it prevents a junk
one-cell file for a cheap ratio. Its `op` is `ratio`, `delta`, or `pctChange`. Each
input is a non-derivation reference that resolves, so a derivation cannot nest.

Materialize-first only is heavy for a trivial ratio. A derivation as a co-equal path
makes the validator compute routinely and the contract heavier. Both were rejected
for the hybrid.

### D8. Types in `contracts/`, logic in a sibling module

The block model and the reference cross the #221 session seam. They live in
`harness/src/contracts/`, and a consumer imports them by a deep path. The public
barrel export lands with the consuming change, so an unused prototype does not widen
the published surface. The validator and the `ReferenceResolver` seam are logic, so
they live in the sibling module `harness/src/report-model/`. To put the types under
`tools/report/` ties a shared contract to the old runtime. Rejected.

### D9. Keep the prototype minimal

The prototype carries only the necessary parts for the fail-a-fabricated-claim
benchmark. Thus the `locator` carries `column`, `rowFilter`, and `row`. The variants `cellRange`,
`jsonPointer`, and `textSpan` are for the artifact types that use them. The
`derivation` op is `ratio`, `delta`, or `pctChange`. An opaque `aggregate` or `expr`
was dropped, because it undermines a transparent transform.

A document `schemaVersion` and an unknown-kind degrade path were dropped. An unknown
kind fails validation, and versioning lands with a second version. A `citation` binds
to a thin external id (`doi`, `pmid`, or `arxiv`) and the raw string. The prototype
does not call `resolve_citation`. That wiring is a later change.

### D10. A whole-file pin is its own reference kind

An image and a table both pin a whole file, but they are not the same thing. Thus
`artifact-file` is a separate kind, and a `figure` binds to it. To bind an image to
`artifact-table` describes a picture as a table, and a reader meets a false term.
Rejected.

The rows of a snapshot artifact are optional, because a pinned image has a hash and
no rows. An empty array would claim that the file holds zero rows, which is a
different statement.

## Risks / Trade-offs

- [The spec gate bans `SHALL`, but the 70 existing specs use `SHALL`] → Use `MUST`
  as the normative keyword. It satisfies the gate and the OpenSpec parser. Confirm
  with `openspec validate --strict`.
- [The prototype resolver does not read live storage] → Resolve a fixture snapshot
  for the benchmark. A production resolver against `cortex_artifacts` and the
  workspace tree is a later change.
- [A `rowFilter` can match zero rows or many rows] → A locator resolves to exactly
  one value. Zero matches give `locator-out-of-range`, and many give `ambiguous-match`.
- [A seam consumer can want a field the shape lacks] → Add a field additively. The
  prototype has no version field, because a versionless additive change is enough.
- [A name collision with `target-synthesis-grounding`] → The new capability is named
  `report-grounding`. The two are distinct groundings.

## Migration Plan

The change is additive. It adds files and a test. It does not change
`iterative-report`, and it wires no runtime. The new types are deep-importable and
sit unused until #221 and #225 consume them. Thus there is no rollback concern.

## Open Questions

None. The block set, the locator set, the derivation op set, the resolver form, and
the module path are settled above.
