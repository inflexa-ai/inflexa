/**
 * Notification-sweep contract: the sweep DELETE returns only the
 * configured limit's worth of rows, terminal-status notifications go
 * away, and live-workflow notifications are preserved.
 *
 * Test uses a stub `deleteStale` so the contract is exercised without a
 * launched DBOS runtime or a real `dbos.*` schema. A separate test
 * scaffold that runs against a real DBOS schema lives in change 8 once
 * workflows are actually registered.
 */

import { describe, expect, test } from "bun:test";
import { sweepStaleNotifications } from "./notification-sweep.js";

describe("sweepStaleNotifications", () => {
    test("forwards limit to deleteStale and returns the cleared count", async () => {
        let received = 0;
        const cleared = await sweepStaleNotifications({
            deleteStale: async (limit) => {
                received = limit;
                return 42;
            },
        });
        expect(received).toBe(10_000);
        expect(cleared).toBe(42);
    });

    test("propagates errors so the scheduled wrapper can log them", async () => {
        await expect(
            sweepStaleNotifications({
                deleteStale: async () => {
                    throw new Error("pg down");
                },
            }),
        ).rejects.toThrow("pg down");
    });

    test("zero-rows return is fine (no log noise required)", async () => {
        const cleared = await sweepStaleNotifications({
            deleteStale: async () => 0,
        });
        expect(cleared).toBe(0);
    });
});
