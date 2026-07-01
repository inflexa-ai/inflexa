## 1. Validate the load-bearing assumption

- [x] 1.1 Confirm against the installed `solid-js` that a `createStore` property read **outside** any reactive scope returns the current plain value (a snapshot) — the basis for command `run`/`enabled` reading `ws.analysis` imperatively. If false, plan the narrow fallback (a command-facing getter; components still read the store reactively) before proceeding. — VERIFIED (solid-js 1.9.13): snapshot reads + functions-in-store + per-key partial set all confirmed empirically.

## 2. Create the context (`src/tui/workspace.ts`)

- [x] 2.1 Define the `Workspace` type: flat fields ordered data-then-capabilities — `analysis: Analysis | null`, `sessionId: string`, `workingDir: string`, `project: Project | null`, then `openDialog`, `closeDialog`, `openSession`, `quit`. JSDoc each field per CLAUDE.md.
- [x] 2.2 Create `WorkspaceContext` via `createContext<Workspace>()` and export `useWorkspace(): Workspace` that calls `useContext` and throws when the value is absent (used outside a Provider).
- [x] 2.3 No JSX in this file (`.ts`); named exports only, no barrel.

## 3. Wire `app.tsx`

- [x] 3.1 Add a `lookupProject(a: Analysis | null): Project | null` helper using `findProjectByRef` (pure read — no marker write).
- [x] 3.2 Replace the three scope signals with a single `createStore<Workspace>` seeded from props (`analysis`, `sessionId`, `workingDir`, `project = lookupProject(props.analysis)`) plus the capability functions.
- [x] 3.3 Rewrite `openSession` as a hoisted `function` that `setWorkspace`s the four data fields (incl. re-resolved `project`) and performs the existing local resets (abort stream, clear messages/`streamText`/`streamPartId`/`errorMsg`, reset chat status, `loadMessages`).
- [x] 3.4 Delete `buildCtx()`; wrap the render tree in `<WorkspaceContext.Provider value={workspace}>`.
- [x] 3.5 Pass the store proxy to `runCommand(cmd, workspace)` in `runCommandById` and to the `leaderSeq("q")` quit binding; update the `StatusBar` subtitle to read `workspace.analysis?.name`.
- [x] 3.6 Drop the `analysis`/`sessionId` props from `<Sidebar>` (keep `messageCount`); confirm `messages`, `streamText`, `streamPartId`, `errorMsg`, `sidebarOpen`, and the `dialogs` stack remain App-local.

## 4. Update consumers

- [x] 4.1 `command_palette.tsx`: `CommandPalette` drops its `ctx` prop and reads `useWorkspace()`; `runCommand` signature becomes `(cmd: Command, ws: Workspace)`; the `enabled?.(ws)` memo and `onSelect` dispatch use the hook value.
- [x] 4.2 `commands.tsx`: replace `CommandContext` with `Workspace` imported from `workspace.ts`; `run`/`enabled` signatures take `Workspace`; each command dialog sub-component drops its `ctx` prop and calls `useWorkspace()`; command bodies reading `ctx.analysis`/`ctx.workingDir` are otherwise unchanged. The file-level `eslint-disable solid/reactivity` is now unused (store reads via `useWorkspace()` are not flagged) and was removed.
- [x] 4.3 `sidebar.tsx`: drop the `analysis`/`sessionId` accessor props; read `useWorkspace()`; delete the local `project` `createMemo` and read `ws.project`; wrap the analysis name in `<Show when={ws.analysis}>` for the nullable field; keep `messageCount` as a prop.

## 5. Guard the no-Provider mount

- [x] 5.1 Confirm `ConfigApp` (standalone `inf config`, `app_config.tsx:274-283`) does not call `useWorkspace()`; only its embedded-dialog mount (pushed via `openDialog`) is under the Provider. — CONFIRMED: no `useWorkspace`/`WorkspaceContext` reference in `app_config.tsx`.

## 6. Verify

- [x] 6.1 `bun run typecheck` and `bun run lint` pass; no stray `CommandContext` or `buildCtx` references remain (no shim). — typecheck clean, lint 0 problems; the only remaining `CommandContext` mentions are historical-comment cleanups (all updated).
- [x] 6.2 `bun run format:file` on every changed `src/` file.
- [ ] 6.3 Smoke-test the running TUI: open the command palette, switch analysis and session (sidebar + status bar update, project name follows), toggle the sidebar, and quit — all behave as before. — NOT run headlessly (needs a real TTY + proxy). Automated equivalents are green: 30/30 unit tests pass, the full module graph loads with all exports resolving, and the store-semantics that the design rests on are empirically verified. Recommend a one-minute live walkthrough via `bun run dev`.
