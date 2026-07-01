import { For, Show, onMount, onCleanup, createEffect, createMemo, on } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { Bus } from "../../lib/bus.ts";
import { theme } from "../theme.ts";
import { MessageBlock } from "../layout/message_block.tsx";
import { Welcome } from "./welcome.tsx";
import { ThinkingIndicator } from "./thinking_indicator.tsx";
import { useWorkspace } from "../contexts/workspace.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { chatStatus } from "../hooks/status.ts";
import { messages, streamText, streamPartId, errorMsg, applyBusEvent, loadMessages, resetHotState } from "../hooks/conversation.ts";
import type { BusEvent } from "../../types/events.ts";

/**
 * The live conversation: the sticky message stream plus the error banner. State (the message store,
 * the streaming buffer, the error) lives in `hooks/conversation.ts`; this component owns the bus
 * subscription that feeds it and the reactive load/reset tied to the open session. The `Sidebar`
 * reads the same store's `messageCount`, so the store is shared rather than private here.
 */
export type ChatProps = {
    /** Receives the scrollbox renderable on mount, so App's scroll keybinds can drive it. */
    onScrollboxRef: (r: ScrollBoxRenderable) => void;
};

export function Chat(props: ChatProps) {
    const ws = useWorkspace();

    // The bus drives all message/stream mutations; filter each event by the currently-open session
    // (read fresh per event — `ws.sessionId` is a reactive store field that a swap updates in place).
    const handler = (event: BusEvent): void => applyBusEvent(event, ws.sessionId);
    onMount(() => {
        Bus.on("inflexa", handler);
        onCleanup(() => Bus.off("inflexa", handler));
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

    // Anchor for the welcome block. Pure `getAnchor` (NOT `resolveAnchor`, which writes a sighting
    // heartbeat), so showing the empty-state welcome touches no disk — the no-litter rule.
    const anchor = createMemo(() => {
        const a = ws.analysis;
        if (!a) return null;
        return getAnchor(a.anchorId).match(
            (x) => x,
            () => null,
        );
    });

    return (
        <box flexDirection="column" flexGrow={1} minHeight={0}>
            <scrollbox
                ref={(r: ScrollBoxRenderable) => props.onScrollboxRef(r)}
                flexGrow={1}
                stickyScroll
                stickyStart="bottom"
                paddingLeft={1}
                paddingRight={1}
                paddingTop={1}
            >
                <Show when={messages.length === 0}>
                    <Welcome
                        greeting="welcome to inflexa"
                        anchorPath={anchor()?.cachedPath}
                        markerWritten={anchor()?.markerWritten}
                        hints={["ctrl+k commands", "ctrl+j newline", "ctrl+x leader", "esc scroll mode"]}
                    />
                </Show>
                {/* index() is the 1-based position within the mounted window (capped at MESSAGE_CAP);
                for sessions under the cap it is the true turn number, and even past it a running
                counter is what the numbering is for. */}
                <For each={messages}>
                    {(msg, index) => (
                        <MessageBlock
                            index={index() + 1}
                            role={msg.role}
                            durationMs={msg.durationMs}
                            parts={msg.parts}
                            streamPartId={streamPartId}
                            streamText={streamText}
                        />
                    )}
                </For>

                {/* Live "thinking" indicator: sits under the last (assistant) turn for the whole busy
                window — before the first token and while text streams below it — so the wait reads as
                active. Inside the scrollbox so it scrolls with the conversation, not as fixed chrome. */}
                <Show when={chatStatus() === "busy"}>
                    <ThinkingIndicator />
                </Show>
            </scrollbox>

            {/* Error banner: onAccent is the readable foreground on the filled error background
                (replaces the prior bg-reuse hack of painting fg with the app background). */}
            <Show when={errorMsg()}>
                <box height={1} width="100%" backgroundColor={theme().error} paddingLeft={1}>
                    <text fg={theme().onAccent}>{errorMsg()}</text>
                </box>
            </Show>
        </box>
    );
}
