## ADDED Requirements

### Requirement: Review launch uses explicit immutable input roles

`review_manuscript` SHALL require one staged `.docx` manuscript path, SHALL accept optional staged model-paper paths, optional staged guideline paths, optional user-supplied guideline text, and `externalCitationResolution` defaulting to false, and SHALL resolve and confine every path before launch. The tool SHALL hash every file input and SHALL pass path, SHA-256, size, and role in the immutable workflow input. A PDF manuscript, missing path, ambiguous role, or unsupported document SHALL return a normal non-launched outcome rather than starting a workflow that later guesses the input.

#### Scenario: Manuscript-only review launches

- **WHEN** the user supplies one valid staged DOCX manuscript and no optional inputs
- **THEN** the tool launches a complete intrinsic review with external citation resolution disabled

#### Scenario: PDF manuscript is unsupported

- **WHEN** the selected manuscript is a PDF
- **THEN** the tool returns an unsupported-manuscript outcome and creates no run
- **AND** the same PDF remains eligible to be supplied as a guideline or model paper

#### Scenario: File identity is frozen at launch

- **WHEN** the tool launches a review with a manuscript and model paper
- **THEN** the workflow input carries the resolved role, path, SHA-256, and size of both files
- **AND** recovery does not reassign their roles from later conversation state

### Requirement: Manuscript review has six fixed phases and no generated plan

`executeManuscriptReview` SHALL execute exactly the stable phases `review-parse`, `review-structure`, `review-language`, `review-coherence`, `review-references`, and `review-conformance`. It SHALL NOT invoke plan generation or create a `cortex_plans` row. Parse SHALL produce the immutable document inventory; structure SHALL report intrinsic document measurements and integrity; language SHALL review scientific register, grammar, and clarity; coherence SHALL compare claims and conclusions with evidence presented inside the manuscript; references SHALL extract/map citations and optionally resolve them; conformance SHALL compare measurements only with sourced target constraints.

#### Scenario: Fixed phase graph is launched

- **WHEN** a manuscript-review run starts
- **THEN** its observable phase set is the six stable ids in their defined dependency order
- **AND** no generated analysis plan is requested or persisted

#### Scenario: No target still produces intrinsic review

- **WHEN** no guideline, reporting-guideline resource, venue rule, or exemplar is available
- **THEN** parse, structure, language, coherence, and reference phases still execute normally
- **AND** conformance reports measurements with `not_determined` constraints rather than failing the review

### Requirement: Section detection records its evidence

The parse and structure phases SHALL start section detection from OOXML style identity and relationships and SHALL use bounded deterministic heading evidence when custom templates obscure built-in styles. Every detected section SHALL record the evidence and confidence that established it. Unrecognized styles SHALL NOT be silently treated as ordinary prose, and an LLM SHALL NOT assign OOXML paragraph addresses.

#### Scenario: Built-in heading style identifies a section

- **WHEN** a paragraph uses a recognized heading style
- **THEN** the inventory records the section and style evidence

#### Scenario: Custom template uses renamed styles

- **WHEN** built-in style identity is unavailable but deterministic heading evidence identifies a section
- **THEN** the inventory records the fallback evidence and confidence
- **AND** it does not claim that a built-in style was present

### Requirement: Phase coverage distinguishes absence from failure

Every phase SHALL return a typed outcome containing status, coverage, findings, measurements, and diagnostics applicable to that phase. Missing optional guidelines, exemplars, reporting resources, or external citation approval SHALL be covered absence states and SHALL NOT be phase failures. A phase that cannot execute SHALL record the reason and SHALL NOT fabricate empty success. Parse failure or final dossier-validation failure SHALL fail the run; a non-essential phase failure after useful phase output exists SHALL permit a valid partial dossier and `partial` terminal status.

#### Scenario: Optional exemplar is absent

- **WHEN** language review runs without a model paper
- **THEN** it reviews against ordinary scientific English and records the exemplar comparison as not requested

#### Scenario: Non-essential phase fails

- **WHEN** language review fails after parse and structure complete and the remaining dossier validates
- **THEN** the language outcome records failed coverage and the run can finish `partial`
- **AND** completed phase results remain in the dossier

#### Scenario: Parse cannot produce an inventory

- **WHEN** the manuscript package cannot be safely parsed
- **THEN** the run fails and advertises no `review.json`

### Requirement: Language and coherence review is bounded and source-grounded

Language and coherence model calls SHALL receive bounded, stable manuscript slices through the configured `ChatProvider`, SHALL place dynamic document text in user messages rather than system prompts, and SHALL validate structured phase output. Language findings SHALL concern register, grammar, or clarity. Coherence findings SHALL compare abstract, body, conclusions, and evidence presented inside the manuscript and SHALL NOT claim that a cited paper supports or contradicts a sentence.

#### Scenario: Remote provider is the only prose boundary

- **WHEN** the configured `ChatProvider` is remote and a language slice is reviewed
- **THEN** only the provider call receives that manuscript slice
- **AND** the workflow does not send the slice to bibliographic authorities or publisher sites

#### Scenario: Coherence does not become claim-support review

- **WHEN** a sentence cites a paper for a claim not independently demonstrated in the manuscript
- **THEN** coherence can flag an internal evidence gap
- **AND** it does not assert what the cited paper says without a separate claim-support capability

### Requirement: The dossier is the authoritative review artifact

The workflow SHALL produce a versioned `ManuscriptReviewDossier` containing run identity, exact source document identity, input identities, phase outcomes, measurements, constraints, reference extraction and resolution evidence, findings, diagnostics, and aggregate coverage. The workflow SHALL deterministically order and validate the dossier, write `runs/{runId}/review.json` atomically, hash it, and register it in `cortex_artifacts` before writing terminal run state or emitting terminal completion. A dossier that fails schema or derived-invariant validation SHALL NOT be advertised.

#### Scenario: Completed review registers its dossier first

- **WHEN** all required review work completes and the dossier validates
- **THEN** `review.json` is written, hashed, and registered before the run becomes terminal

#### Scenario: Dossier validation fails

- **WHEN** findings reference the wrong source hash or a required phase outcome is missing
- **THEN** dossier validation fails the run
- **AND** `inspect_run` does not advertise a review path

### Requirement: Findings are deterministic, located, and explicitly commentable

Every finding SHALL contain a deterministic `findingId`, phase, location, rationale, severity, optional original/replacement text, and optional `commentAnchor`. Location SHALL identify a document, section, or paragraph scope. A comment anchor SHALL exist only for exact source text and SHALL contain OOXML part, paragraph index, paragraph-text hash, and character range. The finding id SHALL derive from dossier schema version, source SHA-256, phase, normalized location, and finding content so it changes with the manuscript or finding and remains stable for replayed identical output.

#### Scenario: Missing abstract has no invented text anchor

- **WHEN** structure review finds that the manuscript has no abstract
- **THEN** it emits a document- or section-located finding without `commentAnchor`
- **AND** the finding remains present but is marked non-commentable

#### Scenario: Two findings share one paragraph

- **WHEN** a paragraph has two findings over different character ranges
- **THEN** each finding has its own deterministic id and exact comment anchor

### Requirement: Reference extraction preserves raw evidence and provenance

Reference review SHALL emit one `ExtractedReference` per segmented entry with raw text, extraction provenance, optional document-supplied structured metadata, entry index, cited locations, and confidence. It SHALL consume supported Word, Zotero, and EndNote field-code metadata when present; otherwise it SHALL segment plain-text bibliography entries from paragraph, style, and heading evidence. A bounded LLM fallback SHALL only divide text already present and SHALL NOT supply missing author, title, venue, year, identifier, volume, page, or other bibliographic metadata.

#### Scenario: Structured field codes accelerate extraction

- **WHEN** a Zotero field contains structured citation metadata and a citation-to-entry mapping
- **THEN** extraction retains that metadata and provenance with the raw document text

#### Scenario: Plain-text bibliography is primary evidence

- **WHEN** a bibliography has no citation-manager field codes
- **THEN** extraction retains each segmented raw entry and its confidence
- **AND** no model-recalled bibliographic fields are added

#### Scenario: Segmentation is not confident

- **WHEN** the bibliography cannot be located or segmented above the configured confidence threshold
- **THEN** the reference phase records the extraction gap and does not externally resolve the affected text

### Requirement: In-text citations are mapped with explicit confidence

Reference review SHALL detect numeric, superscript, and author-year in-text markers across OOXML runs and SHALL map them to extracted entries by deterministic index or bounded fuzzy rules. Each mapping SHALL retain its evidence and confidence. The offline review SHALL always report bibliography orphans, in-text danglers, numeric first-appearance ordering, and formatting-style outliers when their prerequisite extraction coverage exists; a formatting anomaly SHALL NOT by itself prove fabrication.

#### Scenario: Superscript marker spans OOXML runs

- **WHEN** a numeric citation is represented by superscript run properties
- **THEN** extraction detects it from OOXML rather than losing it in plain text

#### Scenario: Dangling in-text citation is reported offline

- **WHEN** an in-text marker maps to no bibliography entry with sufficient confidence
- **THEN** the dossier reports a dangler without requiring network access

### Requirement: External citation resolution is opt-in and coverage-preserving

`externalCitationResolution` SHALL default to false. When false, the references phase SHALL perform no bibliographic-authority request and SHALL record external resolution as `not_requested`. When true, `review_manuscript` SHALL obtain approval before run reservation and launch, naming the source document, potential authorities, and the literal citation content that can be transmitted; denial SHALL create no run and send no citation. An approved workflow SHALL call the shared `CitationResolver.resolveMany` inside one named durable step and SHALL preserve resolver verdict, per-source outcomes, field comparisons, conflicts, and coverage without rewriting `inconclusive` as `not_found`.

#### Scenario: Default review remains offline

- **WHEN** the caller omits `externalCitationResolution`
- **THEN** structural reference review completes with L4 `not_requested`
- **AND** no bibliography entry is sent to an external authority

#### Scenario: User denies external resolution

- **WHEN** external resolution is requested and the user denies the pre-launch disclosure
- **THEN** the tool launches no review run and sends no bibliography entry

#### Scenario: Approved batch has partial resolver coverage

- **WHEN** the approved resolver batch returns an unavailable source and verdict `inconclusive` for one entry
- **THEN** the reference check retains that verdict and source outage in the dossier

### Requirement: Target conformance uses individually sourced constraints

The workflow SHALL represent target conformance as individually resolved constraints with stable id, source kind, source identity, status, value, units where applicable, and conflicting observations. Explicit user-supplied guideline statements SHALL be authoritative for the constraints they state. Available reporting-guideline inventory items SHALL be used only when actually present. Model-paper measurements SHALL be labelled `observed_from_exemplar` and SHALL NOT become required limits. A missing or conflicting source SHALL yield `not_determined`, while the corresponding manuscript measurement remains available.

#### Scenario: Supplied abstract limit is enforced

- **WHEN** user-supplied guidelines explicitly state a 150-word abstract limit and the measured abstract is 243 words
- **THEN** conformance reports the sourced limit, measurement, and 93-word excess

#### Scenario: Exemplar does not create a rule

- **WHEN** a model paper has a 148-word abstract but no guideline states a limit
- **THEN** the dossier reports the exemplar observation and manuscript comparison
- **AND** the constraint remains non-required rather than becoming a 148-word limit

#### Scenario: Reporting resource is absent

- **WHEN** a relevant reporting-guideline item is not available in the reference inventory
- **THEN** the workflow records its absence and proceeds with existing sources
- **AND** it does not invent a path or silently substitute another resource

### Requirement: Review results are selected from the dossier, not reconstructed by the model

Conversation guidance SHALL direct the agent to inspect the terminal run, read only the artifact-gated `reviewPath`, present dossier findings with severity and commentability, obtain the user's selected finding ids, and then call `emit_review_docx`. The emission tool SHALL accept `runId` and non-empty `selectedFindingIds` only and SHALL NOT accept model-reconstructed finding objects.

#### Scenario: Agent presents stable finding ids

- **WHEN** a terminal dossier is available
- **THEN** the conversation agent presents findings using their stored ids and commentability
- **AND** it does not recreate anchors from prose before emission
