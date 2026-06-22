import { createSignal, createEffect, For, Show, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";

import { Bus } from "../lib/bus.ts";
import { shutdown } from "../lib/shutdown.ts";
import { listSessionMessages } from "../db/primary_query.ts";
import { chat } from "../modules/session/chat.ts";
import { theme, noticeColor, type Notice } from "./theme.ts";
import { chatStatus, setChatStatus } from "./hooks/status.ts";
import { commands } from "./commands.tsx";
import { CommandPalette } from "./command_palette.tsx";
import { KEYMAP, matchChord } from "./keymap.ts";
import { StatusBar } from "./layout/status_bar.tsx";
import { MessageBlock } from "./layout/message_block.tsx";
import { InputBar } from "./layout/input_bar.tsx";
import { Sidebar } from "./layout/sidebar.tsx";
import type { CommandContext } from "./commands.tsx";
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
    const _dims = useTerminalDimensions();
    const renderer = useRenderer();

    const [messages, setMessages] = createStore<UIMessage[]>([]);
    const [streamText, setStreamText] = createSignal("");
    const [streamPartId, setStreamPartId] = createSignal<string | null>(null);
    const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

    // The open chat is locally-owned, mutable state the command palette swaps in place (via the
    // setters below). It is SEEDED ONCE from props: `App` is mounted a single time with fixed
    // props (see `launch.tsx`), so reading them at body level is a deliberate one-time seed, not a
    // dependency to track — hence the scoped disable. (Use a `createEffect` instead only if a prop
    // should keep a signal in sync; that is not the case here.)
    /* eslint-disable solid/reactivity -- seed-once: App mounts once with fixed props; these are locally mutated */
    const [currentSessionId, setCurrentSessionId] = createSignal(props.sessionId);
    const [currentWorkingDir, setCurrentWorkingDir] = createSignal(props.workingDir);
    const [currentAnalysis, setCurrentAnalysis] = createSignal<Analysis>(props.analysis);
    /* eslint-enable solid/reactivity */

    const [sidebarOpen, setSidebarOpen] = createSignal(true);

    // Dialog host: a stack of render thunks; only the top one is mounted (see the render below).
    const [dialogs, setDialogs] = createStore<Array<() => JSX.Element>>([]);
    const dialogOpen = (): boolean => dialogs.length > 0;
    const dialogTop = (): (() => JSX.Element) | null => (dialogs.length > 0 ? dialogs[dialogs.length - 1]! : null);

    // Transient status-line feedback from commands (the stdout-free channel).
    const [notice, setNotice] = createSignal<Notice | null>(null);
    let noticeTimer: ReturnType<typeof setTimeout> | null = null;

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

    onMount(() => loadMessages(currentSessionId()));

    const handler = (event: BusEvent) => {
        switch (event.type) {
            case "session.status":
                if (event.sessionId === currentSessionId()) {
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
                if (event.message.sessionId === currentSessionId()) {
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
                if (part.sessionId !== currentSessionId()) break;
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
                if (event.sessionId !== currentSessionId()) break;
                if (streamPartId() !== event.partId) {
                    setStreamPartId(event.partId);
                    setStreamText(event.delta);
                } else {
                    setStreamText((prev) => prev + event.delta);
                }
                break;

            case "session.error":
                if (event.sessionId === currentSessionId()) {
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

    useKeyboard((key) => {
        // The streaming abort stays active even with a dialog open, so a response can be cancelled.
        if (matchChord(KEYMAP.abort.chord, key) && chatStatus() === "busy") {
            abortController?.abort();
            return;
        }
        // useKeyboard is a global, focus-agnostic bus: while a dialog is open it owns the
        // keyboard, so the chat's background handlers early-return.
        if (dialogOpen()) return;
        if (matchChord(KEYMAP.openPalette.chord, key)) {
            // preventDefault so the focused textarea does not also consume the keystroke.
            key.preventDefault();
            openDialog(() => <CommandPalette ctx={buildCtx()} commands={commands} />);
        } else if (matchChord(KEYMAP.toggleSidebar.chord, key)) {
            // preventDefault so the focused textarea does not also consume the keystroke.
            key.preventDefault();
            setSidebarOpen((open) => !open);
        }
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
                sessionId: currentSessionId(),
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

    function openDialog(render: () => JSX.Element): void {
        setDialogs(produce((d) => d.push(render)));
    }

    function closeDialog(): void {
        setDialogs(produce((d) => d.pop()));
    }

    // Restore focus to the chat input whenever the last dialog closes (a dialog's input grabs
    // the single focus slot; nothing returns it automatically).
    createEffect(() => {
        if (!dialogOpen()) queueMicrotask(() => textareaRef?.focus());
    });

    function notify(n: Notice): void {
        if (noticeTimer) clearTimeout(noticeTimer);
        setNotice(n);
        noticeTimer = setTimeout(() => setNotice(null), 4000);
    }

    // Swap the open chat in place — resume a different analysis/session without a process restart.
    function openSession(sessionId: string, workingDir: string, analysis: Analysis): void {
        abortController?.abort(); // stop any in-flight stream before loading the new session
        setCurrentSessionId(sessionId);
        setCurrentWorkingDir(workingDir);
        setCurrentAnalysis(analysis);
        setStreamPartId(null);
        setStreamText("");
        setErrorMsg(null);
        setChatStatus("idle");
        setMessages([]);
        loadMessages(sessionId);
    }

    function buildCtx(): CommandContext {
        return {
            sessionId: currentSessionId(),
            workingDir: currentWorkingDir(),
            analysis: currentAnalysis(),
            openDialog,
            closeDialog,
            openSession,
            notify,
            quit: async () => {
                renderer.destroy();
                await shutdown(0);
            },
        };
    }

    const statusState = (): { text: string; tone: "success" | "warn" | "error" } =>
        chatStatus() === "busy"
            ? { text: "◐ thinking…", tone: "warn" }
            : chatStatus() === "error"
              ? { text: "✗ error", tone: "error" }
              : { text: "● ready", tone: "success" };

    return (
        // Paint the screen with the theme background — without it the terminal's own
        // background shows through, which is invisible for dark themes (terminal black
        // ≈ theme bg) but breaks light themes (dark fg text on a black screen).
        <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg}>
            {/* Header */}
            <StatusBar
                title="inf"
                subtitle={currentAnalysis().name}
                state={statusState()}
                hints={[KEYMAP.openPalette.label, KEYMAP.toggleSidebar.label, KEYMAP.abort.label]}
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

                    {/* Transient command feedback */}
                    <Show when={notice()}>
                        <box height={1} width="100%" backgroundColor={noticeColor(notice()!.kind)} paddingLeft={1}>
                            <text fg={theme().bg}>{notice()!.text}</text>
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
                    <Sidebar analysis={currentAnalysis} sessionId={currentSessionId} messageCount={() => messages.length} />
                </Show>
            </box>

            {/* Dialog host: the top modal floats above the chat as a full-screen absolute
                overlay. It is a direct child of the full-screen root box (NOT a Portal — a
                Portal's wrapper box has no size, so absolute insets would collapse it to the
                bottom). zIndex lifts it above the chat siblings; the scrim dims them; the
                in-flow child is centered. Only the top dialog is mounted. */}
            <Show when={dialogTop()} keyed>
                {(render: () => JSX.Element) => (
                    <box position="absolute" top={0} left={0} right={0} bottom={0} zIndex={100} alignItems="center" justifyContent="center">
                        <box position="absolute" top={0} left={0} right={0} bottom={0} backgroundColor={theme().bg} opacity={0.92} />
                        {render()}
                    </box>
                )}
            </Show>
        </box>
    );
}
