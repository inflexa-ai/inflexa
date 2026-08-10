# CLAUDE.md

Guidance for Claude Code that works with the **prov-kernel** package
(`@inflexa-ai/prov-kernel`).

## Project Overview

`@inflexa-ai/prov-kernel` is the Inflexa provenance format kernel. It carries the
Inflexa PROV dialect, and nothing else:

- the document model (`src/document.ts`): QName derivation, the in-package
  tsprov statement builders, `PROV_UNIFY_OPTIONS`, and the injectable digest
- the core event union and its apply function (`src/events.ts`): the nine
  `ProvEvent` variants and `applyProvEvent` — the event-to-statements mapping
  determines the document bytes, thus it is format
- the signing primitives (`src/signing.ts`): the chain hash, Ed25519
  sign/verify, and the `ProvSigner` seam
- the lineage read model (`src/lineage.ts`): the node/edge model derived from
  stored PROV-JSON, the generation/usage traversal with self-reported depth
  truncation, the all-edge-kind reachability closure, and the `(path, hash)`
  file-entity lookup — the one read-side interpretation every consumer shares
- verification and the signed attestation (`src/verify.ts`)
- the actor and ref value types the builders accept (`src/types.ts`)

The kernel obeys the three-layer rule: the harness observes, the kernel
represents, hosts decide. Thus the package must NOT contain a recorder
lifecycle (sink, flush, queue, CAS), signer wiring, or a harness bridge. Each
host owns those. Core statements are produced only through `applyProvEvent`;
each host maps its own extension events onto `appendLifecycleAction`, the
QName derivations, and tsprov interop. The package has no dependency on
`@inflexa-ai/harness`, and it must keep none.

[`SPEC.md`](SPEC.md) is the wire-format contract. It is derived from the code.
If you change a derivation, an identifier scheme, the chain rule, or the
attestation shape, change `SPEC.md` in the same commit, and expect the golden
fixture test to fail until you regenerate the fixture on purpose.

### Public interface

`src/index.ts` is the curated front door. It re-exports the document model,
the lineage read model, the signing primitives, the verification functions,
the attestation schema, and the value types. `package.json` declares `type: "module"` and the `exports`
map: `.` goes to `dist/index.js`, and `./*` and `./*.js` go to `dist/*.js`.

## Commands

`@inflexa-ai/prov-kernel` is a library. There is no server entry point.

```bash
tsc -p tsconfig.json    # Build: emit dist/ from src/ (also `npm run build`)
bun test                # Unit tests (colocated in src/)
bun run typecheck       # tsc -p tsconfig.eslint.json --noEmit (covers the test files)
bun run lint            # eslint .
bun run smoke           # load dist/ under Node, one QName + one sign/verify roundtrip
```

**Runtime**: Node.js. Bun is only for the tests (`bun test`).

**After a change**, run `bun run typecheck`, `bun run lint`, `bun test`, and
`bun run build && bun run smoke`.

## Formatting

**After you edit a source file in `src/`, run `bun run format:file <paths>` on
the files that you changed.** Do this before you report the task as complete.
Format only a file inside `src/`. Never format a markdown file, a config file,
or the golden fixture.

## Invariants

These invariants are load-bearing. Read them before you change `src/`.

1. **Identifiers are deterministic.** Each execution QName and each execution
   relation id derives from content, not from randomness or a clock. A durable
   host re-emits the same records on recovery, and `unified()` collapses them
   by identifier. An anonymous relation never merges — thus each execution
   relation carries an explicit id.
2. **The digest is injectable and identity-load-bearing.** Every file, input,
   command, and model-agent QName embeds the digest output. A producer with
   existing documents must keep its own digest function, or its identifier
   space forks. `defaultProvDigest` (SHA-256, first 8 bytes, base36) is the
   canonical default.
3. **A replay-unstable timestamp never enters an identifier or a formal PROV
   position.** Run and step times come from the payload (replay-stable clock
   reads). A command activity carries no formal time at all.
4. **One generation edge per file entity.** The command authority and the step
   authority write the same `gen-{fileDigest}` id, so the edge merges instead
   of duplicating.
5. **Unify is last-write-wins** (`PROV_UNIFY_OPTIONS`): a resumed run or step
   supersedes its earlier terminal outcome.
6. **Provenance is never written unsigned.** Each signing failure surfaces as
   a `ProvSigningError` on the err channel.

## Error handling — neverthrow

Failure is modeled as a `Result` or `ResultAsync` value (neverthrow). The
`must-use-result` lint rule enforces consumption. Verification functions
return a `VerifyResult` status value instead — a verification outcome is data,
not a failure.

## Code Comments

A comment describes the **current state** of the code, not its history. Write
a comment only when a future reader would be surprised or misled without it: a
hidden constraint, a non-obvious invariant, or a workaround for a specific
bug.

## Testing

Tests are colocated in `src/` and run with `bun test`. No database and no
container is necessary.

**Test the state, not the interactions.** Assert on returned values and on
serialized documents.

The golden fixture (`src/__fixtures__/golden-document.json`) guards
cross-recorder drift: a fully deterministic document, built from fixed ids and
fixed epoch-ms timestamps, must serialize to the committed bytes. Never use
`Date.now()` in a test. If the format changes on purpose, regenerate the
fixture and record the change in `SPEC.md`.

## References

- **Wire format**: [`SPEC.md`](SPEC.md) — the contract for an independent
  implementation.
- **Specs**: [`openspec/specs/`](openspec/specs/) — the feature
  specifications, and the source of truth for the design decisions.
- **Package README**: [`README.md`](README.md) — the surface a consumer faces.
