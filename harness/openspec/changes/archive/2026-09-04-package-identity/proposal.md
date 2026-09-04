# Package identity: one typed identity, one query grammar

## Why

A package name is an untyped `string` across three subsystems, and each site
applies the rule that it believes. The trace of the branch found four copies
of the PEP 503 fold and twelve parsers of one grammar. It found five
encodings of the ecosystem, and four live faults where two sites disagree.
The change `package-name-resolution` gave the correct rule to the sites
that the fault touched. It left the old rule at the sites that the fault
missed. A type removes the freedom to invent a rule.

## What Changes

- A new capability, `package-identity`, in the harness. It gives the
  `Track`, the `PackageQuery`, and the opaque `PackageIdentity`. A query is
  what a person or an agent asked. An identity is the name that an
  ecosystem recognizes. The module also gives the two constructors, the
  key, the address, one grammar with `parseQuery` and `formatQuery`, and
  `resolveQuery` over a pool index. The harness exports
  the module, and the cli imports it.
- The seam speaks the query. `PackageRequest` becomes `PackageQuery`, an
  outcome echoes `spelling`, and `shelfKey` leaves `sandbox/types.ts`.
- The plan grammar has one parser. `validatePlan` calls `parseQuery`, thus
  the validation is the parse. The link pass dedupes identical queries and
  absorbs nothing. A refusal formats a query with `formatQuery`.
- `link_packages` takes query strings in the same grammar. The `ecosystem`
  field leaves the tool. The two prompt layers teach one grammar.
- The census carries the track as data, not as a heading. The `names`
  lookup resolves a query the way the link does, and a miss carries the
  suggestion. The both-track mark reads the identities.
- The provisioner holds the Python twin of the module. Both copies of
  `canon` leave. Graph version 2 is redefined on this branch: no `r_dir`,
  edges as addresses only, no fold gate. The both-track log line stays.
  **BREAKING** for a store built from this branch before this change: such
  a store is a development store, and it rebuilds. Version 2 is not
  released, thus the version number does not move.
- The store address is the address of the identity. The acquire spec is a
  query, and a both-hit outcome names two identities.

## Capabilities

### New Capabilities

- `package-identity`: the typed identity, the query, the grammar, and the
  resolution that every consumer of a package name shares.

### Modified Capabilities

- `package-store-provisioner`: the graph node holds the identity and no
  `r_dir`. The address derives from the identity. The gate keeps the edge
  check and the both-track report. The acquire spec is a query.
- `planning-enhancements`: the plan entry is a query, the validation is the
  parse, the union dedupes identical queries, and the refusal formats
  queries.
- `harness-sandbox-agents`: `link_packages` takes query strings, and the
  prompt layer teaches one grammar.
- `package-store`: a section carries its track, the `names` lookup
  resolves through `resolveQuery`, a miss carries the suggestion, and the
  both-track mark reads the identities.

## Impact

- New: `harness/src/sandbox/package-identity.ts` and its test, exported
  from `harness/src/index.ts`. New:
  `images/sandbox-provisioner/package_identity.py` and its test. One
  conformance fixture, read by both tests.
- `harness/src/sandbox/types.ts`, `harness/src/schemas/validate-plan.ts`,
  `harness/src/tools/execute-analysis.ts`,
  `harness/src/tools/sandbox/link-packages.ts`,
  `harness/src/tools/sandbox/list-available-packages.ts`,
  `harness/src/config/environment-stores.ts`,
  `harness/src/prompts/sandbox-standards.ts`, `harness/src/prompts/planner.ts`.
- `images/sandbox-provisioner/emit_deps.py`,
  `images/sandbox-provisioner/provision.py`,
  `images/package-store/load-check.py`, and their tests.
- The companion cli change `package-identity` connects the host: the
  lookup, the ledger, the two commands, and the replay path. It modifies
  existing cli specs and adds none.
