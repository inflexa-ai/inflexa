import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { BootIndicator } from "./boot_indicator.tsx";
import { ChatBar } from "../layout/chat_bar.tsx";

// Headless render coverage for the boot gate's visible surface (the store transitions are unit-tested
// in hooks/boot.test.ts). Three observables the spec names: while booting the animation renders, the
// gated input affordance surfaces the closed gate (the render-observable proxy for "submit refused" —
// the host's handleSubmit returns while not ready), and a failed boot shows its actionable message.

const noop = (): void => {};

describe("BootIndicator + gated ChatBar render", () => {
    test("booting shows the spinner label", async () => {
        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <BootIndicator />
                </box>
            ),
            { width: 60, height: 6 },
        );
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("booting harness runtime");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("the gated ChatBar surfaces the closed gate in its placeholder", async () => {
        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <ChatBar gated onTextareaRef={noop} onSubmit={noop} />
                </box>
            ),
            { width: 60, height: 8 },
        );
        try {
            await setup.renderOnce();
            expect(setup.captureCharFrame()).toContain("Booting harness runtime");
        } finally {
            setup.renderer.destroy();
        }
    });

    test("a failed boot shows the actionable message", async () => {
        const setup = await testRender(
            () => (
                <box width="100%" height="100%">
                    <BootIndicator message={"boot failed detail\ntry the fix here"} />
                </box>
            ),
            { width: 60, height: 6 },
        );
        try {
            await setup.renderOnce();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("boot failed detail");
            expect(frame).toContain("try the fix here"); // the second (remedy) line renders too
        } finally {
            setup.renderer.destroy();
        }
    });
});
