import { For, Show, createEffect, createMemo, on } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";

import { theme } from "../theme.ts";
import { MessageBlock, ReportSessionEntry } from "../layout/message_block.tsx";
import { Welcome } from "./welcome.tsx";
import { ThinkingIndicator } from "./thinking_indicator.tsx";
import { ScrollPane } from "./scroll_pane.tsx";
import { useWorkspace } from "../contexts/workspace.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { chatStatus } from "../hooks/status.ts";
import { bootState } from "../hooks/boot.ts";
import { messages, streamText, streamPartId, errorMsg, loadMessages, resetHotState } from "../hooks/conversation.ts";
import { reportChildren, watchReportChildren } from "../hooks/report_children.ts";

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

    // The report sessions of the open thread. The store (`hooks/report_children.ts`) owns the read and
    // the refresh edge; the persisted `report-session` part inside each turn owns the position, and
    // `MessageBlock` renders the entry there. A failed listing gives no children, thus the transcript
    // stays whole. What remains here is the TAIL: the children that no mounted part claims.
    watchReportChildren(ws);

    // The thread ids that a mounted `report-session` part claims, computed ONCE for each change of the
    // messages. A claimed child renders at its part; the rest render at the tail below — a session
    // spawned before the part became durable, or a part whose message left the mounted window.
    const claimedThreadIds = createMemo((): Set<string> => {
        const claimed = new Set<string>();
        for (const message of messages) {
            for (const part of message.parts) {
                if (part.type === "report-session") claimed.add(part.threadId);
            }
        }
        return claimed;
    });
    const tailThreadIds = (): string[] =>
        reportChildren()
            .filter((child) => !claimedThreadIds().has(child.threadId))
            .map((child) => child.threadId);

    // Turn number per store position, computed ONCE per messages change rather than per row.
    //
    // It counts TURNS, so `event` entries — records this app appended for out-of-band work, which
    // nobody said — take no number: numbering them would claim a turn happened where none did, and
    // would renumber every turn after a run finished. They still occupy a slot here (holding their
    // preceding turn's count) purely so the array can be indexed by store position; `MessageBlock`
    // renders no number for them.
    //
    // A memo rather than the obvious per-row `slice().filter().length`: that form is O(n²) over
    // MESSAGE_CAP rows AND makes every row's number depend on the whole array, so one append
    // recomputes all of them.
    const turnNumbers = createMemo((): number[] => {
        let turns = 0;
        return messages.map((m) => (m.role === "event" ? turns : ++turns));
    });

    // Load the transcript from the pg thread, reacting to BOTH the bound thread AND the runtime boot
    // reaching `ready` — the pg thread read needs the booted pool, and the thread itself is bound only
    // at that same edge. On an in-place session swap, reset the hot state before loading the new
    // thread. `on` runs once immediately, then on each thread/phase change.
    createEffect(
        on(
            () => [ws.sessionId, bootState().phase] as const,
            ([sessionId, phase], prev) => {
                const prevSessionId = prev?.[0];
                if (prevSessionId !== undefined && prevSessionId !== sessionId) resetHotState();
                // No thread bound yet (pre-`ready`, or its resolution still in flight) means there is
                // nothing to read; the chat renders empty until the bind lands and re-fires this effect.
                // An unscoped chat likewise has no analysis to key the thread's card resolver on.
                const analysis = ws.analysis;
                if (phase === "ready" && analysis && sessionId !== null) void loadMessages(sessionId, analysis.id);
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
                {/* The displayed number is the 1-based TURN position within the mounted window (capped
                at MESSAGE_CAP); for sessions under the cap it is the true turn number, and even past
                it a running counter is what the numbering is for. `index()` is the STORE position and
                cannot supply it once event entries are interleaved — see `turnNumbers`. */}
                <For each={messages}>
                    {(msg, index) => (
                        <MessageBlock
                            index={turnNumbers()[index()] ?? 0}
                            role={msg.role}
                            durationMs={msg.durationMs}
                            turnUsage={msg.turnUsage}
                            interrupted={msg.interrupted}
                            parts={msg.parts}
                            streamPartId={streamPartId}
                            streamText={streamText}
                        />
                    )}
                </For>
                {/* The tail: each live child that no mounted `report-session` part claims. A session
                spawned before the part became durable has no part to sit at, and a part whose message
                left the mounted window is not mounted either — the tail keeps both reachable. */}
                <For each={tailThreadIds()}>{(threadId) => <ReportSessionEntry threadId={threadId} />}</For>

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
