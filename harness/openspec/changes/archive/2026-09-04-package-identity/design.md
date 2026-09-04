# Design

## Context

A package name crosses three subsystems as a bare `string`. The trace of
the branch (the inventory page and the animated page of 2026-09-04) found
four copies of the PEP 503 fold: `composition.ts:675`, `types.ts:107`,
`provision.py:162`, and `emit_deps.py:121`. It found twelve parsers of the
grammar `[python:|r:]<name>[==<version>]`, and only one of them reads all
three parts (`execute-analysis.ts:128`). It found five encodings of the
ecosystem, and four live faults where two sites disagree on the rule.

The change `package-name-resolution` fixed the collision of `decoupleR`
and `decoupler` by a per-track identity rule. It put that rule at the
sites that the fault touched. The other sites kept their own rule, because
nothing in the type system stopped them. This change replaces the string
with two types, and it keeps graph version 2, because version 2 lives only
on this branch.

## Goals / Non-Goals

**Goals:**

- One place in TypeScript and one place in Python that know the fold.
- One grammar, one parser, and one formatter for a package query, in each
  language, with a round-trip law.
- One resolution ladder, called by the census and by the link.
- A graph node that holds one name, the identity, and no copy of it.
- The four live faults stop as a result of the type, not as four patches.

**Non-Goals:**

- The store directory stays an address in the PEP 503 form for both
  tracks. A directory is not an identity.
- The `inflexa.lock` of a farm does not change. Its `track` field names a
  link subtree, and one mapping turns a subtree into a track.
- The manifest grammar (`decoupler[full]>=2.1.2`) is not the query
  grammar, and this change does not touch it.
- The graph version does not move. Version 2 is unreleased, thus this
  change redefines it.

## Decisions

### D1. Two types, and one construction rule

`PackageQuery` is what a person or an agent asked: a spelling, an
optional track, an optional version. It is never a key. `PackageIdentity`
is the name that an ecosystem recognizes: a track and a name. For the
Python track the name is the PEP 503 fold. For the R track the name is the
DESCRIPTION spelling.

The identity type is opaque. A literal `{ track, name }` does not
typecheck outside the module, because a brand on the name makes it so.
Two constructors exist: `pythonIdentity(spelling)` folds, and
`rIdentity(name)` keeps. `identityOf(track, name)` dispatches to one of
them, for a graph row or a lock row that an emitter already minted. The
fold is idempotent, thus a dispatch over an emitted name is safe.

Alternative: a class with a private constructor. A brand gives the same
guarantee with a plain object, and both consumers prefer a `type`.

### D2. The key and the address derive from the identity

`identityKey` is `track:name`. `identityAddress` is the fold of the name,
for both tracks. Two identities can share one address: `decoupleR` and
`decoupler` both address as `decoupler`. That is correct, because an
address is a directory prefix, and the pin marker inside carries the
identity.

On disk, `by_name` stays two per-track maps keyed by the identity name.
The two maps are the one `track:name` map, partitioned. Thus the JSON
shape does not churn, and the reader builds an identity from the pair.

### D3. One grammar, parsed once

The grammar is `[python:|r:]<spelling>[==<version>]`. `parseQuery` trims
once, and it answers a `Result`. Its errors are typed: `empty`,
`location`, `unknown_prefix`, and `unsupported_specifier`. `formatQuery`
writes the prefix only when a track is set, and `==v` only when a version
is set. The law: `parseQuery(formatQuery(q))` equals `q`.

Every reader of the grammar calls this parser: the plan validation, the
link pass, `link_packages`, `store add`, `store link`, the replay path of
`inflexa run --plan`, and the provisioner spec. The validation of a plan
entry IS the parse, thus no second reader can disagree with it.

Alternative: keep the `ecosystem` field on `link_packages`. Rejected,
because one agent then learns two grammars for one fact. Alternative: an
object entry in the plan. Rejected, because the stored plan is `string[]`.

### D4. One ladder, in the harness, over a pool index

`resolveQuery(query, pool)` takes a small `PoolIndex`: `has(identity)`
and `rIdentitiesFoldingTo(fold)`. It answers `resolved`, `ambiguous`, or
`unknown` with an optional suggestion. The ladder is three branches:

1. The query names a track: that identity, or unknown with the R
   suggestion.
2. The R identity of the spelling and the Python identity of its fold both
   exist: R when the spelling differs from its fold, ambiguous otherwise.
3. Otherwise: R, then Python, then unknown with the sole R identity that
   folds to the fold, when exactly one exists.

The evidence rule survives inside branch 2. An uppercase letter or a dot
is evidence of an R spelling, and a type cannot delete evidence. The
census and the cli link both call this function, thus the census answers
what the link does. The version choice stays with the caller, because the
graph holds the versions.

Alternative: keep the ladder in the cli. Rejected, because the census then
keeps its own third rule (`.toLowerCase()`), and `scikit_learn` stays a
false absence.

### D5. The census answers the same way as the link

A section carries `track` as data. One mapping turns a lock subtree into
a track: `python` gives `python`, and `cran`, `bioconductor`, and `github`
give `r`. Titles are display only, and the two regexes that read a track
out of a heading go. The `names` lookup builds a `PoolIndex` from the
package sections and calls `resolveQuery`. A hit answers with the section
of the identity. An ambiguous name answers once for each track. A miss
carries the suggestion.

This supersedes decision D6 of `package-name-resolution`, which kept the
census lenient. A lenient census sent `seurat` back as present under
`Seurat`, and the link then refused the same spelling. One rule is the
point.

### D6. The link pass absorbs nothing

The union of the plan dedupes equal queries only. A bare `igraph` beside
`r:igraph` is two queries, and the bare one refuses as ambiguous, with the
two prefixed forms in the refusal. The planner is told to qualify a
both-track name.

Alternative: a prefixed entry absorbs a bare entry of its spelling, which
is the rule of `package-name-resolution`. Rejected, because it dropped the
pin of the prefixed entry and it removed a refusal that would have caught
a wrong track.

### D7. Graph version 2, redefined

A node is `{ track, name, version, order, imports, entry_points, edges }`.
`r_dir` goes, because it was byte-equal to `name` by construction, and
its only reader was a gate that could not fire. `edges` holds store
addresses only, because an unresolved edge already stops the run. The
gate keeps the dangling-edge check and the both-track log line, and it
loses the fold comparison, because one field cannot differ from itself.

The version stays 2. A store built from this branch before this change is
a development store, and it rebuilds.

Alternative: version 3. Rejected, because there is nothing to migrate
from. No user holds a version-2 store.

### D8. The Python twin passes the same fixture

`images/sandbox-provisioner/package_identity.py` holds `PackageIdentity`,
`PackageQuery`, `python_identity`, `r_identity`, `identity_of`, `key`,
`address`, `parse_query`, and `format_query`. It imports neither
`provision.py` nor `emit_deps.py`, thus the import cycle that forced the
second `canon` dissolves, and both copies go.

One fixture, `harness/src/sandbox/__fixtures__/package-identity.json`,
lists inputs and their expected parse, key, and address. The TypeScript
test and the Python test both read it. A case that one twin fails is a
red build, not a comment that drifts.

### D9. The seam speaks the query

`ExtendAnalysisFarm` takes `PackageQuery[]`. An outcome echoes
`spelling`. A `collision` of two tracks carries the two identity keys in
its detail. Thus the harness renders `python:<name>` and `r:<name>` with
`formatQuery`, and it never re-derives them. `shelfKey` leaves
`sandbox/types.ts`, because `identityKey` replaces it.

## Risks / Trade-offs

- [A development store from this branch carries `r_dir`] → the reader
  ignores an unknown field, and a store rebuild is the remedy. No
  released store exists at version 2.
- [The census stops answering `seurat` as present] → it answers absent
  with the suggestion `Seurat`, the same as the link. The planner writes
  the suggestion.
- [`store link seurat` and `store add seurat` stay refused] → unchanged
  from `package-name-resolution`. The refusal names `Seurat`.
- [The Python suite reads the fixture across the tree] → the suite skips
  with a named reason when the file is absent. That happens only outside
  a repository checkout.
- [Two ladders exist during the cli transition] → the cli change deletes
  its ladder in the same release, and its tests move to the harness
  fixture.

## Migration Plan

- No user migration. Version 2 is not released.
- A development store from this branch rebuilds with the store build, or
  with `inflexa store download --update` once the build publishes.
- The cli change `package-identity` lands with this change, because the
  seam type changes shape.

## Open Questions

None.
