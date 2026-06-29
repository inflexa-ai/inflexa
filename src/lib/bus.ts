import { EventEmitter } from "events";
import { randomUUIDv7 } from "bun";
import type { BusEvent, StampedEvent } from "../types/events.ts";
import { getLogger } from "./log.ts";

class BusEmitter extends EventEmitter<{
    inflexa: [StampedEvent];
}> {
    override emit<E extends string | symbol>(
        eventName: keyof EventEmitter.EventEmitterEventMap | "inflexa" | E,
        ...args: E extends "inflexa"
            ? { inflexa: [BusEvent] }[E]
            : E extends keyof EventEmitter.EventEmitterEventMap
              ? EventEmitter.EventEmitterEventMap[E]
              : // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stdlib signature we are overriding
                any[]
    ): boolean {
        if (eventName === "inflexa" && args && args[0] && typeof args[0] === "object") {
            args[0].__infId = args[0].__infId ?? randomUUIDv7();
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- args is BusEvent on input but StampedEvent after __infId mutation
        return super.emit(eventName, ...(args as any));
    }
}

export const Bus = new BusEmitter();

let subscribed = false;

/**
 * Content fields (message text, part text, deltas) are deliberately reduced
 * to lengths — these records double as exportable telemetry events.
 */
function eventFields(event: StampedEvent): Record<string, unknown> {
    switch (event.type) {
        case "session.status":
            return { sessionId: event.sessionId, status: event.status };
        case "message.created":
            return {
                sessionId: event.message.sessionId,
                messageId: event.message.id,
                role: event.message.role,
            };
        case "message.updated":
            return {
                sessionId: event.message.sessionId,
                messageId: event.message.id,
                role: event.message.role,
                durationMs: event.message.durationMs,
            };
        case "part.updated":
            return {
                sessionId: event.part.sessionId,
                messageId: event.part.messageId,
                partId: event.part.id,
                partType: event.part.type,
                // Only text/thinking parts carry `text`; the live bus only ever emits text parts,
                // but the Part union now includes mock kinds without it, so narrow before reading.
                textLength: "text" in event.part ? event.part.text.length : undefined,
            };
        case "part.delta":
            return {
                sessionId: event.sessionId,
                messageId: event.messageId,
                partId: event.partId,
                deltaLength: event.delta.length,
            };
        case "session.error":
            return { sessionId: event.sessionId, error: event.error };
        case "prov.analysis_created":
            return { analysisId: event.analysisId, actorKind: event.actor.kind };
        case "prov.input_added":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, inputPath: event.input.path };
        case "prov.input_removed":
            return { analysisId: event.analysisId, actorKind: event.actor.kind, inputPath: event.input.path };
    }
}

/**
 * Explicit init (not an import side effect) so importing Bus alone
 * never starts the tap.
 */
export function initBusLogging(): void {
    if (subscribed) return;
    subscribed = true;

    const log = getLogger("bus");
    Bus.on("inflexa", (event) => {
        log.info({ event: event.type, infId: event.__infId, ...eventFields(event) }, "bus event");
    });
}
