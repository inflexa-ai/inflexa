import { For, Show, createEffect, createMemo, on } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { Thread } from "@inflexa-ai/harness";

import { theme } from "../theme.ts";
import { MessageBlock } from "../layout/message_block.tsx";
import { Welcome } from "./welcome.tsx";
import { ThinkingIndicator } from "./thinking_indicator.tsx";
import { ReportSessionBlock } from "./report_session_block.tsx";
import { ScrollPane } from "./scroll_pane.tsx";
import { useWorkspace } from "../contexts/workspace.ts";
import { getAnchor } from "../../db/primary_query.ts";
import { chatStatus } from "../hooks/status.ts";
import { bootState } from "../hooks/boot.ts";
import { messages, messageSeqMarks, streamText, streamPartId, errorMsg, loadMessages, resetHotState, type MessageSeqMark } from "../hooks/conversation.ts";
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

// One frozen empty listing, thus a position that holds no entry hands `<For>` the same reference on
// each read and reconciles nothing.
const NO_ENTRIES: readonly Thread[] = Object.freeze([]);

/**
 * The mounted position of one report session's entry: after the last mounted message whose mark
 * carries a `seq` that is not greater than the spawn point.
 *
 * Each edge lands on a position, and none of them is a fault:
 *
 * - A spawn point past the loaded transcript takes the END, because the harness can cut a parent tail
 *   behind a spawn point and the entry must still be reachable.
 * - A spawn point below the mounted window takes the TOP, because the transcript mounts the newest
 *   turns alone and an old spawn point has no mounted message at or below it.
 * - A row with no spawn point takes the END. The store pairs a parent with its spawn point, thus a
 *   listing that narrows on a parent gives no such row, but the column permits one.
 */
function slotFor(parentSeq: number | null, marks: readonly MessageSeqMark[], mounted: number): number {
    if (parentSeq === null) return mounted;
    let at = 0;
    for (const mark of marks) {
        if (mark.seq > parentSeq) break;
        at = mark.end;
    }
    return Math.min(Math.max(at, 0), mounted);
}

export function Chat(props: ChatProps) {
    const ws = useWorkspace();

    // The report sessions of the open thread. The store (`hooks/report_children.ts`) owns the read and
    // the refresh edge, and this component only places what it holds — the same split as the transcript
    // load below. A failed listing gives no children, thus the transcript stays whole.
    watchReportChildren(ws);

    // Which mounted position each report session's entry sits at, computed ONCE for each change of the
    // listing, the marks, or the message count. A `Map` because two sessions spawned in one turn share
    // a position, and the entries then render in the order that the store gave them.
    const entrySlots = createMemo((): Map<number, Thread[]> => {
        const marks = messageSeqMarks();
        const mounted = messages.length;
        const slots = new Map<number, Thread[]>();
        for (const child of reportChildren()) {
            const at = slotFor(child.parentSeq, marks, mounted);
            const held = slots.get(at);
            if (held) held.push(child);
            else slots.set(at, [child]);
        }
        return slots;
    });
    const entriesAt = (at: number): readonly Thread[] => entrySlots().get(at) ?? NO_ENTRIES;

    // The open is IN PLACE, through the one session-open operation of the workspace store: it binds the
    // report thread, and the effect below then resets the hot state and loads that thread. Nothing
    // relaunches and no screen pushes. An unscoped chat has no analysis to open a session against, thus
    // the click does nothing.
    const openReportChild = (threadId: string): void => {
        const analysis = ws.analysis;
        if (!analysis) return;
        ws.openSession(threadId, ws.workingDir, analysis);
    };

    // One render function for the two mount points below, thus an entry reads the same wherever it sits.
    // The title is pg-owned and seeded from the first message of the session, thus a row can legitimately
    // carry none. Say so rather than render a blank line, exactly as the sidebar SESSION rail does.
    const reportEntry = (child: Thread) => (
        <ReportSessionBlock
            title={child.title ?? "untitled"}
            activityLabel={Date.relativeAge(child.updatedAt.getTime())}
            onOpen={() => openReportChild(child.threadId)}
        />
    );

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
                        <>
                            {/* Each entry whose position is this message renders BEFORE it, thus the
                            entry sits after the last message that its spawn point named. */}
                            <For each={entriesAt(index())}>{reportEntry}</For>
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
                        </>
                    )}
                </For>
                {/* The tail position, which the loop above cannot reach: a spawn point at or past the end
                of the loaded transcript. A live turn appends below these entries, which is correct — the
                session was spawned before that turn. */}
                <For each={entriesAt(messages.length)}>{reportEntry}</For>

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
