import { afterEach, expect, test } from "bun:test";

import { __pendingNoticeCountForTest, __resetNoticesForTest, currentNotice, notify } from "./notice.ts";

// The store is the non-trivial part (FIFO queue, one timer, auto-advance); the overlay JSX in
// app.tsx is presentation. These assert the queue/timer contract a TUI run can't easily check.

afterEach(() => __resetNoticesForTest());

test("notify sets the current notice", () => {
    notify({ kind: "info", text: "hello" }, 10_000);
    expect(currentNotice()).toEqual({ kind: "info", text: "hello" });
});

test("a second notify QUEUES behind the first rather than replacing it", () => {
    // The channel deliberately does NOT replace on arrival: a run completing is unsolicited, and two
    // runs landing inside one display window is ordinary, so replacing would silently destroy the
    // first — the exact loss this queue exists to prevent.
    notify({ kind: "info", text: "first" }, 10_000);
    notify({ kind: "error", text: "second" }, 10_000);
    expect(currentNotice()).toEqual({ kind: "info", text: "first" });
    expect(__pendingNoticeCountForTest()).toBe(1);
});

test("the notice auto-clears after its duration", async () => {
    notify({ kind: "warn", text: "transient" }, 15);
    expect(currentNotice()).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(currentNotice()).toBeNull();
});

test("a queued notice is promoted when the showing one's window ends", async () => {
    notify({ kind: "info", text: "first" }, 15);
    notify({ kind: "error", text: "second" }, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(currentNotice()).toEqual({ kind: "error", text: "second" });
    expect(__pendingNoticeCountForTest()).toBe(0);
});
