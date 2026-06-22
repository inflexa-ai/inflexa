import { For, Show, onMount, onCleanup, createEffect, on } from "solid-js";

import { Bus } from "../../lib/bus.ts";
import { theme } from "../theme.ts";
import { MessageBlock } from "../layout/message_block.tsx";
import { useWorkspace } from "../contexts/workspace.ts";
import { messages, streamText, streamPartId, errorMsg, applyBusEvent, loadMessages, resetHotState } from "../hooks/conversation.ts";
import type { BusEvent } from "../../types/events.ts";

/**
 * The live conversation: the sticky message stream plus the error banner. State (the message store,
 * the streaming buffer, the error) lives in `hooks/conversation.ts`; this component owns the bus
 * subscription that feeds it and the reactive load/reset tied to the open session. The `Sidebar`
 * reads the same store's `messageCount`, so the store is shared rather than private here.
 */
export function Chat() {
    const ws = useWorkspace();

    // The bus drives all message/stream mutations; filter each event by the currently-open session
    // (read fresh per event — `ws.sessionId` is a reactive store field that a swap updates in place).
    const handler = (event: BusEvent): void => applyBusEvent(event, ws.sessionId);
    onMount(() => {
        Bus.on("inf", handler);
        onCleanup(() => Bus.off("inf", handler));
    });

    // Load on mount, and on an in-place session swap reset the hot state before loading the new
    // session — the reactive replacement for the old imperative `onOpenSession` reset hook. `on`
    // runs once immediately (prev === undefined → load only), then on each `ws.sessionId` change.
    createEffect(
        on(
            () => ws.sessionId,
            (sessionId, prev) => {
                if (prev !== undefined) resetHotState();
                loadMessages(sessionId);
            },
        ),
    );

    return (
        <box flexDirection="column" flexGrow={1} minHeight={0}>
            <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1} paddingTop={1}>
                <Show when={messages.length === 0}>
                    <box paddingTop={1} paddingBottom={1}>
                        <text fg={theme().muted}>Welcome to inf. Type a message to begin.</text>
                    </box>
                </Show>
                <For each={messages}>{(msg) => <MessageBlock role={msg.role} parts={msg.parts} streamPartId={streamPartId} streamText={streamText} />}</For>
            </scrollbox>

            {/* Error banner */}
            <Show when={errorMsg()}>
                <box height={1} width="100%" backgroundColor={theme().error} paddingLeft={1}>
                    <text fg={theme().bg}>{errorMsg()}</text>
                </box>
            </Show>
        </box>
    );
}
