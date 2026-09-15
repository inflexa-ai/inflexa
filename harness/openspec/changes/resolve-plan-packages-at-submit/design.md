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
- A version resolution at the submit. The census holds only the newest pin of each
  package. Thus the link pass stays the only reader of a version.
- A change to the `names` path of `list_available_packages`, or to the text of
  the planner prompt.
- A resolution in the pre-launch validation of a stored plan. The link pass
  already resolves that plan.

## Decisions

### The index is an option of `validatePlan`

`ValidatePlanOptions` gains `pool?: PoolIndex`. The resolution runs only on an
entry that parses, and only when the caller gives the index. Thus
`execute_analysis` plan mode keeps its behavior, and a stored plan still
validates.

An alternative was a second validation function for the planner. It gives two
lists of rules that can drift, thus the option is better.

### The planner builds the index from the one census read

`readInventorySections` already reads the pool sections and the image record
for the seed. Its `sections` arm gains the valid record that it merged. A new
function, `inventoryPoolIndex`, builds the index from the tracked sections and
that record. The planner reads the inventory one time, renders the seed block
from that read, and builds the index from the same read. Thus the seed and the
validator see one state of the store.

The planner builds the index only when the embedder binds `readPoolInventory`,
and only when the read gives sections. The farm-lock fallback describes one
farm, and the farm of a new analysis is empty. An index over that farm refuses
each package. An `unavailable` read gives no index, because an unreadable pool
must not refuse a package that the pool holds.

### The image gives a pool index, and two indexes join

`image-packages.json` gains `r_base` and `python_stdlib`, two optional string
arrays. The schema number stays 1, because the fields are additive, and a
record from before this change still parses. `imagePoolIndex(record)` makes an
R identity for each `r_base` name and a Python identity for each
`python_stdlib` name.

`joinPoolIndexes(first, second)` in `package-identity.ts` answers `has` when
one of the two indexes holds the identity. It answers `rIdentitiesFoldingTo`
with the identities of the two indexes, once for each key. The ladder then runs
one time over the joined index. Thus a base name and a pool name of one
spelling obey the same ambiguity rule as two pool names.

An alternative was a lookup of the base sets before the ladder. That lookup gives
a different answer from the ladder for a spelling that the pool and the image
both hold, thus the join is better.

### The record is the source of the two sets

`image-record.py` asks the runtimes of the image. R gives the names from
`installed.packages(priority = "base")`. Python gives `sys.stdlib_module_names`.
The script runs in the runtime stage with the interpreters that a sandbox runs.
Thus the record cannot disagree with the image. An empty set fails the build.

An alternative was a constant list in the harness. The Python set changes with
each interpreter version, and a constant does not change with the image, thus the
record is better.

### The link pass of the cli answers `present` for an image package

The cli joins the image index to the graph index before the ladder. When the
ladder resolves an identity that the graph does not hold, the image holds it.
Then the seam answers `present`, with the runtime version of the record, and it
links nothing. The companion cli change holds that requirement.

## Risks / Trade-offs

- [A store packed before this change has no `r_base` and no `python_stdlib`] →
  The image index is empty. Then `r:stats` refuses at the submit instead of at
  the launch, and the final result does not change. A new store download gives
  the fields.
- [An embedder binds `readPoolInventory` and no link seam] → The submit refuses
  a name that the launch does not resolve. The census is the statement of what the
  store holds, thus the refusal is correct for that store.
- [A pinned version that the pool does not hold passes the submit] → The link
  pass refuses it at the launch, the same as before.
- [The seed and the submit read one census, and an acquisition lands during the
  loop] → The submit can refuse a package that just arrived. The next plan
  invocation reads the new census.

## Migration Plan

No migration. The record fields are additive. A consumer that reads the record
at schema 1 ignores the two new fields.
