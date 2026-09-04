## ADDED Requirements

### Requirement: A query and an identity are two types

The harness MUST export, from `harness/src/sandbox/package-identity.ts`,
the type `Track` (`"python"` or `"r"`), the type `PackageQuery`, and the
type `PackageIdentity`. A `PackageQuery` holds a `spelling`, an optional
`track`, and an optional `version`. It is what a person or an agent asked,
and it MUST NOT serve as a key. A `PackageIdentity` holds a `track` and a
`name`. The name of a Python identity MUST be the PEP 503 fold of the
spelling. The name of an R identity MUST be the DESCRIPTION spelling,
verbatim.

The identity type MUST be opaque: a literal object MUST NOT typecheck as a
`PackageIdentity` outside the module. Two constructors exist.
`pythonIdentity(spelling)` folds. `rIdentity(name)` keeps. `identityOf(track,
name)` dispatches to one of them, for a name that an emitter minted. The
fold MUST be idempotent, thus a dispatch over an emitted name is safe. Two
identities are equal when their keys are equal.

#### Scenario: A Python identity folds

- **WHEN** `pythonIdentity("PyYAML")` is made
- **THEN** its track is `python`, and its name is `pyyaml`

#### Scenario: An R identity keeps its spelling

- **WHEN** `rIdentity("decoupleR")` is made
- **THEN** its track is `r`, and its name is `decoupleR`

#### Scenario: A dispatch over an emitted name is stable

- **WHEN** `identityOf("python", "pyyaml")` and `pythonIdentity("PyYAML")` are made
- **THEN** the two identities are equal

#### Scenario: A literal is not an identity

- **WHEN** a test writes `{ track: "r", name: "Seurat" }` where a `PackageIdentity` is expected
- **THEN** the typecheck fails

### Requirement: The key and the address derive from the identity

`identityKey(identity)` MUST be `<track>:<name>`. `identityAddress(identity)`
MUST be the PEP 503 fold of the name, for both tracks, because a store
directory is an address and not an identity. Two identities can share one
address. The fold MUST exist in exactly one TypeScript function, inside
this module.

`parseIdentityKey(key)` MUST read a key back, and it MUST split at the
FIRST colon. It MUST answer nothing when the track is neither `python` nor
`r`, and nothing when the name is empty. Thus a reader of a key never
splits the string itself, and a dotted R name survives the read.

#### Scenario: Two identities share one address

- **GIVEN** `rIdentity("decoupleR")` and `pythonIdentity("decoupler")`
- **WHEN** their keys and addresses are read
- **THEN** the keys are `r:decoupleR` and `python:decoupler`, and both addresses are `decoupler`

#### Scenario: A dotted R name addresses with a hyphen

- **WHEN** the address of `rIdentity("GO.db")` is read
- **THEN** it is `go-db`, and the name stays `GO.db`

#### Scenario: A key reads back as its identity

- **WHEN** `parseIdentityKey("r:GO.db")` runs
- **THEN** it answers the identity of `rIdentity("GO.db")`

#### Scenario: A string that is not a key answers nothing

- **WHEN** `parseIdentityKey("bioc:fgsea")` runs
- **THEN** it answers nothing

### Requirement: One grammar, one parser, and one formatter

The grammar of a query MUST be `[python:|r:]<spelling>[==<version>]`.
`parseQuery(entry)` MUST trim the entry, and it MUST answer a `Result`. It
MUST also trim the two halves of `==`, thus `numpy == 1.26.4` gives the
spelling `numpy` and the version `1.26.4`. Its errors are typed: `empty`,
`location` (a path, a URL, or a store directory), `unknown_prefix` (any
other `<word>:`), and `unsupported_specifier`. An `unknown_prefix` error
MUST carry the offending prefix. Each reader of that error in the harness
MUST name `python:` and `r:` in its own refusal.

A specifier that is not `==` MUST answer `unsupported_specifier`. A version
MUST hold no specifier character, no comma, and no space. Thus a compound
range such as `numpy==1.26,<2` answers that same error, and the error
carries the offending text. Without the second rule the range rides into
the pool as a version string.

`formatQuery(query)` MUST write the prefix only when the query names a track,
and `==<version>` only when it names a version. For every query,
`parseQuery(formatQuery(query))` MUST equal the query.

Every reader of the grammar in the harness MUST call `parseQuery`: the
plan validation, the link pass, and `link_packages`. No second parser of
the grammar exists in the harness.

#### Scenario: A full entry parses

- **WHEN** `parseQuery(" r:decoupleR==2.17.0 ")` runs
- **THEN** it answers `{ spelling: "decoupleR", track: "r", version: "2.17.0" }`

#### Scenario: A bare entry parses

- **WHEN** `parseQuery("scanpy")` runs
- **THEN** it answers `{ spelling: "scanpy" }` with no track and no version

#### Scenario: An unknown prefix is refused with the offending prefix

- **WHEN** `parseQuery(" bioc:fgsea")` runs
- **THEN** it answers the error `unknown_prefix`, and the error carries the prefix `bioc`

#### Scenario: A range specifier is refused

- **WHEN** `parseQuery("numpy>=1.26")` runs
- **THEN** it answers the error `unsupported_specifier`

#### Scenario: A spaced pin trims to its two halves

- **WHEN** `parseQuery("numpy == 1.26.4")` runs
- **THEN** it answers `{ spelling: "numpy", version: "1.26.4" }`

#### Scenario: A compound specifier is refused

- **WHEN** `parseQuery("numpy==1.26,<2")` runs
- **THEN** it answers the error `unsupported_specifier`, and the error carries the text `,<`

#### Scenario: A location is refused

- **WHEN** `parseQuery("/mnt/libs/store/scanpy-1.12.3-e71bae79")` runs
- **THEN** it answers the error `location`

#### Scenario: The grammar round-trips

- **GIVEN** the query `{ spelling: "igraph", track: "python", version: "1.0.0" }`
- **WHEN** `formatQuery` writes it and `parseQuery` reads the result
- **THEN** the parse answers the same query, and the written form is `python:igraph==1.0.0`

### Requirement: A query resolves by one ladder over a pool index

The harness MUST export `resolveQuery(query, pool)`. The pool is a
`PoolIndex` with two reads: `has(identity)` and
`rIdentitiesFoldingTo(fold)`. The answer is `resolved` with one identity,
`ambiguous` with the Python identity and the R identity, or `unknown`
with an optional `suggestion`. The version of a query MUST NOT take part,
because the caller holds the versions.

The ladder MUST run in this order:

1. The query names a track: the identity of that track, when the pool
   holds it. Otherwise unknown, with the R suggestion when the track is
   `r`.
2. The pool holds the R identity of the spelling and the Python identity
   of its fold: the R identity when the spelling differs from its fold,
   because an uppercase letter or a dot is evidence of an R spelling.
   Otherwise ambiguous.
3. The pool holds the R identity: the R identity.
4. The pool holds the Python identity: the Python identity.
5. Exactly one R identity in the pool folds to the fold of the spelling:
   unknown, with that identity as the suggestion.
6. Otherwise: unknown.

A silent Python-first pick is a fault. The census and the link of the
embedder MUST both resolve through this function.

#### Scenario: An exact R spelling wins over the Python identity of its fold

- **GIVEN** a pool that holds `r:decoupleR` and `python:decoupler`
- **WHEN** `resolveQuery({ spelling: "decoupleR" }, pool)` runs
- **THEN** it answers `resolved` with `r:decoupleR`

#### Scenario: A folded spelling resolves to the Python identity

- **GIVEN** a pool that holds `r:decoupleR` and `python:decoupler`
- **WHEN** `resolveQuery({ spelling: "decoupler" }, pool)` runs
- **THEN** it answers `resolved` with `python:decoupler`

#### Scenario: One spelling in two tracks is ambiguous

- **GIVEN** a pool that holds `r:igraph` and `python:igraph`
- **WHEN** `resolveQuery({ spelling: "igraph" }, pool)` runs
- **THEN** it answers `ambiguous` with `python:igraph` and `r:igraph`

#### Scenario: An R name that is its own fold resolves

- **GIVEN** a pool that holds `r:dplyr` and no `python:dplyr`
- **WHEN** `resolveQuery({ spelling: "dplyr" }, pool)` runs
- **THEN** it answers `resolved` with `r:dplyr`

#### Scenario: A Python spelling folds

- **GIVEN** a pool that holds `python:pyyaml`
- **WHEN** `resolveQuery({ spelling: "PyYAML" }, pool)` runs
- **THEN** it answers `resolved` with `python:pyyaml`

#### Scenario: A folded R spelling is unknown with a suggestion

- **GIVEN** a pool that holds `r:Seurat` and no `python:seurat`
- **WHEN** `resolveQuery({ spelling: "seurat" }, pool)` runs
- **THEN** it answers `unknown` with the suggestion `r:Seurat`

#### Scenario: A qualified query reads one track

- **GIVEN** a pool that holds `r:igraph` and `python:igraph`
- **WHEN** `resolveQuery({ spelling: "igraph", track: "r" }, pool)` runs
- **THEN** it answers `resolved` with `r:igraph`

#### Scenario: A qualified R miss carries the suggestion

- **GIVEN** a pool that holds `r:Seurat`
- **WHEN** `resolveQuery({ spelling: "seurat", track: "r" }, pool)` runs
- **THEN** it answers `unknown` with the suggestion `r:Seurat`

### Requirement: The Python twin passes the same fixture

The provisioner MUST hold a twin module,
`images/sandbox-provisioner/package_identity.py`, with `PackageIdentity`,
`PackageQuery`, `python_identity`, `r_identity`, `identity_of`, `key`,
`parse_identity_key`, `address`, `parse_query`, and `format_query`. The
twin MUST import neither `provision.py` nor `emit_deps.py`. The fold MUST exist in exactly one
Python function, inside the twin.

One fixture, `harness/src/sandbox/__fixtures__/package-identity.json`,
MUST list inputs with their expected parse, key, and address. The
TypeScript test and the Python test MUST both read it. The Python test
MUST skip with a named reason when the file is absent. The fixture lives
in the repository, not in the provisioner image.

#### Scenario: A fixture case binds both twins

- **GIVEN** a fixture case that expects `parse_query("r:GO.db")` to give the spelling `GO.db` and the track `r`
- **WHEN** the TypeScript suite and the Python suite run
- **THEN** each suite asserts that case, and a twin that answers otherwise fails its suite

#### Scenario: The twin imports no caller

- **WHEN** the import list of `package_identity.py` is read
- **THEN** it names neither `provision` nor `emit_deps`

### Requirement: The farm-extension seam speaks the query

`ExtendAnalysisFarm` MUST take `PackageQuery[]`. Each outcome MUST echo the
`spelling` of its query, verbatim, because a remedy quotes it. A
`collision` of one spelling in two tracks MUST carry the two identity keys
in its detail. The harness MUST render the two prefixed forms of such a
collision with `formatQuery`, and it MUST NOT re-derive them from a store
directory name. `shelfKey` MUST NOT exist in `harness/src/sandbox/types.ts`,
because `identityKey` replaces it.

#### Scenario: An outcome echoes the spelling

- **GIVEN** a query with the spelling `GO.db` that the pool does not hold
- **WHEN** the seam answers
- **THEN** the outcome carries `spelling: "GO.db"`

#### Scenario: A two-track collision carries both keys

- **GIVEN** a query with the spelling `igraph` against a pool that holds `r:igraph` and `python:igraph`
- **WHEN** the seam answers
- **THEN** the outcome is a `collision` whose detail names `python:igraph` and `r:igraph`
