# Create the provenance format kernel package

## Why

Inflexa records the provenance of an analysis as a signed W3C PROV document.
Three producers exist or are planned: the CLI host, the managed Cortex host,
and a future Go writer in Nexus. Each producer must mint the same identifiers
for the same facts, or `unified()` keeps both copies and the lineage graph
forks.

The dialect must be its own package, not a module of a harness recorder, for
three reasons:

- **The harness must not own the tracked vocabulary.** The harness observes
  execution. What counts as a provenance fact, and how a fact becomes a
  statement, is a product contract that outlives any one runtime. The layering
  is the same seam pattern as billing and auth: the harness observes, the
  kernel represents, hosts decide.
- **Per-host recorders own their event sets.** The CLI drains an event bus.
  A managed host writes from workflow bodies. The event union, the reducer,
  and the flush lifecycle differ per host, and they change at host speed. Only
  the representation under them is shared.
- **A future Go writer needs a spec, not a TypeScript import.** Nexus cannot
  import a harness. It can obey a wire format. Thus the dialect needs its own
  package with its own `SPEC.md` and a golden fixture that any implementation
  can target.

## What Changes

- Add the `prov-kernel/` subsystem: the published package `@inflexa-ai/prov-kernel` at
  version 0.1.0.
- Add the dialect code: the document model (`document.ts`), the signing
  primitives (`signing.ts`), verification and the sidecar (`verify.ts`), and
  the value types (`types.ts`).
- Keep any event union out of the types. The kernel keeps only the actor and
  ref value types that the builders accept, plus `VerifyResult`.
- Add `SPEC.md`: the wire format, derived from the code, sufficient for an
  independent implementation.
- Add a golden fixture test: a fully deterministic document, compared against
  committed bytes, so cross-recorder drift fails a test instead of forking an
  identifier space.
- The package depends on `@inflexa-ai/tsprov`, `neverthrow`, and `zod` only.
  It has no dependency on `@inflexa-ai/harness`.

## Capabilities

### New Capabilities

- `prov-kernel`: the Inflexa PROV dialect — deterministic identifiers, the
  document builders, the unify policy, the chain hash, Ed25519 signatures, and
  the signed sidecar.

### Modified Capabilities

<!-- None. The harness and the CLI adopt the kernel in their own changes. -->

## Impact

- New subsystem `prov-kernel/` with its own package manifest, lockfile, lint and
  build configuration, tests, `SPEC.md`, and OpenSpec tree. The scaffolding
  mirrors `harness/`.
- No existing subsystem changes in this change. Each host adopts the kernel
  in its own change.
- Excluded on purpose: the `ProvEvent` union, any event reducer, the recorder
  lifecycle (sink, flush, queue, CAS), and the harness bridges. Those are
  host-owned. The kernel declares the `ProvSigner` seam; key custody stays
  with the host.
