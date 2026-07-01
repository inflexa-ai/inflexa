## Formatting

**After editing source files in `src/`, run `bun run format:file <paths>` on the specific files you changed before reporting the task as complete.** Only format files inside `src/` — never format markdown, config, or spec files. Use `bun run format` for full-project formatting.

## Postmortems

[`HORRIBLE_BUG_FIXES.md`](./HORRIBLE_BUG_FIXES.md) documents catastrophic bugs, root cause analyses, and hard-won lessons. **Read the relevant entry before working in the same area.**

## Scope: implementation only

The user owns work orchestration. Stay focused on implementation in this repo and leave coordination to them.

- Don't discuss release ordering, PR sequencing, rollout staging, deploy timing, or "signaling" other teams.
- Don't propose orchestration plans or ask coordination questions ("when should X merge?", "should we mark this consumed?", "how do we signal readiness?").
- When a handoff doc or spec describes a staged rollout, read it for technical context, then translate the relevant constraints into implementation requirements without echoing the orchestration framing back.

## Quick Start

```bash
bun install          # Install dependencies
bun run dev          # Run the CLI (launches the TUI by default)
bun run typecheck    # tsc --noEmit
bun run lint         # Run ESLint
bun run format       # Format all of src/
```

## Dependencies

**No new dependencies without explicit approval.** If a task seems to need a new package, ask first — the default is to build on what's already here.

## Coding

- **Don't extract single-caller helpers or sub-components into separate files.** Keep them in the same file as their caller. A new file is justified only when multiple callers exist — that's when a real reusable pattern emerges.

## Error handling — neverthrow first

**`Result<T, E>` from `neverthrow` is the default error channel.** Every function that can fail returns `Result` (sync) or `ResultAsync` (async). The `eslint-plugin-neverthrow` `must-use-result` rule is set to `error` — an unconsumed `Result` is a build failure.

### The rule

1. **Return `Result`, don't `throw`.** A function's failure mode is part of its signature. If it can fail, the return type says so (`Result<T, SomeError>`). Callers handle both branches with `.match`, `.andThen`, `.map`, `.mapErr`, etc.
2. **`throw` requires explicit user approval.** Before writing a `throw`, get confirmation. The only pre-approved exceptions are:
   - **Exhaustive-switch defaults** — `throw new Error("unhandled: ...")` (or `never`-typed) in a `default:` branch that the compiler should make unreachable. This is a programmer bug, not a runtime failure.
   - **Top-level entry-point bail-outs** — `fail()` / `dieOn()` in `lib/cli.ts` at the CLI boundary, where the process is about to exit anyway.
   - **`throw` inside `bun:sqlite` transactions** — bun's `transaction()` API uses throw-to-rollback; the `TxAbort` pattern in `db/util.ts` bridges this into `Result`.
3. **Wrap throwing stdlib / external calls at the boundary.** When a function you don't control throws (`readFileSync`, `mkdirSync`, `writeFileSync`, `JSON.parse`, `crypto.*`, `Bun.spawn`, etc.), wrap it in a function that returns `Result`. The wrapper lives beside its callers (in `lib/` if cross-cutting, in the module if local). Existing examples: `tryQuery`/`tryMutation` in `db/util.ts`, `JSON.parseWith` in `extensions/json.ext.ts`.
4. **`try/catch` is only for bridging throws into `Result`.** A `try/catch` that doesn't produce a `Result` is a code smell — it means either the caught function should return `Result` itself, or the catch block should.

### Error types

- **Domain errors are discriminated unions** — `type FooError = { type: "x"; ... } | { type: "y"; ... }`, not `Error` subclasses. This gives exhaustive `switch` and zero prototype overhead.
- **`DbError`** (in `db/errors.ts`) is the storage-layer error. Absence is `T | null` on the `ok` channel, never an error.
- **Keep error types as narrow as the function needs.** A function that can only fail one way returns `Result<T, { type: "io_failed"; cause: unknown }>`, not `Result<T, AllErrors>`.

### Consuming Results

- **At CLI boundaries:** `result.match(v => v, dieOn("context"))` — print and exit.
- **In module logic:** `.andThen` / `.map` to chain, `.mapErr` to translate error types across layers.
- **In the TUI:** the presentation layer may `.match` to render success/error states.
- **Never `.unwrap()` or `._unsafeUnwrap()` in production code.** These defeat the purpose. If you need the value and want to crash on error, you're at a CLI boundary — use `dieOn`. **Exception:** test files (`*.test.ts`) may use `._unsafeUnwrap()` to extract values where an unexpected `Err` is itself a test failure.

### Migrating existing `throw` → `Result`

The codebase has legacy `throw`/`try-catch` sites being migrated. When touching a function that throws, convert it to return `Result` if the change is contained (the function + its direct callers). Don't leave a half-migrated state where a function both throws AND returns `Result`. Mark sites you notice but can't convert in-scope with `// TODO(slop): neverthrow`.

## Code Comments

Comment the why, not the what.

- Do NOT write comments that restate what the code already says. If a comment paraphrases the line below it, delete it. TypeScript's types and good names already document the "what"; lean on them.
- DO write comments that capture intent and reasoning: why the code works this way, what problem it solves, and what would otherwise be non-obvious to a future reader.
- Prefer making the "what" self-evident through the type system (descriptive types, unions, branded types, `readonly`, exhaustive `switch`) so prose doesn't have to carry it.

Document the decisions you made.

- Record which alternative approaches were considered and discarded, and why.
- Record which downsides or trade-offs were explicitly accepted, and why (e.g., why you reached for `any`/`as`, why you disabled a lint rule, why you chose a library).
- Every `// eslint-disable`, `@ts-expect-error`, `@ts-ignore`, or type assertion (`as X`, `!`) should carry a comment explaining why it is safe and necessary — these are the TS equivalent of escape hatches and must never be silent.

Document what is NOT there.

- Flag shortcuts and unhandled cases explicitly rather than leaving them silent. Use `err({ type: "not_implemented" })` when the function returns `Result`, or `throw new Error("not implemented")` only in exhaustive-switch defaults and pre-approved boundary sites (see [Error handling](#error-handling--neverthrow-first)), instead of a stub that returns a fake value.
- In exhaustive `switch`/discriminated-union handling, use a `never`-typed default branch so the compiler flags any case you forgot — this documents "everything is handled" and breaks the build when it stops being true.
- Note future optimization opportunities and the deliberate absence of an implementation (e.g., why a method is intentionally not provided, why a type guard is omitted).

Treat comments as first-class, and write them early.

- Comments are among the most important code you write; treat them with the same care as the logic.
- Consider writing the comment/contract before the implementation — sketch the intended behavior, inputs, and invariants in prose (or a JSDoc block) first, then fill in the code beneath it.

Comment the surprising, the unsafe, and the load-bearing.

- Clearly comment anything a reader would find unexpected: reliance on external or global state, mutation of shared objects, ordering or timing requirements (async sequencing, microtask vs. macrotask), subtle invariants, or a non-obvious algorithm choice.
- The TypeScript analogue of "unsafe" is anywhere you defeat the type checker: `as`/`as unknown as`, non-null assertions (`!`), `any`, `@ts-expect-error`, type predicates (`x is T`), and unchecked casts of external data (JSON, API responses). Each such site needs a comment stating exactly which invariant the surrounding code upholds to make it sound (e.g., "validated by the zod schema above", "guaranteed non-null because we just `.set()` it").

**Comments are not changelogs.** Never write change-history phrasing like "Bumped from X to Y", "Refactored to W", "Now does Z", "Renamed from V", "Extracted from U", "Previously did A". Git tracks history; comments describe the static rationale as a fresh reader will encounter it tomorrow. If a value is unusual, justify the value — not the diff.

### Identifiers

**Mint ids inline with `randomUUIDv7()` (`import { randomUUIDv7 } from "bun"`).** It is the single id scheme for everything — DB row ids, the write-once anchor marker, event ids. It is time-sortable (the role `ulid` used to fill), in-runtime (zero-dependency), and the only v7 source available: Node's `crypto` mints v4 only. **Never wrap id generation in a helper** like `newId()`/`newFooUuid()` — a function whose whole body is `return randomUUIDv7()` is pointless ceremony; write `randomUUIDv7()` at the call site. Don't reach for `ulid` or `crypto.randomUUID()`.

### TODO conventions

Format: `// TODO(<tag>): <reason>`. Never use a bare `// TODO`.

| Tag | Purpose | Example |
|-----|---------|---------|
| `extend` | Hidden/omitted feature to revisit when capabilities expand | Command flag stubbed out until the real backend lands |
| `perf` | Acceptable today, optimize at scale | `O(n)` scan that should be indexed |
| `slop` | Works but should be extracted / cleaned up | Duplicated logic across two modules |
| `robustness` | Missing hardening for stress conditions | No retry/backoff on a flaky external call |

### Local state can desync from the database — never hard-fail on it

The SQLite database is a file on the **user's own machine**: they may delete it, restore an old copy, or hand-edit it at will, and they are entitled to. Meanwhile other state lives **outside** it and persists independently — on-disk anchor markers (`.inflexa/id`), output folders, config. So the two stores routinely disagree: a marker (or a row's foreign key) can reference an id the database no longer has.

**Treat "the referenced row is gone" as a normal, recoverable condition — never a hard error.** When code reads an id/marker/path from one store and looks it up in another, a miss must **heal** (reconstruct from the authoritative source — e.g. re-establish an anchor row from its on-disk marker, but only on a *deliberate* action, never a passive read — see the no-litter policy) or **degrade gracefully** (resolve to `null`/a sensible fallback and carry on), so the user still gets a working command. Returning a `query_failed`/`DbError` for a routine desync is a bug: it turns "your DB and your folders disagree" into a crash the user can't escape without surgery.

Concretely: a lookup that can legitimately miss returns `T | null` (the miss is in-band), not an error; the caller picks a fallback. Reserve the error channel for genuine faults (the query itself failed). See `resolveAnchor` (`modules/anchor/anchor.ts`): a marker pointing at a deleted anchor resolves to `null`, and bare `inflexa` then offers to start fresh in that folder rather than dying with `unknown anchor <id>`.

### Resolving an id-or-name reference

When a command resolves a user-supplied reference that may be **either an id or a human name/slug** (`inflexa resume <x>`, `--analysis <x>`, …):

- **Type the parameter `IdOrName`** (from `lib/types.ts`), never a bare `string` — the alias makes "resolve this by id OR name" legible at the call site.
- **Resolve it in a SINGLE query, id-first** — never fetch-by-id then fall back to fetch-by-name, and never load all rows to `.find`/`.filter` in JS. Put the priority in SQL:

  ```sql
  -- one match (LIMIT 1):
  WHERE id = $ref OR name = $ref ORDER BY (id = $ref) DESC LIMIT 1
  -- candidate set, when the caller must detect name collisions (ambiguity):
  WHERE id = $ref OR slug = $ref OR name = $ref ORDER BY (id = $ref) DESC, created_at DESC
  ```

  `(id = $ref)` sorts the exact-id hit first (ids are unique, so it is THE match); the named `$ref` param binds once. The caller takes `[0]`; "more than one row, none by id" means an ambiguous name/slug. The resolver lives in `db/primary_query.ts` (e.g. `findAnalysesByRef`/`findProjectByRef`).

- **Wrap the resolver in a module `findX`/`matchX` only when the wrapper adds logic.** `matchAnalysis` earns its place — it reshapes the candidate set into `{ analysis, others }` to surface name collisions. When the resolver already returns the single answer (because the lookup column is `UNIQUE`, like `projects.name`), call it directly: a `findProject` whose whole body is `return findProjectByRef(ref)` is pointless ceremony — delete it and let callers import `findProjectByRef`. Same for a one-line write wrapper like `setProject` over `updateAnalysisProject`.

This generalizes: **prefer one query over a read-then-decide round-trip whenever SQL can express the decision** — e.g. a targeted `UPDATE … SET col = ? WHERE id = ?` (rows-changed signals not-found) over read-the-row-then-rewrite-every-column.

### Column & field ordering

Order columns, type fields, and the parameters/bound-args of functions that carry them in three groups, **always in this order**:

1. **Identity** — `id`, `created_at`, `updated_at`, colocated at the top. These three are the row's full identity; keep them together even though the timestamps are rarely read beside `id`. A table/type without timestamps has just `id`; a non-entity (e.g. the `analysis_inputs` reference rows) has no identity group at all.
2. **Core data** — the fields the row is actually about (`name`, `slug`, `path`, `is_dir`, `data`, …).
3. **Foreign keys** — every `*_id`/`*Id` reference, last (`anchor_id`, `project_id`, `session_id`, …).

This governs `CREATE TABLE` columns, the `COLS` constant + row type + `fromRow` in `db/`, `INSERT`/`UPDATE` column lists **and their bound params**, the persisted entity types in `src/types/`, and the parameter lists of functions that pass these fields through. An `UPDATE … SET` omits `id` (it's the `WHERE`) but still leads with `updated_at`, then core, then FKs. Declare tables parent-before-child so every FK is a backward reference.

JSON-blob tables (`sessions`/`messages`/`parts`) follow it at the **column** level — `id, data, <fk>` — but the blob's interior shape is application data, not columns, so it keeps its own narrative order.

## TypeScript

- Prefer `type` over `interface`, `const` over `let`, `function` over arrow functions.
- Always type function parameters and return values (except JSX returns).
- Comment every `any`/`unknown` usage.
- **Use domain types, never raw `string` for known value sets.** Shared domain types — persisted entity shapes (`session.ts`, `anchor.ts`, …) and the event contract (`events.ts`) — live in `src/types/`, grouped by domain. Everything else (command options, error unions, wire schemas) co-locates with its owning code. See [Project structure](#project-structure) for why the entity shapes are shared rather than module-local.
- **Document every exported declaration — types, their properties, and functions — with JSDoc (`/** … */`) blocks, never `//` line comments** — JSDoc is the only form the LSP surfaces on hover and completion, so a `//` above a function is invisible at the call site where you read it. Reserve `//` for inline implementation notes (the WHY) inside a body. Place the block on the line above what it describes.

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

- **Files:** lowercase; snake_case for multi-word names (`primary_query.ts`).
- **Named exports only.** No default exports, no barrel files, no re-exports. Use inline `export` on declarations.
- When moving code, update ALL importers to the new location. Never add shims.

## Project structure

Code is grouped **by feature (vertical slice)**, not by technical layer: a feature owns its logic, its CLI command action(s), and its logic-local types under `src/modules/<domain>/`. Shared infrastructure with no single owner stays in the layer directories.

- `src/index.ts` — entry point: telemetry/log wiring, shutdown hooks, then `cli.parse()`
- `src/cli/` — the cac command **registry** (`index.ts`) + help formatting, nothing else. Each command lazy-imports its action: text commands from their module (e.g. `import("../modules/auth/login.ts")`), TUI screens from `tui/` (e.g. `import("../tui/app.launch.tsx")`).
- `src/modules/<domain>/` — feature slices (see [Modules](#modules)): **headless** domain logic + the text command actions that drive them. Interactive views are NOT here (see `tui/`). Today: `auth/` (Auth0 device flow + `login`/`logout`/`whoami`), `proxy/` (CLIProxyAPI lifecycle + `setup`), `intelligence/` (model-interaction chat engine + `sessions` command), `anchor/` (folder-identity markers + lazy path reconciliation).
- `src/db/` — shared SQLite layer: `primary.ts` (connection), `primary_migrations.ts`, `primary_query.ts`, `primary_mutation.ts`, `errors.ts`, `util.ts`. Queries/mutations stay here (verb-split, beside the migrations); a module imports the functions it needs.
- `src/tui/` — the **presentation layer / app shell**: the entry app plus shared, app-level, or reusable Solid/opentui code. Today: `app.tsx` (the root chat screen, launched by every command that opens a chat), `app.launch.tsx` (`launchTui`), `command_palette.tsx` / `commands.tsx` (the palette adapter + command registry), `app_config.tsx` (settings — an app-level screen), `theme.ts` (the reactive accessor — the id list + palette data live in `lib/design_system.ts`; also home to the shared `Notice` type + `noticeColor` mapping, since a notice kind maps onto a palette role), and `components/` (shared, domain-agnostic widgets — see below). Presentation sits *above* the logic modules: it may import module logic (view → logic); modules must never import `tui/`. **Where a view lives** mirrors Lumen's `components/` vs `modules/<m>/components/` split — shared / app-shell / app-level screens go here; a view owned by exactly one feature co-locates in that module. `app_config.tsx` is an app-level exception that lives here — not a license to put every view in `tui/`. Add `tui/<domain>/` (or module-side view folders) when a screen outgrows one file.
  - `src/tui/components/` — shared TUI widgets. A widget belongs here **iff** it (a) imports only `theme` + opentui/solid (no `modules/`, `db/`, or other domain imports) and (b) has ≥2 callers; one component per file, no barrels. A feature-coupled adapter (e.g. `CommandPalette`, which maps `Command` objects) stays in the `tui/` app-shell, not here. Today: `dialog/` (the dialog subsystem — see below), `select_list.tsx` (`SelectList` — the fuzzy-filtered grouped picker), `text_area.tsx` (`TextArea` — themed textarea with chrome tiers and mode tracking), `text_input.tsx` (`TextInput` — themed single-line input with per-keystroke callback).
  - `src/tui/components/dialog/` — the dialog subsystem: the chrome shell, host/overlay, and reusable content dialogs. `dialog_panel.tsx` (the bordered-panel + accent-title + optional muted-footer + size-preset chrome that every dialog composes), `dialog_host.tsx` (module-level dialog stack + `dialogPush`/`dialogClose`/`useDialog()` API + `DialogOverlay` with focus save/restore and click-outside-to-dismiss), `alert_dialog.tsx` (`AlertDialog`), `confirm_dialog.tsx` (`ConfirmDialog`), `export_options_dialog.tsx` (`ExportOptionsDialog`), `prompt_dialog.tsx` (`PromptDialog` — text prompt with configurable height, optional busy state), `results_dialog.tsx` (`ResultsDialog` — scrollable read-only line list).
  - `src/tui/layout/` — the chat app-shell **composition kit**: a full-width status bar atop a main row of (stream + input) beside a toggleable, full-height **sidebar**. Files: `status_bar.tsx`, `message_block.tsx`, `chat_bar.tsx`, `sidebar.tsx` (the gutter marker set lives in `lib/design_system.ts`, not here). Distinguished from `components/` by **role** (shell composition vs reusable widget), it is a deliberate, scoped exception to the single-caller rule — a kit part MAY be single-caller and MAY import domain types/queries, and stays here even when generic + multi-caller (e.g. `StatusBar`, shared by `app.tsx` + `app_config.tsx`). Chat status lives in the reactive `src/tui/hooks/status.ts` store (the `theme.ts` pattern) — the app only renders it.
  - `src/tui/keymap.ts` — the **keybinding engine**: bindings are DATA dispatched centrally — NEVER write a raw `useKeyboard` or `key.name === …` branch in a component. A component declares a reactive layer with `useBindings(() => ({ enabled?, mode?, target?, priority?, bindings }))`; exactly one `useKeymapRoot()` per renderer (chat `App`; standalone `ConfigApp` only when not embedded) installs the single `useKeyboard` that routes each keystroke to the winning binding. **Modal capture** is the mode stack: an open dialog `pushMode(MODE_MODAL)` (App's effect) suspends every `MODE_BASE` layer at once — no per-binding `if (dialogOpen)`. **Leader + chord sequences**: `leaderSeq("n")` / a `<leader>` spec build timed multi-stroke bindings (escape aborts a half-typed chord, backspace pops one stroke, comma = alternatives); the `WhichKey` overlay (`layout/which_key.tsx`) lists `reachableKeys()` live, free-documented from each binding's `desc`/`group`. **Focus `target`** gates a layer to when a renderable (or descendant) is focused — the fine-grained complement to `mode`. The chord is the single source: display labels are DERIVED (`chordLabel`), never hand-kept beside the chord. App-level keys are remappable via `config.keybinds` (command id → key string, e.g. `app.command-palette`); structural dialog keys come from the shared `KEYS`. Only the root handler + focus check touch opentui — the matcher (`matchChord`) stays structural. **Labels ALWAYS lowercase** (`ctrl+k`, `esc`); chords use **Ctrl, never Alt** (terminals deliver Alt/Option unreliably — macOS composes Option into a character) and never Cmd (not forwarded). Textarea submit/newline stay renderable-level (`text_area.tsx`, cursor-aware), sourced from `SUBMIT_CHORD`/`NEWLINE_CHORD`.
- `src/lib/` — non-domain infrastructure: `env.ts` (sole `process.env` reader), `config.ts` (user config file), `bus.ts` (event bus), `log.ts` (pino), `otel.ts`, `shutdown.ts`, `design_system.ts` (the single merged source for the TUI's visual primitives — `GLYPHS`, the theme registry + `ThemeColors`, the layout `tokens` (`space`/`size`/`stroke`), the `zIndex` stacking ladder, and the gutter `MARKERS`; the reactive accessor over the theme data is `tui/theme.ts`, and any JSX/signal design helper lives in `tui/components/`. See [Glyphs](#glyphs)).
- `src/extensions/` — global runtime extensions (see below)
- `src/types/` — shared domain model, grouped by domain: persisted entity shapes (`session.ts`, `anchor.ts`, …) and the event contract (`events.ts`). These are shared, not module-local, because the `db/` layer references every entity shape and `lib/bus.ts` references the events — homing them in a module would invert the infra→feature dependency.

## Modules

A module under `src/modules/<domain>/` groups everything about one domain: its logic, its CLI command action(s), and its logic-local types. There is **no mandated file layout** — add files as the domain needs them, not preemptively (named exports only, no barrels, per [Naming conventions](#naming-conventions)).

- **Public surface.** Whatever other layers import is the module's API; import it directly from the owning file (e.g. `ensureProxyReady` from `modules/proxy/setup.ts`). No barrel/index re-exports.
- **Dependency direction.** Modules import shared infra (`lib/`, `db/`, `src/types/`, `extensions/`) and **other modules, acyclically** (e.g. `intelligence` → `proxy`; a future `analysis` → `anchor`). They must **not** import `tui/` — presentation depends on logic, never the reverse. Infrastructure (`lib/`, `db/`) must **never** import a module. If two modules need the same code, lift it to a shared layer.

## Global extensions

`src/extensions/*.ext.ts` augment built-in globals with small, broadly-useful methods (`Promise.sleep`, `JSON.parseWith`) so call sites don't each redeclare a one-line helper. Each file:

- Declares the method on the relevant global interface via `declare global { interface PromiseConstructor { … } }` (use `PromiseConstructor`/`JSON`/etc. for statics, the instance interface for prototype methods), assigns the implementation, and ends with `export {}` to stay a module.
- Is registered by adding one side-effect import to `src/extensions/index.ts` — the central loader, imported once from `src/index.ts` before `cli.parse()`. That loader is side-effect-only (not a re-export barrel, so it doesn't violate the no-barrel rule). Anything depending on an extension must run after the entry point loads it (all CLI commands do, since they lazy-import after startup).

Reach for an extension only when a helper is genuinely cross-cutting; keep single-caller helpers in their owning file per the Coding rules.

## Event bus — single bus, typed events

There is **one bus** (`Bus` in `src/lib/bus.ts`), shared by every domain — session, provenance, and any future concern. Domain separation is by event `type` string, not by bus instance. **Never add a second bus** to separate concerns; if the current event contract feels wrong, the fix is better types, not more buses.

- **One event type per domain action.** Each `BusEvent` member carries exactly the fields its action needs. Never pack multiple sub-actions into a single event discriminated by an interior field with nullable companions — that defeats TypeScript's narrowing and forces consumers to guard against impossible states. E.g. provenance has `prov.analysis_created`, `prov.input_added`, `prov.input_removed` — not one `prov.recorded` with a nullable `input`.
- **Event types live in `src/types/events.ts`** — the `BusEvent` discriminated union is the contract. Session-scoped events carry `sessionId`; analysis-scoped events carry `analysisId`. Consumers filter by `type`.
- **Design rationale:** a dedicated bus per domain only earns its keep when that domain needs its own subscriber lifecycle, backpressure, or error isolation. inflexa's bus is a fire-and-forget notification channel with one subscriber per concern — multiplying buses adds wiring overhead for no structural gain. (Validated against OpenCode, which routes ~80+ event types across all domains through a single typed bus.)

## Solid + opentui (TUI)

The TUI is Solid (`solid-js`) rendered to the terminal via `@opentui/solid`. Solid is not React: components run once, reactivity lives in signals/stores, and there are no re-renders.

### Design gallery

**Before writing or changing TUI code, consult the design gallery** (`src/tui/layout/design_gallery.tsx`, opened via the "Design gallery" command-palette entry) — the read-only showcase of every existing block/widget and its states. Reuse what it shows; match its patterns.

**If a task needs something the gallery doesn't cover** (a new block, state, or visual pattern), STOP and talk to the user about adding it to the design system / extending the gallery — don't invent ad-hoc UI off to the side. New surfaces become part of the gallery so it stays the single source of truth.

### Launch and exit

- Each TUI screen lives in `src/tui/` as its component plus a `launch*` function — co-located in one file (like `app_config.tsx`), or split into a `app.launch.tsx` beside a large component (like the chat `app.tsx`). `launch*` resolves its data (session lookup/creation) first, then calls `void render(...)` with `exitOnCtrlC: false`, `targetFps: 30`, `screenMode: "alternate-screen"`.
- **Always `renderer.destroy()` before `shutdown(0)`.** `destroy()` restores the terminal (mouse tracking, alternate screen, cooked mode) — `process.exit()` alone skips OpenTUI's cleanup and leaves the shell broken.
- `exitOnCtrlC` is false, so every TUI app must handle its own quit keys via `useKeyboard`.

### Reactivity

- Never destructure `props` — access `props.x` at use sites or reactivity is lost.
- **`props` as a signal's initial value — `solid/reactivity` will warn; decide seed-once vs stay-in-sync.** Reading `props.x` at component-body top level (e.g. `createSignal(props.x)`) reads it once and drops the reactive link, which the lint rule flags. Two legitimate intents:
  - **Seed-once** (the value is locally-owned mutable state, the prop is just the initial seed): keep `createSignal(props.x)` and add a scoped `eslint-disable solid/reactivity` with a `--` reason stating *why* a one-time read is safe (e.g. the component mounts once with fixed props). This is the common case in our single-mount screens (`app.tsx`'s `currentSessionId`/`currentWorkingDir`/`currentAnalysis` are seeded from `App`'s props, then mutated by the palette). Type the signal explicitly when the prop's type should be pinned (`createSignal<Analysis>(props.analysis)`).
  - **Stay-in-sync** (the signal must follow later prop changes): seed it, then `createEffect(() => setX(props.x))`.
  - Do NOT "fix" the warning by destructuring (forbidden above) or by storing a thunk (`createSignal(() => props.x)` stores a function, not the value). When a whole file's warnings are the same false positive — e.g. reads of a stable `ctx` prop inside opentui `onSelect`/`onSubmit` handlers the rule doesn't recognize (`commands.tsx`) — a file-level `eslint-disable solid/reactivity` with a `--` reason is cleaner than scattering per-line disables.
- `createSignal` for scalars; `createStore` + `produce` for lists and nested data (e.g. messages).
- Streaming deltas accumulate in a dedicated signal (`streamText`/`streamPartId` in `app.tsx`) and flush into the store only when the part completes — never write every delta into the store.
- Control flow with `<For>`/`<Show>`, never `.map()` in JSX.
- Renderable refs: `let ref: SomeRenderable | null = null` + a ref callback. Focus via `queueMicrotask(() => r.focus())` — the renderable isn't ready synchronously.

### Layout (flex) — opentui is NOT web CSS

Two opentui-specific facts, both verified against the engine source and reproduced with the headless `testRender`/`captureCharFrame` harness (see "Verifying layout" below). When a layout overlaps, instrument it — do **not** reason by analogy to CSS.

**1. `flexShrink` is derived from the dimensions.** A child with a non-numeric size (`"100%"`, `"auto"`, unset) defaults to `flexShrink: 1`; a numeric size → `0`. So a `width="100%"` box (e.g. the whole input bar) shrinks by default, and on a short terminal it collapses below its own border. Essential chrome that must keep its rows needs an explicit `flexShrink={0}` (see `chat_bar.tsx`), letting the scroll region (`flexGrow` + `minHeight={0}`, as in `app.tsx`/`chat.tsx`) absorb the squeeze instead.

**2. A `flexGrow` scrollbox overlaps its next flex sibling by one cell.** In a column, opentui's yoga layout gives a `flexGrow={1}` scrollbox a rendered height **one greater** than the height it contributes to the column flow — yoga places the following sibling at `scrollbox.y + height − 1`, *inside* the scrollbox's last row. The scroll content then bleeds onto whatever sits directly below (a footer hint, a detail line). This is **not** fixable with `minHeight`/`flexShrink`/`overflow`/wrapping/integer panel sizes — all were tried and reproduced the overlap; it is a yoga/scrollbox quirk, present at most panel heights, that only becomes *visible* when that row carries content.

The remedy: **any fixed chrome row placed directly below a `flexGrow` scrollbox must be a full-width box painted with the panel background** (`<box width="100%" flexShrink={0} backgroundColor={…}><text/></box>`), so it opaquely reclaims its whole row. A bare `<text>` is not enough — it paints only its own glyphs, leaving the bled content showing through the gaps. Live sites: `dialog/dialog_panel.tsx` (footer), `select_list.tsx` (detail line).

**Verifying layout.** `@opentui/solid`'s `testRender` + `captureCharFrame()` renders any component tree to a text frame at a fixed `{width, height}` with no TTY; `mockInput.pressKeys` drives scrolling, and a renderable's `.x/.y/.width/.height` + `yogaNode.getComputedLayout()` expose the computed boxes. Sweep a range of heights — these bugs are size-dependent and a single size hides them.

### Event bus (TUI consumption)

The bus contract and design rationale live in [Event bus — single bus, typed events](#event-bus--single-bus-typed-events) above. TUI-specific rules:

- Subscribe in component setup with `Bus.on("inflexa", handler)` and always pair with `onCleanup(() => Bus.off("inflexa", handler))`.
- Handlers must filter events by `sessionId` before applying them (provenance events carry `analysisId` and should be ignored).

### Colors

All colors come from `theme` in `src/tui/theme.ts` — the Tokyo Night palette mapped to semantic roles (`bg`, `fg`, `muted`, `accent`, `user`, `assistant`, `success`, `warn`, `error`, …). **Never inline hex in components.**

### Glyphs

Every non-ASCII glyph the TUI prints comes from `GLYPHS` in `src/lib/design_system.ts`, just as colors go through `theme`. **Never inline a glyph literal in `src/tui/`.** Keys are named by shape (one glyph serves many roles). No emoji or Nerd-Font glyphs — they break the fixed-width gutter. Exempt: ASCII `>`/`<` markers and prose em dashes.

### Text emphasis

The "Type & emphasis" scale (one typeface, one size; hierarchy by weight, dim, color) is exposed as composable inline **JSX components** in `src/tui/components/emphasis.tsx`. **In `src/tui/`, reach for those components — `<Bold>`, `<Italic>`, `<Underline>`, `<Dim>`, `<Reverse>`, `<Fg role={…}>` — never hand-compose opentui's `t`/`bold`/`dim`/`italic`/`underline`/`reverse`/`fg`/`bg` primitives at the call site.** Each emits an inline span, so they nest inside a `<text>` and sit beside each other freely. `emphasis.tsx` is the ONE place the low-level opentui styling (and the `style={{…}}` span escape hatch it requires) is allowed to live.

**Emphasis → component** (one source: this table):

| component | use for |
|-----------|---------|
| `<Bold>` | names, active items |
| _(plain text)_ | body / assistant text — no component needed |
| `<Dim>` | meta, labels, hints — but prefer `<Fg role="fgMuted">`; the terminal DIM attribute renders unreliably |
| `<Italic>` | reasoning / quoted — the bit IS emitted, but renders only on italic-capable terminals (`tmux` / macOS Terminal.app often show it plain), so ALWAYS wrap in a muted `<Fg>` too so the meaning survives |
| `<Underline>` | links / paths |
| `<Reverse>` | selection / cursor row (inverse video) |
| `<Fg role={…}>` | apply a color — `role` is a `ThemeColors` key, NEVER a hex. The only way to color inline text |

**Composing:** nest to combine — `<Fg role="fgMuted"><Italic>{text}</Italic></Fg>`. For a single whole-line color, `<text fg={theme().role}>…</text>` is still fine (don't wrap one line in `<Fg>`); reach for the components when a line **mixes** colors/styles.

**Never** nest a block `<text>` inside a `<text>` (rejected as a text-node child at runtime). The emphasis components avoid this by emitting spans — if you need new raw inline styling, add it to `emphasis.tsx` (with the `style={{…}}` channel documented there), never at the call site.

## References

- [`CONTEXT.md`](./CONTEXT.md) — the cli domain map.
- [`openspec/specs/`](./openspec/specs/) — feature specs; the source of truth for cli's decisions.
- [`openspec/changes/`](./openspec/changes/) — active + archived change proposals; cli's decision log (there is no `docs/adr`).
- [`docs/`](./docs/) — supplementary developer notes (audits, dev guides).
- [`HORRIBLE_BUG_FIXES.md`](./HORRIBLE_BUG_FIXES.md) — postmortems; read the relevant entry before working the same area.
