## Context

A plan package entry crosses three readers. `validatePlan` parses it at
`submit_plan`. The pre-launch pass of `execute_analysis` sends it to the
farm-extension seam. The seam of the cli resolves it with `resolveQuery` over
the dependency graph, and it links the resolved store directory.

Only the third reader asks the pool. Thus a plan that parses can still refuse at
the launch, and the planner loop ends before that refusal. The planner already
reads the pool census for its seed (`readPoolInventory`), and the census and the
graph come from one store.

The image holds the base R packages and the Python standard library. The image
record describes the conda tools and the Node packages of the image, but not
these two sets. Thus no reader can count them as present.

## Goals / Non-Goals

**Goals:**

- Refuse a bare both-track name and a name outside the pool at `submit_plan`,
  with the words of the link pass.
- Count a base R package and a Python standard-library module as present in the
  validator and in the link pass.
- Give one answer for each entry from the validator and from the link pass.

**Non-Goals:**

- A change to the string grammar, a tolerated list, or an object shape for an
  entry.
- A version resolution of a pool package at the submit. The census holds only
  the newest pin of each package. Thus the link pass stays the reader of that
  version.
- A change to the `names` path of `list_available_packages`, or to the text of
  the planner prompt.
- A resolution in the pre-launch validation of a stored plan. The link pass
  already resolves that plan.

## Decisions

### The index is an option of `validatePlan`

`ValidatePlanOptions` gains `packages?: PackageSources`: a pool index and an
image base. The resolution runs only on an entry that parses, and only when the
caller gives the sources. Thus
`execute_analysis` plan mode keeps its behavior, and a stored plan still
validates.

An alternative was a second validation function for the planner. It gives two
lists of rules that can drift, thus the option is better.

### The planner takes the sources from the one census read

`readInventorySections` reads the pool sections and the image record for the
seed. Its read carries its own scope (`pool` or `farm`) and its own sources: a
pool index over the tracked rows, and the image base of the record. The planner
renders the seed block from that read, and it takes the sources from the same
read. Thus the seed and the validator see one state of the store.

The read carries the sources, not the record. A caller that rebuilds an index
from the record can forget the record, and it then drops the base sets with no
signal. The read carries the scope, thus no caller passes a wrong boolean.

The planner takes the sources only from a `pool` read. The farm-lock fallback
describes one farm, and the farm of a new analysis is empty. A resolution over
that farm refuses each package. An `unavailable` read gives no sources, because
an unreadable pool must not refuse a package that the pool holds.

### A package resolves over the pool first, then over the image

`image-packages.json` gains `r_base` and `python_stdlib`, two optional string
arrays. The schema number stays 1, because the fields are additive. `imageBaseOf`
makes an index of the two sets, and it keeps the runtime version of each track.

`resolvePackage(query, sources)` holds the rule, and the validator and the link
pass of the cli both call it. It resolves in two steps:

1. Resolve the query over the pool index. A `resolved` answer is the answer.
2. Otherwise, resolve the query over the pool index joined with the image index.

The pool ranks above the image. The package store holds the R package
`optparse`, and Python 3.12 lists `optparse` in its standard library. A peer
join makes a bare `optparse` ambiguous, and a step that resolved before then
refuses. The two-step rule keeps `r:optparse`.

The answer names its source. When only the image resolves the identity, a pin
compares with the runtime version, because the image holds one version of each
base package. A wrong pin gives `image_version`, thus the submit refuses what
the launch refuses.

An alternative was a join of the two indexes as peers. It refuses a name that
resolves today. Another alternative was a lookup of the image BEFORE the ladder.
It lets an image name hide a pool name, thus the pool-first order is better.

### The seam contract carries a package of the image

The harness owns the contract of the farm-extension seam. Thus the harness
widens it before the cli uses it:

- `present` means that the package is importable with no new link. The farm
  linked it already, or the image holds it.
- A `collision` carries two claims in `storeDirs`. A claim is a store directory,
  or a runtime of the image.
- The launch refusal states that "two sources claim it". It promises no two
  directories.

The field keeps the name `storeDirs`, because a rename breaks each embedder of
the seam for one rare case.

### The record is the source of the two sets

`image-record.py` asks the runtimes of the image. R gives the names from
`installed.packages(priority = "base")`. Python gives `sys.stdlib_module_names`.
The script runs in the runtime stage with the interpreters that a sandbox runs.
Thus the record cannot disagree with the image. An empty set fails the build.
A private module name with a leading underscore is left out, because no plan can
name one.

An alternative was a constant list in the harness. The Python set changes with
each interpreter version, and a constant does not change with the image, thus the
record is better.

### The link pass of the cli answers `present` for an image package

The cli calls `resolvePackage` over the graph index and the image base. An
`image` answer is `present`, with the runtime version, and it links nothing. A
damaged record answers `unavailable` for each query, and an absent record gives
the empty image base. The companion cli change holds these requirements.

## Risks / Trade-offs

- [A store packed before this change has no `r_base` and no `python_stdlib`] →
  The image index is empty. Then `r:stats` refuses at the submit instead of at
  the launch, and the final result does not change. A new store download gives
  the fields.
- [An embedder binds `readPoolInventory` and no link seam] → The submit refuses
  a name that the launch does not resolve. The census is the statement of what the
  store holds, thus the refusal is correct for that store.
- [A pinned version of a pool package that the pool does not hold passes the
  submit] → The link pass refuses it at the launch, the same as before.
- [A new Python version or a new R package adds a name that the pool and the
  image both hold] → The pool ranks first, thus the name keeps the answer of the
  pool.
- [The seed and the submit read one census, and an acquisition lands during the
  loop] → The submit can refuse a package that just arrived. The next plan
  invocation reads the new census.

## Migration Plan

No migration. The record fields are additive. A consumer that reads the record
at schema 1 ignores the two new fields.
