import type { BusEvent } from "./types.ts";

type Listener = (event: BusEvent) => void;

class EventBus {
    private listeners = new Set<Listener>();

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    publish(event: BusEvent): void {
        for (const fn of this.listeners) {
            try {
                fn(event);
            } catch {
                // don't let a bad listener break the bus
            }
        }
    }
}

export const bus = new EventBus();
