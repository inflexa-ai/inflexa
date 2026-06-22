import { createSignal, createEffect, For, Show, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { TextareaRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";

import { Bus } from "../lib/bus.ts";
import { GLYPHS } from "../lib/glyphs.ts";
import { zIndex } from "../lib/z_index.ts";
import { shutdown } from "../lib/shutdown.ts";
import { listSessionMessages } from "../db/primary_query.ts";
import { chat } from "../modules/session/chat.ts";
import { theme, noticeColor, type Notice } from "./theme.ts";
import { chatStatus, setChatStatus } from "./hooks/status.ts";
import { currentNotice } from "./hooks/notice.ts";
import { commands } from "./commands.tsx";
import { CommandPalette, runCommand } from "./components/command_palette.tsx";
import { useKeymapRoot, useBindings, pushMode, MODE_BASE, MODE_MODAL, resolveKeybind, keybindLabel, leaderSeq } from "./keymap.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { MessageBlock } from "./layout/message_block.tsx";
import { InputBar } from "./layout/input_bar.tsx";
import { Sidebar } from "./layout/sidebar.tsx";
import { WhichKey } from "./layout/which_key.tsx";
import { WorkspaceContext, createWorkspace } from "./contexts/workspace.ts";
import type { Analysis } from "../types/analysis.ts";
import type { BusEvent } from "../types/events.ts";
import type { Part, TextPart } from "../types/session.ts";

type UIMessage = {
    id: string;
    role: "user" | "assistant";
    parts: Part[];
};

type AppProps = {
    sessionId: string;
    workingDir: string;
    analysis: Analysis;
};

export function App(props: AppProps) {
    const dims = useTerminalDimensions();
    const renderer = useRenderer();

    const [messages, setMessages] = createStore<UIMessage[]>([]);
    const [streamText, setStreamText] = createSignal("");
    const [streamPartId, setStreamPartId] = createSignal<string | null>(null);
    const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

    const [sidebarOpen, setSidebarOpen] = createSignal(true);

    // Dialog host: a stack of render thunks; only the top one is mounted (see the render below).
    const [dialogs, setDialogs] = createStore<Array<() => JSX.Element>>([]);
    const dialogOpen = (): boolean => dialogs.length > 0;
    const dialogTop = (): (() => JSX.Element) | null => (dialogs.length > 0 ? dialogs[dialogs.length - 1]! : null);

    let textareaRef: TextareaRenderable | null = null;
    let abortController: AbortController | null = null;

    function loadMessages(sessionId: string): void {
        listSessionMessages(sessionId).match(
            (existing) => {
                const uiMsgs: UIMessage[] = existing.map((m) => ({
                    id: m.info.id,
                    role: m.info.role,
                    parts: m.parts,
                }));
                setMessages(uiMsgs);
            },
            (error) => {
                setErrorMsg(`Failed to load messages: ${error.type}`);
                setChatStatus("error");
            },
        );
    }

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
    // contexts/workspace.ts; App supplies the capabilities (which close over its local state) and a
    // hot-state reset hook. Seeded once from props — App mounts a single time with fixed props — so
    // the body-level reads are a deliberate one-time seed, hence the scoped disable.
    /* eslint-disable solid/reactivity -- seed-once: App mounts once with fixed props; the store is seeded from them and thereafter written only via openSession */
    const workspace = createWorkspace({
        analysis: props.analysis,
        sessionId: props.sessionId,
        workingDir: props.workingDir,
        openDialog,
        closeDialog,
        quit,
        onOpenSession: (sessionId) => {
            abortController?.abort(); // stop any in-flight stream before loading the new session
            setStreamPartId(null);
            setStreamText("");
            setErrorMsg(null);
            setChatStatus("idle");
            setMessages([]);
            loadMessages(sessionId);
        },
    });
    /* eslint-enable solid/reactivity */

    onMount(() => loadMessages(workspace.sessionId));

    const handler = (event: BusEvent) => {
        switch (event.type) {
            case "session.status":
                if (event.sessionId === workspace.sessionId) {
                    setChatStatus(event.status);
                    if (event.status === "idle" && streamPartId()) {
                        const pid = streamPartId()!;
                        const text = streamText();
                        setMessages(
                            produce((msgs) => {
                                for (const msg of msgs) {
                                    const idx = msg.parts.findIndex((p) => p.id === pid);
                                    if (idx !== -1) {
                                        (msg.parts[idx] as TextPart).text = text;
                                        break;
                                    }
                                }
                            }),
                        );
                        setStreamPartId(null);
                        setStreamText("");
                    }
                }
                break;

            case "message.created":
                if (event.message.sessionId === workspace.sessionId) {
                    setMessages(
                        produce((msgs) => {
                            msgs.push({
                                id: event.message.id,
                                role: event.message.role,
                                parts: [],
                            });
                        }),
                    );
                }
                break;

            case "part.updated": {
                const part = event.part;
                if (part.sessionId !== workspace.sessionId) break;
                setMessages(
                    produce((msgs) => {
                        const msg = msgs.find((m) => m.id === part.messageId);
                        if (!msg) return;
                        const idx = msg.parts.findIndex((p) => p.id === part.id);
                        if (idx === -1) {
                            msg.parts.push(part);
                        } else {
                            msg.parts[idx] = part;
                        }
                    }),
                );
                break;
            }

            case "part.delta":
                if (event.sessionId !== workspace.sessionId) break;
                if (streamPartId() !== event.partId) {
                    setStreamPartId(event.partId);
                    setStreamText(event.delta);
                } else {
                    setStreamText((prev) => prev + event.delta);
                }
                break;

            case "session.error":
                if (event.sessionId === workspace.sessionId) {
                    setErrorMsg(event.error);
                    setChatStatus("error");
                }
                break;
        }
    };

    onMount(() => {
        Bus.on("inf", handler);
        onCleanup(() => Bus.off("inf", handler));
    });

    // The single root keyboard handler that drives the keymap engine. Every binding below is a
    // declarative layer; the dispatcher picks the winner — no hand-branched if/else here.
    useKeymapRoot();

    // Streaming abort stays active even with a dialog open (no `mode`), so a response can always
    // be cancelled; high priority so it wins over any modal binding that shares ctrl+c. The thunk
    // is re-invoked by the dispatcher per keystroke, so the chatStatus() read is always fresh.
    useBindings(() => ({
        enabled: chatStatus() === "busy",
        priority: 100,
        bindings: [{ chord: resolveKeybind("app.abort"), run: () => abortController?.abort() }],
    }));

    function runCommandById(id: string): void {
        const cmd = commands.find((c) => c.id === id);
        if (cmd) void runCommand(cmd, workspace);
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

    // A focus-`target` layer: clear-input (ctrl+u) is live only while the chat textarea is focused —
    // the fine-grained complement to `mode`, so it never fires when a dialog input owns focus.
    useBindings(() => ({
        mode: MODE_BASE,
        target: textareaRef,
        bindings: [{ chord: resolveKeybind("app.clear-input"), run: () => textareaRef?.setText(""), desc: "Clear input", group: "Input" }],
    }));

    // Push MODE_MODAL while any dialog is open and pop it when the stack empties (or App unmounts).
    // Re-runs on each length change: a nested open pops the prior push then adds one, so exactly
    // one modal entry is ever on the stack.
    createEffect(() => {
        if (dialogs.length === 0) return;
        const pop = pushMode(MODE_MODAL);
        onCleanup(pop);
    });

    async function handleSubmit() {
        if (chatStatus() === "busy") return;
        const text = textareaRef?.editBuffer.getText().trim();
        if (!text) return;
        textareaRef!.setText("");
        setErrorMsg(null);

        if (text === "/quit" || text === "/exit") {
            renderer.destroy();
            await shutdown(0);
        }

        abortController = new AbortController();
        (
            await chat({
                sessionId: workspace.sessionId,
                userText: text,
                abort: abortController.signal,
            })
        ).match(
            () => {},
            (error) => {
                setErrorMsg(`Chat error: ${error.type}`);
                setChatStatus("error");
            },
        );
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
            <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg}>
                {/* Header */}
                <StatusBar
                    title="inf"
                    subtitle={workspace.analysis?.name}
                    state={statusState()}
                    hints={[keybindLabel("app.command-palette"), keybindLabel("app.toggle-sidebar"), keybindLabel("app.abort")]}
                />

                {/* Main row: the chat column beside the full-height sidebar. Showing the sidebar
                shrinks the chat column (stream + input together) — the opencode layout. */}
                <box flexDirection="row" flexGrow={1} minHeight={0} width="100%">
                    <box flexDirection="column" flexGrow={1} minHeight={0}>
                        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1} paddingTop={1}>
                            <Show when={messages.length === 0}>
                                <box paddingTop={1} paddingBottom={1}>
                                    <text fg={theme().muted}>Welcome to inf. Type a message to begin.</text>
                                </box>
                            </Show>
                            <For each={messages}>
                                {(msg) => <MessageBlock role={msg.role} parts={msg.parts} streamPartId={streamPartId} streamText={streamText} />}
                            </For>
                        </scrollbox>

                        {/* Error banner */}
                        <Show when={errorMsg()}>
                            <box height={1} width="100%" backgroundColor={theme().error} paddingLeft={1}>
                                <text fg={theme().bg}>{errorMsg()}</text>
                            </box>
                        </Show>

                        {/* Input area */}
                        <InputBar
                            onTextareaRef={(r: TextareaRenderable) => {
                                textareaRef = r;
                                queueMicrotask(() => r.focus());
                            }}
                            onSubmit={() => void handleSubmit()}
                        />
                    </box>

                    {/* Full-height sidebar: spans both the stream and the input; ctrl+b toggles it. */}
                    <Show when={sidebarOpen()}>
                        <Sidebar messageCount={() => messages.length} />
                    </Show>
                </box>

                {/* which-key: while a leader sequence is pending, lists the reachable next keys.
                Base-mode only, so it never overlaps a modal (a dialog suppresses base bindings). */}
                <WhichKey />

                {/* Transient toast: a floating top-right overlay (OpenCode-style), single slot,
                auto-dismissed by the notice store. zIndex above the dialog host so a notice
                raised by a background event still surfaces over an open modal. top={2} clears
                the height-1 status bar with a one-row gap. */}
                <Show when={currentNotice()} keyed>
                    {(n: Notice) => (
                        <box
                            position="absolute"
                            top={2}
                            right={2}
                            zIndex={zIndex.toast}
                            maxWidth={Math.min(60, dims().width - 6)}
                            backgroundColor={theme().bgPanel}
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
