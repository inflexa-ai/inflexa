# Grill round 4 — the context for Q21 and Q24

## Q21 — why `farmSource` is a required field

What the field is: the seam that names the farm for each sandbox. It is a
union of two kinds — `fixed`, one farm for every analysis, and `per-analysis`,
a resolver function (`spike:harness/src/sandbox/types.ts:264`).

Why the seam exists:

- The store has no `current` pointer. Commit `72be27cf` removed it, because
  one live sandbox froze the library set of every other analysis. Thus
  something must name the farm at each `createSandbox` call.
- Only the embedder knows its shape. The CLI resolves per analysis. The
  managed service serves one fixed farm. The harness cannot invent a default,
  because any default names a farm that the embedder never chose.

Why required, not optional:

- The spike tried optional. `7303ab75` kept a compatibility kind that read an
  in-store `current`. `00c3484a` removed it, because nothing produces that
  pointer any more. An optional field with a default resurrects a dead path
  that looks alive.
- Your own review of 2026-08-12 named the fault: `undefined` carried two
  meanings. A required field gives the value one meaning, and a missing value
  surfaces at compile time, where it costs minutes, not at sandbox time.
- The cost to the managed service is one config value. With `libStorePvc`
  unset, the provider never runs, and the behavior does not change
  (`spike:harness/src/sandbox/k8s-client.ts:529`).

## Q24 — the two review findings

**The unused variable.** The quality bot flagged a variable `ext` at
`acceptance.py:102` on 2026-08-03, in the first prototype commit. No commit
fixed it. The rebuild replaces the whole acceptance rig under new names
(decision 14), thus the file dies together with its fault. Proposal: cut the
entry, because a lint fault in a deleted file carries nothing forward.

**The provisioner privilege note.** The review bot observed on 2026-08-03:
the sandbox runs hardened — uid 1000, no network, dropped capabilities — and
the provisioner runs at default container privilege, with nothing that
records the asymmetry. No commit addressed it. Decision 9 already owns this
ground: the egress allowlist, droast coverage of both images, and the
recorded asymmetry. Proposal: cut the entry, because decision 9 absorbs it.
