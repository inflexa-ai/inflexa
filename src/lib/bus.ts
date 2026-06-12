import { EventEmitter } from "events";
import { randomUUIDv7 } from "bun";
import type { BusEvent, StampedEvent } from "../types.ts";

class BusEmitter extends EventEmitter<{
    inf: [StampedEvent];
}> {
    override emit<E extends string | symbol>(
        eventName: keyof EventEmitter.EventEmitterEventMap | "inf" | E,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- That is the stdlib signature that we are overriding
        ...args: E extends "inf" ? { inf: [BusEvent] }[E] : E extends keyof EventEmitter.EventEmitterEventMap ? EventEmitter.EventEmitterEventMap[E] : any[]
    ): boolean {
        if (eventName === "inf" && args && args[0] && typeof args[0] === "object") {
            args[0].__infId = args[0].__infId ?? randomUUIDv7();
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- args is BusEvent on input but StampedEvent after __infId mutation
        return super.emit(eventName, ...(args as any));
    }
}

export const Bus = new BusEmitter();
