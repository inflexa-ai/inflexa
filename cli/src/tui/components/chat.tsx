import { For, Show, createEffect, createMemo, on } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { theme } from "../theme.ts";
import { MessageBlock } from "../layout/message_block.tsx";
import { Welcome } from "./welcome.tsx";
import { ThinkingIndicator } from "./thinking_indicator.tsx";
import { ScrollPane } from "./scroll_pane.tsx";
import { useWorkspace } from "../contexts/workspace.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { chatStatus } from "../hooks/status.ts";
import { bootState } from "../hooks/boot.ts";
import { messages, streamText, streamPartId, errorMsg, loadMessages, resetHotState } from "../hooks/conversation.ts";

/**
 * The live conversation: the sticky message stream plus the error banner. State (the message store,
 * the streaming buffer, the error) lives in `hooks/conversation.ts`; the transcript arrives through
 * that store's harness emit adapter, not the bus (the bus carries only prov events, for the sidebar),
 * and this component owns only the reactive transcript load tied to the open session and the runtime
 * boot. The `Sidebar` reads the same store's `messageCount`, so the store is shared rather than private here.
 */
export type ChatProps = {
    /**
     * Receives the stream's scroll pane on mount. Scroll keys live inside `ScrollPane`; App needs
     * the ref only as a focus target — `esc` focuses it (NORMAL mode) and the `i`/enter layer is
     * gated on it.
     */
    onScrollPaneRef: (r: ScrollBoxRenderable) => void;
};

export function Chat(props: ChatProps) {
    const ws = useWorkspace();

    // Load the transcript from the pg thread, reacting to BOTH the open session AND the runtime boot
    // reaching `ready` — the pg thread read needs the booted pool, so a session opened while booting
    // loads once boot flips to `ready`. On an in-place session swap, reset the hot state
    // before loading the new thread. `on` runs once immediately, then on each session/phase change.
    createEffect(
        on(
            () => [ws.sessionId, bootState().phase] as const,
            ([sessionId, phase], prev) => {
                const prevSessionId = prev?.[0];
                if (prevSessionId !== undefined && prevSessionId !== sessionId) resetHotState();
                // Legacy/unscoped chats have no analysis to key the pg thread's card resolver on;
                // they render empty (SQLite history is frozen, not shown here).
                const analysis = ws.analysis;
                if (phase === "ready" && analysis) void loadMessages(sessionId, analysis.id);
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
            {/* focusOnMount=false: the ChatBar textarea owns focus at startup (INSERT); esc hands
            focus to this pane, which is when its scroll keys go live. */}
            <ScrollPane
                onRef={(r: ScrollBoxRenderable) => props.onScrollPaneRef(r)}
                focusOnMount={false}
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
                            interrupted={msg.interrupted}
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
            </ScrollPane>

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
