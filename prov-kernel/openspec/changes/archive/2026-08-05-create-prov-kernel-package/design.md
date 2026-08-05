## Context

The dialect code separates cleanly: `document.ts`, `signing.ts`, and
`verify.ts` import nothing from any recorder or bridge — only `types.ts` and
the three third-party packages. That seam is the package boundary.

Three producers must agree on identifiers: the CLI host, the managed host, and
a planned Go writer in Nexus. The agreement surface is exactly the kernel: the
QName derivations, the relation-id schemes, the digest, the unify policy, the
chain rule, and the sidecar.

## Goals / Non-Goals

Goals:

- One published package that carries the dialect and nothing else.
- A wire-format document (`SPEC.md`) that an independent implementation can
  obey without the TypeScript source.
- A golden fixture that pins the serialized bytes of a deterministic document.
- Zero harness dependency, so any host — including one with no harness — can
  produce and verify documents.

Non-Goals:

- No recorder. The sink, the flush loop, the queue, and the CAS protocol are
  host lifecycle, and each host already has one.
- No event vocabulary. An event union couples the kernel to one host's
  observation model. Hosts map their events onto the builders.
- No key lifecycle. `ProvSigner` is a seam. Where a keypair lives, rotation,
  and generate-on-first-use are host policy.

## Decisions

### The kernel is a package, not a shared source directory

A copied directory drifts. A published package pins a version, and the golden
fixture makes drift a test failure. The scaffolding mirrors `harness/` (same
build, lint, format, smoke, and publish shape), so the monorepo has one way to
ship a package.

### The `ProvEvent` union stays out

The union enumerates what one host observes. The CLI observes bus events; a
managed host observes workflow settlements. If the kernel owned the union,
every host addition would version the kernel. The builders take value types
(`ProvActor`, refs, outcomes) instead, and each host owns its reducer from its
own events onto the builders.

### The digest stays injectable

Every content-keyed identifier embeds the digest output, so the digest is part
of a document's identity. A producer with existing documents must keep its
historical function or its identifier space forks — re-emission would mint new
QNames for the same files and `unified()` would keep both. The default
(SHA-256, first 8 bytes, big-endian, base36) is canonical for new documents;
a producer with existing documents injects its historical function.

### The dialect is byte-compatible across producers

The derivations, ids, unify options, chain rule, and sidecar shape are one
fixed wire format. Documents written by an earlier producer stay mergeable
with documents written through the kernel. `SPEC.md` is derived from the
code, not designed fresh.

### Determinism is the contract, so the fixture is the test

Assertion-by-assertion tests catch a broken builder. Only a byte-level golden
document catches a *silent* re-derivation — a changed digest fold, a reordered
group digest, a renamed attribute. The fixture is built from fixed ids and
fixed epoch-ms values through the execution builders, which take every time
from the payload. Lifecycle builders stamp the wall clock and mint random
action ids by default, so they stay out of the fixture.

## Risks / Trade-offs

- **Two sources of truth (code and `SPEC.md`).** Accepted: the golden fixture
  binds the code, and the spec rule is explicit — on disagreement the code
  wins and the spec has a defect. The alternative, spec-from-types generation,
  is not worth the machinery at this size.
- **TS 6 type resolution.** TypeScript 6 does not auto-include
  `node_modules/@types`. The harness gets `node` types transitively through
  `@types/pg`; the kernel's lean dependency set does not. The kernel's
  tsconfig therefore declares `"types": ["node"]` (and `["node", "bun"]` in
  the lint program). This is the one deliberate divergence from the harness
  tsconfig.
- **Hosts must not re-wrap the kernel into a second dialect.** The kernel
  exposes builders per fact; a host that invents extra statements outside them
  breaks cross-producer merge. Review guards this at the host side.
