# Design

## Context

The preset arrives through the plugin's `typescript()` factory, and the
factory — not this repository — owns the options of most rules. The harness
call passes no `tests` glob, so the factory default
`['**/*.test.{ts,tsx,js}']` applies: that block already holds
`typescript/explicit-function-return-type: 'off'` for the test files, so the
issue's "on with `off` in the tests" is the factory's own behavior once the
blanket off entry goes. The factory also takes `instanceofErrorAllowIn`,
which feeds the only option `@inflexa-ai/no-instanceof-error` accepts; each
other `@inflexa-ai/*` rule in the block accepts no options (`schema: []`).

The plugin's architecture-directives layer decides where an exception may
live. An `oxlint-disable … -- <reason>` directive is live for a
`typescript/*` rule; an `@inflexa-ai/*` rule "cannot be disabled inline. Fix
the code the way the rule's own message describes. If the rule is wrong for
this case, change its zone or options in the lint configuration so the
exception is visible in review." The one precedent zone in the file is the
`no-console` exemption of `src/lib/console-logger.ts`.

The counts in the issue body come from the plugin 0.7.0 probe of
`tmp/claude/lint/harness.md` section 3 and have drifted: the lower children
removed probes and added predicates while they fixed their own rules. The
worklist authority is a fresh run on this branch. Measured with the block
removed and the factory options intact (probe config
`harness/tmp/pi/709-probe.json`, measurement
`harness/tmp/pi/709-counts.json`): 1015 reports, 635 outside the test
globs — of those, 8 sit in `scripts/refresh-fixtures.ts` and the rest in
non-test `src`.

## Goals / Non-Goals

**Goals:**

- `oxlint.config.ts` turns off no preset rule outside the bun-types test
  block and the deliberate-site zones this design sanctions.
- Each fix states its truth: the code after the fix says what the data is.
- Each kept site carries its reason where a reader of the exception finds
  it.

**Non-Goals:**

- No change to `@inflexa-ai/oxlint-plugin` itself. A rule that needs a new
  option gets its deliberate sites as config zones instead; a plugin change
  is a change of the pinned dependency, outside this issue.
- No re-lint of `cli/` or `prov-kernel/`; their trees own their own configs.
- No behavior change. Where a fix would change reachable behavior, the site
  is deliberate and keeps its exception instead.

## Decisions

### D1 — The config flip is one atomic edit, first

The whole `#609` off-block comes out in the first task, the
`instanceofErrorAllowIn` wiring goes in with it, and a red `bun run lint` is
the sanctioned mid-state of the change (the #704 D1 pattern). The fresh
per-rule, per-directory counts land in `notes.md` as the live worklist; the
probe counts above are the plan, the live run is the authority. Alternative —
flip each rule as its family is fixed — rejected: 27 partial states multiply
review and rebase cost for no information gain.

### D2 — The fix doctrine, per family

The rule message names the fix; the fix states its truth. The behavior bar:
a report names a value that is already wrong (`[object Object]` in a string,
an empty schema that parses anything), so replacing it is the fix, not a
behavior change. A behavior change is a different value where the value was
already correct — a persisted format, a wire field, a golden fixture byte.
Where a fix would change a correct value, the site is deliberate and goes
under D3.

- `typescript/no-base-to-string` (241): never let an object reach a string
  as `[object Object]`. Pick the named property, build with a template that
  interpolates strings, or `JSON.stringify` a record that is logged as data.
  A `toString()` override joins the type only where the string form is a
  real domain concept.
- `@inflexa-ai/no-empty-schema` (106): describe the shape — `z.object`,
  `z.record(z.string(), …)`, `z.array`, `z.enum`. Where the shape is
  deliberately open (a passthrough envelope, a forward-compat part), the
  site is deliberate and goes to a zone under D3.
- `@inflexa-ai/no-typeof-object` (87): replace a `typeof x === "object"`
  probe with the check that carries the meaning — the shared
  `isRecord`-shaped guards of `src/lib`, `Array.isArray`, or a schema parse
  at the boundary that already exists. A probe that restates a cast is dead
  weight the lower children already deleted; what remains states a truth.
- `@inflexa-ai/no-unknown-type-guards` (84): a guard over an
  `unknown`-typed value is the sanctioned shape when it IS the boundary
  check (the ledgered predicates: `isUnknownArray` and the `isRecord`/
  `isRecordOf` family; `isChatPartRecord` reports nothing under plugin
  0.8.0, because its parameter is typed — the #704 ledger's hedge is
  resolved and it needs no zone). The rule's own message names the
  sanctioned form; the ledgered predicates and their new siblings become
  zones under D3, and a guard that narrows a known union is rewritten to
  narrow what it actually checks.
- `@inflexa-ai/no-instanceof-error` (80): check the specific class, or
  narrow structurally the `isProviderError` way. The modules that normalize
  an arbitrary thrown value into an `Error` — the error helpers — go into
  `instanceofErrorAllowIn`, each named with the reason in the config
  comment. The measured non-test population decides the list: a module
  goes in only when normalizing an arbitrary thrown value is its job, and
  the `Result`/error bridges of `src/lib` are the expected candidates.
- `typescript/explicit-function-return-type` (89 non-test): write the return
  type the function already has. Where the inferred type is a large
  structural literal, the declared type is the domain name the module
  already exports.
- `typescript/unbound-method` (52; 42 in tests): reference the method bound
  — `obj.method.bind(obj)`, a local arrow, or a direct call — never a
  detached `obj.method` reference.
- `typescript/restrict-template-expressions` (66): only strings and numbers
  enter a template (the factory allows numbers). A record or array in a
  template is `JSON.stringify` or a named field.
- `typescript/no-deprecated` (38): move to the live API the message names.
  The measured shapes: zod `.passthrough()` (22 sites across
  `src/sandbox/farm.ts`, `image-packages.ts`, the citation clients, the
  literature sources, `schemas/file-metadata.ts`, one test) moves to
  `z.looseObject()` with identical parse semantics; zod `.url()` (2) and
  `.date()` (1) move to `z.url()` and `z.iso.date()`; `ZodIssueCode` (2)
  moves to the live zod issue API; the AI SDK `type: "file"` parts (5,
  led by `src/loop/tool-output.ts`) move to the `file` form with
  `mediaType` and tagged data; `system` (3) moves to `instructions`;
  `fullStream` (2) moves to `stream`. A replacement holds only when the
  runtime semantics are the same, and the module tests of the changed
  file pin the semantics (the provider tests pin request shape, the
  schema tests pin parse behavior).
- The tail rules state their truth mechanically: drop the conversion that
  changes nothing (`no-unnecessary-type-conversion`, 30), delete the
  redundant constituent (10 + 3), remove the braces a template does not
  need (4), give the parameter a use or a `_` name, and so on. Each fix is
  the one the rule message names; no pattern abstraction is needed at these
  sizes.

### D3 — Deliberate sites: where the exception lives

A `typescript/*` site that must stay (a false report the pinned toolchain
cannot see past) takes the inline form the architecture layer reads:
`// oxlint-disable-next-line typescript/<rule> -- <reason>`.

An `@inflexa-ai/*` site that must stay cannot take that form. It becomes a
named file zone in `oxlint.config.ts` — an override with the file, the rule,
and the reason in the comment, the `console-logger.ts` precedent. A site is
deliberate only when every fix the rule message offers changes a value that
was already correct, or breaks a contract a spec records. The zone
discipline: before a zone is made, the file's reports of that rule are
enumerated in `notes.md` by line, each one is fixed or listed as deliberate
with its reason, and the zone block names exactly one rule with a reason
bullet for each file it covers. A zone never lands on a file that still
holds a fixable report of its rule.
The ledgered predicates of the lower children's records
(`adopt-assertion-safety` notes: the test-side `isRecord` pair and
`isRendererFunction`; `adopt-index-access-strictness` notes: the
`isUnknownArray`, `isRecord` family) are the seed of the zone list.

### D4 — The bun-types pair and the carried flag sites

The blanket off entries of `typescript/await-thenable` and
`typescript/no-confusing-void-expression` go with the block; the test-glob
block stays untouched. The three non-test reports — the config comment names
`src/tasks/data-profile.ts` and `src/memory/conversation-display-recorder.ts`
— are real: an `await` on a value that is not a thenable, or a void
expression used where a value is read. Each gets the fix the rule message
names (the `ignoreArrowShorthand` option the factory sets is already in
force). The three carried `typescript/restrict-plus-operands` sites — the
flag-widened `T | undefined` operands of `grouped += digits[index]` at
`src/report-render/number-format.ts` and `field += ch` (with
`ch = text[i]`) at `src/report-model/production-resolver.ts` — sit inside
loops whose bound already proves the index in range, so the read can never
be `undefined`. The fix is the bounded-read form that states that truth
(`digits.charAt(index)`, or a destructured iteration) and the produced
string never changes. The deliberate `z.unknown()` of the submit-synthesis
input schema in `src/execution/run-synthesis.ts` (the issue names line 360)
is the named zone candidate of D3. `typescript/no-unsafe-unary-minus`
reports 0 and needs no site work.

### D5 — Gates and formatting

Each task group gates on its scoped `bun --bun oxlint <paths>` run for its
rules and on the module tests of the files it changed; `bun run typecheck`
stays green inside each group. One deliberate full run of `bun test` and
the full `bun run lint` close task 6.1, then the cli gates against the
linked harness (`bun run harness:local` from `cli/`, then typecheck and test
there) — the standing cross-stack CI requirement. Each edited `src/` file
runs `bun run format:file`.

## Risks / Trade-offs

- [The 27-rule red window spans the whole change] → The config flip is the
  first task and the last task only verifies; per-directory runs
  (`bun --bun oxlint <dir>`) keep each group honest without waiting for the
  full green.
- [A zone can hide a fixable site] → Each zone entry names one rule, one
  file, and the reason; the implementation reviews check each zone against
  the rule message. A zone without a reason sentence fails the artifact
  audit.
- [Behavior drift inside a "mechanical" fix] → The doctrine bar: if the fix
  changes reachable behavior, the site is deliberate and goes under D3; the
  notes record each such call.
- [Count drift between plan and live run] → The probe numbers are the plan;
  the first task re-measures and the live numbers are the worklist.
