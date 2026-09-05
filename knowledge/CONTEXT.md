# Knowledge plane — context

The domain language and the load-bearing patterns of the knowledge subsystem.

## Domain

- **Situation** — The typed description of one analysis situation: the
  question, the modality, the data state, the organism, the group and
  replicate counts, the pairing, the batch structure, the covariates, the time
  points, the library type, the strandedness, the interaction flag, and the
  quality flags. The fields are flat and enumerated. A situation never carries
  a sample row, a file path, or an identifier. It is the data minimization
  boundary of the service.
- **Rule** — A situation-to-method claim. It has conditions over the Situation,
  an action (a step type, a method, parameters, forbidden methods, an
  outcome), a severity (`info`, `warn`, `flag`), a strength (`consensus`,
  `common_practice`, `disputed`), the two GRADE axes, alternatives, disputed
  sides, evidence lines, and a status. The content hash of its canonical JSON
  gives the **claim identifier**, `R-0031@e7d0`. A change to the rule changes
  the suffix.
- **Evidence line** — One source with a direction (`supports`, `disputes`,
  `neutral`), an ECO evidence type, a CiTO intent, a paraphrase, an anchor, an
  optional verbatim span of at most 25 words, and the retrieval date.
- **Source** — A resolvable locator with metadata: a DOI, a PMID, or a URL, the
  title, the year, the venue, the license, and the version of a vignette or a
  guide. Never the full text.
- **Method** — A statistical procedure with its packages, their version ranges,
  the Bioconductor release, and the templates that realize it.
- **Template** — A tested script with a typed parameter contract (each slot
  adaptable or pinned, with a default and a source), inputs and outputs, an
  environment of version pins, a body, and tests over the simulated datasets.
- **Procedure** — The answer of `recommend`: the ordered steps of the modality
  for the question, each with the method, the parameters and their sources,
  the template, the claim identifiers, the flags, the alternatives, and the
  disputed sides.
- **Snapshot** — One dated, content-addressed release of the whole set, as one
  SQLite file. The digest is over the canonical JSON of every record. A plan
  pins the digest. A snapshot is never edited.
- **Decision record** — The file that the template tool writes beside the
  rendered script: the template and its version, the snapshot, each slot with
  its value and its source, the environment match, the syntax check, the
  citations, and the list of unvetted edits. The existing write-file
  provenance of the harness hashes it into the signed document.

## The engine

- **Match** — Collect every active rule of the modality whose conditions all
  hold. A comparison over an absent field is false. `is_null` holds on an
  absent field. `contains` tests a list field.
- **Hit policy** — Order the applicable rules of one step type by specificity
  (the count of conditions), then by strength, then by id. The first rule that
  names a method selects it. The parameters of every applicable rule of the
  step merge, the specific rule last. The other method-naming rules and the
  declared alternatives become the alternatives. A disputed rule returns its
  sides. A warn or flag rule attaches to the step as a flag.
- **Match outcome** — `applicable` when the central step of the question has a
  method, `flag` when a flag rule with an outcome applies, `none` otherwise,
  with the nearest rules and their failed conditions.
- **Check** — The drafted steps against the same applicable rules. A forbidden
  method or a method outside the permitted set is a violation. A parameter
  that differs from a sourced default is a warning. An inferential step on a
  flagged design is a violation.

## The renderer

- Three constructs, no expressions. A slot renders as a literal of its type.
  A pinned slot takes no caller value. Each adaptable slot lands on a marked
  line, thus a later `edit_file` diff has a known place and the decision record
  can list it.
- The environment match compares the pins of the template with the farm
  versions the tool reports: `exact`, `compatible` (same major and minor),
  `mismatch`, or `unknown`.
- The syntax check parses an R script with `Rscript` when one is on the PATH,
  and it reports `unchecked` otherwise. It never reports `ok` by assumption.

## The boundary with the harness

The harness holds its own copy of the wire contract in
`harness/src/tools/knowledge/client.ts`, kept lenient, because the two
subsystems are independent packages. `src/service/api.ts` is the contract of
record, and its digest is the tool definition hash of a snapshot. A change to
the contract is a change to the snapshot identity.

The tools attach only when the embedder binds a client. Absence is the default
state of the open-source CLI, and it is a normal condition, never an error. A
service that is configured but unreachable answers `unavailable`, and the run
continues from the prose skills.

## The evaluation

`eval/` holds the simulator (base R, negative binomial, one design pattern per
call, the truth beside the counts), the task set (eight design patterns), the
runner (the real planner of the harness, with and without the tools), the
deterministic scorer, the rubric judge, and the report with the paired
bootstrap. The airway and pasilla datasets are not in the package store; the
template tests run on the simulated datasets instead.
