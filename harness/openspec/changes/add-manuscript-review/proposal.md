# Review a manuscript against a target journal, and comment on a reviewed copy

## Why

Researchers using Inflexa write the papers that report the work. The editorial
tools that would help them — Paperpal, Writefull, Grammarly — are third-party
SaaS, and an unpublished manuscript carrying unreleased results or IP cannot be
pasted into one. That constraint is not a market gap Inflexa happens to be able
to fill; it is the same constraint that produced the product. A manuscript
review uses the `ChatProvider` the user already wired. When that provider is
local, the manuscript never leaves the machine; when it is remote, the provider
boundary is the only place manuscript prose is sent.

The reference half of the problem is worse than the language half and is the
one no general-purpose editor addresses at all. A bibliography assembled with
LLM help can contain works that do not exist, and it can contain real works that
do not say what they are cited for. `paper/RELATED-WORK.md` §6 in this repository
is that failure enumerated by hand for a single manuscript: six probably-fabricated
works, four claims asserted about real papers that those papers do not support,
and four metadata records that were simply wrong at the source. Doing that by
hand took a person a long afternoon. Existence and metadata checks are
mechanizable; claim-support checking is a separate, more expensive increment.

What the harness supplies today gets most of the way. Staging is
format-agnostic, so a `.docx` is already a legal input. The data profiler already
recognizes `.docx` and `.pdf` as `dataType: "document"`. `fast-xml-parser` and
`pdf-parse` are already dependencies. Durable workflows, the run-event stream,
the artifact ledger, the `RunAuthorizer` seam, and the `RunLauncher` seam already
exist and are agnostic about what a run computes. What is missing is a durable
review that knows what a manuscript is, exposes its result through the existing
pull model, and can turn an explicitly selected subset of findings into comments
without rewriting the source document.

## What Changes

A manuscript review is a durable workflow over an ordinary analysis — the
analysis is the container ("my GigaScience paper"), its immutable inputs are the
manuscript plus any guidelines or model papers the user supplies, and the review
is a run inside it. The `review_manuscript` conversation tool reserves a
`cortex_runs` row with `workflow_name = "executeManuscriptReview"`, authorizes a
`RunSession`, and launches through the existing `RunLauncher` seam. The workflow
writes under `runs/{runId}/`. It needs no new `Scope` kind, top-level entity,
table, or session-model change.

The v1 manuscript input is explicitly `.docx`. A staged PDF may be used as a
model paper or guideline source, but a PDF manuscript is rejected as a normal
unsupported-input outcome because the reviewed-copy surface is OOXML-specific.
The launch input identifies roles rather than asking the workflow to guess:

- required `manuscriptPath`;
- optional `modelPaperPaths`;
- optional staged `guidelinePaths` and/or user-supplied `guidelineText`;
- `externalCitationResolution`, default `false`.

**The manuscript is the only required input.** A user with no exemplar and no
target venue in mind gets a complete intrinsic review — that is the common case,
not a degraded one. Conformance is the only review phase that needs a target
specification, and it records each unresolved constraint instead of blanking the
whole phase.

- New `executeManuscriptReview` workflow with six stable phases and no generated
  plan. It does not call `generate_plan`; its shape is part of the capability:

  | Phase id | What it does | Needs a target spec |
  |-|-|-|
  | `review-parse` | `.docx` → paragraph and OOXML inventory, plus source hash | no |
  | `review-structure` | intrinsic integrity: captions and references for figures/tables, section order, abstract presence, citation-style consistency, and measurements such as word/reference/figure counts | no |
  | `review-language` | register, grammar, and clarity over bounded paragraph slices | no |
  | `review-coherence` | abstract ↔ body ↔ conclusions agreement and claims that outrun evidence presented inside the manuscript; not support from cited papers | no |
  | `review-references` | extract bibliography and in-text citations, map one to the other, run structural checks, and optionally resolve entries externally | no |
  | `review-conformance` | check each measurement against one resolved constraint | yes, where one resolved |

  Structure always reports what the manuscript *is*. Conformance reports what
  it is *supposed to be* only where a source establishes that requirement. An
  abstract limit that resolved is checked; one that did not is recorded as
  measured-but-unconstrained. A review with no target specification loses only
  those conformance verdicts.

  A model paper, when one exists, additionally gives the language phase a
  register to compare against — "the exemplar states results in past tense
  without hedging" is more actionable than generic clarity advice. Absent one,
  the language phase judges against ordinary scientific English.

- The workflow seeds one `cortex_step_executions` row per stable phase and emits
  the existing run-started, DAG/phase-state, step-activity, terminal output, and
  run-completed/run-failed parts. The phases may use bounded internal concurrency,
  but their durable operations and event order remain replay-deterministic.
  Parsing or dossier-validation failure fails the run. A non-essential review
  phase that cannot complete records failed coverage and permits a `partial` run
  with a valid dossier; absence of optional guidelines, exemplars, or external
  citation resolution is not failure.

- **Paragraph style names carry structure, but they are not the only signal.**
  Word documents record `Heading 1`, `Abstract`, and `Caption` as paragraph
  styles. Section detection starts there and falls back to bounded deterministic
  heading evidence when custom templates rename styles. The dossier records which
  evidence established each section; it never silently treats an unrecognized
  style as prose.

- New `ManuscriptReviewDossier` contract in `src/contracts/`, coverage-disciplined
  in the manner of `target-dossier.ts`. It carries `schemaVersion`, `runId`, the
  exact source document `{path, sha256, size}`, phase outcomes, measurements,
  constraints, reference checks, and findings. Coverage is recorded per
  constraint/reference operation, not merely per section: "abstract 243 words,
  limit 150 (user-supplied guidelines), over by 93" and "abstract 243 words, no
  limit determined" are both complete results. A phase that could not run says
  why. The validated dossier is persisted as `runs/{runId}/review.json`, hashed,
  and registered in `cortex_artifacts` before the run becomes terminal.

- Findings are stable, source-bound, located, severity-graded, and explicit
  about whether they can become a Word comment:
  `{findingId, phase, location, original?, replacement?, rationale, severity,
  commentAnchor?}`. `location` can identify the document, a section, or a
  paragraph, so findings such as a missing abstract do not invent text to anchor
  to. A `commentAnchor` exists only when exact source text can carry a comment;
  it contains the OOXML part, paragraph index, paragraph text hash, and character
  range. `findingId` is a deterministic hash of the source document hash plus
  the finding's phase, location, and content. Multiple findings in one paragraph
  therefore remain independently selectable, while no finding can be applied to
  a different manuscript version by index alone.

- New `emit_review_docx` conversation tool. Its input is `runId` plus non-empty
  `selectedFindingIds`; it never accepts model-reconstructed finding objects.
  The tool loads the registered dossier, verifies the source document hash and
  every selected finding's comment anchor/original text, and rejects unknown,
  stale, or non-commentable selections as expected data outcomes before asking
  for approval. It then calls `ctx.ask` with the exact source, selected finding
  count, and output path before writing. Approval is therefore for a concrete
  commentable selection, not for every suggestion in a review. The output path
  is deterministic from the source hash and sorted finding ids, so redelivery is
  idempotent and different approved subsets produce different reviewed copies.
  The user's source file is never modified.

- Review launch and completion follow the existing pull-only run model. A
  planless `data-run-card` variant carries `runId`, workflow kind, title, and six
  phases without inventing a stored analysis plan. After terminal completion,
  `inspect_run` exposes `reviewPath` only when the artifact ledger confirms the
  registered `review.json`; it remains `null` while running, on failure before a
  dossier exists, or for unrelated workflows. Conversation guidance teaches the
  agent to inspect the run, read the advertised dossier, present findings and
  their commentability for selection, and only then call `emit_review_docx`.

### Extracting references

Extraction quality and feature value are inversely correlated, and the design
follows from that. A bibliography carried in Zotero, Mendeley, EndNote, or Word
field codes often yields structured metadata and a citation map. A plain-text
bibliography is the hard case, and it is where fabrications live: an
LLM-assembled reference list has no field codes by construction, and "Unlink
Citations" / "Convert to Plain Text" are routine pre-submission steps that strip
them from otherwise structured documents. **Plain text is the primary case;
field codes are an accelerator.**

No general citation-management parser is built. Field-code metadata is consumed
when present; otherwise the raw entry is retained as the primary evidence. The
resolver contract from `add-citation-resolution` accepts that raw string plus
optional structured fields and decides which sources are applicable. Crossref
can run a bibliographic query over raw prose; PubMed `ecitmatch` is used only when
the extraction supplied its required fields, and raw PubMed/Semantic Scholar/
arXiv searches are treated as candidate generation rather than exact identity.
The returned record is compared to fields or tokens actually present in the
entry, with field-level diagnostics. No LLM-recalled author, title, year, or
venue becomes resolver input.

Extraction is layered, every layer emitting one `ExtractedReference`
`{raw, provenance, structured?, entryIndex, citedAt}`:

| | | |
|-|-|-|
| L0 | field codes (`ADDIN ZOTERO_ITEM CSL_CITATION`, `ADDIN EN.CITE`, `word/bibliography/sources.xml`) | structured metadata and citation↔entry map where encoded |
| L1 | otherwise segment by paragraph boundary, bibliography style, and heading evidence | raw entry strings with segmentation confidence |
| L2 | detect in-text markers across OOXML runs | numeric, superscript, author-year |
| L3 | map markers to entries — numeric by index, author-year by bounded fuzzy match | citation↔entry map with mapping confidence |
| L4 | when externally approved, send the extracted batch to `CitationResolver.resolveMany`; otherwise record `not_requested` | verdicts, coverage, source records, or an explicit offline outcome |

L2 is the concrete reason this parses OOXML rather than extracted text: a
superscript citation marker is `w:vertAlign="superscript"` in the run properties
and is invisible to plain-text extractors.

Four checks fall out of L1–L3 alone, needing no network, target specification, or
external resolver — they always ship and run:

- **orphans** — in the bibliography, never cited;
- **danglers** — cited in the text, absent from the bibliography;
- **numbering integrity** — numeric styles cited out of first-appearance order;
- **style consistency** — outlier formatting reported as an anomaly, never by
  itself as proof of fabrication.

Five rules govern reference review:

- **Extraction provenance rides with every reference and reaches the dossier.**
  A resolver `not_found` on clean field-code metadata and one on a low-confidence
  segmented string have the same bibliographic verdict but different extraction
  confidence; the dossier preserves both dimensions.
- **Resolver coverage is never erased.** `inconclusive` and partial coverage are
  not rewritten as `not_found`, and `unverifiable` is used only when the input
  itself establishes an unsupported work kind.
- **Segmentation failure is an outcome, not an error.** When the bibliography
  cannot be located confidently, the phase records that and stops before
  external resolution. Verifying garbage produces confident nonsense.
- **The LLM may segment; it may not supply metadata.** A bounded LLM fallback may
  divide text already present in the document, but it may not fill missing
  authors, titles, venues, dates, identifiers, or page ranges from memory.
- **External resolution is opt-in.** `externalCitationResolution: false` yields
  a complete offline structural review with L4 recorded as `not_requested`. If
  true, `review_manuscript` obtains `ctx.ask` approval before launch, naming the
  source document and the bibliographic authorities that will receive extracted
  citation strings. A denial writes and sends nothing.

### Resolving the target specification

The specification is a set of individually-resolved constraints, not a document
the review either has or lacks. Each constraint is drawn from whichever of three
optional sources supplies it:

1. **Guidelines the user supplies**, pasted into the conversation or staged as
   an input. The most authoritative when present, because it is the venue
   speaking.
2. **Reporting guidelines from the reference inventory**, if a relevant item is
   actually available. Absence is recorded and no path or dataset is invented.
3. **A model paper**, if the user has one. An exemplar demonstrates structure,
   section proportions, citation density, and register. It is evidence of what
   the venue accepted, not a statement of what it requires — a constraint derived
   this way is `observed_from_exemplar` and reads as "the exemplar's abstract is
   148 words; yours is 243," never as a limit.

All three are optional and the common case is that none are present. Every
constraint carries a stable id, source kind and source artifact/text identity,
resolution status, and any conflicting observations. An unresolved constraint
is `not_determined`; the corresponding manuscript measurement still stands.

Two anti-hallucination rules follow:

- **The model's own recollection of a venue's requirements is not a source.** If
  no supplied source states the limit, there is no limit — the review records
  `not_determined` and moves on.
- **An exemplar is never promoted to a rule.** Deriving "abstracts here run
  around 150 words" from one paper and reporting it as a 150-word limit invents
  a requirement out of a sample of one.

When the user names a target venue but supplies nothing that states its rules,
the honest outcome is a review with measurements and no conformance verdicts,
plus a note naming which constraints would need a source. Asking the user for
guidelines is a reasonable conversational follow-up; guessing them is not.

### DOCX preservation contract

The reviewed copy promises semantic preservation, not archive-byte identity. A
`.docx` is an OPC ZIP package, and adding comments necessarily changes package
relationships, content types, `word/document.xml`, and the ZIP directory. The
testable contract is:

- the source `.docx` is opened read-only and never overwritten;
- every pre-existing binary part retains the same bytes;
- existing comments, relationships, styles, numbering, media, fields,
  bookmarks, hyperlinks, tracked revisions, and custom XML are preserved;
- XML outside the selected comment anchors and the minimal new comment plumbing
  (comment bodies, relationships, and content-type declarations) is semantically
  unchanged, tested by canonical XML rather than ZIP or serializer byte
  equality;
- existing comment ids are retained and new ids are collision-free;
- only selected, source-validated findings with `commentAnchor` produce comment
  anchors and bodies; and
- the output package opens successfully in the OOXML validation fixture and can
  be reparsed into the same paragraph text/style inventory as the source.

Comment injection uses a package-aware ZIP reader/writer and surgical OOXML
updates. `fast-xml-parser` may inspect or canonicalize XML for tests, but a
parse/serialize pass over the whole document is not the write strategy.

### Deliberately not in this change

- **Tracked changes.** v1 emits comments. `w:comment` injection is simpler and,
  for a review deliverable, more accurate — a reviewer comments and an author
  decides. The source-bound finding contract is already what a later redline
  writer would consume.
- **PDF manuscript review or PDF annotation.** PDFs may inform a review as
  guidelines/exemplars, but v1 requires a `.docx` manuscript so findings have
  stable OOXML anchors and can be emitted as Word comments.
- **A sandbox.** Nothing here runs model-generated code. Parsing OOXML and
  injecting comments is fixed, testable host-side TypeScript.
- **Fetching publisher author-guideline pages.** That would add a broad egress
  surface and a direct prompt-injection path into an agent proposing edits.
  Untrusted publisher HTML is not worth a word count.
- **Claim support against cited papers.** Whether a work supports the sentence
  citing it requires abstracts or full text and a separate explicit cost/privacy
  decision. The coherence phase checks only evidence presented in the manuscript.
- **Staging reporting-guideline datasets.** Curating EQUATOR or ICMJE content is
  separate content work; the absent-resource behavior is already complete.

## Capabilities

### New Capabilities

- `manuscript-review`: the durable fixed-phase workflow; explicit input roles;
  run lifecycle and partial-failure semantics; dossier and per-constraint/
  per-reference coverage; offline and externally-approved reference modes;
  stable source-bound findings; pull-based result discovery; and the
  anti-invention rules for venue constraints, exemplars, segmentation, metadata,
  and resolver coverage.
- `docx-review-surface`: deterministic OOXML inventory and reference extraction;
  paragraph/style/run-aware L0–L3 layers; stable anchors; selected-finding comment
  injection; idempotent reviewed-copy identity; and semantic package preservation
  without claiming ZIP-byte identity.

### Modified Capabilities

- `harness-durable-runtime`: register `executeManuscriptReview` at the single
  composition root and launch it only through `RunLauncher` after run
  authorization.
- `run-state-persistence`: reserve and terminally update planless manuscript
  review run rows under the existing run ledger and status vocabulary.
- `step-execution-tracking`: represent the six fixed review phases in the
  existing phase/step ledger without pretending they came from an analysis plan.
- `conversation-run-awareness`: define asynchronous launch, bounded inspection,
  and pull-only completion guidance for manuscript reviews.
- `run-inspection`: expose `reviewPath` only for a terminal manuscript-review run
  whose dossier is present in the artifact ledger.
- `display-cards`: permit a planless run card that identifies the workflow kind
  and fixed phase count while preserving existing analysis-plan cards.
- `artifact-manifest`: register the host-produced dossier and reviewed copies as
  content-hashed run artifacts with their source run/phase identity.
- `workflow-failure-lifecycle`: classify required parse/dossier failures as
  terminal and optional phase gaps as explicit partial coverage.

## Impact

Depends on `add-citation-resolution` for external L4. The manuscript workflow
receives the shared `CitationResolver` service and calls `resolveMany` inside a
named durable step; it does not call the agent-facing `resolve_citation` tool.
L0–L3, the four structural checks, and the complete offline review are
independent and remain available when external resolution is not requested or
approved.

Harness source:

- `src/workflows/execute-manuscript-review.ts` and
  `src/workflows/manuscript-review/` — workflow, phase ledger/events, coverage,
  artifact registration, and result persistence.
- `src/contracts/manuscript-review.ts` — dossier, phase/constraint/reference
  coverage, source identity, finding locations, optional comment anchors, and
  deterministic finding ids; exported for consumers.
- `src/documents/docx.ts` — read-only inventory and package-aware comment
  injection over a ZIP abstraction.
- `src/documents/references.ts` — L0–L3 extraction and `ExtractedReference`;
  separate from OOXML package mutation so it can evolve against fixtures.
- `src/tools/review-manuscript.ts` — run reservation, optional external-resolution
  disclosure/approval, run authorization, launch, and planless run card.
- `src/tools/emit-review-docx.ts` — dossier lookup, selected-id and source-anchor
  validation, exact approval, idempotent output, and artifact registration.
- `src/tools/research/inspect-run.ts`, `src/memory/card-builders.ts`, and chat-part
  contracts — planless review cards and artifact-gated `reviewPath`.
- `src/agents/conversation-agent.ts`, `src/prompts/conversation.ts`, and
  `src/runtime/assemble.ts` — tools, pull guidance, workflow registration, and
  shared resolver injection.
- `src/prompts/manuscript-review/` — language and coherence sub-agent prompts;
  dynamic document slices remain user messages, never system-prompt content.

Test fixtures are real `.docx` packages covering Zotero, EndNote, Word
bibliography sources, a plain-text bibliography, custom heading styles,
superscript markers, existing comments, tracked changes, hyperlinks, fields,
media, and multiple findings in one paragraph. Tests compare source/output
inventories, canonical XML, binary-part hashes, relationships, content types,
comment ids, and successful re-open — not archive bytes.

New dependency: a package-aware ZIP reader/writer (`fflate` or an equivalent
selected in design). `fast-xml-parser` and `pdf-parse` are already present. No
lib-store package, sandbox image, or sandbox egress change.

**Confidentiality boundary**, stated as requirements:

- Manuscript, guideline, and exemplar prose goes only to the wired
  `ChatProvider`. A local provider keeps it on the machine; a remote provider is
  an explicit external boundary the harness cannot describe as local.
- With `externalCitationResolution: false` (the default), no bibliography entry
  is sent to a bibliographic authority; the structural reference review still
  completes.
- With external resolution enabled, the conversation tool obtains approval
  before launch and discloses that extracted raw citation strings or structured
  citation fields — literal content from the user's document, potentially
  including unpublished or in-press entries — will be sent to the resolver's
  named authorities. Only those citation entries are sent, never surrounding
  claims, results, working title, or manuscript prose.
- No publisher-page fetch or other outbound path is introduced. The output copy
  is written locally under the analysis workspace and the source is never
  modified.
