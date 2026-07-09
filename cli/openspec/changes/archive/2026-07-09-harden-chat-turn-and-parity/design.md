# harden-chat-turn-and-parity — Design

## D1. One generation token governs the message store, not two

`conversation.ts` already has the right idea twice over: `loadGeneration` makes the last load *started*
win, and the per-turn `AbortController` instance (C1) makes the newest turn's events the only ones that
reach the store. What it lacks is a rule for the boundary *between* them — and the message store is a
single module singleton both write.

The minimal correct rule: **a turn supersedes a load.** `send` bumps `loadGeneration` at entry, exactly
as `loadMessages` does. Any load already in flight then fails its post-await re-check and drops.

Why that direction and not the reverse (make the load re-apply the in-flight turn)? Because the turn is
the user's live intent and the load is a replay of durable state the turn is *about to append to*. A
dropped load costs a re-read on the next lifecycle edge; a dropped turn costs the user their message.
And it composes with what is already there: the two writers now share one token, so the invariant is
"the newest store-writing operation wins", uniformly.

`resetHotState` also bumps the token. A session swap aborts the turn and clears the store; a load
started for the *old* session must not resurrect it.

**Rejected: guard `loadMessages` on `chatStatus() !== "busy"`.** The status flips to `busy` inside
`send`, after `pushUserMessage`, and back to `idle` in `finishTurn` — but the C1 comment is explicit
that a superseded turn keeps unwinding (`appendTurn`'s pg round-trip, a tool ignoring its signal) long
after the UI has moved on. A status check would be a second, weaker clock. The token is the clock.

## D2. `commitStream` needs a part to commit into

The `ok` branch's condition — "the streamed buffer is empty, so the engine's `fallbackText` is not a
duplicate" — is correct, and worth stating precisely because it is subtle:

`fallbackText` is `finalText(result.messages)`, the *last* assistant message's text. Deltas for that
message accumulate in `streamText` and are only flushed by a **non-text part** arriving after them. So
`streamText().length === 0` at turn end implies no deltas arrived since the last flush, which implies
the final assistant message's text never streamed, which implies `fallbackText` is not already on
screen. The condition is sound.

What is unsound is the sink. `flushPendingText()` nulls `streamPartId` whenever it commits, and
`commitStream()` is a no-op with a null id. So the fix is one line at the point of use:

```ts
if (streamText().length === 0 && outcome.fallbackText.trim().length > 0) {
    if (streamPartId() === null) beginStreamSegment();   // the flush that emptied the buffer took the part with it
    setStreamText(outcome.fallbackText);
}
commitStream();
```

`beginStreamSegment` is already the "prose resumed after a non-text part" primitive (it appends a fresh
text part *after* the tool/card), so the fallback lands in emission order — below the tool chip that
interrupted it — which is exactly where a reload would put it.

**Rejected: mirror the printer's sticky `streamedText` flag.** It would suppress the fallback whenever
*any* delta arrived in the turn, which is wrong for precisely the case at hand: the prose that streamed
belonged to an *earlier* assistant message, and the final one's text still needs rendering. The
printer has the same latent gap; it is out of scope here, and the buffer check is the more precise
predicate.

## D3. Parity drives serialize on one in-flight promise

Every path into the profile lifecycle — the three `watchProfileParity` edges and `driveForceReprofile` —
must observe a consistent view of (input tree on disk, ledger row). Today they observe none: `stageInputs`
mutates the tree with `rmSync`+`linkSync` and then `reconcileStagedTree` deletes anything not in *its*
manifest, and the ledger CAS that would serialize them runs afterwards.

A module-level in-flight promise, keyed by nothing (one chat screen, one analysis at a time), is enough:

```ts
let inFlight: Promise<void> | null = null;

function serialize(run: () => Promise<void>): Promise<void> {
    const next = (inFlight ?? Promise.resolve()).then(run, run);   // a rejected predecessor must not poison the chain
    inFlight = next.finally(() => { if (inFlight === next) inFlight = null; });
    return inFlight;
}
```

Both drivers run their whole body — check/force → stage → seed → trigger → sidebar poke — inside it.
Chaining rather than dropping is deliberate: the *reason* edges 2 and 3 exist is that state changed, so
a drive that arrives during another must still run afterwards, against the new state. Dropping it would
reintroduce the window those edges were added to close.

This subsumes finding 4. `clearDataProfile` (the empty branch of `ensureProfileAtParity`) and
`seedProfileLedger` (the non-empty branch) can no longer interleave, so a seed is never wiped between
its write and its trigger.

Cross-process is already excluded: the TUI holds the per-analysis instance lock for the whole session
(`app.launch.tsx`), and `inflexa profile` / `inflexa run` acquire it before booting. The lock is
re-entrant per pid (`lib/lock.ts:81`), which is why it cannot serve as the in-process guard.

**Rejected: a "drop if busy" flag.** It makes the last input edit of a burst a coin flip — the debounce
already coalesces bursts, and what arrives after it is genuinely new state.

**Accepted cost:** a force-reprofile requested while a parity check is staging waits for it. Staging is
hundreds of ms to seconds; the action is fire-and-forget and already toasts on completion.

## D4. Drift is a signature set, and enumeration pays stat, not sha256

`fileId = Bun.hash(anchorId|path)` is path identity. The comparand becomes the file's **drift
signature** `(fileId, size, mtimeMs)`, serialized as `fileId:size:mtimeMs` for set membership.

`enumerateInputFileIds` becomes `enumerateInputSignatures`, returning `ReadonlySet<string>` of
signatures. It gains one `statSync` per file over the walk `walkInputFiles` already performs (which
uses `withFileTypes`, so this is a new syscall per file, not a new walk). For a directory input of
10k files that is 10k stats — the same order as the `readdirSync` that found them, and nothing
compared to the `sha256File` per file that `stageInputs` pays.

The right-hand side of the comparison is the harness's `result.inputFiles`, added by
`harden-data-profile-claim`. A completed row without it (written before that change) reads as drift and
re-profiles once — the identical self-heal the current code already applies to a completed row with a
null `result` (`profile_trigger.ts:193-196`).

Callers that only ask "is the input set empty?" (`forceReprofile`, and the empty-branch test in
`ensureProfileAtParity`) read `.size` off the signature set unchanged.

**Why not hash?** `enumerateInputFileIds` is documented as the "hash-free twin" of `stageInputs` and
exists so a parity check on every chat open costs stat/readdir. Inputs are genomics files. Hashing them
on every open to catch an edit the user almost always makes through the file picker — which fires
`prov.input_*` and re-triggers on its own — is the wrong trade.

**Accepted miss:** an edit preserving both byte length and mtime. Documented in the spec, not silent.

## D5. The sidebar poll skips, it does not queue

`refreshSidebarData` claims `++refreshGeneration` at entry and re-checks it after each of its two awaits.
That makes the newest refresh the only writer — and it means a tick firing while the previous refresh is
still awaiting *cancels* that refresh. If reads reliably outlast the 5s interval, the store never
receives a write at all, and because `unavailable` is itself an arming state (`hasActiveWork`), a
degraded database is polled forever behind a frozen UI.

The poll — and only the poll — skips a tick when a refresh is already in flight:

```ts
let refreshInFlight = false;
```

Lifecycle-edge refreshes (boot-ready, analysis swap, turn completion, the parity pokes) deliberately do
*not* skip: they carry new information and must supersede, which is what the generation token is for.
The flag lives at the timer callback, not inside `refreshSidebarData`, so its meaning stays "don't pile
on periodic work" rather than "serialize all refreshes".

## D6. The test sandbox is enforced by `env.ts`, not by remembering

`bun test` sets `NODE_ENV=test` regardless of the working directory (verified). `bunfig.toml` resolution
does **not** walk up (verified: a child directory with no bunfig ran zero preloads). So the marker's
absence under `NODE_ENV=test` is a precise, cwd-independent signal that the sandbox preload never ran.

`env.ts` — already the sole `process.env` reader — throws at import in exactly that state, before any
path is resolved. A test file cannot then so much as *name* the developer's real `agent.db`, from any
directory, whether or not its author remembered `assertTestSandbox`.

The guard must be inert everywhere else:

- **Compiled binary.** `scripts/build.ts` `--define`s `process.env.NODE_ENV` to the build channel, so
  the comparison folds to `"production" === "test"` → `false` and the branch is eliminated.
- **`bun run dev`.** `NODE_ENV` is unset. Inert.
- **`runCli` subprocess.** Inherits both `NODE_ENV=test` and the marker from the parent's sandboxed env
  (`test_support/cli.ts:25`), so it passes and reads the same isolated DB.
- **`harness.test.ts`'s marker-deletion test.** `env.ts` is imported (and the guard has run) long before
  the test body deletes the marker to prove `resetDb` refuses. Unaffected.

`assertTestSandbox` stays: it is still the right per-site check for "this specific path is inside the
sandbox", and it now compares on a path boundary (`sandbox + sep`) rather than a raw `startsWith`, so
`/tmp/inflexa-test-abc` cannot authorize a write under `/tmp/inflexa-test-abcDEF`. Its docstring stops
claiming to be a choke point every site funnels through, because it is not one — `env.ts` is.

## D7. A build that cannot stamp provenance fails at build time

`bakedEnv`'s scanner (`scripts/build.ts:28-40`) collects literal `process.env.X` accesses **inside the
`Object.freeze` block**. `INFLEXA_GIT_COMMIT` is read inside `resolveGitCommit()`, outside that block,
so it has never been `--define`d — confirmed by running the scanner against the real file. On `main` the
runtime guard keyed on `NODE_ENV`, which was also never defined, so the throw never fired and a release
binary silently stamped whatever `git rev-parse HEAD` returned in the user's cwd. This branch bakes
`INFLEXA_BUILD_CHANNEL`, which turns that dormant throw into a certain crash on the first provenance
stamp — and provenance must never be unsigned, so it is unrecoverable by design.

Two changes, in this order of authority:

1. **Build-time gate.** After the channel is validated, a `production` build with no
   `INFLEXA_GIT_COMMIT` prints the reason and exits non-zero. The operator learns at the build, not the
   user at first run.
2. **Explicit define.** `define["process.env.INFLEXA_GIT_COMMIT"]` is set when the value is non-empty —
   *not* by adding a literal to the `bakedEnv` block, because that would route it through the
   missing-var guard and fail a `development` build outside a git checkout too. A dev binary with no
   commit falls through to the existing `git rev-parse` path, which is what that path is for.

The runtime `throw` stays. It is now genuinely a backstop — reachable only by a binary built without
`scripts/build.ts` — and its comment says that, instead of asserting the branch is dead code.

## D8. Two escape hatches state their invariant

- `staging.ts:64`'s `err({ … } as FsError)`: the assertion is load-bearing only because the object
  literal widens `type: "io_failed"` to `string` in an `err()` position without a contextual type. The
  sibling site at `:140` has that contextual type, hence no cast. Rather than document the cast, give
  the literal the contextual type by annotating the helper's return — the cast disappears.
- `workspace.ts:141`'s `throw`: a missing `WorkspaceContext.Provider` is a component-tree wiring bug,
  not a runtime failure — the same class as an exhaustive-switch default. It stays a `throw`, with the
  comment naming that class explicitly so the neverthrow rule's exception is visible at the site.
