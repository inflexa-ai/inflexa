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
- **Use domain types, never raw `string` for known value sets.** Cross-cutting domain types live in `src/types.ts`; everything else co-locates with its owning code.

## Naming conventions

- **Files:** lowercase; snake_case for multi-word names (`primary_query.ts`).
- **Named exports only.** No default exports, no barrel files, no re-exports. Use inline `export` on declarations.
- When moving code, update ALL importers to the new location. Never add shims.

## Project structure

- `src/index.ts` — entry point: telemetry/log wiring, shutdown hooks, then `cli.parse()`
- `src/cli/` — cac command registry (`index.ts`) plus one file per command (`tui.tsx`, `config.tsx`, `sessions.ts`). Commands lazy-import their implementation.
- `src/tui/` — Solid/opentui components (`app.tsx`) and the color palette (`theme.ts`)
- `src/lib/` — shared infrastructure: `env.ts` (sole `process.env` reader), `config.ts` (user config file), `bus.ts` (event bus), `log.ts` (pino), `otel.ts`, `shutdown.ts`
- `src/db/` — SQLite layer: `primary.ts` (connection), `primary_migrations.ts`, `primary_query.ts`, `primary_mutation.ts`, `errors.ts`, `util.ts`
- `src/chat/` — chat backends (`echo.ts` is the placeholder)
- `src/extensions/` — global runtime extensions (see below)
- `src/types.ts` — cross-cutting domain types (`Session`, `Message`, `Part`, `BusEvent`)

## Global extensions

`src/extensions/*.ext.ts` augment built-in globals with small, broadly-useful methods (`Promise.sleep`, `JSON.parseWith`) so call sites don't each redeclare a one-line helper. Each file:

- Declares the method on the relevant global interface via `declare global { interface PromiseConstructor { … } }` (use `PromiseConstructor`/`JSON`/etc. for statics, the instance interface for prototype methods), assigns the implementation, and ends with `export {}` to stay a module.
- Is registered by adding one side-effect import to `src/extensions/index.ts` — the central loader, imported once from `src/index.ts` before `cli.parse()`. That loader is side-effect-only (not a re-export barrel, so it doesn't violate the no-barrel rule). Anything depending on an extension must run after the entry point loads it (all CLI commands do, since they lazy-import after startup).

Reach for an extension only when a helper is genuinely cross-cutting; keep single-caller helpers in their owning file per the Coding rules.

## Solid + opentui (TUI)

The TUI is Solid (`solid-js`) rendered to the terminal via `@opentui/solid`. Solid is not React: components run once, reactivity lives in signals/stores, and there are no re-renders.

### Launch and exit

- Each TUI command has a `launch*` function in `src/cli/*.tsx` that resolves its data (session lookup/creation) first, then calls `void render(...)` with `exitOnCtrlC: false`, `targetFps: 30`, `screenMode: "alternate-screen"`.
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
