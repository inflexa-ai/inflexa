import { createSignal, createEffect, For, Show, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { TextareaRenderable, KeyBinding } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";

import { Bus } from "../lib/bus.ts";
import { shutdown } from "../lib/shutdown.ts";
import { listSessionMessages } from "../db/primary_query.ts";
import { chat } from "../modules/session/chat.ts";
import { syntaxStyle, theme } from "./theme.ts";
import { commands } from "./commands.tsx";
import { CommandPalette } from "./command_palette.tsx";
import type { CommandContext, Notice } from "./commands.tsx";
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
    const [status, setStatus] = createSignal<"idle" | "busy" | "error">("idle");
    const [streamText, setStreamText] = createSignal("");
    const [streamPartId, setStreamPartId] = createSignal<string | null>(null);
    const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

    // The open chat is reactive (not a static prop) so the command palette can swap it in place.
    const [currentSessionId, setCurrentSessionId] = createSignal(props.sessionId);
    const [currentWorkingDir, setCurrentWorkingDir] = createSignal(props.workingDir);
    const [currentAnalysis, setCurrentAnalysis] = createSignal<Analysis>(props.analysis);

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
                setStatus("error");
            },
        );
    }

    onMount(() => loadMessages(currentSessionId()));

    const handler = (event: BusEvent) => {
        switch (event.type) {
            case "session.status":
                if (event.sessionId === currentSessionId()) {
                    setStatus(event.status);
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
                    setStatus("error");
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
        if (key.name === "c" && key.ctrl && status() === "busy") {
            abortController?.abort();
            return;
        }
        // useKeyboard is a global, focus-agnostic bus: while a dialog is open it owns the
        // keyboard, so the chat's background handlers early-return.
        if (dialogOpen()) return;
        if (key.name === "k" && key.ctrl) {
            // preventDefault so the focused textarea does not also consume the keystroke.
            key.preventDefault();
            openDialog(() => <CommandPalette ctx={buildCtx()} commands={commands} />);
        }
    });

    const keyBindings: KeyBinding[] = [
        { name: "return", action: "submit" },
        { name: "return", meta: true, action: "newline" },
    ];

    async function handleSubmit() {
        if (status() === "busy") return;
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
                setStatus("error");
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
        setStatus("idle");
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

    return (
        // Paint the screen with the theme background — without it the terminal's own
        // background shows through, which is invisible for dark themes (terminal black
        // ≈ theme bg) but breaks light themes (dark fg text on a black screen).
        <box flexDirection="column" width="100%" height="100%" backgroundColor={theme().bg}>
            {/* Header */}
            <box height={1} width="100%" flexDirection="row" backgroundColor={theme().bgPanel} paddingLeft={1} paddingRight={1}>
                <text fg={theme().accent} attributes={1}>
                    inf
                </text>
                <text fg={theme().muted}> | {currentWorkingDir().split("/").pop()} | </text>
                <text fg={status() === "busy" ? theme().warn : status() === "error" ? theme().error : theme().success}>
                    {status() === "busy" ? "thinking..." : status() === "error" ? "error" : "ready"}
                </text>
                <text fg={theme().muted}> | Ctrl+K: commands | Ctrl+C: abort | /quit: exit</text>
            </box>

            {/* Chat area */}
            <scrollbox flexGrow={1} width="100%" stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1} paddingTop={1}>
                <Show when={messages.length === 0}>
                    <box paddingTop={1} paddingBottom={1}>
                        <text fg={theme().muted}>Welcome to inf. Type a message to begin.</text>
                    </box>
                </Show>
                <For each={messages}>
                    {(msg) => (
                        <box width="100%" flexDirection="column" paddingBottom={1}>
                            <text fg={msg.role === "user" ? theme().user : theme().assistant} attributes={1}>
                                {msg.role === "user" ? "> You" : "< Assistant"}
                            </text>
                            <For each={msg.parts}>
                                {(part) => {
                                    const p = part as TextPart;
                                    const isStreaming = () => streamPartId() === p.id;
                                    const content = () => (isStreaming() ? streamText() : p.text);
                                    return (
                                        <Show when={content()}>
                                            <markdown
                                                content={content()}
                                                fg={theme().fg}
                                                syntaxStyle={syntaxStyle()}
                                                streaming={isStreaming()}
                                                paddingLeft={2}
                                            />
                                        </Show>
                                    );
                                }}
                            </For>
                        </box>
                    )}
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
                <box
                    height={1}
                    width="100%"
                    backgroundColor={notice()!.kind === "error" ? theme().error : notice()!.kind === "warn" ? theme().warn : theme().info}
                    paddingLeft={1}
                >
                    <text fg={theme().bg}>{notice()!.text}</text>
                </box>
            </Show>

            {/* Input area */}
            <box width="100%" minHeight={3} maxHeight={8} borderColor={theme().borderActive} border paddingLeft={1} paddingRight={1}>
                <textarea
                    ref={(r: TextareaRenderable) => {
                        textareaRef = r;
                        queueMicrotask(() => r.focus());
                    }}
                    focused
                    width="100%"
                    placeholder="Type a message... (Enter to send, Meta+Enter for newline)"
                    placeholderColor={theme().muted}
                    textColor={theme().fg}
                    backgroundColor={theme().bg}
                    focusedBackgroundColor={theme().bgFocused}
                    keyBindings={keyBindings}
                    onSubmit={() => void handleSubmit()}
                />
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
