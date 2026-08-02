# Review a manuscript against a target journal, and comment on it in place

## Why

Researchers using Inflexa write the papers that report the work. The editorial
tools that would help them — Paperpal, Writefull, Grammarly — are third-party
SaaS, and an unpublished manuscript carrying unreleased results or IP cannot be
pasted into one. That constraint is not a market gap Inflexa happens to be able
to fill; it is the same constraint that produced the product. A manuscript
reviewed by the model the user already wired never leaves the machine.

The reference half of the problem is worse than the language half and is the
one no general-purpose editor addresses at all. A bibliography assembled with
LLM help contains works that do not exist, and it contains real works that do
not say what they are cited for. `paper/RELATED-WORK.md` §6 in this repository
is that failure enumerated by hand for a single manuscript: six probably-fabricated
works, four claims asserted about real papers that those papers do not support,
and four metadata records that were simply wrong at the source. Doing that by
hand took a person a long afternoon. It is mechanizable, and the machinery is
mostly already here.

What the harness supplies today gets most of the way. Staging is
format-agnostic, so a `.docx` is already a legal input. The data profiler
already parses `.docx` and `.pdf` and registers them as `dataType: "document"`.
`fast-xml-parser` and `pdf-parse` are already dependencies. Durable workflows,
the run-event stream, the artifact ledger, and the `RunLauncher` seam already
exist and are agnostic about what a run computes. What is missing is a review
that knows what a manuscript is.

## What Changes

A manuscript review is a durable workflow over an ordinary analysis — the
analysis is the container ("my GigaScience paper"), its inputs are the
manuscript plus any model papers the user happens to have, and the review is a
run inside it. It launches through the existing `RunLauncher` seam exactly as
`execute_plan` does, writes under `runs/{runId}/`, and needs no new `Scope`
kind, no new table, and no session-model change.

**The manuscript is the only required input.** A user with no exemplar and no
target venue in mind gets a full review — that is the common case, not a
degraded one. Only one of the five review phases consults a target
specification at all, and it is the phase that degrades most gracefully.

- New `executeManuscriptReview` workflow with a fixed internal shape — this is
  not a planned DAG, so it does not go through `generate_plan`:

  | Phase | What it does | Needs a target spec |
  |-|-|-|
  | parse | `.docx` → paragraph inventory `{idx, style, text}` | no |
  | structure | intrinsic integrity: every figure and table has a caption and is referenced from the text, sections appear in a coherent order, an abstract exists, citation style is internally consistent — plus the measurements themselves (abstract 243 words, main text 4,812, 6 figures, 58 references) | no |
  | language | register, grammar, clarity — over bounded paragraph slices | no |
  | coherence | abstract ↔ body ↔ conclusions agreement; claims that outrun their stated evidence | no |
  | references | extract the bibliography and in-text citations, map one to the other, run the structural checks, fan out `resolve_citation` per entry (below) | no |
  | conformance | each measurement checked against a resolved constraint — per constraint, not per phase | yes, where one resolved |

  Structure always reports what the manuscript *is*. Conformance is the only
  thing that needs to know what it is *supposed to be*, and it reports per
  constraint: an abstract limit that resolved is checked, one that did not is
  reported as measured-but-unconstrained. A review with no spec at all loses
  exactly the conformance verdicts and nothing else.

  A model paper, when one exists, additionally gives the language phase a
  register to compare against — "the exemplar states results in past tense
  without hedging" is more actionable than generic clarity advice. Absent one,
  the language phase judges against ordinary scientific English, which is what
  it would do anyway for a user with no target venue.

- **Paragraph style names carry the structure.** Word documents record
  `Heading 1`, `Abstract`, `Caption` as paragraph styles. Section detection
  reads those, not regular expressions over prose — the difference between a
  check that works on a real manuscript and one that works on a tidy one.
- New `ManuscriptReviewDossier` contract in `src/contracts/`, coverage-disciplined
  in the manner of `target-dossier.ts`. Coverage is recorded **per constraint**,
  not per section: "abstract 243 words, limit 150 (user-supplied guidelines),
  over by 93" and "abstract 243 words, no limit determined" are both complete
  results, and neither is an empty section. A phase that could not run at all
  says so rather than reporting nothing. Persisted as `runs/{runId}/review.json`,
  beside the existing `synthesis.json` convention.
- Findings are **paragraph-addressed and severity-graded** — `{paragraphIdx,
  original, replacement?, rationale, severity}`. This is the load-bearing
  representation choice. It bounds context (slices, not the whole document),
  makes each finding individually approvable, and keeps every untouched
  paragraph byte-identical, which is what makes round-tripping a `.docx`
  survivable at all.
- New `emit_review_docx` conversation tool: writes a reviewed **copy** of the
  manuscript with the approved findings injected as Word comments
  (`w:commentRangeStart` / `w:commentRangeEnd` / `w:commentReference` plus
  `word/comments.xml`). The user's file is never modified.

### Extracting references

Extraction quality and feature value are inversely correlated, and the design
follows from that. A bibliography carried in Zotero, Mendeley, EndNote, or Word
field codes yields full structured metadata for free — and contains
approximately no fabricated entries, because every one of them came from a
record somewhere. A plain-text bibliography is the hard case, and it is where
fabrications live: an LLM-assembled reference list has no field codes by
construction, and "Unlink Citations" / "Convert to Plain Text" are routine
pre-submission steps that strip them from everyone else's. **Plain text is the
primary case; field codes are an accelerator.**

**No reference parser is built.** Verification is not citation management:
reformatting an entry needs clean parsed fields, but confirming one exists does
not. Every authority `resolve_citation` reaches accepts unparsed input —
Crossref's `query.bibliographic` is purpose-built for reference matching and
returns scored candidates; PubMed offers `ecitmatch`; Semantic Scholar offers
title matching. So the order inverts: **look up the raw string, then verify that
the returned record's authors, year, title, and venue actually appear in it.** A
low-scoring match, or a returned title whose tokens are absent from the raw
string, is `not_found` or `metadata_mismatch` — verdicts
`add-citation-resolution` already defines. This removes any need for a
third-party reference parser, none of which are TypeScript.

Extraction is layered, every layer emitting one `ExtractedReference`
`{raw, provenance, structured?, entryIndex, citedAt}`:

| | | |
|-|-|-|
| L0 | field codes (`ADDIN ZOTERO_ITEM CSL_CITATION`, `ADDIN EN.CITE`, `word/bibliography/sources.xml`) | structured metadata + the citation↔entry map, free |
| L1 | else segment by paragraph boundary, the built-in `Bibliography` style, and heading text | raw entry strings |
| L2 | detect in-text markers across runs | numeric, superscript, author-year |
| L3 | map markers to entries — numeric by index, author-year by fuzzy match | the citation↔entry map |
| L4 | each entry → `resolve_citation` | verdicts |

L2 is the concrete reason this parses OOXML rather than extracted text: a
superscript citation marker is `w:vertAlign="superscript"` in the run
properties and is **invisible to every text extractor**.

Four checks fall out of L1–L3 alone, needing no network, no target spec, and
almost no code — they ship in v1:

- **orphans** — in the bibliography, never cited
- **danglers** — cited in the text, absent from the bibliography
- **numbering integrity** — numeric styles cited out of first-appearance order
- **style consistency** — which doubles as a fabrication signal: when 40 entries
  follow one pattern and 3 do not, those 3 came from somewhere else

Three rules govern it:

- **Extraction provenance rides with every reference and reaches the dossier.**
  `not_found` on clean CSL-JSON means the work probably does not exist;
  `not_found` on a possibly-mis-segmented string means the segmentation may be
  wrong. Same verdict, different confidence, and the per-constraint coverage
  discipline is where that distinction is recorded.
- **Segmentation failure is an outcome, not an error.** When the bibliography
  cannot be located confidently, the phase reports that and stops. Verifying
  garbage produces confident nonsense, which is worse than a gap.
- **The LLM may segment; it may not supply metadata.** Deterministic
  segmentation handles most documents and an LLM fallback is reasonable for the
  rest — the manuscript text already goes to the wired provider, so this adds no
  exposure. But splitting text cannot invent a reference, whereas recalling its
  fields can. This is the same rule as "recollection is not a source," one layer
  down.

### Resolving the target specification

The specification is a set of individually-resolved constraints, not a document
the review either has or lacks. Each constraint is drawn from whichever of three
optional sources supplies it:

1. **Guidelines the user supplies**, pasted into the conversation or staged as
   an input. The most authoritative when present, because it is the venue
   speaking.
2. **Reporting guidelines from the reference inventory**, if any are staged.
3. **A model paper**, if the user has one. An exemplar demonstrates structure,
   section proportions, citation density, and register. It is evidence of what
   the venue accepts, not a statement of what it requires — a constraint derived
   this way is recorded as observed-from-exemplar, and reads as "the exemplar's
   abstract is 148 words; yours is 243," never as a limit.

**All three are optional and the common case is that none are present.** An
unresolved constraint is reported as not determined and the corresponding
measurement still stands on its own.

Two rules follow, and both are anti-hallucination rules of the same kind that
motivates `add-citation-resolution`:

- **The model's own recollection of a venue's requirements is not a source.**
  An agent that "knows" a journal's abstract limit is doing from memory exactly
  what a fabricated citation does from memory. If no supplied source states the
  limit, there is no limit — the review says so and moves on.
- **An exemplar is never promoted to a rule.** Deriving "abstracts here run
  ~150 words" from one paper and reporting it as a 150-word limit invents a
  requirement out of a sample of one.

When the user names a target venue but supplies nothing that states its rules,
the honest outcome is a review with measurements and no conformance verdicts,
plus a note saying which constraints would need a source. Asking the user for
the guidelines is a reasonable conversational follow-up; guessing them is not.

### Deliberately not in this change

- **Tracked changes.** v1 emits comments. `w:comment` injection is markedly
  simpler than `w:ins`/`w:del`, and for a review deliverable it is arguably the
  more correct artifact — a reviewer comments, an author decides. The
  paragraph-addressed finding is already the representation a redline writer
  would consume, so v2 adds a writer and changes nothing upstream of it.
- **A sandbox.** Nothing here runs model-generated code. Parsing a `.docx` and
  injecting comments is fixed, testable code, and an LLM writing python-docx
  against a user's manuscript is a way to destroy it. All of this is host-side
  TypeScript.
- **Fetching publisher author-guideline pages.** That needs a generic web-fetch
  tool the harness does not have and should not gain incidentally: it is a broad
  egress surface and a direct prompt-injection path into an agent that then
  proposes edits to the user's paper. Untrusted publisher HTML is not worth a
  word count.
- **Claim support** — whether a cited work supports the sentence citing it.
  It depends on `add-citation-resolution` shipping first and carries a different
  cost profile; it is the natural next increment.
- **Staging reporting-guideline datasets.** Curating upstream URLs for EQUATOR
  and ICMJE content is content work with its own validation, and the review must
  work without it. The resolution rule above already specifies the absent case.

## Capabilities

### New Capabilities

- `manuscript-review`: the durable review workflow — its phases and which of
  them a target specification reaches, the dossier contract and its
  per-constraint coverage discipline, per-constraint resolution across the three
  optional sources with the manuscript as the only required input, the four
  structural reference checks, provenance-weighted reference verdicts, the three
  anti-invention rules (model recollection is not a source; an exemplar is not a
  rule; the LLM may segment but may not supply metadata), the
  paragraph-addressed finding shape, and the confidentiality boundary below.
- `docx-review-surface`: the deterministic document surface — parsing a `.docx`
  into a paragraph inventory keyed by index and style, extracting references
  through the L0–L3 layers (field codes, segmentation, marker detection across
  runs including superscript, marker-to-entry mapping) into one
  `ExtractedReference` shape carrying its own provenance, and injecting comments
  into a copy while preserving every untouched byte. Mechanical and separable
  from any review policy — it decides nothing about what a finding means.

### Modified Capabilities

None. The workflow registers alongside the existing ones and the conversation
agent gains tools; no existing requirement changes.

## Impact

Depends on `add-citation-resolution` — the references phase's L4 is a fan-out
over `resolve_citation` and has nothing to verify against without it. L0–L3 and
the four structural checks are independent of it and could land first.

`resolve_citation` must accept a raw, unparsed reference string as an input
form, since that is what L1 produces. If `add-citation-resolution` ships with
only identifier and parsed-field inputs, this change extends it.

Harness source:

- `src/workflows/execute-manuscript-review.ts` and `src/workflows/manuscript-review/` —
  the workflow and its phases, structured after `workflows/target-assessment/`.
- `src/contracts/manuscript-review.ts` — the dossier, exported for consumers
  rendering it.
- `src/documents/docx.ts` — parse and comment-inject, over `fast-xml-parser`
  plus a zip reader.
- `src/documents/references.ts` — the L0–L3 extraction layers and the
  `ExtractedReference` contract. Separate from `docx.ts` because segmentation
  and marker mapping are the part most likely to need iteration against real
  customer documents, and they are testable on fixtures without a review.
- `src/tools/review-manuscript.ts`, `src/tools/emit-review-docx.ts` — the two
  conversation tools.
- `src/agents/conversation-agent.ts`, `src/runtime/assemble.ts` — roster entries
  and workflow registration.
- `src/prompts/manuscript-review/` — the language and coherence sub-agent prompts.

Test fixtures: real `.docx` files covering each L0 field-code dialect plus a
plain-text bibliography, since every extraction claim here is only as good as
the documents it was checked against.

New dependency: a zip reader (`fflate` or equivalent) — a `.docx` is a zip of
XML and Node ships no zip reader. `fast-xml-parser` and `pdf-parse` are already
present. No lib-store package, no sandbox image change.

**Confidentiality boundary**, which this capability exists to honour and which
the spec states as a requirement rather than leaving to implementation:

- Manuscript text goes to the wired `ChatProvider` and nowhere else. When that
  provider is local, the manuscript never leaves the machine.
- The bibliography goes outbound, to `resolve_citation`'s bibliographic
  authorities. That discloses which published works are cited — not the
  manuscript, not its results, not its claims.
- No other outbound path exists in this change. In particular there is no
  web fetch, so nothing carries the user's target venue or working title to a
  publisher's server.
