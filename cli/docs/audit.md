# Codebase Audit — 2026-06-30

Comprehensive review of every module, the TUI layer, the database schema, CLI commands,
documentation, and test coverage. Findings are grouped by category and ordered by impact
within each group. Every claim cites `file:line`.

**Codebase snapshot:** 254 tests pass, typecheck clean, 0 `TODO(slop)` tags remaining.

---

## 1. Features not seen to completion

These are 90%-done features where the architecture and UI components exist but the last
mile of wiring is missing.

### 1.1 Sidebar CONTEXT and RUNS sections show mock data

**Files:** `src/tui/layout/sidebar.tsx:94-128`, `src/lib/mock_fixtures.ts`

The SESSION and ANALYSIS sidebar sections render live data from the workspace store.
CONTEXT (tokens / cost / percent) and RUNS (task steps + progress) render hardcoded
fixtures imported from `mock_fixtures.ts`. The mock values (`12.1K tok · 6% · $0.04`,
two static runs) never change.

**What's needed:** A live data source for context-window accounting (token usage, cost)
and a run/task system that emits progress events the sidebar can subscribe to. The
sidebar's reactive architecture is proven by the live SESSION/ANALYSIS sections — the
mock sections need the same treatment with real data backing them.

**Scope:** Medium — needs a token-tracking layer in the chat engine and a run lifecycle
system. The sidebar rendering is already done.

---

### 1.2 Part types beyond text are MOCK-only

**Files:** `src/types/session.ts:31-84`, `src/modules/intelligence/chat.ts:1-253`

Three part types carry docstrings starting with "MOCK part:":

- `ThinkingPart` (session.ts:31): "Not produced by the live engine and not persisted —
  exists so the stream can render the 'thinking' state from fixtures. Wiring real
  reasoning emission is a deliberate follow-up."
- `ToolCallPart` (session.ts:47): "Not produced by the live engine and not persisted —
  drives the 'tool call' stream state from fixtures."
- `FileEditPart` (session.ts:67): "Not produced by the live engine and not persisted —
  drives the 'diff / file edit' stream state from fixtures."

The UI components that render these (`thinking_block.tsx`, `tool_block.tsx`,
`diff_block.tsx`, `run_block.tsx`) are fully built, styled, and showcased in the design
gallery. But `chat.ts` only creates `TextPart` instances — the AI SDK `streamText` call
(chat.ts:133-145) produces text deltas only. No tool-calling, structured output, or
reasoning extraction is wired.

**What's needed:** Extend the chat engine to use the AI SDK's tool-calling and reasoning
APIs, produce the corresponding part types, persist them, and emit bus events the
conversation store already knows how to render.

**Scope:** Large — the streaming pipeline, persistence, bus events, and conversation
reducer all need to handle multi-part turns.

---

### 1.3 Stream-block affordances are display-only

Three block components render interactive affordances that have no backing keybindings or
callbacks:

#### 1.3a DiffBlock accept/reject/edit

**File:** `src/tui/components/diff_block.tsx:33`

```
a accept · r reject · e edit
```

No `a`, `r`, or `e` keybindings exist in the keymap. No callbacks are wired. The
component is purely presentational.

**What's needed:** A keybinding layer (focus-target gated to the diff block) with
`a`/`r`/`e` bindings that dispatch to a file-write/undo/editor-launch flow. Blocked on
§1.2 (file edits aren't produced yet).

#### 1.3b RunBlock detach

**File:** `src/tui/components/run_block.tsx:67`

```
esc detach · ctrl+c abort
```

`ctrl+c` works via the global `app.abort` keybinding. `esc detach` has no binding —
`esc` is used for blur/cancel in other contexts. No run lifecycle system exists to detach
from.

**What's needed:** A run system with attach/detach semantics. Blocked on §1.1 (no live
run data).

#### 1.3c ThinkingBlock expand/collapse

**File:** `src/tui/components/thinking_block.tsx:15-16`

The component accepts an `expanded` prop. The docstring says: "the block is
presentational and the caller owns the expand state, since stream rows are not
individually focusable yet (key-driven toggle is a follow-up)."

**What's needed:** Per-block expand state in the conversation store and a keybinding to
toggle it. Requires making stream rows individually focusable.

**Scope (1.3 overall):** Small UI work per item, but each is blocked on the
corresponding backend feature (§1.2 for diffs/thinking, §1.1 for runs).

---

### 1.4 Input bar effort selector is hardcoded

**File:** `src/tui/layout/input_bar.tsx:31,68`

The footer row shows `xhigh /effort` as a static string (line 68). The comment at line
31 says: "hardcoded until those features are integrated." There is no effort-level state,
no selector UI, and no keybindings to change the value.

**What's needed:** An effort state (e.g. in the workspace store or a dedicated signal),
a keybinding pair (e.g. `,`/`.` to decrease/increase), and integration with the chat
engine's `maxOutputTokens` or model parameters.

**Scope:** Small — UI + state plumbing only.

---

### 1.5 Staging module is complete but not integrated

**Files:** `src/modules/staging/staging.ts`, `src/modules/staging/staging.test.ts`

The staging module is fully implemented: file staging with hardlink-first + copy
fallback, recursive directory walking, SHA-256 content hashing, `StagedInput` type
wire-compatible with cortex-core's `StagedInput`. Tests cover single files, directory
subtrees, multiple inputs, orphaned anchors, and content verification.

However:
- The module is **untracked** — `git status` shows `?? src/modules/staging/`.
- No CLI command invokes `stageInputs()`.
- No bus event triggers staging.
- No integration with the analysis launch or export flows.

**What's needed:** Commit the module, wire it into the analysis lifecycle (e.g. before
cortex-core execution), and add a CLI command or bus-driven trigger.

**Scope:** Small (wiring only — the implementation is done).

---

### 1.6 Chat-stream provenance harvesting is deferred

**File:** `docs/prov.progress.md:26`

The provenance recorder subscribes to three bus events only:

- `prov.analysis_created`
- `prov.input_added`
- `prov.input_removed`

Chat messages, model interactions, tool calls, and file edits are not recorded as PROV
activities. The design doc says: "Chat-stream harvesting deferred."

**What's needed:** New bus event types for chat turns (e.g. `prov.message_sent`,
`prov.tool_invoked`), corresponding `appendAction` calls in the recorder, and PROV
mappings for the new activities.

**Scope:** Medium — needs new event types, recorder logic, and PROV entity mapping.
Blocked on §1.2 (tool calls don't exist yet).

---

## 2. Missing functionality

Features that don't exist at all — no partial implementation.

### 2.1 No delete or rename for analyses, projects, or sessions

**File:** `src/db/primary_mutation.ts`

The mutation layer provides:
- `deleteAnalysisInput` (line 212)
- `deleteAnchor` (line 150) + `deleteAnalysesForAnchor` (line 220)

Missing:
- `deleteAnalysis` — no way to remove a single analysis without deleting its anchor
- `deleteProject` — projects cannot be removed once created
- `deleteSession` — sessions accumulate with no cleanup
- `renameAnalysis` — `updateAnalysis` (line 178) exists but no CLI/TUI command exposes
  name editing
- `renameProject` / `updateProject` — no mutation at all for project metadata changes

The TUI command palette (`src/tui/commands.tsx`) has no entries for any of these
operations.

**What's needed:** DB mutations + CLI commands + TUI palette commands for delete/rename
of each entity.

**Scope:** Medium — straightforward CRUD, but needs careful cascade handling (e.g.
deleting an analysis should cascade to sessions/messages/parts and clean up provenance).

---

### 2.2 No slash command system

**File:** `src/tui/app.tsx:211-214`

The chat input only handles two hardcoded slash commands:

```typescript
if (text === "/quit" || text === "/exit") {
    renderer.destroy();
    await shutdown(0);
}
```

No slash command parser, no registry, no extensibility. Each new command would require
another `if` branch.

Meanwhile, the welcome screen (`src/tui/components/chat.tsx:78`) hints:

```typescript
hints={["run /init", "^K for commands"]}
```

`/init` does not exist. The hint is misleading.

**What's needed:** A slash command registry (similar to the palette command registry in
`commands.tsx`), a parser that intercepts `/`-prefixed input, and removal or correction
of the `/init` hint.

**Scope:** Small-medium — the palette command system is a good model to adapt.

---

### 2.3 No input management in the TUI

**Files:** `src/tui/commands.tsx`, `src/modules/analysis/analysis.ts:addInputs/removeInput`

The module logic for adding and removing inputs exists:
- `addInputs()` (analysis.ts) — batch add with provenance events
- `removeInput()` (analysis.ts:153) — single remove with provenance event

But no TUI palette command exposes these. The only way to manage inputs is:
- At creation time via `inflexa new [name] [paths...]` (CLI only)
- No way to add/remove inputs to an existing analysis from the TUI

**What's needed:** TUI commands like "Add input" (file picker or path prompt) and
"Remove input" (list picker). The sidebar already shows the input count
(sidebar.tsx:113).

**Scope:** Small — the logic exists, just needs UI wiring.

---

### 2.4 No "set project" in the TUI

**File:** `src/cli/index.ts:123-129`

The CLI has `inflexa analysis set-project <analysis> [project]` which calls
`runSetProject` from `modules/analysis/set_project.ts`. But no TUI command exposes this.
You can create a project from the palette (`project.new`, commands.tsx:449) but cannot
attach an analysis to one without quitting to the CLI.

**What's needed:** A TUI command that shows a project picker and calls
`updateAnalysisProject`.

**Scope:** Small — the DB mutation and project picker pattern both exist.

---

### 2.5 No auth status or whoami in the TUI

**File:** `src/cli/index.ts:222-226`

The CLI has `inflexa auth whoami` which displays the logged-in user, email, and token
status. The `docs/dev_commandPalette.md` design doc lists `auth whoami` as
palette-compatible, but no TUI command was implemented.

**What's needed:** A TUI command that imports `whoami` and renders its output in a
`ResultsDialog`.

**Scope:** Tiny — one palette command entry.

---

### 2.6 No "project ls" in the TUI

**File:** `src/tui/commands.tsx`

The CLI has `inflexa project ls` (`cli/index.ts:147-152`) which calls `projectLs` from
`modules/project/project.ts:34-53`. The TUI palette has "New project" but no "List
projects" command.

**What's needed:** A palette command that renders project data in a `ResultsDialog` or
`SelectList`.

**Scope:** Tiny — one palette command entry.

---

## 3. Implementation issues

Correctness or robustness concerns in existing code.

### 3.1 `analysis_inputs` table lacks a UNIQUE constraint

**File:** `src/db/primary_migrations.ts:47-52`

```sql
CREATE TABLE analysis_inputs (
    path TEXT NOT NULL,
    is_dir INTEGER NOT NULL DEFAULT 0,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    anchor_id TEXT REFERENCES anchors(id)
);
```

No PRIMARY KEY, no UNIQUE constraint. The logical key is
`(analysis_id, path, anchor_id)` — the deletion query at `primary_mutation.ts:214` uses
this tuple:

```sql
DELETE FROM analysis_inputs WHERE analysis_id = ? AND path = ? AND anchor_id IS ?
```

Without a UNIQUE constraint, duplicate rows can exist. The application logic in
`addInputs` (analysis.ts) doesn't check for duplicates before inserting.

**What's needed:** A migration (v5) adding
`UNIQUE(analysis_id, path, anchor_id)` — or a composite check in `addInputs`.

**Scope:** Small — one migration + optional application-level guard.

---

### 3.2 `sessions` FK to `analyses` lacks ON DELETE CASCADE

**File:** `src/db/primary_migrations.ts:60`

```sql
analysis_id TEXT REFERENCES analyses(id)
```

No `ON DELETE CASCADE`. Compare with `analysis_inputs` (line 50) which does cascade, and
`messages`→`sessions` (line 67) and `parts`→`messages` (line 75) which also cascade.

Currently no `deleteAnalysis` function exists (§2.1), so this is not a live bug. But when
analysis deletion is added, orphaned sessions will remain unless this FK is fixed.

**What's needed:** A migration adding the cascade (SQLite requires recreating the table
to alter FK constraints), or handling session cleanup in application code when
`deleteAnalysis` is added.

**Scope:** Small — but coupled to §2.1 (analysis deletion).

---

### 3.3 Welcome hints reference nonexistent `/init` command

**File:** `src/tui/components/chat.tsx:78`

```typescript
hints={["run /init", "^K for commands"]}
```

`/init` does not exist (see §2.2). Users who type `/init` get it sent as a chat message.

**What's needed:** Either implement `/init` or change the hint to something that works
(e.g. `"ctrl+k for commands"` only).

**Scope:** Tiny fix (one string change), or part of §2.2 (slash command system).

---

## 4. Nice-to-have improvements

Not bugs or gaps, but features that would improve the experience.

### 4.1 Session rename

Sessions are auto-titled `Chat — <analysis name>` (launch.ts:64, commands.tsx:77). All
sessions for an analysis share the same title. The switch-session dialog
(commands.tsx:212) shows `s.title` + timestamp, but all titles are identical.

A rename capability would let users distinguish sessions meaningfully.

---

### 4.2 Analysis rename from the TUI

`updateAnalysis` exists (primary_mutation.ts:178) and handles name + slug + all fields.
But no TUI command exposes it — only available by calling the DB function from code.

A "Rename analysis" palette command with a `PromptDialog` would be straightforward.

---

### 4.3 Configurable system prompt

**File:** `src/modules/intelligence/chat.ts:23`

```typescript
const SYSTEM_PROMPT = "You are Inflexa, a concise and helpful coding assistant operating in a terminal.";
```

Hardcoded constant. Could be configurable per analysis or via the settings screen.

---

### 4.4 Model selection in the TUI

**File:** `src/modules/intelligence/chat.ts:228-234`

`pickDefaultModel` auto-selects by preference order (claude > gpt > gemini > qwen). The
proxy lists available models via `/models`, but the user cannot choose. A model picker in
the TUI (or a config setting) would give users control.

---

### 4.5 Message search / conversation history search

No search within the conversation stream or across sessions. Long conversations have no
way to find a prior exchange.

---

### 4.6 Single-message copy to clipboard

Copy-on-select works globally (app.tsx:121-127), but there's no message-level "copy"
action (e.g. via a keybinding when focused on a message).

---

### 4.7 Export analysis bundle

Individual exports exist (provenance JSON/PROV-N via the palette). No "export
everything" flow that bundles inputs + provenance + chat history for sharing or archival.

---

## 5. UI/UX improvements

### 5.1 No strong visual distinction between INSERT and NORMAL mode

**File:** `src/tui/layout/input_bar.tsx:66`

The mode word (`INSERT` / `NORMAL`) is shown in muted text. The textarea border changes
color on focus/blur (line 47: `borderFocus` vs `border`), but this is subtle. In NORMAL
mode, vim scroll keys are active — accidental typing of `j`, `k`, `g`, `G`, etc. scrolls
instead of inserting, which can be disorienting without a strong visual cue.

A more prominent indicator (e.g. background color change, bold mode word, or a mode-line
accent) would help.

---

### 5.2 Empty-state guidance in switch dialogs

**Files:** `src/tui/commands.tsx:202-226` (SwitchSessionDialog),
`src/tui/commands.tsx:180-200` (SwitchAnalysisDialog)

When no items exist, the dialogs show flat text ("No sessions for this analysis" / "No
analyses yet") with no next-step guidance. Offering to create one (e.g. a "Create new"
action on empty) would smooth the flow.

---

### 5.3 Toast notification duration

**File:** `src/tui/hooks/notice.ts`

Toasts auto-dismiss on a fixed timer. Long error messages (e.g. a provenance signing
failure path) may not be readable before dismissal. A configurable or content-adaptive
duration would help.

---

### 5.4 No confirmation before quit with active stream

**File:** `src/tui/app.tsx:210-214`

`/quit` exits immediately even if the model is mid-stream. There is no "are you sure?"
confirmation. The abort keybinding (ctrl+c) already serves double duty: stop streaming
(when busy) and quit (when idle). But `/quit` bypasses both — it destroys the renderer
and shuts down unconditionally.

---

### 5.5 Placeholder documentation files

Three docs exist as stubs:
- `docs/privacy.md` — contains only "TODO"
- `docs/sandbox.md` — contains only "TODO"
- `docs/provenance.md` — empty file (0 bytes)
- `README.md:67` — `<!-- TODO: document supported providers and how to set API keys. -->`

---

## Summary by implementation priority

| # | Finding | Category | Scope | Blocked by |
|---|---------|----------|-------|------------|
| 3.3 | Welcome `/init` hint is wrong | Bug | Tiny | — |
| 3.1 | analysis_inputs no UNIQUE constraint | Bug | Small | — |
| 2.5 | No whoami in TUI | Missing | Tiny | — |
| 2.6 | No project ls in TUI | Missing | Tiny | — |
| 2.4 | No set-project in TUI | Missing | Small | — |
| 2.3 | No input management in TUI | Missing | Small | — |
| 1.4 | Hardcoded effort selector | Incomplete | Small | — |
| 4.2 | Analysis rename in TUI | Nice-to-have | Small | — |
| 4.1 | Session rename | Nice-to-have | Small | — |
| 2.2 | No slash command system | Missing | Small-med | — |
| 2.1 | No delete/rename for entities | Missing | Medium | — |
| 3.2 | sessions FK no CASCADE | Bug | Small | §2.1 |
| 1.5 | Staging not integrated | Incomplete | Small | — |
| 1.1 | Sidebar mock data | Incomplete | Medium | — |
| 1.6 | Chat-stream prov harvesting | Incomplete | Medium | §1.2 |
| 1.2 | MOCK part types (no tool/think/diff) | Incomplete | Large | — |
| 1.3 | Block affordances display-only | Incomplete | Small each | §1.2, §1.1 |
| 4.4 | Model selection in TUI | Nice-to-have | Small | — |
| 4.3 | Configurable system prompt | Nice-to-have | Small | — |
| 5.1 | INSERT/NORMAL mode visual cue | UX | Tiny | — |
| 5.2 | Empty-state dialog guidance | UX | Tiny | — |
| 5.3 | Toast duration | UX | Tiny | — |
| 5.4 | Quit confirmation during stream | UX | Tiny | — |
| 5.5 | Placeholder docs | Docs | Small | — |
| 4.5 | Message search | Nice-to-have | Medium | — |
| 4.6 | Single-message clipboard | Nice-to-have | Small | — |
| 4.7 | Export analysis bundle | Nice-to-have | Medium | — |
