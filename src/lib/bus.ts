import { EventEmitter } from "events";
import { randomUUIDv7 } from "bun";

export type BusEvent =
    | { type: "session.status"; sessionId: string; status: "idle" | "busy" | "error" }
    | { type: "message.created"; message: string }
    | { type: "session.error"; sessionId: string; error: string };

class BusEmitter extends EventEmitter<{
    inf: [BusEvent];
}> {
    override emit<E extends string | symbol>(
        eventName: keyof EventEmitter.EventEmitterEventMap | "inf" | E,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- That is the stdlib signature that we are overriding
        ...args: E extends "inf" ? { inf: [BusEvent] }[E] : E extends keyof EventEmitter.EventEmitterEventMap ? EventEmitter.EventEmitterEventMap[E] : any[]
    ): boolean {
        if (eventName === "inf" && args && args[0] && typeof args[0] === "object") {
            args[0].__infId = args[0].__infId ?? randomUUIDv7();
        }
        return super.emit(eventName, ...args);
    }
}

export const Bus = new BusEmitter();
