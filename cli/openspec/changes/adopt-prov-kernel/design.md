# Design — adopt-prov-kernel

## The ownership line

The kernel owns the representation and its integrity: the QName derivations, the statement each
core event appends, the unify policy, the chain/sign/verify primitives, and the sidecar schema.
The cli owns everything around a document's life on this machine: the recorder lifecycle (SQLite
snapshot columns, revision-guarded dirty tracking, coalesced single-flight flush,
rehydration-on-first-touch), the bus delivery mechanics, the keypair FILE lifecycle in the config
dir, the lineage read side, and the CLI commands. A statement-shape question goes to the kernel; a
"when does it persist" question stays here.

`applyProvEvent` is the kernel's sole supported producer of core statements. The recorder does not
call builders; it strips the bus envelope (`prov.` prefix, stamp id) off a bus member and hands
the kernel event over. The stripped-member-extends-`ProvEvent` check in `toKernelEvent` is the
compile-time guard that replaced the old exhaustive switch: a new `prov.*` bus member with no
kernel counterpart is a build error.

## Continuity invariant A — the digest

Every file/command/agent QName in an existing document embeds the cli's historical digest,
`Bun.hash(s).toString(36)`. Documents are immutable and signed, so the derivation can never
change: a different digest would fork the identifier space, and re-emission after an upgrade would
mint new QNames for the same files, which `unified()` keeps alongside the old ones. The kernel
makes the digest injectable for exactly this reason; the cli injects `cliProvDigest` and pins it
with a literal in `kernel_compat.test.ts`, alongside QName literals captured from the pre-kernel
implementation before it was deleted.

## Continuity invariant B — user-agent identity

The kernel's user actor is `{ kind: "user"; id: string; email?: string }` with the QName derived
from `id`. The cli historically keyed user agents by email (`agent-user-${qnameSafe(email)}`). The
cli SHALL pass `id` = that same email value (and also passes `email` as the attribute), so derived
QNames are byte-identical on existing documents. Recorded in `types/prov.ts` and pinned by the
compat suite. The same reasoning fixes the system actor: the kernel parameterizes `label`; the cli
passes `label: "inflexa cli"`, the string its pre-kernel builder hard-coded.

## The compatibility fixture

`__fixtures__/kernel_compat.json` was generated ONCE by the pre-kernel implementation (frozen
clock, throwaway Ed25519 keypair): the unified PROV-JSON of a small document driven through every
event kind, its first-flush chain hash, its signature, the public JWK, the logical event list in
kernel shape, and captured QName literals. The suite proves, against the exact bytes existing
users hold: kernel `verifyProvenance` accepts it; kernel `loadDocument` rehydrates it; re-applying
the same execution events through `applyProvEvent` dedupes into it (structural equality modulo
serializer-assigned blank-node numbering — no duplicate elements, no new anonymous relations,
stable QNames).

## Accepted forward deltas

- **Empty args.** Pre-kernel code wrote `inflexa:args: ""` for an empty argument vector (a truthy
  `[]` guard); the kernel omits the attribute. On re-emission into an existing document the old
  `""` survives the union and the kernel adds nothing — convergence, not corruption — covered by
  an explicit test. New documents never carry the attribute.
- **Sidecar `kid`.** The kernel sidecar schema adds an optional `kid` signer id. The cli does not
  set it; old sidecars without it validate unchanged.
- **Verify wording.** The kernel's `formatVerifyResult` says "the signing key is missing" where
  the cli said "the signing key file is missing". Presentation-only; the cli adopts the kernel
  wording rather than keeping a one-line fork.

## Rejected alternatives

- Keeping thin cli wrappers named after the old builders (`appendCreation`, …) that call
  `applyProvEvent`: pointless ceremony in production code, and it re-creates the surface the
  kernel deliberately withholds. Test files keep local helpers of that shape instead, because ~160
  fixture call sites were written against it.
- Restating the kernel value types in `types/prov.ts` instead of re-exporting: a restated signed
  format drifts exactly the way the duplicated builders did; the re-export keeps one source of
  truth while the file documents the cli's identity conventions.
