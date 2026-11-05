import { afterEach, beforeEach } from "bun:test";

import { Bus } from "../lib/bus.ts";
import type { StampedEvent } from "../types/events.ts";

/** The `inflexa` events the bus captured during the CURRENT test, plus a way to clear them mid-test. */
export type BusEventCapture = {
    readonly events: () => StampedEvent[];
    /** Drop the events captured so far while the spy stays attached. */
    readonly reset: () => void;
};

/**
 * Capture every `inflexa` event the adapter under test emits on the bus, for the length of each
 * test. The listener always detaches in cleanup: a lingering spy would double-count a later test's
 * events, in this file or in a file bun test runs after this one.
 */
export function captureBusEvents(): BusEventCapture {
    let captured: StampedEvent[] = [];
    const spy = (event: StampedEvent): void => {
        captured.push(event);
    };
    beforeEach(() => {
        captured = [];
        Bus.on("inflexa", spy);
    });
    afterEach(() => {
        Bus.off("inflexa", spy);
    });
    return {
        events: () => captured,
        reset: () => {
            captured = [];
        },
    };
}
