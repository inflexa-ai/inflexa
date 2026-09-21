# Design — stamp the author of a chat turn

## Context

See proposal.md for the motivation. These facts shape the approach:

- `ConversationTurn.author` is optional in `@inflexa-ai/harness`. `appendTurn` stores it on
  the first row of the append when that row is a genuine user start. It stores it on no
  other row, and it strips NUL from the value.
- `cli/node_modules/@inflexa-ai/harness` is a symbolic link to the working copy. The link
  resolves through `harness/dist`, and that build already declares `author` and `createdAt`.
- The append site is one call in the shared turn engine,
  `src/modules/harness/turn.ts:415`. The TUI hook (`src/tui/hooks/conversation.ts:1436`)
  and the dev REPL (`src/modules/harness/dev/chat.ts:267`) both drive that engine.
- The chat path holds no identity. `buildChatSession` (`src/modules/harness/turn.ts:196`)
  writes the literal `local` into `identity.user`, and the ask gateway keys its grants on
  the same literal (`LOCAL_ASK_USER_ID`, `src/tui/hooks/conversation.ts:111`).
- The cli reads the person from the Auth0 session on disk. `loadAuth`
  (`src/modules/auth/auth.ts:200`) is synchronous, and `decodeIdTokenClaims`
  (`src/modules/auth/whoami.ts:45`) gives `sub`, `email`, and `name`. `loadAuth` reports a
  missing file, an unreadable file, and a file that the schema refuses.
- `currentUserActor` (`src/modules/prov/prov.ts:37`) already answers "who is the user" with
  that email. A failure and an absence both give an anonymous actor on the ok path.
- `ChatTurnSeams` (`src/modules/harness/turn.ts:177`) is the existing bag of injectable
  edges. The unit tests build the engine with fakes and record the `appendTurn` payload.
- `src/test_support/preload.ts` points `XDG_*` at a temporary directory before any import of
  `lib/env.ts`. Thus a read of the auth file under `bun test` finds an empty sandbox, and it
  never finds the session of the developer.
- The run-outcome record appends through `conversationRecordTurn`
  (`src/tui/hooks/run_completion.ts:185`). That append opens on a synthetic row, thus the
  harness drops an author on it. `run-completion-notice` owns that record, and this change
  states nothing about it.

## Goals / Non-Goals

**Goals:**

- One identity rule for the cli. A transcript and a provenance document name one person.
- A unit case that drives the signed-in branch, with no auth file and no token fixture.
- No new argument at a call site of the engine. One engine stamps both surfaces.

**Non-Goals:**

- A display of the author or of the creation time (see proposal.md, "Out of scope").
- A change to the identity of the agent session, or to the key of an ask grant.
- The transcript load path. `cortexToUiMessage` (`src/tui/hooks/conversation.ts`) MUST NOT
  map either field onto `UIMessage`, and no component renders either field.

## Decisions

### D1 — The author is the email of the signed-in identity

The cli has one identity: the Auth0 session on disk. The cli attributes a user action to the
email of that session today. The provenance document of an analysis carries the same email.
Thus the email is the honest answer to "who sent this message", and a transcript agrees with
the provenance of the same work.

A signed-out cli records no author. The harness contract says that an absent author means
that nothing recorded a sender, thus absence is the correct value and it needs no
placeholder.

Alternatives:

- The literal `local` of the agent session. It is always available, but it names no person.
  Each row would then hold one constant, which tells a reader nothing that the store does
  not hold already.
- The `sub` claim of the token. It is stable under a change of email. But the cli keys its
  user agents by email, thus `sub` would add a second identifier for one person.
- The user name of the operating system. The cli reads no such value anywhere today, and it
  identifies a machine account, not an account of the product.

### D2 — The engine resolves the author through its injectable edges

`ChatTurnSeams` gets a required member `readAuthor: () => string | null`, a verb the same as
`prepare` and `run`. `realTurnSeams` binds it to `currentUserEmail` (D3). It is required, thus
an omission is a compile error rather than a turn that silently stores no sender. This is
the rule that `RunChatTurnArgs.usageRecorder` already states for the same reason.

The price is the four sites that build the bag literally. Each one gets a member that gives
`null`:

- `src/modules/harness/turn.test.ts:157`, the shared `runWith` helper. A case that drives
  the signed-in branch passes a member that gives an email.
- `src/tui/hooks/conversation.usage_recorder.test.ts:69` and `:94`.
- `src/modules/harness/usage_ledger.test.ts:258`.
- `src/modules/harness/agent_switch.test.ts:338`.

The engine calls the member at the top of the turn, before `seams.prepare`. The author is
who sent the message, thus the value comes from the moment of the message. A sign-out during
a long turn then leaves the sender on the row, and it does not erase the person who wrote
it. A turn that `prepare` refuses spends one read of a small file and stores nothing. That
is the price of one read site instead of two. The engine spreads the author onto the
`appendTurn` payload only for a non-empty string.

The engine resolves the value, thus neither surface passes an argument and the two cannot
drift.

Alternatives:

- A direct call of the auth module inside the engine. The suite runs in a sandbox with no
  auth file, thus the signed-out branch is reachable but the signed-in branch is not. A case
  would have to write a token fixture, which binds the engine to the file format.
- A new `author` member on `RunChatTurnArgs`. Each surface would then resolve the identity
  itself, which puts one rule in two places and adds a delta on the REPL capability.
- A read at boot, held on the runtime handle. A sign-in during a session would then not
  reach the next turn, and the engine runs under the suite with no booted runtime.

### D3 — The identity read lives in the auth module, and the recorder calls it

The email read moves out of `currentUserActor` into `currentUserEmail(): string | null`, an
exported function of `src/modules/auth/whoami.ts`, beside `decodeIdTokenClaims`.
`currentUserActor` calls it and keeps its actor shape and its anonymous branch. The behavior
of the recorder does not change, thus its capability needs no delta.

The issue names no work in the provenance module, thus this edit goes beyond the request.
The reason to accept it: this change makes the second caller of one identity rule. The
repository rule is to extend the near match where it lives, and never to copy it. Two copies
can disagree after a change to the claims.

The edit is behavior-preserving, but nothing holds it to that today. No case calls
`currentUserActor`, and its callers in `src/modules/analysis/analysis.ts` assert nothing
about the actor. Thus the change adds the case that pins the two branches of the actor. A
refactor with no control is not a safe one.

The alternative is a second copy of the `loadAuth` and claims read inside the turn engine.
It keeps the provenance module untouched, and it pays with the duplication above.

`currentUserEmail` gives `string | null`. `null` is the in-band absence that the cli uses for "the
referenced value is not there", and the read reports no error, because a signed-out cli is a
normal condition. Each failure of the read gives `null`: no stored session, an unreadable
file, a file that the schema refuses, a token that does not decode, and a token with no
email claim. An empty claim also gives `null`, because an empty name is not a sender.

### D4 — The engine keeps its own guard on the empty string

The engine spreads the author only for a non-empty string, although D3 already maps an empty
claim to `null`. The guard is the boundary of the store: the harness writes what it gets,
thus an empty string would reach the column and read back as a sender with no name. The cost
is one duplicated condition, and the value is that no future caller of the member can put an
empty author into the store.

## Risks / Trade-offs

- [The email is personal data, and it lands in the message store] → The provenance document
  of an analysis carries the same email already. `prov export` publishes that document. The
  store belongs to the user. Thus the change adds no new class of data to the machine.
- [The author of a turn and the identity of the session disagree] → The session says
  `local` and the row says the email. The two answer different questions: the session scopes
  the grants of one install, and the author names the person. The spec states the split.
- [An existing assertion on the whole append payload] → The shared helper gives no author.
  Thus an existing assertion keeps its meaning. A new case drives the signed-in branch.
- [The linked harness resolves through `dist`] → A stale build fails the cli typecheck. The
  current build already declares the two fields, thus this change needs no harness work.
- [A turn that the engine refuses before the agent loop] → `prepare_failed`, `thread_gone`,
  and `agent_unresolved` append nothing, thus they store no author. The message never
  reached the store at all, thus no sender is lost.
