## Context

The harness has durable analysis runs, staged document inputs, run/step ledgers,
artifact registration, run-event streaming, and pull-based inspection. It does
not have a workflow whose fixed domain phases review a manuscript, nor a safe
writer that adds selected findings as Word comments without rewriting the
source. The generic analysis workflow is plan-driven and sandbox-oriented; a
manuscript review has a stable phase graph and performs fixed host-side document
operations, so forcing it through a generated plan would misrepresent both its
lifecycle and its security boundary.

Version 1 accepts a `.docx` manuscript. Guidelines and model papers may be DOCX,
PDF, or supplied text. The manuscript may contain custom styles, citation-manager
field codes, tracked revisions, existing comments, media, and arbitrary OPC
parts. The reviewed copy must preserve those constructs while adding comments
only for a user-approved subset of source-validated findings.

External bibliography resolution depends on `add-citation-resolution` and is
disabled by default. Manuscript prose is sent only through the configured
`ChatProvider`; bibliography entries reach external authorities only after a
separate pre-launch approval.

## Goals / Non-Goals

**Goals:**

- Launch a fixed six-phase durable manuscript-review workflow through the
  existing run authorization and launcher seams.
- Produce a validated, content-hashed dossier with per-phase, per-constraint,
  and per-reference coverage.
- Review structure, language, coherence, references, and target conformance
  without inventing venue rules or citation metadata.
- Support plain-text bibliographies as the baseline and structured field codes
  as an accelerator.
- Give every finding a deterministic identity and location, and mark only exact
  text ranges as commentable.
- Emit an idempotent reviewed `.docx` for an explicitly selected, approved set of
  commentable findings while never modifying the source.
- Surface launch, progress, completion, and dossier discovery through existing
  run cards, event streams, artifact ledgers, and `inspect_run`.

**Non-Goals:**

- PDF manuscripts or PDF annotation.
- Tracked-change/redline output.
- Fetching publisher guideline pages.
- Claim-support checking against cited abstracts or full text.
- General-purpose reference parsing or citation-manager round-tripping.
- Running model-generated code or adding a sandbox.
- Creating a new top-level entity, scope kind, database table, or push
  notification channel.

## Decisions

### 1. Manuscript review is a planless first-class durable workflow

`review_manuscript` validates explicit input roles, reserves an idempotent
`cortex_runs` row with `workflow_name = "executeManuscriptReview"`, obtains a
`RunSession` from `RunAuthorizer`, and launches only through `RunLauncher`. The
workflow receives immutable paths, content identities, review options, and the
authorized session.

The workflow seeds six fixed `cortex_step_executions` rows: `review-parse`,
`review-structure`, `review-language`, `review-coherence`, `review-references`,
and `review-conformance`. These rows use the existing status vocabulary and
ordered waves; no stored plan or `cortex_plans` row is created. A planless run
card names the workflow and phases explicitly.

Using `executeAnalysis` with a generated plan was rejected because the phases
are product semantics, not model output, and the document operations do not
belong in a code-execution sandbox.

### 2. Input roles and identities are resolved before launch

The tool accepts one manuscript path, optional model-paper paths, optional
guideline paths/text, and the external-resolution flag. Every staged path is
resolved and confined through existing workspace rules. The manuscript must be
DOCX; guideline and exemplar paths may be DOCX or PDF. Unsupported manuscript
types and missing/ambiguous paths are normal tool outcomes and launch no run.

The tool hashes every file input before reservation. The workflow input carries
path, SHA-256, size, and role so recovery never reclassifies files by current
conversation state. User-supplied guideline text is stored as an immutable run
input artifact with its own hash rather than embedded only in an event.

### 3. Parse once into an immutable document inventory

`review-parse` opens the source read-only and validates OPC/ZIP safety limits:
package size, entry count, per-entry inflated size, total inflated size, duplicate
entry names, path traversal, and required Word parts. It creates an immutable
inventory of parts, relationships, paragraph/run text and properties, styles,
sections, fields, bookmarks, comments, revisions, figures, tables, captions, and
source hashes. Subsequent phases read that inventory instead of reparsing the
package independently.

Section recognition starts with style relationships and built-in style ids,
then applies bounded deterministic heading evidence. The inventory records which
evidence selected a section and its confidence. An LLM never determines OOXML
addresses.

The implementation uses `fflate` as a direct dependency for ZIP decode/encode,
wrapped behind a small package abstraction. The writer preserves the uncompressed
bytes of untouched entries and mutates only explicitly allowed XML parts. A
whole-document XML parse/serialize write was rejected because it can reorder or
drop unknown markup.

### 4. Phase orchestration is deterministic; model work is bounded

The parent workflow owns phase transitions and named durable steps. Structure,
reference extraction, target measurements, dossier validation, and DOCX writing
are deterministic TypeScript. Language and coherence phases call narrowly
prompted agents through the configured `ChatProvider` over bounded paragraph
slices, with stable slice ids and structured outputs. Dynamic manuscript text is
always a user message, never interpolated into a system prompt.

Independent review phases may execute concurrently only through a fixed branch
shape whose joins and event order are deterministic under replay. Each phase
returns a typed outcome containing status, coverage, findings, measurements, and
diagnostics. The parent is the only writer of run-level terminal state.

Parsing or final dossier validation failure makes the run `failed`. If at least
one substantive review phase succeeds and a non-essential phase fails, the
dossier is still valid, explicitly records the gap, and the run is `partial`.
Absent optional inputs or declined external resolution are covered states, not
phase failures.

### 5. The dossier is the single review result contract

`ManuscriptReviewDossier` is a versioned Zod contract. It contains run and source
identity, input identities, phase outcomes, document measurements, resolved and
unresolved target constraints, reference extraction/resolution evidence,
findings, diagnostics, and aggregate coverage. Findings and reference checks
never live only in chat prose.

The parent validates and writes `runs/{runId}/review.json` atomically, computes
its hash, and registers it through `ArtifactRegistry` before terminal run state
or completion events are emitted. A dossier that cannot validate is not
advertised. Deterministic ordering by phase, source location, and id makes the
serialized artifact reproducible.

### 6. Findings separate review location from comment anchors

A finding contains a deterministic `findingId`, phase, severity, rationale,
location, optional original/replacement text, and optional `commentAnchor`.
Locations can be document-, section-, or paragraph-scoped. Comment anchors exist
only for exact source text and contain OOXML part name, paragraph index,
paragraph-text hash, and character range.

The id hashes the dossier schema version, source document hash, phase, normalized
location, and finding content. It is stable across replay of the same inputs and
changes when the source or finding changes. Findings such as a missing abstract
remain useful but non-commentable instead of inventing an anchor.

### 7. Reference extraction is layered and provenance-preserving

Reference extraction emits `ExtractedReference` values carrying raw document
text, source provenance, optional structured metadata, entry index, and mapped
in-text locations. Layers execute in order:

1. Decode supported Word/Zotero/EndNote field-code metadata when present.
2. Otherwise segment the bibliography using paragraph/style/heading evidence,
   with a bounded LLM segmentation fallback over text already present.
3. Detect numeric, superscript, and author-year markers across OOXML runs.
4. Map markers to entries using deterministic index or bounded fuzzy rules.
5. Optionally send the extracted batch to `CitationResolver.resolveMany`.

The LLM may propose segment boundaries but cannot add or repair bibliographic
fields. Raw entries remain the primary evidence. Structural checks—orphans,
danglers, numbering integrity, and style consistency—run without network access.
Low-confidence segmentation blocks external resolution for affected entries
rather than producing confident results from malformed input.

### 8. External citation resolution is approved before launch

`externalCitationResolution` defaults to false. When false, L4 records
`not_requested` and the workflow performs no authority calls. When true, the
conversation tool asks before run reservation/launch and identifies the source
document, the potential authorities, and the fact that literal raw citation
strings or structured fields will be transmitted. Denial launches nothing and
sends nothing.

The approved workflow receives the shared `CitationResolver` and invokes
`resolveMany` in one named durable step. It never calls the agent tool or creates
a `ToolContext`. Resolver verdict and coverage are copied without collapsing
`inconclusive` into `not_found`.

### 9. Target conformance is a set of sourced constraints

Guideline text/artifacts, available reporting-guideline inventory items, and
model papers produce candidate constraints with stable ids and source identity.
Only explicit guideline statements become required limits. Exemplar measurements
are marked `observed_from_exemplar` and remain comparisons, not requirements.
Conflicting sources remain attached to an unresolved constraint until precedence
or user-supplied guidance resolves them.

The conformance phase joins deterministic manuscript measurements to individually
resolved constraints. Missing sources yield `not_determined`; they never trigger
model-recalled venue rules. Reporting-guideline inventory absence is recorded and
does not lead to an invented path or substitute dataset.

### 10. Reviewed-copy emission is a separate approved operation

`emit_review_docx` accepts only `runId` and a non-empty set of finding ids. It
loads the terminal run's registered dossier, confines the source/output paths,
rehashes the source, and verifies that every selected finding exists, is
commentable, and still matches its paragraph hash, range, and original text.
Unknown, stale, or non-commentable selections return expected outcomes before
approval or writing.

The output identity hashes source SHA-256 plus sorted selected ids and is written
under the run workspace. If an artifact with that identity already exists and
validates, redelivery returns it. Otherwise the tool asks for approval naming the
source, count, and exact output path, writes to a temporary sibling, validates
the resulting package, atomically renames it, hashes it, and registers it. The
source is never opened for write.

### 11. OOXML mutation is surgical and preservation is semantic

Comment injection adds collision-free comment ids, range start/end markers,
comment references, the comments part if absent, the necessary document
relationship, and content-type declaration. Existing XML nodes are preserved in
their original representation wherever they are not an allowed mutation. Every
untouched binary entry has identical uncompressed bytes. Existing comments,
revisions, fields, bookmarks, hyperlinks, styles, numbering, media, custom XML,
and relationships remain present.

Validation reparses the output and checks package relationships, content types,
comment ids/anchors, paragraph text/style inventory, binary hashes, and canonical
XML outside allowed mutations. ZIP bytes and serializer formatting are not part
of the contract because adding an OPC part necessarily changes the archive.

### 12. Results remain pull-only

Run events expose fixed phase progress and terminal status but do not push the
dossier into a later conversation turn. `inspect_run` gains an optional
`reviewPath`, returned only for a terminal `executeManuscriptReview` run whose
registered dossier exists. List and targeted inspection remain bounded under the
existing rules. Conversation guidance tells the agent to inspect once, read the
advertised dossier, present findings with commentability, obtain a selection, and
then call `emit_review_docx`.

The run card schema gains a discriminated planless manuscript-review variant
rather than populating fake plan fields. Existing analysis-run cards remain
unchanged.

## Risks / Trade-offs

- **[OOXML has constructs outside the fixtures]** → Preserve unknown parts and
  markup by default, mutate an allowlist of parts, and fail closed when an anchor
  crosses unsupported structures.
- **[ZIP bombs or oversized media exhaust memory]** → Enforce compressed and
  inflated package limits before materializing entries; surface a normal
  unsupported/too-large outcome.
- **[Custom templates weaken section detection]** → Record evidence/confidence,
  use deterministic fallback signals, and report unknown structure rather than
  guessing.
- **[LLM review findings vary across providers]** → Use bounded stable slices,
  structured schemas, deterministic ids derived from returned content, and phase
  coverage rather than claiming reproducible prose.
- **[Plain-text bibliography segmentation is ambiguous]** → Retain raw text and
  confidence, allow segmentation-only fallback, and block external resolution
  when confidence is insufficient.
- **[Comment ranges can become stale]** → Bind them to source hash, paragraph
  hash, range, and original text and revalidate immediately before writing.
- **[External resolution leaks citation text]** → Default it off and require a
  pre-launch disclosure/approval specific to the document and authorities.
- **[A separate workflow duplicates some executeAnalysis finalization logic]** →
  Extract/reuse lifecycle helpers where their semantics are general, while
  keeping manuscript-specific phase derivation explicit in delta specs.

## Migration Plan

The change is additive. Add contracts and deterministic document modules first,
then the workflow and lifecycle integration, then conversation tools/cards/
inspection, and finally optional citation resolution and reviewed-copy emission.
Register `executeManuscriptReview` at the existing composition root only after
its input and terminal paths are covered by tests.

No existing run or artifact row is rewritten. Older hosts ignore the new
workflow name and card variant only if they never launch it; the harness and
embedder version update must include the exported contracts together. Rollback
removes the two tools and workflow registration. Existing review artifacts remain
ordinary ledger entries and can still be accessed as files.

## Open Questions

No implementation-blocking product questions remain. Initial package limits,
language/coherence slice sizes, and supported field-code variants are conservative
constants finalized with fixtures; extending those sets later does not change
the dossier or workflow contracts.
