# Grill round 5 — the farm source structure, and the acquisition batching

## Q21c — the structure of `FarmSource`

The real type, from `spike:harness/src/sandbox/types.ts:228-264`:

```ts
export type FarmLocation = string;

export type FarmResolution =
    | { readonly kind: "farm"; readonly location: FarmLocation }
    | { readonly kind: "unavailable"; readonly reason: string };

export type ResolveAnalysisFarm =
    (analysisId: string) => Promise<FarmResolution> | FarmResolution;

export type FarmSource =
    | { readonly kind: "fixed"; readonly location: FarmLocation }
    | { readonly kind: "per-analysis"; readonly resolve: ResolveAnalysisFarm };
```

What each option does:

- **`fixed`** — one farm path serves every analysis. The managed deployment
  names `farms/catalog` of the published artifact, and it composes nothing.
  Every sandbox of every analysis mounts that one farm.
- **`per-analysis`** — a resolver function. Each `createSandbox` call passes
  the analysis id, and the embedder answers with a farm location, or with
  `unavailable` plus a reason that the user reads. The CLI uses this kind.
  It is what lets two analyses hold two versions of one package at once.
  The backend resolves at each call, thus a farm that grows between two
  sandboxes reaches the next sandbox with no restart.

What the spike tried first, and why it went:

- First shape (`07441b19`): an optional provider. `undefined` meant two
  things at once — "this embedder has no store" and "use the legacy in-store
  `current` pointer". Your review of 2026-08-12 named that fault.
- Second shape (`7303ab75`): a named union with three kinds, one of them
  `store-root`, the compatibility kind that read the `current` pointer.
- Final shape (`00c3484a`): two kinds, field required. The `store-root` kind
  died because nothing writes a `current` pointer any more. A kind that reads
  a pointer that nothing produces is dead code with a live face.

The judgment: the removals were good, and each one obeyed the same rule.
A value must not carry two meanings, and a code path must have a producer.

Could a different shape be better? The alternatives:

1. **Optional with a default.** The harness would have to invent a farm when
   the field is absent. Any invention names a location, and the harness owns
   no naming rule by design (`types.ts:225-227`). Rejected.
2. **Required, two kinds** — the spike HEAD shape. One meaning per value, a
   missing value fails at compile time, and the managed cost is one config
   value.
3. **A third `none` kind** instead of "unset `libStorePath`". Today the
   provider only runs when the store path is set
   (`spike:harness/src/sandbox/docker-client.ts:299`). A `none` kind would
   make "no packages" an explicit choice instead of an absent path. It is
   cleaner in theory, and it costs one more kind that only tests would use.

The recommendation stays: shape 2, the spike HEAD shape. Take shape 3 only if
the spec work shows a real embedder that wants "no store" as a first-class
mode.

## Q23c — bulk acquisition against per-package asks

The cost model first:

- One acquisition run = one provisioner container start plus one resolve.
  The container start costs seconds. The resolve costs more: uv fetches
  metadata and builds a closure, and pak resolves R in minutes, not seconds.
- The provisioner entrypoint already takes many specs in one run
  (`spike:images/sandbox-provisioner/provision.py:1711`). Thus one run per
  batch is possible today. The waste sits in one-run-per-package, which pays
  the start and the resolve N times, and resolves shared dependencies N times.

The three shapes:

1. **Status quo.** Each approved ask starts its own flight, cap 2. No new
   machinery, N resolves for N packages.
2. **A long-lived provisioner.** The container stays alive after the last
   request and consumes an in-container queue. This buys only the container
   start time, because each enqueued package still resolves. And it costs a
   daemon: idle reaping, crash recovery, a long-lived writer against the
   store commit mutex, and failure attribution across a queue. Your instinct
   is right — too complex for what it buys.
3. **A host-side pending set.** The asks stay exactly as settled: one TUI
   ask per package, in the conversation. An approved package joins a pending
   set in the CLI. The flight starts when the asks of the turn finish: at the
   end of the agent turn, or on an explicit flush. Then one one-shot
   provisioner run resolves the whole approved set. The queue is host state.
   The container stays one-shot. One resolve covers the batch, and the shared
   dependencies resolve once.

The failure detail of shape 3: when one spec of a batch cannot resolve, the
run names the failing spec. The flight drops it, reports it as its own
refusal, and retries the rest as one batch. Thus one bad package never blocks
the good ones, and the agent gets a per-package outcome either way.

The recommendation: shape 3. It keeps the consent model, it gets the batch
economics, and no daemon exists. The CLI surface stays one package per
`store add` call — bulk is a behavior of the queue, not a syntax. A script
that calls `add` five times in a row lands in one or two runs, for free.
