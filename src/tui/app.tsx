import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { TextareaRenderable, KeyBinding } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";

import { Bus } from "../lib/bus.ts";
import { shutdown } from "../lib/shutdown.ts";
import { getSessionMessages } from "../db/primary_query.ts";
import { chat } from "../chat/agent.ts";
import { syntaxStyle, theme } from "./theme.ts";
import type { BusEvent, Part, TextPart } from "../types.ts";

type UIMessage = {
    id: string;
    role: "user" | "assistant";
    parts: Part[];
};

type AppProps = {
    sessionId: string;
    workingDir: string;
};

export function App(props: AppProps) {
    const _dims = useTerminalDimensions();
    const renderer = useRenderer();

    const [messages, setMessages] = createStore<UIMessage[]>([]);
    const [status, setStatus] = createSignal<"idle" | "busy" | "error">("idle");
    const [streamText, setStreamText] = createSignal("");
    const [streamPartId, setStreamPartId] = createSignal<string | null>(null);
    const [errorMsg, setErrorMsg] = createSignal<string | null>(null);

    let textareaRef: TextareaRenderable | null = null;
    let abortController: AbortController | null = null;

    onMount(() => {
        getSessionMessages(props.sessionId).match(
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
    });

    const handler = (event: BusEvent) => {
        switch (event.type) {
            case "session.status":
                if (event.sessionId === props.sessionId) {
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
                if (event.message.sessionId === props.sessionId) {
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
                if (part.sessionId !== props.sessionId) break;
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
                if (event.sessionId !== props.sessionId) break;
                if (streamPartId() !== event.partId) {
                    setStreamPartId(event.partId);
                    setStreamText(event.delta);
                } else {
                    setStreamText((prev) => prev + event.delta);
                }
                break;

            case "session.error":
                if (event.sessionId === props.sessionId) {
                    setErrorMsg(event.error);
                    setStatus("error");
                }
                break;
        }
    };
    Bus.on("inf", handler);

    onCleanup(() => Bus.off("inf", handler));

    useKeyboard((key) => {
        if (key.name === "c" && key.ctrl && status() === "busy") {
            abortController?.abort();
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
                sessionId: props.sessionId,
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

    return (
        <box flexDirection="column" width="100%" height="100%">
            {/* Header */}
            <box height={1} width="100%" flexDirection="row" backgroundColor={theme().bgPanel} paddingLeft={1} paddingRight={1}>
                <text fg={theme().accent} attributes={1}>
                    inf
                </text>
                <text fg={theme().muted}> | {props.workingDir.split("/").pop()} | </text>
                <text fg={status() === "busy" ? theme().warn : status() === "error" ? theme().error : theme().success}>
                    {status() === "busy" ? "thinking..." : status() === "error" ? "error" : "ready"}
                </text>
                <text fg={theme().muted}> | Ctrl+C: abort | /quit: exit</text>
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
                                            <markdown content={content()} syntaxStyle={syntaxStyle()} streaming={isStreaming()} paddingLeft={2} />
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
        </box>
    );
}
