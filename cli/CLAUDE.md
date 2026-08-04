## Formatting

**After you edit a source file in `src/`, run `bun run format:file <paths>` on the
files that you changed.** Do this before you report the task as complete. Format
only a file inside `src/`. Never format a markdown file, a config file, or a spec
file. Use `bun run format` for the format of the full project.

## Postmortems

[`HORRIBLE_BUG_FIXES.md`](./HORRIBLE_BUG_FIXES.md) records the catastrophic bugs,
their root cause analyses, and the lessons. **Read the applicable entry before you
work in the same area.**

## Scope: implementation only

The user controls the orchestration of the work. Stay on the implementation in
this repository, and leave the coordination to the user.

- Do not discuss the release order, the pull request sequence, the rollout stages,
  the deploy time, or a signal to a different team.
- Do not give an orchestration plan. Do not ask a coordination question, for
  example "when must X merge?", "must we mark this consumed?", or "how do we
  signal readiness?".
- A handoff document or a spec can describe a staged rollout. Read it for the
  technical context. Then change the applicable constraints into implementation
  requirements. Do not echo the orchestration framing back.
- Red `cli` CI on a main push, after a combined `cli` and `harness` change
  merges, is correct, and the developer controls it. Refer to the root
  [`CLAUDE.md`](../CLAUDE.md). Say nothing about it.

## Quick Start

```bash
bun install          # Install dependencies
bun run dev          # Run the CLI (launches the TUI by default)
bun run typecheck    # tsc --noEmit
bun run lint         # Run ESLint
bun run format       # Format all of src/
bun run docs:gen     # Generate the CLI reference package (dist-docs/, untracked)
bun run test         # bun test — the whole suite in one process, exactly what CI runs
```

The suite is plain `bun test`. It runs in one process, each test file shares that
process, and it takes about 60 seconds and less than 1 GiB. The arguments pass
straight through, for example `bun run test src/lib/lock.test.ts`, `-t <name>`, and
`--watch`.

**`[test].preload` in `bunfig.toml` must never get
`"@opentui/solid/runtime-plugin-support"` again.** Its catch-all `onResolve` leaks
the directory handles that it opens. A run in a shared process then climbs to file
descriptor number about 21,400. That is past the macOS `OPEN_MAX` of 10240, at
which `Bun.spawn` silently hands the child `/dev/null` instead of a socketpair.

The child then runs correctly and exits 0, but the parent reads zero bytes. Thus a
test that depends on spawn fails with empty captured output, and nothing in its own
code explains why. The two known sites are `spawnInflexa — process bounds` in
`src/modules/harness/inflexa_tool.test.ts`, and the `launchWithBinary` readiness
drain in `src/modules/embedding/local-provider.test.ts`. Without that entry the run
peaks at file descriptor 2307, which is 4.4 times of headroom. Nothing needs it,
and that includes the render tests.

## Dependencies

**No new dependency without your explicit approval.** If a task seems to want a new
package, ask first. The default is to build on what is already here.

## Coding

- **Do not extract a single-caller helper or sub-component into a separate file.**
  Keep it in the same file as its caller. A new file is justified only when there
  are multiple callers, because that is when a real reusable pattern emerges.

### Agent command policy — ask, never guess

Each command in the registry (`src/cli/index.ts`) declares an `AgentPolicy` at
registration, through `registerAction(command, policy, handler)`. That policy
decides if the `run_inflexa` tool of the conversation agent can run the command:

- `auto` — prompt-free, with a `safeFlags` allowlist
- `approval` — the default in-chat prompt
- `blocked` — never, with a mandatory reason.

The policy parameter is required, thus an unclassified command is a compile error.
A lint rule bans a raw `.action(` there. A tree-walk and a snapshot test
(`agent_policy_tree.test.ts`) pin the whole `{grantKey → kind (+ safeFlags)}` table.

**When you add a command, or when you add an option to an `auto` command, ASK the
user which classification it gets.** Never guess `approval`, `auto`, or `blocked`
for convenience. Never guess which flags are safe.

The default is not "whatever compiles". A command that writes anything, even a small
thing, is `approval`. `auto` needs the user to make sure of the read-only quality
against the implementation of the action. A flag belongs in `safeFlags` only when
*each* value that it can carry leaves the command read-only, for example an
output-shaping flag such as `--json`. A new option on an `auto` command is unsafe
until the user says differently.

**An option must never change the effect class of a command, from read to write
or from write to read.** Make it a new subcommand with its own policy, not a flag.
Write `refs refresh`, not `refs list --refresh`. This keeps `safeFlags` small, and
it classifies each effect class independently.

## Error handling — neverthrow first

**`Result<T, E>` from `neverthrow` is the default error channel.** Each function
that can fail gives a `Result` (sync) or a `ResultAsync` (async). The
`must-use-result` rule of `eslint-plugin-neverthrow` is set to `error`, thus a
`Result` that nothing consumes is a build failure.

### The rule

1. **Give a `Result`. Do not `throw`.** The failure mode of a function is part of
   its signature. If it can fail, the return type says so (`Result<T, SomeError>`).
   A caller handles the two branches with `.match`, `.andThen`, `.map`, `.mapErr`,
   and the others.
2. **A `throw` needs your explicit approval.** Get confirmation before you write a
   `throw`. These are the only pre-approved exceptions:
   - **An exhaustive-switch default** — `throw new Error("unhandled: ...")`, or a
     `never`-typed branch, in a `default:` that the compiler must make
     unreachable. This is a programmer bug, not a runtime failure.
   - **A top-level entry-point bail-out** — `fail()` or `dieOn()` in `lib/cli.ts`,
     at the CLI boundary, where the process is about to exit.
   - **A `throw` inside a `bun:sqlite` transaction** — the `transaction()` API of
     bun uses throw-to-rollback. The `TxAbort` pattern in `db/util.ts` bridges this
     into a `Result`.
3. **Wrap a throwing stdlib call or external call at the boundary.** A function
   that you do not control can throw, for example `readFileSync`, `mkdirSync`,
   `writeFileSync`, `JSON.parse`, `crypto.*`, or `Bun.spawn`. Wrap it in a function
   that gives a `Result`. The wrapper lives beside its callers: in `lib/` when it
   is cross-cutting, and in the module when it is local. The existing examples are
   `tryQuery` and `tryMutation` in `db/util.ts`, and `JSON.parseWith` in
   `extensions/json.ext.ts`.
4. **A `try/catch` is only a bridge from a throw into a `Result`.** A `try/catch`
   that gives no `Result` is a code smell. It means that the caught function must
   give a `Result` itself, or that the catch block must.

### Error types

- **A domain error is a discriminated union** —
  `type FooError = { type: "x"; ... } | { type: "y"; ... }`, not an `Error`
  subclass. This gives an exhaustive `switch` and zero prototype overhead.
- **`DbError`** (in `db/errors.ts`) is the storage-layer error. Absence is
  `T | null` on the `ok` channel, never an error.
- **Keep an error type as narrow as the function wants.** A function that can fail
  one way only gives `Result<T, { type: "io_failed"; cause: unknown }>`, not
  `Result<T, AllErrors>`.

### Consuming Results

- **At a CLI boundary:** `result.match(v => v, dieOn("context"))` — print and exit.
- **In module logic:** `.andThen` and `.map` to chain, and `.mapErr` to translate
  an error type across a layer.
- **In the TUI:** the presentation layer can `.match` to render a success state or
  an error state.
- **Never use `.unwrap()` or `._unsafeUnwrap()` in production code.** They defeat
  the purpose. If you want the value and you want to crash on an error, you are at
  a CLI boundary, thus use `dieOn`. **Exception:** a test file (`*.test.ts`) can
  use `._unsafeUnwrap()` to extract a value, where an unexpected `Err` is itself a
  test failure.

### Migration from `throw` to `Result`

The codebase has legacy `throw` and `try-catch` sites in migration. When you touch
a function that throws, change it to give a `Result`. Do this only if the change
is contained, which means the function and its direct callers. Do not leave a half-migrated
state, where a function both throws AND gives a `Result`. Mark a site that you see
but cannot convert in scope with `// TODO(slop): neverthrow`.

## Code Comments

Comment the why, not the what.

- Do NOT write a comment that restates what the code already says. If a comment
  paraphrases the line below it, delete it. The types of TypeScript and good names
  already document the "what". Depend on them.
- DO write a comment that captures the intent and the reasoning: why the code works
  this way, what problem it solves, and what a future reader would find
  non-obvious.
- Prefer to make the "what" self-evident through the type system: a descriptive
  type, a union, a branded type, `readonly`, an exhaustive `switch`. Then the prose
  does not have to carry it.

Document the decisions that you made.

- Record which alternative approaches you considered and discarded, and why.
- Record which downsides or trade-offs you accepted, and why. Examples are the
  reason for an `any` or an `as`, the reason for a disabled lint rule, and the
  reason for a library.
- Each `// eslint-disable`, `@ts-expect-error`, `@ts-ignore`, and type assertion
  (`as X`, `!`) must carry a comment that explains why it is safe and necessary.
  These are the TypeScript equivalent of an escape hatch, and they must never be
  silent.

Document what is NOT there.

- Flag a shortcut and an unhandled case explicitly. Do not leave them silent. Use
  `err({ type: "not_implemented" })` when the function gives a `Result`. Use
  `throw new Error("not implemented")` only in an exhaustive-switch default and at
  a pre-approved boundary site — refer to
  [Error handling](#error-handling--neverthrow-first). Never write a stub that
  gives a fake value.
- In an exhaustive `switch` or a discriminated-union handler, use a `never`-typed
  default branch. Then the compiler flags each case that you forgot. This documents
  "each case is handled", and it breaks the build when that stops being true.
- Note a future optimization opportunity, and note the deliberate absence of an
  implementation. Examples are the reason that a method is intentionally absent,
  and the reason that a type guard is omitted.

Treat a comment as first-class, and write it early.

- A comment is among the most important code that you write. Treat it with the same
  care as the logic.
- Think about the comment or the contract before the implementation. Sketch the
  intended behavior, the inputs, and the invariants in prose, or in a JSDoc block,
  first. Then fill in the code beneath it.

Comment the surprising, the unsafe, and the load-bearing.

- Clearly comment anything that a reader would find unexpected. Examples are:
  - a dependence on external or global state
  - a mutation of a shared object
  - an order or timing requirement (async sequence, microtask against macrotask)
  - a subtle invariant
  - a non-obvious algorithm choice.
- The TypeScript analogue of "unsafe" is anywhere that you defeat the type checker:
  `as`, `as unknown as`, a non-null assertion (`!`), `any`, `@ts-expect-error`, a
  type predicate (`x is T`), and an unchecked cast of external data (JSON, an API
  response). Each such site wants a comment that states exactly which invariant the
  code around it upholds to make it sound. Examples are "the zod schema above
  validates it" and "it is guaranteed non-null because we just `.set()` it".

**A comment is not a changelog.** Never write change-history phrasing, for example
"Bumped from X to Y", "Refactored to W", "Now does Z", "Renamed from V", "Extracted
from U", or "Previously did A". Git tracks the history. A comment describes the
static rationale as a fresh reader meets it tomorrow. If a value is unusual,
justify the value, not the diff.

### Identifiers

**Mint an id inline with `randomUUIDv7()` (`import { randomUUIDv7 } from "bun"`).**
It is the single id scheme for each thing: a DB row id, the write-once anchor
marker, and an event id. It is time-sortable, which is the role that `ulid` used to
fill. It is in-runtime, with zero dependencies. It is also the only v7 source that
is available, because the `crypto` of Node mints v4 only.

**Never wrap the id generation in a helper** such as `newId()` or `newFooUuid()`. A
function whose whole body is `return randomUUIDv7()` is pointless ceremony. Write
`randomUUIDv7()` at the call site. Do not reach for `ulid` or
`crypto.randomUUID()`.

### TODO conventions

The format is `// TODO(<tag>): <reason>`. Never use a bare `// TODO`.

| Tag | Purpose | Example |
|-----|---------|---------|
| `extend` | Hidden or omitted feature, to revisit when the capabilities expand | Command flag stubbed out until the real backend lands |
| `perf` | Acceptable today, optimize at scale | `O(n)` scan that must be indexed |
| `slop` | Works, but must be extracted or cleaned up | Duplicated logic across two modules |
| `robustness` | Missing hardening for a stress condition | No retry or backoff on a flaky external call |

### Local state can go out of agreement with the database — never fail hard on it

The SQLite database is a file on the **machine of the user**. The user can delete
it, restore an old copy, or hand-edit it, and they are entitled to. Meanwhile other
state lives **outside** it and persists independently: the anchor markers on disk
(`.inflexa/id`), the output folders, and the configuration. Thus the two stores
routinely disagree. A marker, or the foreign key of a row, can refer to an id that
the database no longer has.

**Treat "the referenced row is gone" as a normal, recoverable condition. It is
never a hard error.** Code reads an id, a marker, or a path from one store and
looks it up in another. A miss must **recover** or it must **degrade**.

To recover is to reconstruct from the authoritative source, for example to
establish an anchor row again from its marker on disk. Do that only on a
*deliberate* action, never on a passive read — refer to the no-litter policy. To
degrade is to resolve to `null` or to a sensible fallback and continue. Then the
user still gets a working command. A `query_failed` or a `DbError` for a routine
disagreement is a bug: it changes "your DB and your folders disagree" into a crash
that the user cannot escape without surgery.

Concretely: a lookup that can legitimately miss gives `T | null`, thus the miss is
in-band and it is not an error. The caller picks a fallback. Reserve the error
channel for a genuine fault, which is a query that itself failed. Refer to
`resolveAnchor` (`modules/anchor/anchor.ts`). A marker that points at a deleted
anchor resolves to `null`. A bare `inflexa` then offers to start fresh in that
folder, and it does not die with `unknown anchor <id>`.

### Resolving an id-or-name reference

A command resolves a reference from the user that can be **either an id or a human
name or slug** (`inflexa resume <x>`, `--analysis <x>`, and others). Obey these
rules:

- **Type the parameter `IdOrName`** (from `lib/types.ts`), never a bare `string`.
  The alias makes "resolve this by id OR name" legible at the call site.
- **Resolve it in a SINGLE query, id-first.** Never fetch by id and then fall back
  to a fetch by name. Never load each row and then `.find` or `.filter` in JS. Put
  the priority in SQL:

  ```sql
  -- one match (LIMIT 1):
  WHERE id = $ref OR name = $ref ORDER BY (id = $ref) DESC LIMIT 1
  -- candidate set, when the caller must detect name collisions (ambiguity):
  WHERE id = $ref OR slug = $ref OR name = $ref ORDER BY (id = $ref) DESC, created_at DESC
  ```

  `(id = $ref)` sorts the exact-id hit first, because an id is unique, thus it is
  THE match. The named `$ref` param binds one time. The caller takes `[0]`. "More
  than one row, none by id" means an ambiguous name or slug. The resolver is in
  `db/primary_query.ts`, for example `findAnalysesByRef` and `findProjectByRef`.

- **Wrap the resolver in a module `findX` or `matchX` only when the wrapper adds
  logic.** `matchAnalysis` earns its place, because it reshapes the candidate set
  into `{ analysis, others }` to surface a name collision. When the resolver
  already gives the single answer, because the lookup column is `UNIQUE` like
  `projects.name`, call it directly. A `findProject` whose whole body is
  `return findProjectByRef(ref)` is pointless ceremony. Delete it, and let a caller
  import `findProjectByRef`. The same is true for a one-line write wrapper such as
  `setProject` over `updateAnalysisProject`.

This generalizes. **Prefer one query over a read-then-decide round-trip whenever
SQL can express the decision.** For example, prefer a targeted
`UPDATE … SET col = ? WHERE id = ?`, where the rows-changed count signals
not-found, over a read of the row and then a rewrite of each column.

### Column and field ordering

Order the columns, the type fields, and the parameters and bound args of the
functions that carry them in three groups, **always in this order**:

1. **Identity** — `id`, `created_at`, `updated_at`, colocated at the top. These
   three are the full identity of the row. Keep them together, although the
   timestamps are rarely read beside `id`. A table or type with no timestamps has
   `id` only. A non-entity, for example the `analysis_inputs` reference rows, has
   no identity group at all.
2. **Core data** — the fields that the row is about (`name`, `slug`, `path`,
   `is_dir`, `data`, and the others).
3. **Foreign keys** — each `*_id` or `*Id` reference, last (`anchor_id`,
   `project_id`, `session_id`, and the others).

This governs the `CREATE TABLE` columns, the `COLS` constant, the row type, and
`fromRow` in `db/`. It governs the `INSERT` and `UPDATE` column lists **and their
bound params**. It governs the persisted entity types in `src/types/`, and the
parameter lists of the functions that pass these fields through. An
`UPDATE … SET` omits `id`, because that is the `WHERE`, but it still leads with
`updated_at`, then the core, then the FKs. Declare a table parent-before-child,
thus each FK is a backward reference.

A JSON-blob table, whose payload rides a single `data` column, obeys this at the
**column** level (`id, data, <fk>`). But the interior shape of the blob is
application data, not columns, thus it keeps its own narrative order. No table in
the schema is shaped that way today. Each live table is columnar.

## TypeScript

- Prefer `type` over `interface`, `const` over `let`, and `function` over an arrow
  function.
- Always type the function parameters and the return values, except for a JSX
  return.
- Comment each `any` and each `unknown`.
- **Use a domain type. Never use a raw `string` for a known value set.** The shared
  domain types are in `src/types/`, grouped by domain: the persisted entity shapes
  (`session.ts`, `anchor.ts`, and the others) and the event contract (`events.ts`).
  Each other type (a command option, an error union, a wire schema) is colocated
  with the code that has it. Refer to [Project structure](#project-structure) for
  the reason that the entity shapes are shared and not module-local.
- **Document each exported declaration — a type, its properties, and a function —
  with a JSDoc (`/** … */`) block, never with a `//` line comment.** JSDoc is the
  only form that the LSP surfaces on hover and on completion. Thus a `//` above a
  function is invisible at the call site where you read it. Reserve `//` for an
  inline implementation note (the WHY) inside a body. Put the block on the line
  above what it describes.

  ```ts
  /** Invisible folder-identity record. Keyed by the marker id, not its path. */
  export type Anchor = {
      /** false when the folder was not writable (no on-disk marker) */
      markerWritten: boolean;
      // NOT: markerWritten: boolean; // false when the folder was not writable
  };

  /** Records a sighting heartbeat only — does NOT touch `updatedAt` (the data-edit stamp). */
  export function touchAnchor(id: string): Result<void, DbError> {
      /* … */
  }
  ```

## Naming conventions

- **Files:** lowercase. Use snake_case for a multi-word name
  (`primary_query.ts`).
- **Named exports only.** No default export, no barrel file, and no re-export. Use
  an inline `export` on the declaration.
- When you move code, update EACH importer to the new location. Never add a shim.

## Project structure

The code is in groups **by feature (a vertical slice)**, not by technical layer. A
feature has its logic, its CLI command actions, and its logic-local types, under
`src/modules/<domain>/`. Shared infrastructure with no single owner stays in the
layer directories.

- `src/index.ts` — the entry point: the telemetry and log wiring, the shutdown
  hooks, then `cli.parse()`.
- `src/cli/` — the commander command **registry** (`index.ts`) plus the help
  format, and nothing else. Each command lazy-imports its action. A text command
  comes from its module, for example `import("../modules/auth/login.ts")`. A TUI
  screen comes from `tui/`, for example `import("../tui/app.launch.tsx")`.
- `src/modules/<domain>/` — the feature slices (refer to [Modules](#modules)):
  **headless** domain logic, plus the text command actions that operate them. An
  interactive view is NOT here (refer to `tui/`). Today the slices are:
  - `auth/` — the Auth0 device flow, with `login`, `logout`, and `whoami`
  - `proxy/` — the CLIProxyAPI model helpers in `models.ts`: the client API key
    discovery and the default-model rank. The container lifecycle is in `infra/`
  - `analysis/` — the analysis lifecycle
  - `anchor/` — the folder-identity markers, and the lazy path reconciliation
  - `harness/` — the harness embedder. It boots the harness runtime (DBOS, the
    sandbox, the providers) and operates the chat turn, the model-free
    `run --plan` replay engine, the data profiler, and the provenance bridge
  - `embedding/` — the embedding-provider resolution from the configuration, plus
    the in-process bge-small local model: the download, the check, and the
    lifecycle
  - `infra/` — the container stack. `setup`, `up`, and `down` provision CLIProxyAPI
    and Postgres with pgvector, through a generated Docker Compose file
  - `libs/` — the published sandbox image variants (the GHCR refs), plus the
    `sandbox pull` and `status` actions
  - `project/` — the project CRUD command actions (`project new`, `project ls`)
  - `prov/` — the provenance recorder. It is a bus subscriber that builds, signs,
    and stores the PROV document of each analysis. It gives `prov export` and
    `prov verify`
  - `staging/` — it puts the analysis input files under the `data/` root of the
    analysis workspace. It gives each file a content hash, and it writes the
    `StagedInput` manifest that the harness accepts.
- `src/db/` — the shared SQLite layer: `primary.ts` (the connection),
  `primary_migrations.ts`, `primary_query.ts`, `primary_mutation.ts`, `errors.ts`,
  and `util.ts`. The queries and the mutations stay here, verb-split, beside the
  migrations. A module imports the functions that it wants.
- `src/tui/` — the **presentation layer and app shell**: the entry app, plus the
  shared, app-level, or reusable Solid and opentui code. Today it has `app.tsx`
  (the root chat screen, which each command that opens a chat launches),
  `app.launch.tsx` (`launchTui`), `command_palette.tsx` and `commands.tsx` (the
  palette adapter and the command registry), `app_config.tsx` (the settings, an
  app-level screen), `theme.ts` (the reactive accessor — the id list and the
  palette data are in `lib/design_system.ts`, and it also has the shared `Notice`
  type and the `noticeColor` mapping, because a notice kind maps onto a palette
  role), and `components/` (the shared, domain-agnostic widgets, below).

  The presentation sits *above* the logic modules. It can import module logic
  (view to logic), but a module must never import `tui/`. **Where a view lives**
  mirrors the `components/` and `modules/<m>/components/` split of Lumen. A shared,
  app-shell, or app-level screen goes here. A view that exactly one feature has
  colocates in that module. `app_config.tsx` is an app-level exception that lives
  here. It is not a license to put each view in `tui/`. Add `tui/<domain>/`, or a
  module-side view folder, when a screen outgrows one file.
  - `src/tui/components/` — the shared TUI widgets. A widget belongs here **only
    if** it imports `theme` plus opentui and solid only (no `modules/`, no `db/`,
    and no other domain import), **and** it has 2 or more callers. There is one
    component for each file, and no barrels. A feature-coupled adapter, for example
    `CommandPalette`, which maps `Command` objects, stays in the `tui/` app-shell,
    not here.

    Today it has `dialog/` (the dialog subsystem, below). It has `list_core.tsx`,
    `fixed_list.tsx`, and `dynamic_list.tsx` (the list primitives — fuzzy-filtered
    grouped lists). `FixedList` reads its items ONCE and renders with `<For>`.
    `DynamicList` tracks reactive items and renders with `<Index>`. A host has the
    filter input and passes `query` down. A row can be `pinned` to opt out of the
    rank. Use that for an escape-hatch row whose action is "enter something these
    rows cannot express". There the query is precisely the text that its own label
    cannot match.

    It also has `text_area.tsx` (`TextArea` — a themed textarea with chrome tiers
    and mode tracking) and `text_input.tsx` (`TextInput` — a themed single-line
    input with a callback for each keystroke). The two editors take an `autoFocus`
    opt-out (a list-first host, a gallery exhibit, a showcased dialog) that also
    seeds the focus signal of their chrome. Thus a blurred mount renders blurred
    from the first frame.
  - `src/tui/components/dialog/` — the dialog subsystem: the chrome shell, the host
    and overlay, and the reusable content dialogs. `dialog_host.tsx` is the **state
    machine**. It has a module-level stack, where a lower entry stays MOUNTED but
    hidden and inert, thus dialog-over-dialog preserves the state.

    Each dismissal routes through the single close funnel `dialogClose(reason)`,
    where `reason` is `cancel` (esc), `dismiss` (click-outside, ctrl+c, sweeps), or
    `commit` (the default — a programmatic close is the tail of a submit flow). The
    host has the ONE structural esc binding, and a content dialog never binds esc.

    A dialog participates through hooks:
    - `useDialogBindings` — key layers, auto-suspended while a dialog is stacked
      above. It is REQUIRED for each dialog key, and for a screen layer that must
      suspend under a prompt.
    - `useDialogCancel` — wire an `onCancel` prop to each close that is not a
      commit.
    - `useDialogCloseGuard` — veto a close, for a busy prompt or a dirty form. The
      app abort chord escalates past a veto on a quick second push.
    - `useDialogEntry().setInitialFocus` — the host applies the focus on push and
      on reveal. There is no mount-time focus microtask for each dialog.
    - `DialogShowcase` — render a dialog as an inert gallery exhibit. The `inert`
      flag of the handle threads into the `autoFocus` of an editor, thus an exhibit
      grabs no focus even at mount.

    The size comes from the `dialogSize` presets: fixed columns plus a `maxWidth`
    clamp. The height is FIXED for a tier whose content changes while it is open:
    the `lg` pickers and `xl`. A panel that resizes as its list filters is worse
    UX than empty rows. Only the static-content `md` is content-height. Refer
    to `design_system.ts`.

    A percentage-capped panel must NOT be inside an auto-sized box, because yoga
    resolves the percentage against the parent and squeezes the panel. The per-entry
    wrapper of the overlay is full-inset for this reason. The click containment is
    on `DialogPanel` itself (`dialogPanelMouseDown/Up`).

    The content dialogs are `alert_dialog.tsx`, `confirm_dialog.tsx` (with
    `tone="danger"` chrome), `export_options_dialog.tsx`, `file_picker.tsx`
    (`FilePicker` — a multi-select file browser on `DynamicList`, with INSERT,
    NORMAL, and REVIEW modes), `prompt_dialog.tsx` (`PromptDialog` — a single-line
    `TextInput` by default, and `multiline` opts into `TextArea`. A busy state
    vetoes each dismissal), `results_dialog.tsx`, and `select_dialog.tsx`
    (`SelectDialog` — the picker dialog that composes a filter `TextInput` and a
    `FixedList`, for each "choose one of these" command). The design gallery
    showcases each one.
  - `src/tui/layout/` — the **composition kit** of the chat app shell: a full-width
    status bar above a main row of stream and input, beside a toggleable,
    full-height **sidebar**. The files are `status_bar.tsx`, `message_block.tsx`,
    `chat_bar.tsx`, and `sidebar.tsx`. The gutter marker set is in
    `lib/design_system.ts`, not here.

    Its **role** makes it different from `components/`: it is shell composition,
    not a reusable widget. It is a deliberate, scoped exception to the
    single-caller rule. A kit part CAN be single-caller, and it CAN import a domain
    type or query. It stays here even when it is generic and multi-caller, for
    example `StatusBar`, which `app.tsx` and `app_config.tsx` share. The chat
    status is in the reactive `src/tui/hooks/status.ts` store, which is the pattern
    of `theme.ts`. The app only renders it.
  - `src/tui/keymap.ts` — the **keybinding engine**. A binding is DATA, dispatched
    centrally. NEVER write a raw `useKeyboard` or a `key.name === …` branch in a
    component. A component declares a reactive layer with
    `useBindings(() => ({ enabled?, mode?, target?, priority?, bindings }))`.
    Exactly one `useKeymapRoot()` for each renderer installs the single
    `useKeyboard` that routes each keystroke to the winning binding. The renderers
    are the chat `App`, and the standalone `ConfigApp` only when it is not
    embedded.

    **Modal capture** is the mode stack. An open dialog does `pushMode(MODE_MODAL)`
    (the effect of App), which suspends each `MODE_BASE` layer at one time. There is
    no `if (dialogOpen)` for each binding.

    **A leader and a chord sequence**: `leaderSeq("n")`, or a `<leader>` spec,
    builds a timed multi-stroke binding. Escape aborts a half-typed chord,
    backspace pops one stroke, and a comma gives the alternatives. The `WhichKey`
    overlay (`layout/which_key.tsx`) lists `reachableKeys()` live, documented free
    from the `desc` and `group` of each binding.

    **A focus `target`** gates a layer to when a renderable, or a descendant, has
    the focus. It is the fine-grained complement to `mode`. The chord is the single
    source: a display label is DERIVED (`chordLabel`), and it is never hand-kept
    beside the chord. An app-level key is remappable through `config.keybinds`
    (command id to key string, for example `app.command-palette`). A structural
    dialog key comes from the shared `KEYS`. Only the root handler and the focus
    check touch opentui. The matcher (`matchChord`) stays structural.

    **A label is ALWAYS lowercase** (`ctrl+k`, `esc`). A chord uses **Ctrl, never
    Alt**, because a terminal delivers Alt and Option unreliably, and macOS
    composes Option into a character. A chord never uses Cmd, because a terminal
    does not forward it. The textarea submit and newline stay at the renderable
    level (`text_area.tsx`, cursor-aware), and they come from `SUBMIT_CHORD` and
    `NEWLINE_CHORD`.
- `src/lib/` — non-domain infrastructure: `env.ts` (the sole reader of
  `process.env`), `config.ts` (the user config file), `bus.ts` (the event bus),
  `log.ts` (pino), `otel.ts`, `shutdown.ts`, and `design_system.ts`.

  `design_system.ts` is the single merged source for the visual primitives of the
  TUI: `GLYPHS`, the theme registry and `ThemeColors`, the layout `tokens`
  (`space`, `size`, `stroke`), the `zIndex` stacking ladder, and the gutter
  `MARKERS`. The reactive accessor over the theme data is `tui/theme.ts`. A JSX or
  signal design helper is in `tui/components/`. Refer to [Glyphs](#glyphs).
- `src/extensions/` — the global runtime extensions (below).
- `src/types/` — the shared domain model, grouped by domain: the persisted entity
  shapes (`session.ts`, `anchor.ts`, and the others) and the event contract
  (`events.ts`). These are shared, not module-local, because the `db/` layer refers
  to each entity shape and `lib/bus.ts` refers to the events. To home them in a
  module would invert the dependency from infra to feature.

## Modules

A module under `src/modules/<domain>/` groups each thing about one domain: its
logic, its CLI command actions, and its logic-local types. There is **no mandated
file layout**. Add a file as the domain wants it, not before. Use named exports
only, and no barrels, per [Naming conventions](#naming-conventions).

- **Public surface.** Whatever the other layers import is the API of the module.
  Import it directly from the file that has it, for example `ensureProxyReady` from
  `modules/proxy/setup.ts`. There is no barrel and no index re-export.
- **Dependency direction.** A module imports the shared infra (`lib/`, `db/`,
  `src/types/`, `extensions/`) and **other modules, acyclically**, for example
  `harness` to `proxy`, and `analysis` to `anchor`. A module must **not** import
  `tui/`, because the presentation depends on the logic and never the opposite. The
  infrastructure (`lib/`, `db/`) must **never** import a module. If two modules want
  the same code, lift it to a shared layer.

## Global extensions

`src/extensions/*.ext.ts` augments a built-in global with a small, broadly-useful
method (`Promise.sleep`, `JSON.parseWith`). Thus a call site does not redeclare a
one-line helper. Each file:

- Declares the method on the applicable global interface, through
  `declare global { interface PromiseConstructor { … } }`. Use `PromiseConstructor`
  or `JSON` for a static, and the instance interface for a prototype method. Then
  it assigns the implementation, and it ends with `export {}` to stay a module.
- Is registered by one side-effect import in `src/extensions/index.ts`. That is the
  central loader, imported one time from `src/index.ts` before `cli.parse()`. The
  loader is side-effect-only. It is not a re-export barrel, thus it does not
  violate the no-barrel rule. Anything that depends on an extension must run after
  the entry point loads it. Each CLI command does, because it lazy-imports after
  startup.

Reach for an extension only when a helper is genuinely cross-cutting. Keep a
single-caller helper in the file that has it, per the Coding rules.

## Event bus — one bus, typed events

There is **one bus** (`Bus` in `src/lib/bus.ts`), and each domain shares it:
session, provenance, and any future concern. The domain separation is by the event
`type` string, not by a bus instance. **Never add a second bus** to separate the
concerns. If the current event contract feels wrong, the fix is better types, not
more buses.

- **One event type for each domain action.** Each `BusEvent` member carries exactly
  the fields that its action wants. Never pack more than one sub-action into a single
  event that an interior field discriminates, with nullable companions. That
  defeats the narrowing of TypeScript, and it forces a consumer to guard against an
  impossible state. For example, provenance has `prov.analysis_created`,
  `prov.input_added`, and `prov.input_removed`. It does not have one
  `prov.recorded` with a nullable `input`.
- **The event types are in `src/types/events.ts`.** The `BusEvent` discriminated
  union is the contract. Each member today is analysis-scoped provenance (`prov.*`,
  which carries an `analysisId`). The harness conversation path writes the Solid
  store directly, and it does not use the bus. A consumer filters by `type`.
- **The design rationale:** a dedicated bus for each domain earns its keep only
  when that domain wants its own subscriber lifecycle, backpressure, or error
  isolation. The bus of inflexa is a fire-and-forget notification channel, with one
  subscriber for each concern. To multiply the buses adds wiring overhead for no
  structural gain. This was validated against OpenCode, which routes more than 80
  event types across each domain through a single typed bus.

## Solid and opentui (the TUI)

The TUI is Solid (`solid-js`), rendered to the terminal through `@opentui/solid`.
Solid is not React: a component runs one time, the reactivity is in signals and
stores, and there are no re-renders.

### Design gallery

**Before you write or change TUI code, consult the design gallery**
(`src/tui/layout/design_gallery.tsx`, opened through the "Design gallery"
command-palette entry). It is the read-only showcase of each existing block and
widget, and of its states. Use again what it shows, and match its patterns.

**A task can want something that the gallery does not cover: a new block, a new
state, or a new visual pattern. Then STOP, and talk to the user.** The subject is
an addition to the design system, or an extension of the gallery. Do not invent an ad-hoc UI off to
the side. A new surface becomes part of the gallery, thus the gallery stays the
single source of truth.

### Launch and exit

- Each TUI screen is in `src/tui/` as its component plus a `launch*` function. The
  two are colocated in one file, like `app_config.tsx`, or split into an
  `app.launch.tsx` beside a large component, like the chat `app.tsx`. `launch*`
  resolves its data (the session lookup or creation) first. Then it calls
  `void render(...)` with `exitOnCtrlC: false`, `targetFps: 30`, and
  `screenMode: "alternate-screen"`.
- **Always call `renderer.destroy()` before `shutdown(0)`.** `destroy()` restores
  the terminal: the mouse tracking, the alternate screen, and the cooked mode.
  `process.exit()` alone skips the cleanup of OpenTUI, and it leaves the shell
  broken.
- `exitOnCtrlC` is false, thus each TUI app must handle its own quit keys through
  `useKeyboard`.

### Reactivity

- Never destructure `props`. Access `props.x` at the use site, or the reactivity is
  lost.
- **`props` as the initial value of a signal — `solid/reactivity` gives a warning.
  Decide between seed-once and stay-in-sync.** A read of `props.x` at the top level
  of the component body, for example `createSignal(props.x)`, reads it one time and
  drops the reactive link. The lint rule flags that. There are two legitimate
  intents:
  - **Seed-once** (the value is locally-owned mutable state, and the prop is only
    the initial seed): keep `createSignal(props.x)` and add a scoped
    `eslint-disable solid/reactivity` with a `--` reason. The reason must state
    *why* a one-time read is safe, for example that the component mounts one time
    with fixed props. This is the common case in our single-mount screens: the
    `currentSessionId`, `currentWorkingDir`, and `currentAnalysis` of `app.tsx` are
    seeded from the props of `App`, and the palette then mutates them. Type the
    signal explicitly when the type of the prop must be pinned
    (`createSignal<Analysis>(props.analysis)`).
  - **Stay-in-sync** (the signal must obey a later prop change): seed it, then
    `createEffect(() => setX(props.x))`.
  - Do NOT "fix" the warning by a destructure (forbidden above), and do not store a
    thunk (`createSignal(() => props.x)` stores a function, not the value). When
    the warnings of a whole file are the same false positive, a file-level
    `eslint-disable solid/reactivity` with a `--` reason is cleaner than per-line
    disables. An example is the reads of a stable `ctx` prop, inside the opentui
    `onSelect` and `onSubmit` handlers that the rule does not recognize
    (`commands.tsx`).
- Use `createSignal` for a scalar. Use `createStore` plus `produce` for a list and
  for nested data, for example the messages.
- A streaming delta accumulates in a dedicated signal (`streamText` and
  `streamPartId` in `app.tsx`). It flushes into the store only when the part
  completes. Never write each delta into the store.
- Control the flow with `<For>` and `<Show>`, never with `.map()` in JSX.
- A renderable ref is `let ref: SomeRenderable | null = null` plus a ref callback.
  Focus it through `queueMicrotask(() => r.focus())`, because the renderable is not
  ready synchronously.

### Layout (flex) — opentui is NOT web CSS

Two opentui-specific facts. Both were verified against the engine source, and both
were reproduced with the headless `testRender` and `captureCharFrame` harness —
refer to "How to do a check of a layout" below. When a layout overlaps, instrument it. Do
**not** reason by analogy to CSS.

**1. `flexShrink` comes from the dimensions.** A child with a non-numeric size
(`"100%"`, `"auto"`, unset) defaults to `flexShrink: 1`. A numeric size gives `0`.
Thus a `width="100%"` box, for example the whole input bar, shrinks by default, and
on a short terminal it collapses below its own border. Essential chrome that must
keep its rows wants an explicit `flexShrink={0}` — refer to `chat_bar.tsx`. Then
the scroll region (`flexGrow` plus `minHeight={0}`, as in `app.tsx` and `chat.tsx`)
absorbs the squeeze instead.

**2. A `flexGrow` scrollbox overlaps its next flex sibling by one cell.** In a
column, the yoga layout of opentui gives a `flexGrow={1}` scrollbox a rendered
height that is **one greater**. It is one greater than the height that the
scrollbox contributes to the column flow. Yoga
places the sibling that follows at `scrollbox.y + height − 1`, which is *inside* the
last row of the scrollbox. The scroll content then bleeds onto whatever sits
directly below, for example a footer hint or a detail line.

This is **not** fixable with `minHeight`, `flexShrink`, `overflow`, a wrap, or an
integer panel size. Each of those was tried, and each reproduced the overlap. It is
a yoga and scrollbox quirk. It is present at most panel heights, and it only
becomes *visible* when that row carries content.

The remedy: **a fixed chrome row that is directly below a `flexGrow` scrollbox must
be a full-width box, painted with the panel background**
(`<box width="100%" flexShrink={0} backgroundColor={…}><text/></box>`). Then it
opaquely reclaims its whole row. A bare `<text>` is not enough, because it paints
its own glyphs only, and the bled content shows through the gaps. The live sites
are `dialog/dialog_panel.tsx` (the footer) and `list_core.tsx` (the detail line).

**How to do a check of a layout.** The `testRender` and `captureCharFrame()` of
`@opentui/solid` render any component tree to a text frame at a fixed
`{width, height}`, with no TTY. `mockInput.pressKeys` operates the scroll. The
`.x`, `.y`, `.width`, and `.height` of a renderable, plus
`yogaNode.getComputedLayout()`, expose the computed boxes. Sweep a range of
heights, because these bugs depend on the size and a single size hides them.

### Event bus (TUI consumption)

The bus contract and its design rationale are in
[Event bus — one bus, typed events](#event-bus--one-bus-typed-events) above. These
rules are TUI-specific:

- Subscribe in the component setup with `Bus.on("inflexa", handler)`. Always pair
  it with `onCleanup(() => Bus.off("inflexa", handler))`.
- A handler must filter the events by `analysisId`, because each bus member is
  analysis-scoped provenance. It applies only the domains that it has.

### Colors

Each color comes from `theme` in `src/tui/theme.ts`. There are ten palettes: five
dark, then five light, and `tokyo-night` is the default. They map to semantic roles
(`bg`, `fg`, `fgMuted`, `fgSubtle`, `border`, `accent`, `user`, `assistant`,
`success`, `warning`, `error`, and others). **Never inline a hex value in a
component.**

**Each `<text>` resolves an explicit foreground.** The text renderable of opentui
defaults `fg` to opaque white (`RGBA.fromValues(1, 1, 1, 1)`). Thus a `<text>` that
names no color paints `#ffffff`. On the five dark themes that scores 12:1 to 18:1.
It is off-palette, because the body text of tokyo-night must be `#c0caf5`. But it
is legible. That is exactly why the default hides the bug from a person who
examines the dark default only. On the five light themes it scores 1.00:1 to 1.13:1, thus it
is invisible. `github-light` (bg `#ffffff`) measures exactly 1.00:1.

Two shapes satisfy the rule, and both are correct:

- **`fg` on the element** — `<text fg={theme().fg}>…</text>`. The prop propagates
  into a child span that does not override it, thus a nested `<Bold>` inherits it.
  A block whose whole line shares one color is better served by the prop than by a
  wrap of each child.
- **Wrap each information-bearing child** in `<Fg role={…}>` or `<Reverse>` —
  `<text><Fg role="fg">{heading()}</Fg></text>`
  (`components/plan_card_block.tsx`). This is required once a line mixes colors.

**A bare string literal inside an `fg`-less `<text>` is the defect.** That includes
one that sits beside correctly-wrapped siblings, because `<Fg>` colors its own span
and never the text next to it:

```tsx
// WRONG — the glyph is themed, ` DONE` paints #ffffff
<text><Fg role="accent">{GLYPHS.check}</Fg> DONE</text>
// RIGHT
<text fg={theme().fg}><Fg role="accent">{GLYPHS.check}</Fg> DONE</text>
```

**Contrast floors.** Information-bearing text holds 4.5:1 or more against each
background that it lands on. Non-text and decorative content holds 3:1 or more:
the borders, the progress-meter cells, the separator glyphs, and the `fgSubtle`
tier. The tiers, and which of them the 4.5:1 threshold exempts, are defined on
`ThemeColors` in `src/lib/design_system.ts`. Use that vocabulary. Do not mint a new
tier.

**Examine each new or changed surface on a light theme**, never on the dark default
only. The 12:1 to 18:1 of white on dark is what lets an unresolved foreground pass
a review. `github-light` is the sharpest case, because its `bg` is pure `#ffffff`,
thus an unresolved foreground is fully invisible and not merely wrong.

**A character-frame assertion cannot prove legibility.** `captureCharFrame()` plus
`toContain(…)` proves that a glyph was emitted. A frame carries no color, thus an
invisible span satisfies it identically to a correct one. A claim that a surface is
*visible* must assert on the span color. `captureSpans()` exposes the resolved `fg`
of each span (`theme_contrast.render.test.tsx`, `diff_contrast.render.test.tsx`).

Relatedly, **give a fixture distinct values for the fields that a frame assertion
could confuse**. `openable_card_block.render.test.tsx` asserts
`toContain("Volcano plot")` against a fixture where that string is both the card
title and the row name. Thus the assertion passed on the row, while the title
rendered unpainted.

### Glyphs

Each non-ASCII glyph that the TUI prints comes from `GLYPHS` in
`src/lib/design_system.ts`, exactly as each color goes through `theme`. **Never
inline a glyph literal in `src/tui/`.** A key is named by shape, because one glyph
serves many roles. There is no emoji and there is no Nerd-Font glyph, because they
break the fixed-width gutter. The exempt items are the ASCII `>` and `<` markers,
and an em dash in prose.

### Time rendering

Match the readout to the permanence of the record. A durable, referenced record
renders an absolute local timestamp through `toLocaleString()`. Examples are the
detail dialogs for a profile or a run, a record listing, and the completed-profile
rail line. A live or ephemeral fixed-width readout renders a compact relative age
through `Date.relativeAge`. Examples are a sidebar session age, a run age, and an
elapsed indicator. A duration renders through `Date.formatDuration` — one
vocabulary, and never a hand-rolled `ms`, `s`, or `m` formatter at the call site.

### Text emphasis

The "Type and emphasis" scale is one typeface and one size, with the hierarchy from
the weight, the dim, and the color. It is exposed as composable inline **JSX
components** in `src/tui/components/emphasis.tsx`.

**In `src/tui/`, reach for those components — `<Bold>`, `<Italic>`, `<Underline>`,
`<Dim>`, `<Reverse>`, `<Fg role={…}>`. Never hand-compose the `t`, `bold`, `dim`,
`italic`, `underline`, `reverse`, `fg`, and `bg` primitives of opentui at the call
site.** Each component emits an inline span, thus they nest inside a `<text>` and
sit beside each other freely. `emphasis.tsx` is the ONE place where the low-level
opentui styling can live. It is also the one place for the `style={{…}}` span
escape hatch that the styling wants.

**Emphasis to component** (one source: this table):

| component | use for |
|-----------|---------|
| `<Bold>` | names, active items |
| _(plain text)_ | body / assistant text — no component needed |
| `<Dim>` | meta, labels, hints — but prefer `<Fg role="fgMuted">`; the terminal DIM attribute renders unreliably |
| `<Italic>` | reasoning / quoted — the bit IS emitted, but renders only on italic-capable terminals (`tmux` / macOS Terminal.app often show it plain), so ALWAYS wrap in a muted `<Fg>` too so the meaning survives |
| `<Underline>` | links / paths |
| `<Reverse>` | selection / cursor row (inverse video) |
| `<Fg role={…}>` | apply a color — `role` is a `ThemeColors` key, NEVER a hex. The only way to color inline text |

**Only `<Fg>` and `<Reverse>` resolve a color. The others carry none.** `<Bold>`,
`<Italic>`, `<Underline>`, and `<Dim>` emit an attribute-only span (`<b>`, `<i>`,
`<u>`, `{ dim: true }`), and they inherit whatever an ancestor resolved. Thus none
of them can be the outermost colored element.

This is the mechanism behind the italic and dim guidance above.
`<Fg role="fgMuted"><Italic>…</Italic></Fg>` is necessary for two reasons. The
meaning must survive a terminal that drops the ITALIC bit. Also, the text has no color at all without
the `<Fg>`, or without an `fg` on the enclosing `<text>`. It then falls through to
the white default of opentui (refer to [Colors](#colors)). `<Reverse>`
is self-sufficient, because it paints both the `fg` and the `bg` itself.

**How to compose:** nest to combine —
`<Fg role="fgMuted"><Italic>{text}</Italic></Fg>`. For a single whole-line color,
`<text fg={theme().role}>…</text>` is still correct. Do not wrap one line in
`<Fg>`. Reach for the components when a line **mixes** colors or styles.

**Never** nest a block `<text>` inside a `<text>`. The runtime rejects it as a
text-node child. The emphasis components prevent this, because they emit spans. If
you want new raw inline styling, add it to `emphasis.tsx`, with the `style={{…}}`
channel documented there. Never add it at the call site.

## CLI reference docs

`bun run docs:gen` (`scripts/gen_docs.ts`) walks the commander registry. It emits
the publishable CLI reference package to `dist-docs/` (untracked): SSG-neutral
CommonMark pages plus `manifest.json`. The contract is in the
`cli-reference-docs` spec. The release workflow generates the package again at the
tagged commit, and it attaches it to the GitHub release as `cli-docs.tar.gz`, which
the website consumes. The invariants are:

- **Never run the generator under `bun test`.** The registry imports `lib/env.ts`,
  whose data-loss guard throws in a test process that has no sandbox marker. Run it
  as a plain `bun scripts/gen_docs.ts`. CI invokes it as a subprocess.
- **A dev-channel command is excluded by design.** The generator bakes a production
  build channel before it imports the registry. Thus the docs describe exactly the
  surface of the release binary.
- **Each visible command, argument, and option wants a description.** The
  generation, and the lint CI job that runs it, fails without one. Declare a
  positional through `.argument(name, description)`, never inline in the command
  string.

## References

- [`CONTEXT.md`](./CONTEXT.md) — the cli domain map.
- [`openspec/specs/`](./openspec/specs/) — the feature specs, and the source of
  truth for the decisions of cli.
- [`openspec/changes/`](./openspec/changes/) — the active and archived change
  proposals, and the decision log of cli. There is no `docs/adr`.
- [`docs/`](./docs/) — supplementary developer notes: audits and dev guides.
- [`HORRIBLE_BUG_FIXES.md`](./HORRIBLE_BUG_FIXES.md) — the postmortems. Read the
  applicable entry before you work in the same area.
