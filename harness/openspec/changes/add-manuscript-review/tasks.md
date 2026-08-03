## 1. Prerequisites and Public Contracts

- [ ] 1.1 Confirm the implemented `add-citation-resolution` public service exposes the resolver batch, evidence, verdict, coverage, and cancellation contracts consumed by L4.
- [ ] 1.2 Add `fflate` as a direct harness dependency and add the package abstraction module without using transitive ZIP dependencies directly.
- [ ] 1.3 Define and export Zod/TypeScript contracts for immutable review launch input, source identities, phase outcomes, measurements, constraints, extracted references, findings, locations, comment anchors, and `ManuscriptReviewDossier`.
- [ ] 1.4 Add derived dossier invariants for source binding, stable phase ids, deterministic ordering, reference/finding identities, coverage, and comment-anchor ranges.
- [ ] 1.5 Add contract tests for valid complete/partial dossiers and invalid source, phase, coverage, finding, reference, and anchor combinations.

## 2. Safe DOCX and Supporting-Document Readers

- [ ] 2.1 Implement the read-only OPC/ZIP loader with path, duplicate-entry, encryption, compressed-size, entry-count, and inflated-size guards.
- [ ] 2.2 Implement relationship, content-type, styles, numbering, comments, fields, bookmarks, revisions, media, custom-XML, and unknown-part inventory collection.
- [ ] 2.3 Implement stable paragraph/run text inventory with OOXML part/index addresses, text hashes, character offsets, and relevant paragraph/run properties.
- [ ] 2.4 Implement style-first section detection plus bounded deterministic custom-template fallback and recorded evidence/confidence.
- [ ] 2.5 Implement DOCX and PDF text/inventory readers for optional guidelines and exemplars with immutable source identity.
- [ ] 2.6 Add parser tests for malformed/unsupported/over-limit packages, custom styles, superscript runs, field boundaries, rich OOXML constructs, and read-only source handling.

## 3. Reference Extraction and Offline Checks

- [ ] 3.1 Implement supported Word bibliography, Zotero, and EndNote field-code extraction while retaining raw text and exact provenance.
- [ ] 3.2 Implement plain-text bibliography location and paragraph/style/heading segmentation with per-entry confidence.
- [ ] 3.3 Implement the bounded segmentation-only LLM fallback and schema guards that reject model-supplied bibliographic fields.
- [ ] 3.4 Implement numeric, superscript, and author-year in-text marker detection across OOXML runs.
- [ ] 3.5 Implement deterministic numeric and bounded fuzzy author-year citation-to-entry mapping with evidence and confidence.
- [ ] 3.6 Implement offline orphan, dangler, first-appearance numbering, and formatting-style checks without fabrication claims.
- [ ] 3.7 Add reference fixtures/tests for each field-code family, plain text, ambiguous segmentation, split/superscript markers, low-confidence mapping, and all four offline checks.

## 4. Target Constraints and Deterministic Review Phases

- [ ] 4.1 Implement deterministic manuscript measurements for sections, abstract, words, references, figures, tables, captions, and cross-references.
- [ ] 4.2 Implement stable sourced-constraint extraction from user guidelines and actually available reporting-guideline inventory items with absence and conflict outcomes.
- [ ] 4.3 Implement exemplar measurements as `observed_from_exemplar` comparisons that cannot become required limits.
- [ ] 4.4 Implement structure and conformance phase functions with per-measurement/per-constraint coverage and `not_determined` handling.
- [ ] 4.5 Implement bounded language and coherence phase prompts, stable slicing, derived phase sessions, and structured-output validation.
- [ ] 4.6 Add phase tests for no-target intrinsic review, explicit limits, missing resources, conflicting constraints, exemplar-only comparisons, and coherence/claim-support separation.

## 5. Optional External Citation Resolution

- [ ] 5.1 Add the default-off launch option and pre-launch disclosure/approval naming the source document, potential authorities, and transmitted citation content.
- [ ] 5.2 Implement L4 batch preparation that uses only raw document evidence and extracted structured fields and skips low-confidence segmentation.
- [ ] 5.3 Invoke the shared `CitationResolver.resolveMany` in one named durable step and preserve every verdict, source outcome, comparison, conflict, and coverage value in the dossier.
- [ ] 5.4 Add tests proving the default and denied paths send nothing and launch appropriately, while approved partial/outage outcomes are not collapsed to `not_found`.

## 6. Planless Durable Workflow

- [ ] 6.1 Define the serialized `executeManuscriptReview` input/result and dependency bag with authorized `RunSession`, ownership flag, logger, pool, workspace/artifact seams, chat provider, event stream, and optional resolver.
- [ ] 6.2 Implement idempotent planless run reservation with invocation-derived bare UUID, analysis/thread scoping, authorization-failure cleanup, and duplicate-delivery behavior.
- [ ] 6.3 Register `executeManuscriptReview` at the single runtime composition root and launch it only through `RunLauncher`.
- [ ] 6.4 Seed the six fixed phase ledger rows idempotently with stable waves/identities and implement monotone running/terminal phase transitions.
- [ ] 6.5 Implement the fixed replay-deterministic phase graph, bounded fixed concurrency, named durable steps, and phase event emissions without plan generation.
- [ ] 6.6 Implement deterministic dossier assembly, atomic `review.json` persistence, validation, hashing, and pre-terminal artifact registration.
- [ ] 6.7 Implement one replay-safe finaliser for completed, partial, failed, canceled, and insufficient-funds outcomes, including phase settlement, charge close, authorization revoke, and exactly one terminal event.
- [ ] 6.8 Add workflow/body tests for replay, duplicate launch, all-complete, optional absence, partial phase failure, parse failure, dossier failure, operator cancel, budget exhaustion, and terminal-side-effect idempotency.

## 7. Run Cards, Inspection, and Conversation Guidance

- [ ] 7.1 Add the discriminated planless manuscript-review `data-run-card` contract, schema, builder, rendering payload, and reconstruction path without changing plan-backed cards.
- [ ] 7.2 Extend targeted `inspect_run` with artifact-gated nullable `reviewPath` for terminal manuscript-review runs only.
- [ ] 7.3 Add inspection tests for running, suspended, completed/partial with dossier, failed without dossier, unrelated workflow, missing ledger entry, and bounded wait behavior.
- [ ] 7.4 Add `review_manuscript` to the conversation-agent roster and implement explicit role validation, path confinement, hashing, approval, reservation, authorization, launch, and card emission.
- [ ] 7.5 Update conversation guidance to keep completion pull-only, avoid inspect polling, read only advertised dossiers, present stored ids/commentability, and request a selection before emission.
- [ ] 7.6 Add roster, prompt, card, reconstruction, and launch-tool regression tests.

## 8. Reviewed-Copy Emission

- [ ] 8.1 Implement dossier lookup and source/selection validation for `emit_review_docx`, including unknown, duplicate, stale, out-of-range, and non-commentable expected outcomes.
- [ ] 8.2 Implement deterministic reviewed-copy identity/path derivation from source hash and sorted unique selected ids plus valid-artifact replay lookup.
- [ ] 8.3 Implement exact pre-write approval with source, selected count, and output path and prove denial writes/registers nothing.
- [ ] 8.4 Implement surgical comment ids, ranges, references, bodies, document relationships, and content-type mutations with fail-closed unsupported-anchor handling.
- [ ] 8.5 Implement temporary sibling write, semantic package validation, atomic final rename, hashing, and reviewed-copy artifact registration.
- [ ] 8.6 Add `emit_review_docx` to the conversation-agent roster and export its public result contracts.

## 9. DOCX Preservation Fixtures

- [ ] 9.1 Add real DOCX fixtures for Zotero, EndNote, Word bibliography sources, plain-text bibliography, custom heading styles, split superscript markers, and multiple findings in one paragraph.
- [ ] 9.2 Add rich preservation fixtures containing existing comments, tracked changes, hyperlinks, fields, bookmarks, numbering, media, relationships, custom XML, and unknown parts.
- [ ] 9.3 Add successful emission tests for exact ranges, existing-comment id collision avoidance, selected subsets, different subset identities, and idempotent redelivery.
- [ ] 9.4 Add failure tests for stale source/paragraph/range/original text, non-commentable selection, unsupported OOXML boundary, output validation failure, and artifact registration failure.
- [ ] 9.5 Add preservation assertions for untouched binary hashes, canonical XML outside allowed mutations, relationships/content types, existing comment ids, paragraph text/style inventory, package reopen, and unchanged source hash.

## 10. Verification

- [ ] 10.1 Format all changed harness source and test files with the subsystem formatter.
- [ ] 10.2 Run focused contract, DOCX, reference, phase, workflow, inspection/card, and emission tests and resolve failures.
- [ ] 10.3 Run `tsc -p tsconfig.json`, `bun run lint`, and `bun run test:full` from `harness` and resolve regressions.
- [ ] 10.4 Run `openspec validate add-manuscript-review --strict` and confirm every task-backed requirement remains represented.
