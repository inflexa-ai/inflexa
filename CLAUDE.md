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

- Explain `WHY` in comments, not `HOW`.
- **Don't extract single-caller helpers or sub-components into separate files.** Keep them in the same file as their caller. A new file is justified only when multiple callers exist — that's when a real reusable pattern emerges.

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
- `src/cli/` — the cac command **registry** (`index.ts`) + help formatting, nothing else. Each command lazy-imports its action: text commands from their module (e.g. `import("../modules/auth/login.ts")`), TUI screens from `tui/` (e.g. `import("../tui/launch.tsx")`).
- `src/modules/<domain>/` — feature slices (see [Modules](#modules)): **headless** domain logic + the text command actions that drive them. Interactive views are NOT here (see `tui/`). Today: `auth/` (Auth0 device flow + `login`/`logout`/`whoami`), `proxy/` (CLIProxyAPI lifecycle + `setup`), `session/` (chat backend + `sessions` command), `anchor/` (folder-identity markers + lazy path reconciliation).
- `src/db/` — shared SQLite layer: `primary.ts` (connection), `primary_migrations.ts`, `primary_query.ts`, `primary_mutation.ts`, `errors.ts`, `util.ts`. Queries/mutations stay here (verb-split, beside the migrations); a module imports the functions it needs.
- `src/tui/` — the **presentation layer / app shell**: the entry app plus shared, app-level, or reusable Solid/opentui code. Today: `app.tsx` (the root chat screen, launched by every command that opens a chat), `launch.tsx` (`launchTui`), `config.tsx` (settings — an app-level screen), `theme.ts` (the reactive accessor — the id list + palette data live in `lib/themes.ts`). Presentation sits *above* the logic modules: it may import module logic (view → logic); modules must never import `tui/`. **Where a view lives** mirrors Lumen's `components/` vs `modules/<m>/components/` split — shared / app-shell / app-level screens go here; a view owned by exactly one feature co-locates in that module. `config.tsx` is an app-level exception that lives here — not a license to put every view in `tui/`. Kept flat while the surface is small; add `tui/<domain>/` (or module-side view folders) when a screen outgrows one file or shared widgets emerge.
- `src/lib/` — non-domain infrastructure: `env.ts` (sole `process.env` reader), `config.ts` (user config file), `bus.ts` (event bus), `log.ts` (pino), `otel.ts`, `shutdown.ts`, `themes.ts`.
- `src/extensions/` — global runtime extensions (see below)
- `src/types/` — shared domain model, grouped by domain: persisted entity shapes (`session.ts`, `anchor.ts`, …) and the event contract (`events.ts`). These are shared, not module-local, because the `db/` layer references every entity shape and `lib/bus.ts` references the events — homing them in a module would invert the infra→feature dependency.

## Modules

A module under `src/modules/<domain>/` groups everything about one domain: its logic, its CLI command action(s), and its logic-local types. There is **no mandated file layout** — add files as the domain needs them, not preemptively (named exports only, no barrels, per [Naming conventions](#naming-conventions)).

- **Public surface.** Whatever other layers import is the module's API; import it directly from the owning file (e.g. `ensureProxyReady` from `modules/proxy/setup.ts`). No barrel/index re-exports.
- **Dependency direction.** Modules import shared infra (`lib/`, `db/`, `src/types/`, `extensions/`) and **other modules, acyclically** (e.g. `session` → `proxy`; a future `analysis` → `anchor`). They must **not** import `tui/` — presentation depends on logic, never the reverse. Infrastructure (`lib/`, `db/`) must **never** import a module. If two modules need the same code, lift it to a shared layer.

## Global extensions

`src/extensions/*.ext.ts` augment built-in globals with small, broadly-useful methods (`Promise.sleep`, `JSON.parseWith`) so call sites don't each redeclare a one-line helper. Each file:

- Declares the method on the relevant global interface via `declare global { interface PromiseConstructor { … } }` (use `PromiseConstructor`/`JSON`/etc. for statics, the instance interface for prototype methods), assigns the implementation, and ends with `export {}` to stay a module.
- Is registered by adding one side-effect import to `src/extensions/index.ts` — the central loader, imported once from `src/index.ts` before `cli.parse()`. That loader is side-effect-only (not a re-export barrel, so it doesn't violate the no-barrel rule). Anything depending on an extension must run after the entry point loads it (all CLI commands do, since they lazy-import after startup).

Reach for an extension only when a helper is genuinely cross-cutting; keep single-caller helpers in their owning file per the Coding rules.

## Solid + opentui (TUI)

The TUI is Solid (`solid-js`) rendered to the terminal via `@opentui/solid`. Solid is not React: components run once, reactivity lives in signals/stores, and there are no re-renders.

### Launch and exit

- Each TUI screen lives in `src/tui/` as its component plus a `launch*` function — co-located in one file (like `config.tsx`), or split into a `launch.tsx` beside a large component (like the chat `app.tsx`). `launch*` resolves its data (session lookup/creation) first, then calls `void render(...)` with `exitOnCtrlC: false`, `targetFps: 30`, `screenMode: "alternate-screen"`.
- **Always `renderer.destroy()` before `shutdown(0)`.** `destroy()` restores the terminal (mouse tracking, alternate screen, cooked mode) — `process.exit()` alone skips OpenTUI's cleanup and leaves the shell broken.
- `exitOnCtrlC` is false, so every TUI app must handle its own quit keys via `useKeyboard`.

### Reactivity

- Never destructure `props` — access `props.x` at use sites or reactivity is lost.
- `createSignal` for scalars; `createStore` + `produce` for lists and nested data (e.g. messages).
- Streaming deltas accumulate in a dedicated signal (`streamText`/`streamPartId` in `app.tsx`) and flush into the store only when the part completes — never write every delta into the store.
- Control flow with `<For>`/`<Show>`, never `.map()` in JSX.
- Renderable refs: `let ref: SomeRenderable | null = null` + a ref callback. Focus via `queueMicrotask(() => r.focus())` — the renderable isn't ready synchronously.

### Event bus

- UI state updates flow from `Bus` events: subscribe in component setup with `Bus.on("inf", handler)` and always pair with `onCleanup(() => Bus.off("inf", handler))`.
- Handlers must filter events by `sessionId` before applying them.

### Colors

All colors come from `theme` in `src/tui/theme.ts` — the Tokyo Night palette mapped to semantic roles (`bg`, `fg`, `muted`, `accent`, `user`, `assistant`, `success`, `warn`, `error`, …). **Never inline hex in components.**
