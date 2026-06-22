Command palette for the inflexa TUI — design

TL;DR

Build the palette as three small pieces layered on a single dispatch model,
with commands as a flat declarative registry so adding one is a one-entry
edit:

1. A command registry (src/tui/commands.tsx) — a flat Command[] array. This is
the only file you edit to add a command.
2. An overlay/dialog host in app.tsx (the one genuinely-new piece of infra) —
a portal-mounted modal slot, since the app has no modal system today.
3. A reusable filtered select list that powers the palette (and, later, the
analysis/session pickers).

The CLI and the palette are two adapters over one shared logic layer
(src/modules/) — not a single shared command object. They have incompatible
execution models (fresh process + stdio vs. live TUI + renderer), so forcing
one registry would fight both. "Exposes CLI functionality" means offering the
same actions backed by the same module logic — which is exactly the repo's
existing thin-adapter pattern.

Three findings that shape the design

1. opentui gives us everything for a modal natively — no new dep needed.
position="absolute" + top/left/right/bottom + zIndex + opacity exist on every
box; <Portal> (from @opentui/solid) mounts an overlay on renderer.root above
the app; <input> is a single-line search box; <scrollbox> +
scrollChildIntoView(id) handle the result list. So we can match opencode's UX
without @opentui/keymap.
2. useKeyboard is a global, focus-agnostic bus — every handler fires for every
key, before the focused widget. This is the load-bearing constraint: to make
the palette "swallow" keys, background handlers must gate on a dialogOpen()
signal (early-return), and the open-key handler must key.preventDefault() so
the textarea doesn't also act on it. (You can't rely on stopPropagation()
ordering between two useKeyboard subscriptions.)
3. opencode's best ideas transfer; its engine doesn't. Worth copying: one
generic fuzzy select reused everywhere, a single dispatch(name) verb, category
grouping as data, and enabled() contextual availability. What we skip:
@opentui/keymap (the leader-key/mode/useBindings engine) — it's a dep, and v1
doesn't need leader sequences or mode stacks.

Architecture

 Ctrl+K ─┐
 (future:│
  keybind,│   ┌─────────────────────────────────────────────┐
  slash)  └──▶│  CommandPalette overlay (command_palette.tsx)│
             │   <input> search → fuzzy filter → SelectList  │
             └───────────────┬─────────────────────────────┘
                             │ runCommand(cmd, ctx)   ← single dispatch
                             ▼
        commands.tsx:  Command[] registry  ── enabled(ctx)/run(ctx)
                             │
                             ▼
              CommandContext  (built in app.tsx)
   { sessionId, workingDir, analysis,
     openDialog, closeDialog, openSession, notify, quit }
                             │
                             ▼
          src/modules/*  (shared headless logic — same code the CLI calls)

The pieces

1. Command registry & types — src/tui/commands.tsx

Co-located with the TUI (these types aren't persisted entities or the event
contract, so they don't belong in src/types/). A flat array; category drives
grouping; enabled(ctx) is contextual availability (opencode's "reachable").

/** A palette command: metadata + an action that runs inside the live TUI. */
export type Command = {
    /** Stable dotted id, e.g. "analysis.new". Decoupled from title so renames
don't break dispatch. */
    id: CommandId;
    /** Label shown in the palette. */
    title: string;
    /** One-line help shown under the title. */
    description?: string;
    /** Grouping header in the palette. */
    category: CommandCategory;
    /** Display-only shortcut hint, e.g. "Ctrl+K". Not a binding (v1 has no
keybind engine). */
    keybind?: string;
    /** Contextual availability — a command absent here is hidden from the
palette. */
    enabled?: (ctx: CommandContext) => boolean;
    /** The action. Runs with the in-app capability surface, never stdio. */
    run: (ctx: CommandContext) => void | Promise<void>;
};

export type CommandCategory = "Analysis" | "Session" | "Project" | "View" |
"App";
export type CommandId = string; // dotted ids; widen to a union once the set
stabilizes

/** The single source of truth. Add a command = add an entry here. */
export const commands: Command[] = [ /* … see examples below … */ ];

2. CommandContext — the in-app capability surface (the extensibility keystone)

Everything a command needs to act inside the running TUI. Built in app.tsx,
closing over its signals/dialog stack:

/** What a command may do inside the live TUI. No stdio — that's the CLI's
world. */
export type CommandContext = {
    sessionId: string;
    workingDir: string;
    /** Current analysis, or null when the chat isn't analysis-scoped. */
    analysis: Analysis | null;
    /** Push a modal (picker / prompt / results) onto the overlay stack. */
    openDialog: (render: () => JSX.Element) => void;
    /** Pop the top modal. */
    closeDialog: () => void;
    /** Switch the active chat in place (resume a different analysis/session).
*/
    openSession: (sessionId: string, workingDir: string) => void;
    /** Transient status-line feedback (replaces console.log, which can't
reach the alt-screen). */
    notify: (notice: { kind: "info" | "warn" | "error"; text: string }) =>
void;
    /** Clean quit (renderer.destroy + shutdown). */
    quit: () => Promise<void>;
};

3. Overlay/dialog host — the new infra, lives in app.tsx

The app is a single screen with no modal system. Add a minimal stack + a
portal slot. Keep it in app.tsx until a second screen needs it (per the
no-premature-extraction rule).

// inside App():
const [dialogs, setDialogs] = createStore<(() => JSX.Element)[]>([]);
const dialogOpen = () => dialogs.length > 0;

const ctx = (): CommandContext => ({
    sessionId: currentSession().id,
    workingDir: currentSession().workingDir,
    analysis: currentAnalysis(),
    openDialog: (render) => setDialogs(produce((d) => d.push(render))),
    closeDialog: () => setDialogs(produce((d) => d.pop())),
    openSession,            // see refactor #2
    notify: setNotice,
    quit: async () => { renderer.destroy(); await shutdown(0); },
});

// root keyboard handler GATES on dialogOpen() so background keys don't fire
while a modal is up:
useKeyboard((key) => {
    if (dialogOpen()) return;                       // modal owns the keyboard
    if (key.ctrl && key.name === "k") {
        key.preventDefault();                       // stop the textarea from
also acting
        setDialogs(produce((d) => d.push(() => <CommandPalette ctx={ctx()}
/>)));
        return;
    }
    if (key.ctrl && key.name === "c" && status() === "busy")
abortController?.abort();
});

// render slot — Portal floats it on renderer.root, above the chat:
<Show when={dialogOpen()}>
    <Portal>
        <box position="absolute" top={0} left={0} right={0} bottom={0}
             backgroundColor={theme().bg} opacity={0.85} zIndex={100}>
            {dialogs[dialogs.length - 1]!()}
        </box>
    </Portal>
</Show>

Each dialog component runs its own useKeyboard that early-returns unless it's
the top dialog (Esc → closeDialog).

4. The palette UI + reusable select — src/tui/command_palette.tsx

A thin data-adapter over a filtered list, mirroring opencode's
CommandPaletteDialog → DialogSelect split. The list/nav/fuzzy logic starts
inline here (single caller); when the analysis/session picker needs it too,
that's when it graduates to src/tui/select_list.tsx (real reuse = the trigger
for a new file, per the repo's extraction rule).

export function CommandPalette(props: { ctx: CommandContext }) {
    const [query, setQuery] = createSignal("");
    const [cursor, setCursor] = createSignal(0);

    // enabled() filters availability; then fuzzy-rank by query; then group by
category.
    const visible = () => rank(commands.filter((c) => c.enabled?.(props.ctx)
?? true), query());

    useKeyboard((key) => {
        if (key.name === "escape") return props.ctx.closeDialog();
        if (key.name === "up" || (key.ctrl && key.name === "p")) setCursor((i)
=> Math.max(0, i - 1));
        else if (key.name === "down" || (key.ctrl && key.name === "n"))
setCursor((i) => Math.min(visible().length - 1, i + 1));
        else if (key.name === "return") {
            const cmd = visible()[cursor()];
            if (cmd) { props.ctx.closeDialog(); void runCommand(cmd,
props.ctx); }
        }
    });
    // <input focused onInput={setQuery}>  +  <scrollbox> of grouped rows,
highlight cursor,
    //   scrollChildIntoView on the highlighted row, keybind hint
right-aligned per row.
}

/** Single dispatch verb — reached by palette Enter today; by keybind/slash
later. */
export async function runCommand(cmd: Command, ctx: CommandContext):
Promise<void> {
    await cmd.run(ctx);
}

Fuzzy ranking is a ~20-line subsequence scorer (title weighted over category)
— no fuzzysort dep. Empty query shows all, grouped, with a "Suggested" group
on top (opencode's pattern) if we tag commands suggested.

Extensibility: adding a command

The headline property — a no-input command is one entry, reusing module logic
unchanged:

{
    id: "analysis.open-output",
    title: "Open output folder",
    description: "Reveal this analysis's output directory",
    category: "Analysis",
    keybind: undefined,
    enabled: (ctx) => ctx.analysis !== null,
    run: (ctx) => runOpen(ctx.analysis!.id),   // same module fn the CLI's
`inf open` calls
},

An input-taking command opens a dialog (a small PromptDialog/picker built on
the overlay infra):

{
    id: "project.new",
    title: "New project",
    category: "Project",
    run: (ctx) => ctx.openDialog(() => (
        <PromptDialog title="New project" placeholder="Project name"
onSubmit={(name) => {
            createProject(name).match(   // headless core, returns Result —
see principle below
                () => ctx.notify({ kind: "info", text: `Created "${name}"` }),
                (e) => ctx.notify({ kind: "error", text: `Failed: ${e.type}`
}),
            );
            ctx.closeDialog();
        }} />
    )),
},

One principle this surfaces: mutating commands need a headless core that
returns Result — the console.log belongs in the CLI adapter, not the logic.
Several module fns today (projectNew, runStatus, …) print directly. Splitting
"do the work (Result)" from "print it (CLI)" lets both surfaces call the core
— the CLI wrapper prints, the palette wrapper notifys. This tightens the
module boundary the repo already favors.

CLI → palette mapping

┌──────────────────────────┬──────────┬──────────────────────────────────┐
│       CLI command        │   In     │         In-app behavior          │
│                          │ palette? │                                  │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ new, resume, sessions    │ ✅       │ dialog picker → openSession      │
│                          │          │ (needs refactor #2)              │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ config                   │ ✅       │ push ConfigApp as a dialog       │
│                          │          │ screen                           │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ open                     │ ✅       │ runOpen(current) — OS open, safe │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ ls, status, project ls   │ ✅       │ render into a read-only results  │
│                          │          │ dialog                           │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ project new, analysis    │ ✅       │ prompt dialog → headless core    │
│ set-project              │          │                                  │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ theme switch             │ ✅       │ quick command → setTheme +       │
│                          │          │ persist                          │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ repair/relocate/prune    │ ⚠️  defer │ path-based anchor backstops; low │
│                          │          │  value in-app                    │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│                          │ ❌       │ device flow / docker need normal │
│ auth login, setup        │ CLI-only │  stdio — can't run under the     │
│                          │          │ alt-screen                       │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ auth whoami              │ ✅       │ results dialog                   │
├──────────────────────────┼──────────┼──────────────────────────────────┤
│ quit                     │ ✅       │ ctx.quit()                       │
└──────────────────────────┴──────────┴──────────────────────────────────┘

The honest boundary: stdio/device-flow/subprocess commands stay CLI-only. The
registry's opt-in nature handles this for free — not every verb belongs in the
palette, and absence is the mechanism.

Required refactors & incremental plan

Two refactors gate the full feature; the palette ships useful before both
land.

- Refactor #1 — overlay host (small, isolated): the dialog stack + Portal slot
+ dialogOpen() gate in app.tsx. Self-contained.
- Refactor #2 — reactive session (the one nontrivial change): today App takes
sessionId/workingDir as static props and the bus handler filters by
props.sessionId. To switch chats in place, make the current session a signal;
openSession() swaps it, resets messages/stream/error, aborts any in-flight

The honest boundary: stdio/device-flow/subprocess commands stay CLI-only. The registry's opt-in nature handles this for free — not every verb belongs in the palette, and
absence is the mechanism.

Required refactors & incremental plan

Two refactors gate the full feature; the palette ships useful before both land.

- Refactor #1 — overlay host (small, isolated): the dialog stack + Portal slot + dialogOpen() gate in app.tsx. Self-contained.
- Refactor #2 — reactive session (the one nontrivial change): today App takes sessionId/workingDir as static props and the bus handler filters by props.sessionId. To
switch chats in place, make the current session a signal; openSession() swaps it, resets messages/stream/error, aborts any in-flight chat, and the bus handler reads the
signal. App also needs the current Analysis (it only gets sessionId/workingDir now) — pass it through launch.tsx.

Phased build:
1. Phase 1 — palette + overlay, no session switching. Ship View/App commands that need no chat swap: Settings, Change theme, Open output folder, Show status / List
analyses (results dialogs), New project, Quit. Delivers the full UX and the extensibility surface immediately. (Refactor #1 only.)
2. Phase 2 — session-switching commands. Land refactor #2, then add Switch analysis / Switch session / New analysis. This is where the palette becomes a true CLI
replacement in-app.
3. Phase 3 — polish/extension hooks (optional): suggested group, per-command keybinds (a small key→id map dispatching via the same runCommand), /-slash entry, and reactive
per-component command contribution (opencode's useBindings idea) if contextual command sets ever appear.

Two options to confirm

- Open key: I'd use Ctrl+K (VS Code/Linear/Slack convention; free in inflexa — the app only binds Ctrl+C and Enter). opencode uses Ctrl+P; easy to change.
- @opentui/keymap: I'm deliberately not proposing it (it's a new dep, needs approval, and v1 doesn't need leader keys/modes). The design reimplements only what we need
(~150 lines). If you later want leader sequences / mode stacks, adopting it is a clean future swap behind the same runCommand dispatch.

---
This is the investigation/design. The architecture is intentionally a flat registry + one dispatch verb + a capability context, so "add a new command" stays a one-entry
edit indefinitely. Want me to implement Phase 1 (palette + overlay host + a starter set of commands), or adjust the design first — e.g. the open-key, or whether to fold
session-switching into the first pass?