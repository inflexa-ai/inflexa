import { createSignal, createEffect, Show, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Renderable, TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";

import { GLYPHS, zIndex } from "../lib/design_system.ts";
import { shutdown } from "../lib/shutdown.ts";
import { writeClipboard } from "../lib/clipboard.ts";
import { theme, themeVariant, noticeColor, type Notice } from "./theme.ts";
import { chatStatus } from "./hooks/status.ts";
import * as conversation from "./hooks/conversation.ts";
import { currentNotice, notify } from "./hooks/notice.ts";
import { commands } from "./commands.tsx";
import { CommandPalette, runCommand } from "./components/command_palette.tsx";
import { useKeymapRoot, useBindings, pushMode, MODE_BASE, MODE_MODAL, resolveKeybind, keybindLabel, leaderSeq, KEYS } from "./keymap.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { Chat } from "./components/chat.tsx";
import { InputBar } from "./layout/input_bar.tsx";
import { Sidebar } from "./layout/sidebar.tsx";
import { WhichKey } from "./layout/which_key.tsx";
import { WorkspaceContext, createWorkspace } from "./contexts/workspace.ts";
import type { Analysis } from "../types/analysis.ts";

type AppProps = {
    sessionId: string;
    workingDir: string;
    analysis: Analysis;
};

export function App(props: AppProps) {
    const dims = useTerminalDimensions();
    const renderer = useRenderer();

    const [sidebarOpen, setSidebarOpen] = createSignal(true);

    // INSERT vs NORMAL: true while the chat input holds focus (the default). Blurring it (esc) enters
    // a vim-style "scroll mode" where the scroll keys below are live; the textarea's focused/blurred
    // events (wired in onTextareaRef) keep this in sync however focus changes — keyboard or mouse.
    const [inputFocused, setInputFocused] = createSignal(true);

    // Dialog host: a stack of render thunks; only the top one is mounted (see the render below).
    const [dialogs, setDialogs] = createStore<Array<() => JSX.Element>>([]);
    const dialogOpen = (): boolean => dialogs.length > 0;
    const dialogTop = (): (() => JSX.Element) | null => (dialogs.length > 0 ? dialogs[dialogs.length - 1]! : null);

    let textareaRef: TextareaRenderable | null = null;
    let scrollboxRef: ScrollBoxRenderable | null = null;

    // In-app capabilities that close over App's local state, handed to the workspace store below.
    function openDialog(render: () => JSX.Element): void {
        setDialogs(produce((d) => d.push(render)));
    }
    function closeDialog(): void {
        setDialogs(produce((d) => d.pop()));
    }
    // Quit cleanly: destroy() restores the terminal (mouse tracking, alternate screen, cooked mode)
    // before exit — process.exit() alone skips OpenTUI's cleanup and leaves the shell broken.
    async function quit(): Promise<void> {
        renderer.destroy();
        await shutdown(0);
    }

    // The workspace context store. Its reactivity and the `openSession` write path live in
    // contexts/workspace.ts; App supplies the capabilities (which close over its local state). The
    // chat hot-state reset on an in-place swap is driven reactively by the `Chat` component (an
    // effect on `workspace.sessionId`), so App no longer passes an imperative reset hook. Seeded
    // once from props — App mounts a single time with fixed props — so the body-level reads are a
    // deliberate one-time seed, hence the scoped disable.
    /* eslint-disable solid/reactivity -- seed-once: App mounts once with fixed props; the store is seeded from them and thereafter written only via openSession */
    const workspace = createWorkspace({
        analysis: props.analysis,
        sessionId: props.sessionId,
        workingDir: props.workingDir,
        openDialog,
        closeDialog,
        quit,
    });
    /* eslint-enable solid/reactivity */

    // The single root keyboard handler that drives the keymap engine. Every binding below is a
    // declarative layer; the dispatcher picks the winner — no hand-branched if/else here.
    useKeymapRoot();

    // Two-stage ctrl+c: abort the stream if busy, quit if idle. Always active (no `mode` gate),
    // high priority so it wins over any modal binding that shares the chord.
    useBindings(() => ({
        priority: 100,
        bindings: [
            {
                chord: resolveKeybind("app.abort"),
                run: () => {
                    if (chatStatus() === "busy") {
                        conversation.abort();
                        return;
                    }
                    void quit();
                },
            },
        ],
    }));

    function runCommandById(id: string): void {
        const cmd = commands.find((c) => c.id === id);
        if (cmd) void runCommand(cmd, workspace);
    }

    // Per-palette selection highlight. Dark themes keep OpenTUI's native highlight (each cell's fg becomes
    // its selection bg) — vivid against their bright syntax; light themes invert into mush, so there we
    // flatten the bg to `bgActive` and leave the fg alone (each token keeps its syntax color). Applied on
    // mouse-DOWN, not the `selection` event which only fires on mouse-up — too late for the first drag
    // frame; walked over the tree because markdown's internal text/code children take no `selectionBg` prop.
    function applySelectionColors(): void {
        const bg = themeVariant() === "light" ? theme().bgActive : undefined;
        const visit = (r: Renderable): void => {
            // text/code/diff/textarea expose the setters, a box doesn't; the `in` guard makes the cast sound.
            if ("selectionBg" in r) {
                const sel = r as Renderable & { selectionBg: string | undefined; selectionFg: string | undefined };
                sel.selectionBg = bg; // undefined = native highlight; reassigned each call so a theme switch re-derives
                sel.selectionFg = undefined;
            }
            for (const child of r.getChildren()) visit(child);
        };
        visit(renderer.root);
    }

    // Copy-on-select (see TEXT-SELECTION-CLIPBOARD-REPORT.md): OpenTUI owns the selection, we just read,
    // write, toast, clear. On the root box so a release anywhere copies.
    // Unconditional for now — the report's Windows explicit-copy flag can become a config knob if asked.
    function copySelection(): void {
        const text = renderer.getSelection()?.getSelectedText();
        if (!text) return; // empty → a plain click, not a drag
        void writeClipboard(text); // best-effort, never rejects → notify optimistically
        notify({ kind: "info", text: "Copied to clipboard" });
        renderer.clearSelection();
    }

    // Base chat keys, live only in base mode: opening a dialog pushes MODE_MODAL (effect below),
    // which suspends this whole layer at once — the declarative replacement for `if (dialogOpen)`.
    // Each app key has a direct chord AND a `<leader>` sequence (the leader, ctrl+x by default,
    // begins a chord the which-key panel documents live). desc/group feed that panel.
    useBindings(() => ({
        mode: MODE_BASE,
        bindings: [
            { chord: resolveKeybind("app.command-palette"), run: () => openDialog(() => <CommandPalette commands={commands} />) },
            { chord: resolveKeybind("app.toggle-sidebar"), run: () => setSidebarOpen((open) => !open) },
            {
                chord: leaderSeq("k"),
                run: () => openDialog(() => <CommandPalette commands={commands} />),
                desc: "Command palette",
                group: "App",
            },
            { chord: leaderSeq("b"), run: () => setSidebarOpen((open) => !open), desc: "Toggle sidebar", group: "App" },
            { chord: leaderSeq("a"), run: () => runCommandById("analysis.switch"), desc: "Switch analysis", group: "Analysis" },
            { chord: leaderSeq("n"), run: () => runCommandById("analysis.new"), desc: "New analysis", group: "Analysis" },
            { chord: leaderSeq("s"), run: () => runCommandById("session.switch"), desc: "Switch session", group: "Session" },
            { chord: leaderSeq("t"), run: () => runCommandById("view.theme"), desc: "Change theme", group: "View" },
            { chord: leaderSeq("q"), run: () => void quit(), desc: "Quit", group: "App" },
        ],
    }));

    // Vim-style scroll navigation. The chat textarea is always focused so plain letters insert text;
    // these drive the conversation scrollbox by direct method calls (NOT opentui's own scrollbox key
    // handler, which only fires when the scrollbox itself is focused — it never is). scrollBy's
    // "viewport" unit scales by the visible height; scrollTo(scrollHeight) clamps and re-engages the
    // bottom stickiness so the view resumes following new stream output.
    function scrollToBottom(): void {
        if (scrollboxRef) scrollboxRef.scrollTo(scrollboxRef.scrollHeight);
    }

    // A focus-`target` layer: clear-input (ctrl+u) is live only while the chat textarea is focused —
    // the fine-grained complement to `mode`, so it never fires when a dialog input owns focus. esc
    // blurs the input into NORMAL scroll mode (the scroll layer below takes over).
    useBindings(() => ({
        mode: MODE_BASE,
        target: textareaRef,
        bindings: [
            { chord: resolveKeybind("app.clear-input"), run: () => textareaRef?.setText(""), desc: "Clear input", group: "Input" },
            { chord: KEYS.escape, run: () => textareaRef?.blur(), desc: "Scroll mode (vim keys)", group: "Input" },
        ],
    }));

    // Scroll-mode keys: live only while the input is BLURRED (NORMAL mode), so they never collide
    // with typing. Disjoint from the input's own keys above (target-gated to the focused input), so
    // the shared ctrl+u/ctrl+d never clash. `i`/enter (or a mouse click) refocus the input.
    useBindings(() => ({
        mode: MODE_BASE,
        enabled: !inputFocused(),
        bindings: [
            { chord: [{ key: "g" }, { key: "g" }], run: () => scrollboxRef?.scrollTo(0), desc: "Scroll to top", group: "Scroll" },
            { chord: { key: "g", shift: true }, run: scrollToBottom, desc: "Scroll to bottom", group: "Scroll" },
            { chord: { key: "j" }, run: () => scrollboxRef?.scrollBy(1), desc: "Scroll down", group: "Scroll" },
            { chord: { key: "k" }, run: () => scrollboxRef?.scrollBy(-1), desc: "Scroll up", group: "Scroll" },
            { chord: KEYS.down, run: () => scrollboxRef?.scrollBy(1) },
            { chord: KEYS.up, run: () => scrollboxRef?.scrollBy(-1) },
            { chord: { key: "d", ctrl: true }, run: () => scrollboxRef?.scrollBy(0.5, "viewport"), desc: "Half page down", group: "Scroll" },
            { chord: { key: "u", ctrl: true }, run: () => scrollboxRef?.scrollBy(-0.5, "viewport"), desc: "Half page up", group: "Scroll" },
            { chord: KEYS.pageDown, run: () => scrollboxRef?.scrollBy(1, "viewport"), desc: "Page down", group: "Scroll" },
            { chord: KEYS.pageUp, run: () => scrollboxRef?.scrollBy(-1, "viewport"), desc: "Page up", group: "Scroll" },
            { chord: { key: "i" }, run: () => textareaRef?.focus(), desc: "Insert mode", group: "Input" },
            { chord: KEYS.enter, run: () => textareaRef?.focus(), desc: "Focus input", group: "Input" },
        ],
    }));

    // Push MODE_MODAL while any dialog is open and pop it when the stack empties (or App unmounts).
    // Re-runs on each length change: a nested open pops the prior push then adds one, so exactly
    // one modal entry is ever on the stack.
    createEffect(() => {
        if (dialogs.length === 0) return;
        const pop = pushMode(MODE_MODAL);
        onCleanup(pop);
    });

    // TODO(robustness): minimal slash-command stub — only quit aliases for now. Replace with a
    // proper registry (parser, help listing, extensible command map) when the slash system lands.
    const QUIT_ALIASES = new Set(["quit", "exit", "q", "bye", "ciao"]);

    async function handleSubmit() {
        const text = textareaRef?.editBuffer.getText().trim();
        if (!text) return;

        if (text.startsWith("/")) {
            const name = text.slice(1).split(/\s+/)[0]?.toLowerCase();
            if (name && QUIT_ALIASES.has(name)) {
                textareaRef!.setText("");
                if (chatStatus() === "busy") {
                    conversation.abort();
                    notify({ kind: "info", text: "Stopped streaming. Type /quit again to exit." });
                    return;
                }
                renderer.destroy();
                await shutdown(0);
                return;
            }
        }

        if (chatStatus() === "busy") return;
        textareaRef!.setText("");

        // The conversation store owns the request lifecycle (the AbortController + the chat() call);
        // its bus events drive the stream, so App only hands off the user text.
        await conversation.send({ sessionId: workspace.sessionId, userText: text });
    }

    // Restore focus to the chat input whenever the last dialog closes (a dialog's input grabs
    // the single focus slot; nothing returns it automatically).
    createEffect(() => {
        if (!dialogOpen()) queueMicrotask(() => textareaRef?.focus());
    });

    const statusState = (): { text: string; tone: "success" | "warn" | "error" } =>
        chatStatus() === "busy"
            ? { text: `${GLYPHS.circleHalf} thinking${GLYPHS.ellipsis}`, tone: "warn" }
            : chatStatus() === "error"
              ? { text: `${GLYPHS.cross} error`, tone: "error" }
              : { text: `${GLYPHS.circle} ready`, tone: "success" };

    return (
        <WorkspaceContext.Provider value={workspace}>
            <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg} onMouseDown={applySelectionColors} onMouseUp={copySelection}>
                {/* Header */}
                <StatusBar
                    title="inflexa"
                    subtitle={workspace.analysis?.name}
                    state={statusState()}
                    hints={[keybindLabel("app.command-palette"), keybindLabel("app.toggle-sidebar"), keybindLabel("app.abort")]}
                />

                {/* Main row: the chat column beside the full-height sidebar. Showing the sidebar
                shrinks the chat column (stream + input together) — the opencode layout. */}
                <box flexDirection="row" flexGrow={1} minHeight={0} width="100%">
                    <box flexDirection="column" flexGrow={1} minHeight={0}>
                        {/* The live conversation: stream + error banner, all state in hooks/conversation.ts */}
                        <Chat onScrollboxRef={(r: ScrollBoxRenderable) => (scrollboxRef = r)} />

                        {/* Input area */}
                        <InputBar
                            onTextareaRef={(r: TextareaRenderable) => {
                                textareaRef = r;
                                // focused/blurred fire on every focus change (esc, the refocus effect, a
                                // mouse click), making inputFocused the single source of truth for the
                                // INSERT/NORMAL mode word and the scroll-key gate.
                                r.on("focused", () => setInputFocused(true));
                                r.on("blurred", () => setInputFocused(false));
                                queueMicrotask(() => r.focus());
                            }}
                            onSubmit={() => void handleSubmit()}
                            focused={inputFocused}
                        />

                        {/* Transient toast (single slot, auto-dismissed). Inside the chat column, not the
                        root box, so it floats over the conversation and never the sidebar — opentui absolute
                        positioning is parent-relative. zIndex keeps it above an open modal. */}
                        <Show when={currentNotice()} keyed>
                            {(n: Notice) => (
                                <box
                                    position="absolute"
                                    top={1}
                                    right={2}
                                    zIndex={zIndex.toast}
                                    // A DEFINITE width (not maxWidth) so a long line wraps instead of clipping —
                                    // opentui only wraps text whose box has a resolved width; maxWidth sizes to the
                                    // text's single-line length and then clips the overflow (hiding a long export
                                    // path mid-string). Size to the text so short toasts stay snug, capped so a long
                                    // path wraps within the cap. +6 = border (2) + padding (2) + glyph and its space (2).
                                    width={Math.min(60, dims().width - 6, n.text.length + 6)}
                                    backgroundColor={theme().bgRaised}
                                    border
                                    borderColor={noticeColor(n.kind)}
                                    paddingLeft={1}
                                    paddingRight={1}
                                >
                                    <text fg={noticeColor(n.kind)}>
                                        {n.kind === "error" ? GLYPHS.cross : n.kind === "warn" ? GLYPHS.warning : GLYPHS.circle} {n.text}
                                    </text>
                                </box>
                            )}
                        </Show>
                    </box>

                    {/* Full-height sidebar: spans both the stream and the input; ctrl+b toggles it. */}
                    <Show when={sidebarOpen()}>
                        <Sidebar messageCount={conversation.messageCount} />
                    </Show>
                </box>

                {/* which-key: while a leader sequence is pending, lists the reachable next keys.
                Base-mode only, so it never overlaps a modal (a dialog suppresses base bindings). */}
                <WhichKey />

                {/* Dialog host: the top modal floats above the chat as a full-screen absolute
                overlay. It is a direct child of the full-screen root box (NOT a Portal — a
                Portal's wrapper box has no size, so absolute insets would collapse it to the
                bottom). zIndex lifts it above the chat siblings; the scrim dims them; the
                in-flow child is centered. Only the top dialog is mounted. */}
                <Show when={dialogTop()} keyed>
                    {(render: () => JSX.Element) => (
                        <box position="absolute" top={0} left={0} right={0} bottom={0} zIndex={zIndex.modal} alignItems="center" justifyContent="center">
                            <box position="absolute" top={0} left={0} right={0} bottom={0} backgroundColor={theme().bg} opacity={0.92} />
                            {render()}
                        </box>
                    )}
                </Show>
            </box>
        </WorkspaceContext.Provider>
    );
}
