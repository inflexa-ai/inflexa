import { expect, test } from "bun:test";

import { currentNotice, notify } from "./notice.ts";

// The store is the non-trivial part (single slot, replace-on-new, auto-dismiss timer); the overlay
// JSX in app.tsx is presentation. These assert the slot/timer contract a TUI run can't easily check.

test("notify sets the current notice", () => {
    notify({ kind: "info", text: "hello" }, 10_000);
    expect(currentNotice()).toEqual({ kind: "info", text: "hello" });
});

test("a second notify REPLACES the first (single slot, no queue)", () => {
    notify({ kind: "info", text: "first" }, 10_000);
    notify({ kind: "error", text: "second" }, 10_000);
    expect(currentNotice()).toEqual({ kind: "error", text: "second" });
});

test("the notice auto-clears after its duration", async () => {
    notify({ kind: "warn", text: "transient" }, 15);
    expect(currentNotice()).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(currentNotice()).toBeNull();
});
