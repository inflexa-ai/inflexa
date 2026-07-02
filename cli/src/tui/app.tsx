import { createSignal, Show } from "solid-js";
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
import { dialogPush, dialogClose, dialogIsOpen, DialogOverlay } from "./components/dialog/dialog_host.tsx";
import { useKeymapRoot, useBindings, MODE_BASE, resolveKeybind, keybindLabel, leaderSeq, KEYS } from "./keymap.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { Chat } from "./components/chat.tsx";
import { ChatBar } from "./layout/chat_bar.tsx";
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

    // INSERT vs NORMAL is pure focus: the textarea holds focus in INSERT (the default); esc moves
    // focus to the stream's ScrollPane (NORMAL — its focus-gated scroll keys go live). Focus is
    // ALWAYS on one of the two widgets, so the dialog host's save/restore never sees a null focus.
    let textareaRef: TextareaRenderable | null = null;
    let scrollPaneRef: ScrollBoxRenderable | null = null;

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
        openDialog: dialogPush,
        closeDialog: dialogClose,
        quit,
    });
    /* eslint-enable solid/reactivity */

    // The single root keyboard handler that drives the keymap engine. Every binding below is a
    // declarative layer; the dispatcher picks the winner — no hand-branched if/else here.
    useKeymapRoot();

    // Three-way ctrl+c: dismiss dialog → abort stream → quit. Always active (no `mode` gate),
    // high priority so it wins over any modal binding that shares the chord.
    // A dialog may VETO its dismissal (busy prompt, dirty config). The first vetoed press stops
    // there — the veto blocks accidental dismissal and the dialog shows its own feedback; a quick
    // second press escalates past the stuck dialog to the next tier, keeping a panic exit within
    // two keystrokes.
    let lastVetoAt = 0;
    const VETO_ESCALATE_WINDOW_MS = 1500;
    useBindings(() => ({
        priority: 100,
        bindings: [
            {
                chord: resolveKeybind("app.abort"),
                run: () => {
                    if (dialogIsOpen()) {
                        // When text is selected inside a dialog, ctrl+c copies instead of dismissing —
                        // matches OpenCode's selection-aware behavior.
                        const selected = renderer.getSelection()?.getSelectedText();
                        if (selected) {
                            void writeClipboard(selected);
                            notify({ kind: "info", text: "Copied to clipboard" });
                            renderer.clearSelection();
                            return;
                        }
                        if (dialogClose("dismiss")) {
                            lastVetoAt = 0;
                            return;
                        }
                        const now = Date.now();
                        const escalate = now - lastVetoAt < VETO_ESCALATE_WINDOW_MS;
                        lastVetoAt = now;
                        if (!escalate) return;
                    }
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
            { chord: resolveKeybind("app.command-palette"), run: () => dialogPush(() => <CommandPalette commands={commands} />) },
            { chord: resolveKeybind("app.toggle-sidebar"), run: () => setSidebarOpen((open) => !open) },
            {
                chord: leaderSeq("k"),
                run: () => dialogPush(() => <CommandPalette commands={commands} />),
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

    // A focus-`target` layer: clear-input (ctrl+u) is live only while the chat textarea is focused —
    // the fine-grained complement to `mode`, so it never fires when a dialog input owns focus. esc
    // FOCUSES the stream's ScrollPane (NORMAL mode) — never a bare blur, so focus always lands on a
    // widget. The pane's own focus-gated layer (see ScrollPane) supplies the vim scroll keys.
    useBindings(() => ({
        mode: MODE_BASE,
        target: textareaRef,
        bindings: [
            { chord: resolveKeybind("app.clear-input"), run: () => textareaRef?.setText(""), desc: "Clear input", group: "Input" },
            { chord: KEYS.escape, run: () => scrollPaneRef?.focus(), desc: "Scroll mode (vim keys)", group: "Input" },
        ],
    }));

    // NORMAL-mode companion layer, live while the stream's pane is focused: returning to INSERT is
    // chat-specific (dialog panes have no input to return to), so it lives here, not in ScrollPane.
    // esc while the pane is focused matches no binding and the native scrollbox handler has no
    // escape case — the deliberate no-op that keeps focus from ever landing nowhere. The shared
    // ctrl+u never clashes across the two layers: each is gated to a disjoint focus target.
    useBindings(() => ({
        mode: MODE_BASE,
        target: scrollPaneRef,
        bindings: [
            { chord: { key: "i" }, run: () => textareaRef?.focus(), desc: "Insert mode", group: "Input" },
            { chord: KEYS.enter, run: () => textareaRef?.focus(), desc: "Focus input", group: "Input" },
        ],
    }));

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
                    notify({ kind: "info", text: "Stream aborted — /quit again to exit" });
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
                        <Chat onScrollPaneRef={(r: ScrollBoxRenderable) => (scrollPaneRef = r)} />

                        {/* Input area */}
                        <ChatBar
                            onTextareaRef={(r: TextareaRenderable) => {
                                textareaRef = r;
                                queueMicrotask(() => r.focus());
                            }}
                            onSubmit={() => void handleSubmit()}
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

                {/* Dialog host: the module-level stack + overlay, extracted to dialog_host.tsx.
                A direct child of the full-screen root box (not a Portal — see dialog_host).
                Focus restore is uniform: some widget (textarea or scroll pane) is always focused
                when a dialog opens, so the saved focus is never null. */}
                <DialogOverlay />
            </box>
        </WorkspaceContext.Provider>
    );
}
