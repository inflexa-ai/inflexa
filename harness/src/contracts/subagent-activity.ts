// The sub-agent activity of a chat turn, beside `applyChatFrame`. Browser-safe: each import from outside `contracts/` is a type import.

import type { ChatFrame, ChatPartFrame } from "./chat-events.js";
import type { SubAgentActivityEntry } from "./chat-parts.js";

/** The most entries that one root tool call holds. Each later call of its sub-agents only adds to `dropped`. */
export const SUBAGENT_ACTIVITY_MAX_ENTRIES = 200;

export type SubAgentActivityTracker = {
    /**
     * Read one frame of the turn, from the root agent or from a sub-agent, with the time of its receipt in
     * milliseconds. Gives the new `data-subagent-activity` part frame (no source) when the frame changes the activity
     * of a root tool call, else `null`.
     */
    track(frame: ChatFrame, nowMs: number): ChatPartFrame | null;
};

type CallInfo = {
    rootId: string;
    /** The index in the entries of the root call. Absent for a root call and for a dropped call. */
    entryIndex?: number;
    startedMs: number;
};

type RootRecord = {
    entries: SubAgentActivityEntry[];
    dropped: number;
};

// A call id is unique only inside the loop that made the call, thus the call path of that loop is part of the key.
// The path is the lineage of the sub-agent, the same read as `isRootFrame`. No control flow of the harness uses it.
function callKey(loopPath: readonly string[], callId: string): string {
    return JSON.stringify([loopPath, callId]);
}

export function createSubAgentActivityTracker(): SubAgentActivityTracker {
    // A dropped call stays in the map, thus a deeper call below it still counts in `dropped`.
    const calls = new Map<string, CallInfo>();
    const records = new Map<string, RootRecord>();

    const partOf = (rootId: string, record: RootRecord): ChatPartFrame => ({
        type: "data-subagent-activity",
        id: `subagent-activity-${rootId}`,
        toolCallId: rootId,
        entries: record.entries.map((entry) => ({ ...entry, callPath: [...entry.callPath] })),
        dropped: record.dropped,
    });

    return {
        track(frame, nowMs) {
            if (frame.type !== "tool-started" && frame.type !== "tool-finished") return null;
            const { source } = frame;

            if (frame.type === "tool-started") {
                if (source.callPath.length <= 1) {
                    calls.set(callKey(source.callPath, frame.toolUseId), { rootId: frame.toolUseId, startedMs: nowMs });
                    return null;
                }
                if (source.invocationId === undefined) return null;
                const parent = calls.get(callKey(source.callPath.slice(0, -1), source.invocationId));
                if (parent === undefined) return null;

                let record = records.get(parent.rootId);
                if (record === undefined) {
                    record = { entries: [], dropped: 0 };
                    records.set(parent.rootId, record);
                }
                if (record.entries.length >= SUBAGENT_ACTIVITY_MAX_ENTRIES) {
                    record.dropped += 1;
                    calls.set(callKey(source.callPath, frame.toolUseId), { rootId: parent.rootId, startedMs: nowMs });
                } else {
                    // An entry without a detail must not carry the key, so the absence survives the JSON round trip.
                    const entry: SubAgentActivityEntry = {
                        agentId: source.agentId,
                        callPath: [...source.callPath],
                        tool: frame.name,
                        startedAt: new Date(nowMs).toISOString(),
                    };
                    if (frame.detail !== undefined) entry.label = frame.detail;
                    record.entries.push(entry);
                    calls.set(callKey(source.callPath, frame.toolUseId), {
                        rootId: parent.rootId,
                        entryIndex: record.entries.length - 1,
                        startedMs: nowMs,
                    });
                }
                return partOf(parent.rootId, record);
            }

            if (source.callPath.length <= 1) return null;
            const call = calls.get(callKey(source.callPath, frame.toolUseId));
            if (call?.entryIndex === undefined) return null;
            const record = records.get(call.rootId);
            const entry = record?.entries[call.entryIndex];
            if (record === undefined || entry === undefined) return null;

            entry.outcome = frame.outcome;
            if (frame.detail !== undefined) entry.label = frame.detail;
            entry.endedAt = new Date(frame.durationMs === undefined ? nowMs : call.startedMs + frame.durationMs).toISOString();
            return partOf(call.rootId, record);
        },
    };
}
