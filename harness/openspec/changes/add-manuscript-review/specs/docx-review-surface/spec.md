## ADDED Requirements

### Requirement: DOCX parsing enforces package safety before inventory

The DOCX reader SHALL open the source read-only, SHALL reject path traversal and duplicate ZIP entry names, SHALL enforce configured compressed size, entry-count, per-entry inflated size, and total inflated-size limits, and SHALL require the OPC parts needed for a Word document before materializing an inventory. Unsupported, encrypted, malformed, or over-limit packages SHALL return typed outcomes and SHALL NOT be partially mutated.

#### Scenario: ZIP traversal entry is rejected

- **WHEN** a DOCX contains an entry whose normalized path escapes the package root
- **THEN** parsing rejects the package before any entry is written to disk

#### Scenario: Inflated-size limit is exceeded

- **WHEN** compressed entries would exceed the configured total inflated-size limit
- **THEN** parsing stops with an over-limit outcome and produces no inventory

### Requirement: The document inventory preserves OOXML addressability

The DOCX reader SHALL inventory package parts, relationships, content types, paragraphs, runs, text, paragraph/run properties, styles, sections, fields, bookmarks, comments, tracked revisions, figures, tables, captions, numbering, media references, and source hashes needed by review and validation. Paragraph indices and text hashes SHALL be stable for one exact source package, and text extraction SHALL retain run properties needed to detect superscript markers and field-code boundaries.

#### Scenario: Existing rich document is inventoried

- **WHEN** a source contains comments, tracked changes, hyperlinks, fields, media, and custom styles
- **THEN** the inventory records those constructs and their package relationships without modifying the source

#### Scenario: Superscript remains addressable

- **WHEN** a citation number is represented by a run with superscript vertical alignment
- **THEN** the inventory retains that run property beside its paragraph and character position

### Requirement: Comment emission validates stored selections against the source

`emit_review_docx` SHALL load a terminal manuscript-review run and its registered dossier, SHALL rehash the source, and SHALL validate every selected finding id, `commentAnchor`, paragraph-text hash, character range, and original text before approval or writing. Unknown, stale, duplicate, or non-commentable selections SHALL return expected non-written outcomes. The tool SHALL NOT accept an arbitrary dossier path or caller-supplied anchor.

#### Scenario: Source changed after review

- **WHEN** the current source hash differs from the dossier's source SHA-256
- **THEN** emission returns a stale-source outcome before asking for approval
- **AND** no output is written

#### Scenario: Selection contains a document-level finding

- **WHEN** a selected finding has no `commentAnchor`
- **THEN** emission returns a non-commentable-selection outcome before writing

### Requirement: Reviewed-copy approval names the exact operation

After all selection and source validation succeeds, `emit_review_docx` SHALL call `ctx.ask` with the exact source path, selected finding count, and deterministic output path. Denial SHALL write and register nothing. Approval SHALL apply only to that source identity and selected finding set.

#### Scenario: User approves a subset

- **WHEN** three commentable findings are selected and validation succeeds
- **THEN** the approval request names that three-finding operation and its output path
- **AND** unselected findings are not included in the reviewed copy

#### Scenario: User denies emission

- **WHEN** the user denies the exact reviewed-copy operation
- **THEN** no DOCX is written, no artifact is registered, and the source remains unchanged

### Requirement: Reviewed-copy identity is deterministic and idempotent

The output identity and path SHALL derive from source SHA-256 and sorted unique selected finding ids under the run workspace. If a registered output with that identity exists and passes hash/package validation, redelivery SHALL return it without rewriting or requesting duplicate approval. Different selected sets SHALL produce different identities. The writer SHALL create a temporary sibling, validate it, and atomically rename it to the final path before artifact registration.

#### Scenario: Identical delivery is replayed

- **WHEN** the same source and selected ids are delivered after a valid reviewed copy was registered
- **THEN** the tool returns the existing artifact and performs no second write

#### Scenario: Selection changes

- **WHEN** one finding id is added to an otherwise identical approved selection
- **THEN** the derived output identity and path differ from the earlier reviewed copy

### Requirement: Comment injection performs only allowed OOXML mutations

The writer SHALL add collision-free comment ids, exact comment-range start/end markers, comment references, comment bodies, and only the relationships and content-type declarations required by the comments part. It SHALL preserve existing comment ids and bodies. It SHALL reject an anchor that cannot be represented without crossing unsupported OOXML structures instead of widening or relocating the range.

#### Scenario: Document already has comments

- **WHEN** the source has existing comment ids and two findings are emitted
- **THEN** existing ids and bodies remain unchanged and both new ids are collision-free

#### Scenario: Anchor crosses unsupported structure

- **WHEN** a selected range cannot be represented without crossing a field or incompatible tracked-revision boundary
- **THEN** emission fails closed for that selection and writes no final output

### Requirement: Preservation is semantic rather than archive-byte identity

Every pre-existing binary package part SHALL retain identical uncompressed bytes. Existing comments, relationships, styles, numbering, media, fields, bookmarks, hyperlinks, tracked revisions, custom XML, and unknown package parts SHALL remain present. XML outside selected anchors and minimal comment plumbing SHALL be semantically unchanged under canonical comparison. The output SHALL reparse to the same paragraph text/style inventory as the source and SHALL pass package relationship, content-type, and comment validation. The contract SHALL NOT require identical ZIP bytes or serializer formatting.

#### Scenario: Rich source survives comment injection

- **WHEN** comments are emitted into a fixture containing media, fields, hyperlinks, tracked changes, custom XML, and existing comments
- **THEN** output validation finds all pre-existing constructs preserved and all untouched binary hashes equal

#### Scenario: ZIP encoding changes harmlessly

- **WHEN** the output archive has different compression or central-directory bytes but passes semantic and package validation
- **THEN** preservation succeeds and is not rejected for archive-byte inequality

### Requirement: The source document is never overwritten

All review and emission operations SHALL open the source without write access and SHALL place reviewed copies under a confined run output path. A failure at any parse, mutation, validation, rename, or registration stage SHALL leave the source bytes unchanged.

#### Scenario: Output validation fails

- **WHEN** a temporary reviewed package fails post-write validation
- **THEN** no final reviewed-copy artifact is registered
- **AND** the source document retains its original hash
