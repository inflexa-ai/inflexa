# Resolve a citation against the record that would contain it

## Why

The harness can search four literature sources and cannot verify a single
citation. Retrieval and verification are different questions — "find me papers
about X" versus "does *this* reference exist, and is its metadata right" — and
only the first has an operation.

The cost of the missing second one is already sitting in the run synthesis. A
synthesized `KeyReference` carries a `pmid` whose only guards are
`checkKeyReferencesCited` (`src/execution/run-synthesis.ts:167`, which checks
the id also appears under a finding) and `checkKeyReferencePmidFormat`
(`:199`, which is `PMID_PATTERN.test` — digits). Neither asks whether the record
exists. The remaining defence is prose inside a `.describe()`:
`src/schemas/run-synthesis.ts:116` says the pmid *"Must come from a
literature_reviewer response — never invented."* Nothing reads that back. A
fabricated id therefore reaches `synthesis.json`, the run-completed card, the
vector index, and the report — while the signed PROV document lends
content-hashed authority to everything around it. Provenance that is rigorous
about bytes and silent about assertions reads as verification it never
performed.

The near-term driver is manuscript review (`add-manuscript-review`), where the
bibliography arrives inside the user's document. Retrieval attestation — "this
identifier entered through a real tool call in this session" — is complete by
construction for citations the harness itself produced and is worth nothing for
a reference the harness never fetched. External resolution is the strictly
larger capability, and it is the only one that covers both cases.

This repository also contains the evidence for what such a verifier has to get
right. `paper/RELATED-WORK.md` §6 is a hand-built quarantine list from an actual
manuscript, and it separates four failure classes that a naive checker collapses
into one — including two cases where the *resolver* was wrong, not the author
(OpenAlex returned a corrupted DOI for BLOOM; bioRxiv returned a superseded
title for STELLA).

## What Changes

- New `resolve_citation` tool. Input is one citation, given as a DOI, PMID,
  arXiv id, or free-text reference string. Output is a verdict plus the record
  each source returned, so a caller can see what was compared rather than being
  handed a boolean.
- New Crossref client (`api.crossref.org`, no key, polite-pool `mailto`). It is
  the DOI authority and the only one of the four sources that covers literature
  outside biomedicine — the gap that makes the current toolset unable to check a
  methods or systems citation at all.
- Resolution fans out across Crossref, PubMed, arXiv, and Semantic Scholar.
  Semantic Scholar and arXiv are reachable today from exactly one caller
  (`generate_analogy_report`); this makes them generally available.
- **Four-value verdict**, with `unverifiable` a first-class outcome rather than
  a synonym for absence:
  - `verified` — resolved, and the supplied metadata agrees with the record.
  - `metadata_mismatch` — resolved, but authors, year, title, or venue differ.
  - `not_found` — no source holds a record.
  - `unverifiable` — the work is of a kind these sources do not index (books,
    theses, standards, in-press), so absence carries no signal.
  Collapsing the fourth into `not_found` is what makes a citation checker cry
  wolf on a legitimate book chapter, and a checker that cries wolf gets ignored.
- **Cross-source disagreement is reported, never arbitrated.** When two sources
  return incompatible records the tool returns both and marks the conflict. No
  precedence order, no "most trusted source" — a single-source resolver would
  have returned `verified` for both of the corrupted records named above.
- Per-source outcomes follow the `SourceOutcome` shape already used by
  `gene-disease-evidence.ts`, `drug-gene-interactions.ts`, and
  `target-safety.ts`: a source that is down degrades that one source and the
  call still answers.
- Rostered on the conversation agent and the literature reviewer, and added to
  the `SandboxToolName` union so a sandbox agent may declare it.

Deliberately out of scope, each for a stated reason:

- **Claim support** — whether the cited work actually supports the sentence
  citing it. It needs the abstract at minimum and often full text, which is a
  different cost profile and belongs behind an explicit opt-in. It is the error
  class `paper/RELATED-WORK.md` hit most often, so it is a follow-on, not a
  dismissal.
- **Enforcing the check in run synthesis.** The check is the easy half; the
  policy is not. Failing a whole synthesis on one unresolvable reference, versus
  annotating it, versus dropping the reference, is a decision about run
  semantics that deserves its own change. This one ships the verifier that
  change will need.
- **OpenAlex and dblp as sources.** OpenAlex is the source of two of the four
  bad records in `paper/RELATED-WORK.md` §6; adding it would raise recall and
  lower precision, and Crossref already covers the DOI space authoritatively.
  dblp would genuinely help for CS conference papers and can be added later
  without changing the contract.

## Capabilities

### New Capabilities

- `citation-resolution`: resolving one citation against multiple bibliographic
  authorities and returning a verdict. Covers the input forms, the four-value
  verdict, per-source outcomes, the disagreement contract, and the rule that
  absence of an unindexable work is not evidence of fabrication.

### Modified Capabilities

None. This adds a tool and a client; no existing requirement changes.

## Impact

Harness source:

- `src/tools/lib/crossref-client.ts` — new pure-async client, sibling to
  `pubmed-client.ts`.
- `src/tools/research/resolve-citation.ts` — the tool, as a `defineTool`
  factory closure over the four clients.
- `src/tools/research/search-semantic-scholar.ts`, `src/tools/research/search-arxiv.ts` —
  their record shapes become inputs to resolution; no behaviour change to the
  existing tools.
- `src/agents/conversation-agent.ts` — roster entry.
- `src/tools/research/literature-reviewer.ts` — roster entry, so a research brief
  can confirm what it reports.
- `src/agents/sandbox/types.ts`, `src/agents/sandbox/shared.ts` — the
  `SandboxToolName` union and its resolver.

No new dependency. No image change. No sandbox involvement — resolution runs
host-side, as every bio tool already does, so the container's egress firewall is
not in the path.

Network posture: every call is outbound metadata about published works. Nothing
of a user's own document or data is transmitted. That distinction is load-bearing
for the confidentiality-constrained deployments `add-manuscript-review` targets
and is stated here so it is inherited rather than re-derived.
