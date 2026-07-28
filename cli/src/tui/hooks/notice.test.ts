import { afterEach, expect, test } from "bun:test";

import { __pendingNoticeCountForTest, __resetNoticesForTest, currentNotice, notify } from "./notice.ts";

// The store is the non-trivial part (two delivery disciplines, one timer, auto-advance); the overlay
// JSX in app.tsx is presentation. These assert the queue/timer contract a TUI run can't easily check.

afterEach(() => __resetNoticesForTest());

test("notify sets the current notice", () => {
    notify({ kind: "info", text: "hello" }, 10_000);
    expect(currentNotice()).toEqual({ kind: "info", text: "hello" });
});

test("a solicited notice REPLACES the showing one and queues nothing", () => {
    // The default, and the overwhelmingly common case: the user pressed copy, then pressed it again.
    // Queueing these would play two identical toasts back to back, making the second keystroke look
    // like it did something different from the first.
    notify({ kind: "info", text: "Copied to clipboard" }, 10_000);
    notify({ kind: "info", text: "Copied to clipboard" }, 10_000);
    expect(currentNotice()).toEqual({ kind: "info", text: "Copied to clipboard" });
    expect(__pendingNoticeCountForTest()).toBe(0);
});

test("an unsolicited notice QUEUES behind the showing one rather than replacing it", () => {
    // A run completing is unsolicited, and two runs landing inside one display window is ordinary,
    // so replacing would silently destroy the first — the exact loss the queue exists to prevent.
    notify({ kind: "info", text: "first run done" }, 10_000, { queue: true });
    notify({ kind: "error", text: "second run failed" }, 10_000, { queue: true });
    expect(currentNotice()).toEqual({ kind: "info", text: "first run done" });
    expect(__pendingNoticeCountForTest()).toBe(1);
});

test("a solicited notice takes the slot but does NOT discard what is queued behind it", async () => {
    // The two disciplines meet here: keystroke feedback must not wait behind background chatter, but
    // the run outcomes queued behind it are unsolicited and must still be delivered.
    notify({ kind: "info", text: "run A done" }, 15, { queue: true });
    notify({ kind: "info", text: "run B done" }, 10_000, { queue: true });
    notify({ kind: "info", text: "Copied to clipboard" }, 15);

    expect(currentNotice()).toEqual({ kind: "info", text: "Copied to clipboard" });
    expect(__pendingNoticeCountForTest()).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(currentNotice()).toEqual({ kind: "info", text: "run B done" });
});

test("the notice auto-clears after its duration", async () => {
    notify({ kind: "warn", text: "transient" }, 15);
    expect(currentNotice()).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(currentNotice()).toBeNull();
});

test("a queued notice is promoted when the showing one's window ends", async () => {
    notify({ kind: "info", text: "first" }, 15, { queue: true });
    notify({ kind: "error", text: "second" }, 10_000, { queue: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(currentNotice()).toEqual({ kind: "error", text: "second" });
    expect(__pendingNoticeCountForTest()).toBe(0);
});
