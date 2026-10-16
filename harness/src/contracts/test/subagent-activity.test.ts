import { describe, expect, test } from "bun:test";
import { must } from "@inflexa-ai/harness/lib/test/guards.js";

import type { ChatFrame, EventSource } from "../chat-events.js";
import type { SubAgentActivityPart } from "../chat-parts.js";
import { applyChatFrame, checkChatPart } from "../chat-frame.js";
import type { ChatMessage } from "../message.js";
import { createSubAgentActivityTracker, SUBAGENT_ACTIVITY_MAX_ENTRIES } from "../subagent-activity.js";

const ROOT: EventSource = { agentId: "conversation-agent", callPath: ["conversation-agent"] };
const planner = (invocationId?: string): EventSource => ({
    agentId: "planner",
    callPath: ["conversation-agent", "planner"],
    invocationId,
});
const deeper = (invocationId?: string): EventSource => ({
    agentId: "reviewer",
    callPath: ["conversation-agent", "planner", "reviewer"],
    invocationId,
});

const started = (source: EventSource, toolUseId: string, detail?: string): ChatFrame => ({
    type: "tool-started",
    toolUseId,
    name: "search",
    detail,
    source,
});
const finished = (source: EventSource, toolUseId: string, extra: { detail?: string; durationMs?: number } = {}): ChatFrame => ({
    type: "tool-finished",
    toolUseId,
    name: "search",
    outcome: "ok",
    ...extra,
    source,
});

const T0 = Date.parse("2026-10-12T10:00:00.000Z");

function partOf(frame: ReturnType<ReturnType<typeof createSubAgentActivityTracker>["track"]>): SubAgentActivityPart {
    if (frame === null || frame.type !== "data-subagent-activity") {
        throw new Error(`expected a data-subagent-activity frame, got ${String(frame?.type)}`);
    }
    return frame;
}

describe("createSubAgentActivityTracker", () => {
    test("a planner call shows its tool calls in the message", () => {
        const tracker = createSubAgentActivityTracker();
        const frames: ChatFrame[] = [started(ROOT, "t1"), started(planner("t1"), "s1", "TP53"), finished(planner("t1"), "s1")];
        let messages: ChatMessage[] = [];
        for (const [i, frame] of frames.entries()) {
            messages = applyChatFrame(messages, frame, "asst").messages;
            const part = tracker.track(frame, T0 + i * 100);
            if (part !== null) messages = applyChatFrame(messages, part, "asst").messages;
        }

        const parts = messages[0].parts.filter((p) => p.type === "data-subagent-activity");
        expect(parts).toEqual([
            {
                type: "data-subagent-activity",
                id: "subagent-activity-t1",
                toolCallId: "t1",
                entries: [
                    {
                        agentId: "planner",
                        callPath: ["conversation-agent", "planner"],
                        tool: "search",
                        label: "TP53",
                        startedAt: new Date(T0 + 100).toISOString(),
                        endedAt: new Date(T0 + 200).toISOString(),
                        outcome: "ok",
                    },
                ],
                dropped: 0,
            },
        ]);
    });

    test("gives each part a source-free frame that passes checkChatPart", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        const part = tracker.track(started(planner("t1"), "s1"), T0);
        expect(part).not.toBeNull();
        expect(part).not.toHaveProperty("source");
        expect(checkChatPart(must(part, "part")).ok).toBe(true);
    });

    test("a nested sub-agent belongs to the root tool call", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        tracker.track(started(planner("t1"), "s1"), T0);
        const part = partOf(tracker.track(started(deeper("s1"), "d1"), T0 + 5));

        expect(part.toolCallId).toBe("t1");
        expect(part.entries.map((e) => [e.agentId, e.callPath.length])).toEqual([
            ["planner", 2],
            ["reviewer", 3],
        ]);
    });

    test("concurrent root calls keep separate lists", () => {
        const tracker = createSubAgentActivityTracker();
        const other = (invocationId: string): EventSource => ({ agentId: "analogy", callPath: ["conversation-agent", "analogy"], invocationId });
        tracker.track(started(ROOT, "t1"), T0);
        tracker.track(started(ROOT, "t2"), T0);
        tracker.track(started(planner("t1"), "s1"), T0);
        tracker.track(started(other("t2"), "o1"), T0);
        const p1 = partOf(tracker.track(started(planner("t1"), "s2"), T0));
        const p2 = partOf(tracker.track(finished(other("t2"), "o1"), T0));

        expect(p1.toolCallId).toBe("t1");
        expect(p1.entries.map((e) => e.agentId)).toEqual(["planner", "planner"]);
        expect(p2.toolCallId).toBe("t2");
        expect(p2.entries.map((e) => e.agentId)).toEqual(["analogy"]);
        expect(p2.entries[0].outcome).toBe("ok");
    });

    test("a call id that two loops reuse does not join two lists", () => {
        const tracker = createSubAgentActivityTracker();
        const other = (invocationId: string): EventSource => ({ agentId: "analogy", callPath: ["conversation-agent", "analogy"], invocationId });
        tracker.track(started(ROOT, "t1"), T0);
        tracker.track(started(ROOT, "t2"), T0);
        tracker.track(started(planner("t1"), "same"), T0);
        const part = partOf(tracker.track(started(other("t2"), "same"), T0));
        expect(part.toolCallId).toBe("t2");
        expect(part.entries).toHaveLength(1);
        const finish = partOf(tracker.track(finished(planner("t1"), "same"), T0 + 1));
        expect(finish.toolCallId).toBe("t1");
        expect(finish.entries[0].outcome).toBe("ok");
    });

    test("a frame with no invocation id changes nothing", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        expect(tracker.track(started(planner(), "s1"), T0)).toBeNull();
        expect(tracker.track(finished(planner(), "s1"), T0)).toBeNull();
        expect(tracker.track(started(planner("unknown"), "s2"), T0)).toBeNull();
    });

    test("the cap counts the calls that it drops", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        let part: SubAgentActivityPart | undefined;
        for (let i = 0; i < SUBAGENT_ACTIVITY_MAX_ENTRIES + 1; i += 1) {
            part = partOf(tracker.track(started(planner("t1"), `s${i}`), T0 + i));
        }
        expect(must(part, "part").entries).toHaveLength(SUBAGENT_ACTIVITY_MAX_ENTRIES);
        expect(must(part, "part").entries[0].tool).toBe("search");
        expect(must(part, "part").dropped).toBe(1);
        // The finish of a dropped call changes nothing.
        expect(tracker.track(finished(planner("t1"), `s${SUBAGENT_ACTIVITY_MAX_ENTRIES}`), T0)).toBeNull();
    });

    test("a deeper call below a dropped call is counted", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        for (let i = 0; i < SUBAGENT_ACTIVITY_MAX_ENTRIES; i += 1) tracker.track(started(planner("t1"), `s${i}`), T0);
        const dropped = partOf(tracker.track(started(planner("t1"), "s-dropped"), T0));
        expect(dropped.dropped).toBe(1);

        const part = partOf(tracker.track(started(deeper("s-dropped"), "d1"), T0));
        expect(part.entries).toHaveLength(SUBAGENT_ACTIVITY_MAX_ENTRIES);
        expect(part.dropped).toBe(2);
    });

    test("the end time uses the measured duration", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        tracker.track(started(planner("t1"), "s1"), T0);
        const part = partOf(tracker.track(finished(planner("t1"), "s1", { durationMs: 800 }), T0 + 5_000));
        expect(part.entries[0].startedAt).toBe("2026-10-12T10:00:00.000Z");
        expect(part.entries[0].endedAt).toBe("2026-10-12T10:00:00.800Z");
    });

    test("the end time is the receipt time when the finish has no duration", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        tracker.track(started(planner("t1"), "s1"), T0);
        const part = partOf(tracker.track(finished(planner("t1"), "s1"), T0 + 2_000));
        expect(part.entries[0].endedAt).toBe("2026-10-12T10:00:02.000Z");
    });

    test("the finish detail replaces the start detail, and the start detail stays otherwise", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        tracker.track(started(planner("t1"), "s1", "from start"), T0);
        tracker.track(started(planner("t1"), "s2", "kept"), T0);
        tracker.track(finished(planner("t1"), "s1", { detail: "from finish" }), T0);
        const part = partOf(tracker.track(finished(planner("t1"), "s2"), T0));
        expect(part.entries.map((e) => e.label)).toEqual(["from finish", "kept"]);
    });

    test("an entry with no detail has no label key", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        const part = partOf(tracker.track(started(planner("t1"), "s1"), T0));
        expect(Object.hasOwn(part.entries[0], "label")).toBe(false);
    });

    test("a finish with no recorded entry changes nothing", () => {
        const tracker = createSubAgentActivityTracker();
        tracker.track(started(ROOT, "t1"), T0);
        expect(tracker.track(finished(planner("t1"), "never-started"), T0)).toBeNull();
    });

    test("the other frames change nothing", () => {
        const tracker = createSubAgentActivityTracker();
        expect(tracker.track(started(ROOT, "t1"), T0)).toBeNull();
        expect(tracker.track(finished(ROOT, "t1"), T0)).toBeNull();
        const others: ChatFrame[] = [
            { type: "text-delta", text: "hello", source: planner("t1") },
            { type: "iteration", source: planner("t1") },
            { type: "finish", source: planner("t1") },
            { type: "error", message: "x", source: planner("t1") },
            { type: "data-presentation", id: "p", content: { kind: "markdown", body: "x" }, source: planner("t1") },
        ];
        for (const frame of others) expect(tracker.track(frame, T0)).toBeNull();
    });

    test("gives the same parts for the same frames and times", () => {
        const run = () => {
            const tracker = createSubAgentActivityTracker();
            return [started(ROOT, "t1"), started(planner("t1"), "s1"), finished(planner("t1"), "s1", { durationMs: 10 })].map((frame, i) =>
                tracker.track(frame, T0 + i),
            );
        };
        expect(run()).toEqual(run());
    });
});
